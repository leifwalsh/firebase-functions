const functions = require('firebase-functions');
const Slack = require('slack');
const allSettled = require('promise.allsettled');
const _ = require('lodash');
const fs = require('fs');
const showdown = require('showdown');
const sgMail = require('@sendgrid/mail');
const {argv} = require('yargs');

sgMail.setApiKey(functions.config().sendgrid.api_key);
allSettled.shim();

const {
  INBOUND_TABLE,
  INTAKE_TABLE,
  META_STORE_KEYS,
  REIMBURSEMENTS_TABLE,
  VOLUNTEER_FORM_TABLE,
  getChangedRecords,
  getMeta,
  getLastNonDuplicate,
  getRecord,
  getRecordsWithTicketID,
  getRecordsWithStatus,
  getTicketDueDate,
  getVolunteerSlackID,
  storeMeta,
  updateRecord,
} = require('../airtable');

const {
  INBOUND_STATUSES
} = require('../schema');

const {
  getIntakePostContent,
  getIntakePostDetails,
  getDeliveryDMContent,
  getTicketSummaryBlocks,
  getShoppingList,
  renderShoppingList,
  renderSingleTicketShoppingList,
} = require('../messages');

async function getOneIntaketicket(ticket) {
  const records = await getRecordsWithTicketID(INTAKE_TABLE, ticket);
  if (records.length !== 1) {
    throw new Error(`Found ${records.length} records`);
  }
  return records[0];
}

const saveIntakeTicketInfo = async (ticket) => {
  const record = await getOneIntaketicket(ticket);
  fs.writeFileSync(`${ticket}.json`, JSON.stringify(record));
};


const sendEmail = async (msg) => {
  try {
    console.log('Sending message', msg);
    return await sgMail.send(msg);
  } catch (error) {
    console.error(error);

    if (error.response) {
      console.error(error.response.body);
    }
  }
};

const showShoppingList = async (tickets) => {
  const records = await Promise.all(_.map(tickets.split(','), getOneIntaketicket));
  const shoppingList = await getShoppingList(records);
  if (tickets.split(',').length === 1) {
    const [, fields,] = records[0];
    var markdown = `**Ticket ID:** ${fields.ticketID}<br/>\n`;
    markdown += `**Neighbor:** ${fields.requestName} (${fields.nearestIntersection})<br/>\n`;
    markdown += `**Address:** ${fields.address}<br/>\n`;
    markdown += `**Phone:** ${fields.phoneNumber}<br/>\n`;
    markdown += `**Delivery Notes:** ${fields.deliveryNotes}<br/>\n`;
    if (fields.vulnerability) {
      markdown += `**Vulnerabilities:** ${fields.vulnerability}<br/>\n`;
    }
    markdown += `**Household Size:** ${fields.householdSize}<br/>\n`;
    markdown += renderSingleTicketShoppingList(shoppingList);
    markdown += `\n**Other Items:** ${fields.otherItems}\n`

    const converter = new showdown.Converter({ tasklists: true });
    const html = converter.makeHtml(markdown);
  
    const msg = {
      to: 'leif.walsh@gmail.com',
      from: functions.config().sendgrid.from,
      subject: fields.ticketID,
      text: markdown,
      html: html,
    };
    console.log(await sendEmail(msg));
  } else {
    console.log(renderShoppingList(shoppingList));
  }
};

const main = async () => {
  if (argv.saveTicket !== undefined) {
    await saveIntakeTicketInfo(argv.saveTicket);
  } else if (argv.showShoppingList !== undefined) {
    await showShoppingList(argv.showShoppingList);
  } else {
    console.error('no arguments matched TODO help text');
  }
};

main().catch(e => { console.error(e); process.exit(1); });
