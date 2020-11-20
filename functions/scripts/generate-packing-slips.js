const fs = require('fs');

const _ = require('lodash');
const markdownpdf = require('markdown-pdf');
const pdfmerge = require('easy-pdf-merge');
const util = require('util');
const yargs = require('yargs');

const {
  reconcileOrders,
  // eslint-disable-next-line no-unused-vars
  ReconciledOrder,
  getAllHolidayRoutes,
  getTicketsForHolidayRoute,
} = require('../airtable');

const generalCategories = ['Non-perishable', 'Produce'];

/**
 * Render one packing slip for this order.
 * @param {ReconciledOrder} order Reconciled order
 * @returns {string} markdown for this packing slip
 */
function renderPackingSlip(fields) {
  let markdown = `# **${_.trim(fields.ticketID)}** (Route ${fields.bulkDeliveryRoute.name}): ${fields.requestName} (${fields.nearestIntersection.trim()})\n\n`;
  markdown += `**Delivery**: ${fields.bulkDeliveryRoute.deliveryVolunteerName}\n\n`;
  markdown += `**Household Size**: ${fields.householdSize}\n\n`;

  const groceryList = _.concat(
    (_.includes(['Turkey', 'Pork Shoulder'], fields.porkOrTurkey) ? [`1 ${fields.porkOrTurkey}`] : []),
    [
      '1 Dessert',
      '1 bottle Cooking Oil',
      '1 Mayo Squeeze Bottle',
      '1 pack Dinner Rolls',
      '1 package Baked Beans',
      '1 package Turkey Gravy',
      '1 package Cranberry Sauce',
      '1 package Dry Split Peas',
      '1 package Macaroni Pasta',
      'Potatoes',
    ],
    [(fields.householdSize > 4 ? '2 Produce Boxes' : '1 Produce Box')],
  );

  markdown += '## Grocery List\n\n';
  for (const item of groceryList) {
    markdown += `- ${item}\n`;
  }

  return markdown;
}

/**
 * Render packing slips into one PDF file.
 * @param {ReconciledOrder[]} orders orders to render
 * @returns {Promise<string>} Path PDF was written to.
 */
async function savePackingSlips(orders) {
  try {
    await fs.promises.mkdir('out/');
  } catch (e) {
    if (e.code !== 'EEXIST') {
      throw e;
    }
  }

  const PDF = markdownpdf({
    paperFormat: 'A3',
    cssPath: 'functions/scripts/packing-slips.css',
    paperOrientation: 'portrait',
  });

  const outPaths = _.flatten(await Promise.all(_.flatMap(orders, async (order) => {
    const tickets = await Promise.all(getTicketsForHolidayRoute(order));
    const produceBoxes = _.sum(_.map(tickets, (ticket) => {
      return ticket[1].householdSize > 4 ? 2 : 1;
    }));
    console.log(order[1].name, produceBoxes);
    const routeMarkdown = `# Route ${order[1].name}\n\n**Delivery:** ${order[1].deliveryVolunteerName}\n\n**Produce Boxes:** ${produceBoxes}\n`;
    const stream = PDF.from.string(routeMarkdown);
    const routeOutPath = `out/route-${order[1].name}.pdf`;
    await util.promisify(stream.to.path)(routeOutPath);
    return _.concat(
      [],
      await Promise.all(_.map(tickets, async (ticket) => {
        const markdown = renderPackingSlip(Object.assign({}, ticket[1], { bulkDeliveryRoute: order[1] }));
        const stream = PDF.from.string(markdown);
        const outPath = `out/${ticket[1].ticketID}.pdf`;
        // @ts-ignore stream.to.path's callback isn't of the right type for
        // promisify
        await util.promisify(stream.to.path)(outPath);
        return outPath;
      }
      ))
    );
  })));
  const mergedOutPath = 'out/packing_slips.pdf';
  // @ts-ignore pdfmerge's callback isn't of the right type for promisify
  await util.promisify(pdfmerge)(outPaths, mergedOutPath);

  await Promise.all(_.map(outPaths, (path) => {
    return fs.promises.unlink(path);
  }));

  return mergedOutPath;
}

async function main() {
  const { argv } = yargs.option('deliveryDate', {
    coerce: (x) => new Date(x),
    demandOption: true,
    describe: 'Date of scheduled delivery (yyyy-mm-dd format)',
  });

  const orders = _.sortBy(await getAllHolidayRoutes(argv.deliveryDate), ([, bulkDeliveryRoute,]) => {
    return _.toNumber(bulkDeliveryRoute.name);
  });

  console.log('Creating packing slips...');
  const outPath = await savePackingSlips(orders);
  console.log('Wrote packing slips to', outPath);
}

main()
  .then(() => console.log('Done.'))
  .catch((err) => console.log('Error!', { err: err }));
