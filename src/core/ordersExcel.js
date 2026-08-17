const XLSX    = require('xlsx');
const ExcelJS = require('exceljs');
const fs      = require('fs');
const path    = require('path');
const { todayFilePath } = require('./dateManager');
const { findCargoInText } = require('./cargoList');
const orderStore = require('./orderStore');

const SENDERS_FILE = path.resolve(__dirname, '../../config/senders.xlsx');

function parseAddress(from) {
  const m = String(from).match(/<([^>]+)>/);
  return (m ? m[1] : from).toLowerCase().trim();
}

async function removeNotCheckRows() {
  if (!fs.existsSync(SENDERS_FILE)) return 0;
  const fp = todayFilePath();
  if (!fs.existsSync(fp)) return 0;

  const swb = new ExcelJS.Workbook();
  await swb.xlsx.readFile(SENDERS_FILE);
  const sws = swb.getWorksheet('Senders');
  const notcheck = new Set();
  sws.eachRow((row, i) => {
    if (i === 1) return;
    const b = String(row.getCell(2).value || '').toLowerCase().trim();
    if (b) notcheck.add(b);
  });
  if (!notcheck.size) return 0;

  const wb  = XLSX.readFile(fp);
  const ws  = wb.Sheets[wb.SheetNames[0]];
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1 });
  const filtered = [aoa[0], ...aoa.slice(1).filter(row => !notcheck.has(parseAddress(String(row[4] || ''))))];
  const removed = aoa.length - filtered.length;
  if (removed > 0) {
    wb.Sheets[wb.SheetNames[0]] = XLSX.utils.aoa_to_sheet(filtered);
    XLSX.writeFile(wb, fp);
    console.log(`Removed ${removed} Not Check row(s) from orders Excel.`);
  }
  return removed;
}

const ORDERS_COLUMNS = ['Plate', 'Driver', 'Cargo', 'Weight', 'Sender', 'Received', 'Bulk', 'Gross Weight'];

function ensureTodayExcel() {
  const fp = todayFilePath();
  if (fs.existsSync(fp)) return;
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([ORDERS_COLUMNS]), 'Orders');
  XLSX.writeFile(wb, fp);
  console.log('Created today\'s Excel:', fp);
}

function normalizePlate(str) {
  return str.replace(/[\s/\\]+/g, '').toLowerCase();
}

const DATA_DIR = process.env.DATA_DIR || 'C:\\PortSystem\\data';

// Returns the raw Plate strings (e.g. "MTV610//EP012") from today's orders file.
function todayOrderPlates() {
  const fp = todayFilePath();
  if (!fs.existsSync(fp)) return [];
  const wb   = XLSX.readFile(fp);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
  return rows.map(r => r['Plate'] || '').filter(Boolean);
}

// Driver isn't stored on the order-store record (only plate/cargo/weight/bulk are), only in the
// Excel row — used by the draft-email template, which wants a driver name.
function getDriverForPlate(plate) {
  const fp = todayFilePath();
  if (!fs.existsSync(fp)) return '';
  const wb   = XLSX.readFile(fp);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
  const n = normalizePlate(plate);
  const row = rows.find(r => normalizePlate(String(r['Plate'] || '')) === n);
  return row ? String(row['Driver'] || '') : '';
}

// Appends a row to today's orders Excel.
// Returns { saved: true } or { skipped: true, reason: string }
function appendOrderRow({ plate, driver, cargo, weight, sender, received, bulk }) {
  ensureTodayExcel();
  const fp = todayFilePath();

  // A truck still open (not done/cancelled) today blocks a repeat row — see the matching rule
  // in orderStore.ensureOrder for why. Once closed, a repeat is a legitimate second trip.
  if (orderStore.activeOrderForPlate(plate)) return { skipped: true, reason: 'Truck already in pipeline (not done yet)' };

  const wb  = XLSX.readFile(fp);
  const ws  = wb.Sheets[wb.SheetNames[0]];
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1 });
  // Migrate existing files: add Bulk column to header if missing
  if (!aoa[0].includes('Bulk')) aoa[0].push('Bulk');
  aoa.push([
    plate,
    driver    || '',
    cargo     || '',
    weight    || '',
    sender    || '',
    received  || '',
    bulk      ? '1' : '',
  ]);

  wb.Sheets[wb.SheetNames[0]] = XLSX.utils.aoa_to_sheet(aoa);
  XLSX.writeFile(wb, fp);
  return { saved: true };
}

