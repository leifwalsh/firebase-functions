const fs = require('fs');
const { Readable, finished } = require('stream');

const _ = require('lodash');
const markdownpdf = require('markdown-pdf');
const pdfmerge = require('easy-pdf-merge');
const util = require('util');
const { argv } = require('yargs');

const {
  BULK_ORDER_TABLE,
  INTAKE_TABLE,
  ITEMS_BY_HOUSEHOLD_SIZE_TABLE,
  getAllRecords,
  getRecordsWithStatus,
  getBulkOrder,
  BULK_CLUSTER_TABLE,
} = require('../airtable');

class PackingSlip {
  constructor(intakeRecord, requested, provided, bulkClusterRecords) {
    this.intakeRecord = intakeRecord;
    this.requested = requested;
    this.provided = provided;
    this.bulkClusterRecords = bulkClusterRecords;
  }

  getMarkdown(itemToCategory) {
    const fields = this.intakeRecord[1];

    const [, bulkCluster,] = _.find(this.bulkClusterRecords, ([id,,]) => { return id === fields.bulkCluster[0]; });

    let markdown = `# **${fields.ticketID}** (Cluster ${bulkCluster.name}): ${fields.requestName} (${fields.nearestIntersection.trim()})\n\n`;

    const itemGroups = _.groupBy(
      _.toPairs(this.provided),
      ([item,]) => { return _.includes(['Bread', 'Bananas'], item) ? 'Last' : itemToCategory[item]; }
    );

    const categoryOrder = [
      'Fridge / Frozen',
      'Produce',
      'Non-perishable',
      'Cleaning Bundle',
      'Last',
    ];

    const renderTable = (groups, categories) => {
      const numRows = _.max(_.map(_.toPairs(groups), ([, items]) => { return items.length; }));
      markdown += '| ';
      _.forEach(categories, (category) => { markdown += ` ${category} |`; });
      markdown += '\n';
      _.forEach(categories, () => { markdown += ' --- |'; });
      for (var i = 0; i < numRows; i++) {
        markdown += '\n|';
        for (const category of categories) {
          const items = groups[category];
          if (items === undefined || i >= items.length) {
            markdown += ' &nbsp; |';
          } else {
            markdown += ` ${items[i][1]} ${items[i][0]} |`;
          }
        }
      }
      markdown += '\n';      
    };
    renderTable(itemGroups, categoryOrder);

    if (!_.isNull(fields.otherItems) || !_.isEqual(this.provided, this.requested)) {
      const missingItems = _.filter(
        _.map(
          _.toPairs(this.requested),
          ([item, numRequested]) => {
            return [item, numRequested - _.get(this.provided, item, 0)];
          },
        ),
        ([, diff]) => { return diff !== 0; },
      );

      const customItems = (!_.isNull(fields.otherItems) ? _.map(fields.otherItems.split(','), (item) => { return [item, '']; }) : []);

      const otherItems = missingItems.concat(customItems);

      if (otherItems.length > 0) {
        markdown += '\n---\n';

        renderTable({ Other: otherItems }, ['Other']);
      }
    }

    return markdown;
  }
}

async function savePackingSlips(packingSlips) {
  const itemToCategory = _.fromPairs(
    _.map(
      await getAllRecords(ITEMS_BY_HOUSEHOLD_SIZE_TABLE),
      ([, fields,]) => { return [fields.item, fields.category]; },
    )
  );

  try {
    await fs.promises.mkdir('out/');
  } catch (e) {
    if (e.code !== 'EEXIST') {
      throw e;
    }
  }

  const outPaths = await Promise.all(
    _.map(
      packingSlips,
      async (slip) => {
        const outPath = `out/${slip.intakeRecord[1].ticketID}.pdf`;

        // NOTE that I used A3 page size here (which is longer than A4) to ensure 
        // that we didn't use two pages for one ticket
        const stream = Readable.from([slip.getMarkdown(itemToCategory)]).pipe(
          markdownpdf({paperFormat: 'A3', cssPath: 'functions/scripts/packing-slips.css', paperOrientation: 'landscape'})
        ).pipe(fs.createWriteStream(outPath));
        await util.promisify(finished)(stream);

        return outPath;
      },
    )
  );

  const mergedOutPath = 'out/packing_slips.pdf';

  await util.promisify(pdfmerge)(outPaths, mergedOutPath);

  // TODO : do the collating and conversation to A4 page size here

  return mergedOutPath;
}

async function main() {
  // TODO: Actually implement a real arg parser.
  const deliveryDate = argv.deliveryDate;
  if (!deliveryDate) {
    throw new Error('must provide --deliveryDate=yyyy-mm-dd');
  }

  const intakeRecords = await getRecordsWithStatus(INTAKE_TABLE, 'Bulk Delivery Confirmed');

  console.log(`Found ${intakeRecords.length} bulk delivery confirmed tickets.`);

  const bulkOrderRecords = _.filter(await getAllRecords(BULK_ORDER_TABLE), ([, fields,]) => { return fields.deliveryDate === deliveryDate; });

  const itemToNumAvailable = _.fromPairs(
    _.map(
      bulkOrderRecords,
      ([, fields,]) => { return [fields.item, fields.quantity]; },
    )
  );

  const bulkClusterRecords = await getAllRecords(BULK_CLUSTER_TABLE);

  const packingSlips = await Promise.all(
    _.map(
      intakeRecords,
      async (record) => {
        const itemToNumRequested = await getBulkOrder([record]);

        const itemToNumProvided = _.fromPairs(
          _.filter(
            _.map(
              _.toPairs(itemToNumRequested),
              ([item, numRequested]) => {
                return [item, _.min([numRequested, itemToNumAvailable[item]])];
              }
            ),
            ([, numProvided]) => {
              return numProvided !== 0;
            }
          ),
        );

        // Update the num available for the bulk items we are providing for this ticket
        _.assign(
          itemToNumAvailable,
          _.fromPairs(
            _.map(
              _.toPairs(itemToNumProvided),
              ([item, numProvided]) => { return [item, itemToNumAvailable[item] - numProvided]; },
            )
          )
        );

        return new PackingSlip(record, itemToNumRequested, itemToNumProvided, bulkClusterRecords);
      },
    )
  );

  _.forIn(
    _.toPairs(itemToNumAvailable),
    ([item, numAvailable]) => {
      if (numAvailable < 0) {
        throw Error(`Accounting for ${item} was off, found ${numAvailable} leftovers`);
      }
    },
  );

  console.log('Creating packing slips...');

  const outPath = await savePackingSlips(packingSlips);

  console.log(`Merged packing slips: ${outPath}`);
}

main().then(
  () => console.log('Done.')
).catch(
  (err) => console.log('Error!', { err: err })
);
