require('dotenv').config();

const { getMessages, markAsRead } = require('./ingestion/graphClient');
const { parseGraphMessage }       = require('./ingestion/emailParser');
const { emailToRows }             = require('./processing/emailToRows');
const { appendRows }              = require('./excel/excelWriter');
const { todayFilePath }           = require('./core/dateManager');

function ts() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

async function run() {
  console.log(`[${ts()}] Starting  output → ${todayFilePath()}`);

  const messages = await getMessages();
  console.log(`[${ts()}] Fetched   ${messages.length} message(s)`);

  for (const msg of messages) {
    const email = parseGraphMessage(msg);
    const rows  = emailToRows(email);

    if (!rows.length) {
      console.log(`[${ts()}] SKIP      ${msg.id} — no plates found  "${email.subject}"`);
      continue;
    }

    const filePath = appendRows(rows);
    await markAsRead(msg.id);

    const plates = rows.map((r) => r['Plate']);
    console.log(`[${ts()}] WRITTEN   ${msg.id} — ${plates.length} plate(s): ${plates.join(', ')}  → ${filePath}`);
  }

  console.log(`[${ts()}] Done`);
}

run().catch((err) => {
  console.error(`[${ts()}] FATAL`, err.message);
  process.exit(1);
});