// Back-fills Cargo and/or Weight for an existing row whose plate matches — each field only
// written when it's currently empty. Automated gap-filling (e.g. a re-processed email/PDF
// revealing what a prior pass missed); never overwrites a value already present.
function updateOrderCargo(plate, cargo, weight) {
  if (!cargo && (weight === undefined || weight === '')) return false;
  const fp = todayFilePath();
  if (!fs.existsSync(fp)) return false;

  const wb  = XLSX.readFile(fp);
  const ws  = wb.Sheets[wb.SheetNames[0]];
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1 });
  if (aoa.length < 2) return false;

  const header    = aoa[0];
  const plateIdx  = header.indexOf('Plate');
  const cargoIdx  = header.indexOf('Cargo');
  const weightIdx = header.indexOf('Weight');
  if (plateIdx === -1) return false;

  const incomingPlates = plate.split('//').map(normalizePlate);
  let updated = false;

  for (let i = 1; i < aoa.length; i++) {
    const existingPlates = String(aoa[i][plateIdx] || '').split('//').map(normalizePlate);
    if (!incomingPlates.some(p => existingPlates.includes(p))) continue;
    if (cargo && cargoIdx !== -1 && !String(aoa[i][cargoIdx] || '').trim()) {
      aoa[i][cargoIdx] = cargo;
      updated = true;
    }
    if (weight !== undefined && weight !== '' && weightIdx !== -1 && !String(aoa[i][weightIdx] || '').trim()) {
      aoa[i][weightIdx] = weight;
      updated = true;
    }
    break;
  }

  if (updated) {
    wb.Sheets[wb.SheetNames[0]] = XLSX.utils.aoa_to_sheet(aoa);
    XLSX.writeFile(wb, fp);
  }
  return updated;
}

// Updates cargo, weight, bulk and/or gross weight for an existing row by plate — an explicit
// operator edit, so any field provided is overwritten outright (unlike updateOrderCargo's
// back-fill-only rule).
function updateOrderFields(plate, { cargo, weight, bulk, grossWeight } = {}) {
  const fp = todayFilePath();
  if (!fs.existsSync(fp)) return false;

  const wb  = XLSX.readFile(fp);
  const ws  = wb.Sheets[wb.SheetNames[0]];
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1 });
  if (aoa.length < 2) return false;

  const header    = aoa[0];
  const plateIdx  = header.indexOf('Plate');
  const cargoIdx  = header.indexOf('Cargo');
  const weightIdx = header.indexOf('Weight');
  let   bulkIdx   = header.indexOf('Bulk');
  let   grossIdx  = header.indexOf('Gross Weight');

  if (plateIdx === -1) return false;
  if (bulkIdx === -1 && bulk !== undefined) { bulkIdx = header.length; header.push('Bulk'); }
  if (grossIdx === -1 && grossWeight !== undefined) { grossIdx = header.length; header.push('Gross Weight'); }

  const incoming = plate.split('//').map(normalizePlate);
  let updated = false;

  for (let i = 1; i < aoa.length; i++) {
    const existing = String(aoa[i][plateIdx] || '').split('//').map(normalizePlate);
    if (!incoming.some(p => existing.includes(p))) continue;
    if (cargo !== undefined && cargoIdx !== -1) {
      aoa[i][cargoIdx] = cargo;
      updated = true;
    }
    if (weight !== undefined && weightIdx !== -1) {
      aoa[i][weightIdx] = weight;
      updated = true;
    }
    if (bulk !== undefined && bulkIdx !== -1) {
      aoa[i][bulkIdx] = bulk ? '1' : '';
      updated = true;
    }
    if (grossWeight !== undefined && grossIdx !== -1) {
      aoa[i][grossIdx] = grossWeight;
      updated = true;
    }
    break;
  }

  if (updated) {
    wb.Sheets[wb.SheetNames[0]] = XLSX.utils.aoa_to_sheet(aoa);
    XLSX.writeFile(wb, fp);
  }
  return updated;
}

// Re-runs cargo matching on every row that has an empty Cargo field,
// using the rich text stored in the Driver column.
// Returns the number of rows updated.
function refreshCargo() {
  const fp = todayFilePath();
  if (!fs.existsSync(fp)) return 0;

  const wb  = XLSX.readFile(fp);
  const ws  = wb.Sheets[wb.SheetNames[0]];
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1 });
  if (aoa.length < 2) return 0;

  const header     = aoa[0];
  const cargoIdx   = header.indexOf('Cargo');
  const driverIdx  = header.indexOf('Driver');
  if (cargoIdx === -1 || driverIdx === -1) return 0;

  let updated = 0;
  for (let i = 1; i < aoa.length; i++) {
    const row = aoa[i];
    if (String(row[cargoIdx] || '').trim()) continue; // already has cargo
    const driverText = String(row[driverIdx] || '');
    if (!driverText) continue;
    const found = findCargoInText(driverText);
    if (found) {
      row[cargoIdx] = found.cargo;
      updated++;
    }
  }

  if (updated > 0) {
    wb.Sheets[wb.SheetNames[0]] = XLSX.utils.aoa_to_sheet(aoa);
    XLSX.writeFile(wb, fp);
  }
  return updated;
}

module.exports = { appendOrderRow, removeNotCheckRows, refreshCargo, updateOrderCargo, updateOrderFields, todayOrderPlates, getDriverForPlate };
