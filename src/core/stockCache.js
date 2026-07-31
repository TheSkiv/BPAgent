const http = require('http');

const STOCK_URL = 'http://192.168.1.146:3000/api/stock-report?report=stock_gbl&sheet=Sheet3';
const MIN_NETTO_KG = 24000;
const TTL_MS = 5 * 60 * 1000;

let _rows    = null;
let _loadedAt = 0;

function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function extractFormula(name) {
  const m = String(name || '').match(/\d{1,2}-\d{1,2}-\d{1,2}(?:-\d+)?/);
  return m ? m[0] : null;
}

function parseNetto(val) {
  return parseFloat(String(val || 0).replace(/,/g, '')) || 0;
}

function parseDischarged(val) {
  const s = String(val || '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return new Date(s);
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return new Date(0);
  let y = parseInt(m[3]);
  if (y < 100) y += 2000;
  return new Date(y, parseInt(m[1]) - 1, parseInt(m[2]));
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function fetchStockRows() {
  if (_rows && Date.now() - _loadedAt < TTL_MS) return _rows;

  const raw  = await fetchJson(STOCK_URL);
  const data = Array.isArray(raw.data) ? raw.data : [];
  if (data.length < 2) { _rows = []; _loadedAt = Date.now(); return []; }

  const [headers, ...rest] = data;
  const col = name => headers.indexOf(name);

  _rows = rest
    .map(r => ({
      vessel:     String(r[col('Laivas')]     || '').trim(),
      produktas:  String(r[col('Produktas')]  || '').trim(),
      netto:      parseNetto(r[col('Netto')]),
      discharged: parseDischarged(r[col('Discharged')]),
    }))
    .filter(r => r.vessel && r.vessel !== 'STOCK' && r.produktas && r.produktas !== 'STOCK');

  _loadedAt = Date.now();
  return _rows;
}

// Synchronous: given pre-loaded stock rows and a cargo name, returns the single
// vessel that should be used (oldest with >= 24t). Returns:
//   string  — vessel name to display (may be '' if cargo is in stock but all depleted)
//   null    — cargo not found in stock at all (caller should fall back to cargo.xlsx)
function resolveVessel(cargoName, stockRows) {
  if (!cargoName || !stockRows) return null;

  const normCargo = norm(cargoName);

  // Pass 1: exact normalized name match
  let matching = stockRows.filter(r => norm(r.produktas) === normCargo);

  // Pass 2: NPK formula match (e.g. "Cropcare 11-11-21" ↔ "NPK 11-11-21")
  if (!matching.length) {
    const formula = extractFormula(cargoName);
    if (formula) matching = stockRows.filter(r => r.produktas.includes(formula));
  }

  // Pass 3: prefix match (e.g. "DAP" matches "DAP 18-46")
  if (!matching.length && normCargo.length >= 3) {
    matching = stockRows.filter(r => norm(r.produktas).startsWith(normCargo));
  }

  if (!matching.length) return null; // not found in stock → caller falls back

  // Group by vessel, sum netto, track oldest discharged date
  const byVessel = new Map();
  for (const r of matching) {
    if (!byVessel.has(r.vessel)) byVessel.set(r.vessel, { netto: 0, discharged: r.discharged });
    const e = byVessel.get(r.vessel);
    e.netto += r.netto;
    if (r.discharged < e.discharged) e.discharged = r.discharged;
  }

  const sufficient = [...byVessel.entries()]
    .filter(([, v]) => v.netto >= MIN_NETTO_KG)
    .sort((a, b) => a[1].discharged - b[1].discharged);

  return sufficient.length ? sufficient[0][0] : '';
}

// Returns all vessels for a cargo with their total netto, sorted oldest-first.
// Each entry: { vessel, nettoKg, sufficient } where sufficient = nettoKg >= MIN_NETTO_KG.
function vesselBreakdown(cargoName, stockRows) {
  if (!cargoName || !stockRows) return [];

  const normCargo = norm(cargoName);
  let matching = stockRows.filter(r => norm(r.produktas) === normCargo);

  if (!matching.length) {
    const formula = extractFormula(cargoName);
    if (formula) matching = stockRows.filter(r => r.produktas.includes(formula));
  }

  if (!matching.length && normCargo.length >= 3) {
    matching = stockRows.filter(r => norm(r.produktas).startsWith(normCargo));
  }

  if (!matching.length) return [];

  const byVessel = new Map();
  for (const r of matching) {
    if (!byVessel.has(r.vessel)) byVessel.set(r.vessel, { netto: 0, discharged: r.discharged });
    const e = byVessel.get(r.vessel);
    e.netto += r.netto;
    if (r.discharged < e.discharged) e.discharged = r.discharged;
  }

  return [...byVessel.entries()]
    .sort((a, b) => a[1].discharged - b[1].discharged)
    .map(([vessel, v]) => ({
      vessel,
      nettoKg:   Math.round(v.netto),
      sufficient: v.netto >= MIN_NETTO_KG,
    }));
}

module.exports = { fetchStockRows, resolveVessel, vesselBreakdown };
