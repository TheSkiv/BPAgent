const ExcelJS = require('exceljs');
const path    = require('path');
const fs      = require('fs');

const SENDERS_FILE   = path.resolve(__dirname, '../../config/senders.xlsx');
// Explicit human confirmation. Being in the Check column is NOT confirmation — unknown senders
// are auto-added there, so only this list may authorise automatic filing.
const CONFIRMED_FILE = path.resolve(__dirname, '../../config/confirmed_senders.json');

const RED_FILL = {
  type: 'pattern', pattern: 'solid',
  fgColor: { argb: 'FFFF6666' },
};

// Extract bare email address from "Display Name <email@domain.com>" or "email@domain.com"
function parseAddress(from) {
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1] : from).toLowerCase().trim();
}

async function ensureSendersFile() {
  if (fs.existsSync(SENDERS_FILE)) return;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Senders');
  ws.columns = [
    { header: 'Check',     key: 'check',     width: 40 },
    { header: 'Not Check', key: 'notcheck',  width: 40 },
  ];
  // Bold headers
  ws.getRow(1).font = { bold: true };
  await wb.xlsx.writeFile(SENDERS_FILE);
  console.log('Created senders file:', SENDERS_FILE);
}

// Returns { check: Set<email>, notcheck: Set<email> }
async function loadSenders() {
  await ensureSendersFile();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(SENDERS_FILE);
  const ws = wb.getWorksheet('Senders');

  const check    = new Set();
  const notcheck = new Set();

  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; // skip header
    const a = String(row.getCell(1).value || '').toLowerCase().trim();
    const b = String(row.getCell(2).value || '').toLowerCase().trim();
    if (a) check.add(a);
    if (b) notcheck.add(b);
  });

  return { check, notcheck };
}

// Classify a sender: 'check' | 'notcheck' | 'unknown'
async function classifySender(from) {
  const email = parseAddress(from);
  const { check, notcheck } = await loadSenders();
  if (check.has(email))    return 'check';
  if (notcheck.has(email)) return 'notcheck';
  return 'unknown';
}

// Add an email address to the Check column with red highlight.
// No-op if already present in either column.
async function addToCheck(from, highlight = false) {
  const email = parseAddress(from);
  await ensureSendersFile();

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(SENDERS_FILE);
  const ws = wb.getWorksheet('Senders');

  // Check if already exists
  const { check, notcheck } = await loadSenders();
  if (check.has(email) || notcheck.has(email)) return;

  // Find first empty row in column A
  let targetRow = 2;
  ws.eachRow((row, rowNumber) => {
    const val = String(row.getCell(1).value || '').trim();
    if (rowNumber > 1 && val) targetRow = rowNumber + 1;
  });

  const cell = ws.getCell(targetRow, 1);
  cell.value = email;

  if (highlight) {
    cell.fill = RED_FILL;
    cell.font = { color: { argb: 'FF8B0000' }, bold: true };
  }

  await wb.xlsx.writeFile(SENDERS_FILE);
  console.log(`Sender added to Check${highlight ? ' (red - unreviewed)' : ''}: ${email}`);
}

// Populate Check column from a list of "from" strings, skipping already-known senders.
async function populateFromList(froms) {
  await ensureSendersFile();

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(SENDERS_FILE);
  const ws = wb.getWorksheet('Senders');

  const { check, notcheck } = await loadSenders();

  // Find next free row in column A
  let nextRow = 2;
  ws.eachRow((row, rowNumber) => {
    if (rowNumber > 1 && String(row.getCell(1).value || '').trim()) {
      nextRow = rowNumber + 1;
    }
  });

  const added = [];
  for (const from of froms) {
    const email = parseAddress(from);
    if (!email || check.has(email) || notcheck.has(email)) continue;
    check.add(email); // prevent duplicates within this batch

    const cell = ws.getCell(nextRow, 1);
    cell.value = email;
    nextRow++;
    added.push(email);
  }

  if (added.length) {
    await wb.xlsx.writeFile(SENDERS_FILE);
    console.log(`Added ${added.length} sender(s) to Check column.`);
  }
  return added;
}

function loadConfirmed() {
  if (!fs.existsSync(CONFIRMED_FILE)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIRMED_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function saveConfirmed(list) {
  fs.writeFileSync(CONFIRMED_FILE, JSON.stringify(list, null, 1));
}

function isConfirmed(from) {
  const email = parseAddress(from);
  return loadConfirmed().some(e => e.email === email);
}

// Marks a sender as human-confirmed: their future orders may be filed without review.
async function confirmSender(from) {
  const email = parseAddress(from);
  const list  = loadConfirmed();
  if (!list.some(e => e.email === email)) {
    list.push({ email, at: new Date().toISOString() });
    saveConfirmed(list);
    console.log(`Sender CONFIRMED (may auto-file): ${email}`);
  }
  await addToCheck(from); // keep senders.xlsx in sync, without the red "unreviewed" fill
  return email;
}

// Blocks a sender: moves them to Not Check and revokes any confirmation.
async function blockSender(from) {
  const email = parseAddress(from);

  saveConfirmed(loadConfirmed().filter(e => e.email !== email));

  await ensureSendersFile();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(SENDERS_FILE);
  const ws = wb.getWorksheet('Senders');

  const { notcheck } = await loadSenders();
  if (!notcheck.has(email)) {
    let targetRow = 2;
    ws.eachRow((row, rowNumber) => {
      if (rowNumber > 1 && String(row.getCell(2).value || '').trim()) targetRow = rowNumber + 1;
    });
    ws.getCell(targetRow, 2).value = email;
  }

  // Clear them from the Check column so the two lists cannot disagree.
  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    if (String(row.getCell(1).value || '').toLowerCase().trim() === email) row.getCell(1).value = null;
  });

  await wb.xlsx.writeFile(SENDERS_FILE);
  console.log(`Sender BLOCKED (Not Check): ${email}`);
  return email;
}

module.exports = {
  classifySender, addToCheck, populateFromList, parseAddress,
  isConfirmed, confirmSender, blockSender, loadConfirmed,
};
