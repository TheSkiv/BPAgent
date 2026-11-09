const http  = require('http');
const XLSX  = require('xlsx');
const fs    = require('fs');
const path  = require('path');

const { fetchStockRows, resolveVessel } = require('./stockCache');

const CARGO_FILE = path.resolve(__dirname, '../../config/cargo.xlsx');

const ENDPOINTS = [
  'http://192.168.1.146:3000/api/stock-report?report=stock_gbl&sheet=Sheet3',
  'http://192.168.1.146:3000/api/stock-report?report=stock_helm&sheet=Sheet3',
  'http://192.168.1.146:3000/api/stock_gbl_sheet4',
  'http://192.168.1.146:3000/api/stock_helm_sheet4',
];

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 10000 }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch (e) { reject(new Error(`JSON parse failed for ${url}: ${e.message}`)); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout: ${url}`)); });
    req.on('error', reject);
  });
}

function extractRows(data) {
  const raw = data.data || data.rows || [];
  if (!raw.length) return [];
  // array-of-arrays: first row is headers
  if (Array.isArray(raw[0])) {
    const headers = raw[0].map(h => String(h ?? '').trim());
    return raw.slice(1).map(arr => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = arr[i] ?? ''; });
      return obj;
    });
  }
  return raw;
}

function normalizeRow(row) {
  const cargo  = String(row['Produktas'] || row['Product Name'] || '').trim();
  const vessel = String(row['Laivas']    || '').trim();
  return cargo && vessel ? { cargo, vessel } : null;
}

function loadExisting() {
  if (!fs.existsSync(CARGO_FILE)) return new Map();
  const wb   = XLSX.readFile(CARGO_FILE);
  const ws   = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws);
  const map  = new Map();
  for (const r of rows) {
    const cargo = String(r['Cargo'] || '').trim();
    if (cargo) map.set(cargo.toLowerCase(), { cargo, vessel: String(r['Vessel'] || '').trim() });
  }
  return map;
}

async function syncCargo() {
  const existing = loadExisting();
  const incoming = new Map();
  const errors   = [];

  for (const url of ENDPOINTS) {
    try {
      const data = await fetchJson(url);
      const rows = extractRows(data);
      for (const row of rows) {
        const entry = normalizeRow(Array.isArray(row) ? {} : row);
        if (!entry) continue;
        const key = entry.cargo.toLowerCase();
        if (!incoming.has(key)) incoming.set(key, entry);
      }
    } catch (err) {
      errors.push(`${url}: ${err.message}`);
      console.warn('[syncCargo] fetch failed:', err.message);
    }
  }

  // Add only entries that don't already exist
  let added = 0;
  for (const [key, entry] of incoming) {
    if (!existing.has(key)) {
      existing.set(key, entry);
      added++;
    }
  }

  // Re-point every cargo name the stock reports still carry at its current vessel. Without this a
  // name kept its first vessel forever (e.g. ammonium sulphate stayed on RIX SPIRIT after ULSAN
  // arrived). Names no longer in stock keep their last vessel — they are only a fallback.
  let updated = 0;
  try {
    const stockRows = await fetchStockRows();
    for (const entry of existing.values()) {
      const vessel = resolveVessel(entry.cargo, stockRows);
      if (vessel && vessel !== entry.vessel) {
        console.log(`[syncCargo] ${entry.cargo}: ${entry.vessel || '(none)'} → ${vessel}`);
        entry.vessel = vessel;
        updated++;
      }
    }
  } catch (err) {
    errors.push(`vessel refresh: ${err.message}`);
  }

  if (added === 0 && updated === 0) return { synced: 0, updated: 0, errors };

  const allEntries = [...existing.values()].sort((a, b) => a.cargo.localeCompare(b.cargo));
  const aoa = [['Cargo', 'Vessel'], ...allEntries.map(e => [e.cargo, e.vessel])];
  const wb  = XLSX.utils.book_new();
  const ws  = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 30 }, { wch: 30 }];
  XLSX.utils.book_append_sheet(wb, ws, 'Cargo');
  XLSX.writeFile(wb, CARGO_FILE);

  return { synced: added, updated, errors };
}

module.exports = { syncCargo };
