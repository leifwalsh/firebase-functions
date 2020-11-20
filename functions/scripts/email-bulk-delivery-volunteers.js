const functions = require('firebase-functions');
const _ = require('lodash');
const fs = require('fs');
const moment = require('moment');
const Mustache = require('mustache');
const yargs = require('yargs');

// eslint-disable-next-line no-unused-vars
const { getAllHolidayRoutes, getTicketsForHolidayRoutes, getRecordsWithFilter, reconcileOrders, HOLIDAY_DELIVERY_ROUTES_TABLE, ReconciledOrder } = require('../airtable');
const { googleMapsUrl, Email } = require('../messages');

// Each week we might need custom shoppers to do some "bulk purchases" if we
// couldn't procure everything we needed. The "no route" section lets us ask
// every custom shopper to get some bulk items and not sort them by tickets.
const noRouteSection = {
  items: []
};

/**
 * Sometimes, we have "custom items" we have on hand and don't need shoppers
 * to purchase, but they aren't represented in the Bulk Order table.
 * @param {{ item: string, quantity: number | null }} param0 Custom item.
 */
const itemNeedsCustomShopping = ({ item }) => {
  const lowered = _.lowerCase(item);
  return !(
    _.endsWith(lowered, 'art kit')
    || _.endsWith(lowered, 'art kits')
    || lowered.match(/\d\s*books?\s/) !== null
    || _.endsWith(lowered, 'helmet')
    || _.endsWith(lowered, 'helmets')
  );
};

/**
 * Construct the mustache template parameter map.
 * @param {Object} route route fields
 * @param {ReconciledOrder[]} orders list of orders
 */
function getEmailTemplateParameters(route, orders) {
  const ticketParameterMaps = orders.map((order) => {
    const [, ticket,] = order;
    const groceryList = _.join(
      _.concat(
        (_.includes(['Turkey', 'Pork Shoulder'], ticket.porkOrTurkey) ? [`1 ${ticket.porkOrTurkey}`] : []),
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
        [(ticket.householdSize > 4 ? '2 Produce Boxes' : '1 Produce Box')],
      ), ', ');
    return Object.assign({}, ticket, {
      phoneNumberNumbersOnly: _.replace(ticket.phoneNumber, /[^0-9]/g, ''),
      mapsUrl: googleMapsUrl(_.trim(ticket.address)),
      groceryList,
    });
  });
  return {
    to: route.deliveryVolunteerEmail,
    deliveryDateString: moment(route.deliveryDate).utc().format('MMMM Do'),
    firstName: route.deliveryVolunteerName[0].split(' ')[0],
    routeName: route.name,
    ticketIDs: _.join(_.map(orders, ([, fields,]) => {
      return fields.ticketID;
    }), ', '),
    warehouseMapsUrl: googleMapsUrl('221 Glenmore Ave'),
    arrivalTime: _.trim(route.arrivalTime),
    warehouseCoordinatorPhone1: functions.config().bulk_ops_team.warehouse_coordinator1.phone_number,
    warehouseCoordinatorPhone2: functions.config().bulk_ops_team.warehouse_coordinator2.phone_number,
    tickets: ticketParameterMaps,
  };
}

async function main() {
  const { argv } = yargs
    .option('deliveryDate', {
      coerce: (x) => new Date(x),
      demandOption: true,
      describe: 'Date of scheduled delivery (yyyy-mm-dd format)',
    })
    .option('route', {
      coerce: String,
      demandOption: false,
      describe: 'Email just one delivery volunteer for a specific route ID',
      type: 'string',
    })
    .boolean('dryRun');

  const routes = argv.route ? (
    await getRecordsWithFilter(HOLIDAY_DELIVERY_ROUTES_TABLE, { deliveryDate: argv.deliveryDate, name: argv.route })
  ) : await getAllHolidayRoutes(argv.deliveryDate);

  const templateParameterMaps = await Promise.all(_.map(routes, async (route) => {
    const ticketRecords = await getTicketsForHolidayRoutes([route]);
    const [, routeFields,] = route;
    return getEmailTemplateParameters(routeFields, ticketRecords);
  }));

  const emailTemplateFilename = 'functions/templates/bulk-delivery-volunteer-email.md.mustache';
  const emailTemplate = (await fs.promises.readFile(emailTemplateFilename)).toString('utf-8');

  const emails = _.map(templateParameterMaps, (view) => {
    const markdown = Mustache.render(emailTemplate, view);
    return new Email(markdown, {
      to: view.to,
      cc: 'operations+bulk@bedstuystrong.com',
      replyTo: 'operations+bulk@bedstuystrong.com',
      subject: `[BSS Bulk Ordering] ${view.deliveryDateString} Holiday Delivery Prep and Instructions for ${view.firstName}`,
    });
  });

  if (argv.dryRun) {
    _.forEach(emails, (email) => {
      console.log('To:', email.render().to);
      console.log(email.render().text);
    });
  } else {
    await Promise.all(_.map(emails, (email) => {
      return email.send();
    }));
  }
}

main().then(
  () => console.log('done')
).catch(
  (e) => {
    console.error(e);
    if (e.response && e.response.body && e.response.body.errors) {
      console.error(e.response.body.errors);
    }
  }
);
