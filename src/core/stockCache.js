const http = require('http');
const fs   = require('fs');
const path = require('path');

// Both stock reports carry vessel cargo for this terminal; reading only one makes the other
// report's cargo look "not in stock" (ROADMAP A21). They name the product column differently.
const STOCK_REPORTS = [
  { name: 'GBL',     url: 'http://192.168.1.146:3000/api/stock-report?report=stock_gbl&sheet=Sheet3' },
  { name: 'Helm AG', url: 'http://192.168.1.146:3000/api/stock-report?report=stock_helm&sheet=Sheet3' },
];
const PRODUCT_COLUMNS = ['Produktas', 'Product Name'];
const SYNONYMS_PATH   = path.resolve(__dirname, '../../config/cargo_synonyms.json');
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

function parseReport(raw, report) {
  const data = Array.isArray(raw.data) ? raw.data : [];
  if (data.length < 2) return [];

  const [headers, ...rest] = data;
  const col = name => headers.indexOf(name);
  const productCol = PRODUCT_COLUMNS.map(col).find(i => i !== -1) ?? -1;

  return rest
    .map(r => ({
      report,
      vessel:     String(r[col('Laivas')] || '').trim(),
      produktas:  String(r[productCol]    || '').trim(),
      netto:      parseNetto(r[col('Netto')]),
      discharged: parseDischarged(r[col('Discharged')]),
    }))
    .filter(r => r.vessel && r.vessel !== 'STOCK' && r.produktas && r.produktas !== 'STOCK');
}

// All-or-nothing: if one report can't be read, the stock picture is incomplete and a cargo from
// that report would wrongly look absent — so the caller is told the stock is unavailable instead.
async function fetchStockRows() {
  if (_rows && Date.now() - _loadedAt < TTL_MS) return _rows;

  const reports = await Promise.all(STOCK_REPORTS.map(async r => parseReport(await fetchJson(r.url), r.name)));
  _rows = reports.flat();
  _loadedAt = Date.now();
  return _rows;
}

// Groups of names for the same cargo — orders are usually Lithuanian, stock reports English.
// Read on every lookup so an operator's edit to the file applies without a restart.
function synonymGroups() {
  try {
    const { groups } = JSON.parse(fs.readFileSync(SYNONYMS_PATH, 'utf8'));
    return Array.isArray(groups) ? groups.map(g => g.map(norm).filter(Boolean)) : [];
  } catch {
    return [];
  }
}

// Name words for word matching: letters only, no diacritics, 3+ letters. Drops packaging and
// filler ("po 600 kg", "(A5)") and grade codes like "N27", which are written differently on each
// side ("27-04" in an order, "N27, S3,7%" in stock).
function nameWords(s) {
  return (String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().match(/[a-z]+/g) || [])
    .filter(w => w.length >= 3);
}

// Every word of the order name starts a word of the other name:
// "YARA BELA AXAN 27-04 po 600 kg" ↔ "Yara Bela Axan N27, S3,7% (RSK)", "Gran Urea" ↔ "GRANULAR UREA".
// A grade formula in the order must be in the other name too — the words alone ("NPK") would let
// NPK 11-11-21 match NPK 8-12-22.
function wordsMatch(orderCargo, otherName) {
  const formula = extractFormula(orderCargo);
  if (formula && !String(otherName).includes(formula)) return false;
  const want = nameWords(orderCargo);
  const have = nameWords(otherName);
  return want.length > 0 && want.every(w => have.some(h => h.startsWith(w)));
}

function matchingRows(cargoName, stockRows) {
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

  // Pass 4: synonym match (e.g. "Amonio sulfatas (600) gran." ↔ "AMMONIUM SULPHATE")
  if (!matching.length) {
    const group = synonymGroups().find(g => g.some(name => normCargo.includes(name)));
    if (group) matching = stockRows.filter(r => group.some(name => norm(r.produktas).includes(name)));
  }

  // Pass 5: word match — only when it points at a single product; two different products
  // (e.g. two Yara grades) would be a guess, so the run stops instead.
  if (!matching.length) {
    const hits = stockRows.filter(r => wordsMatch(cargoName, r.produktas));
    const products = [...new Set(hits.map(r => norm(r.produktas)))];
    if (products.length === 1) matching = hits;
    else if (products.length > 1) console.warn(`Stock: "${cargoName}" matches ${products.length} different products (${[...new Set(hits.map(r => r.produktas))].join(' | ')}) — not guessing`);
  }

  return matching;
}

// Whether a KIPIS lot's cargo name is the ordered cargo. Looser than the stock lookup in one
// way: either name may be the start of the other ("AMONIO SULFATAS" ↔ "Amonio sulfatas (600) gran.").
function sameCargo(orderCargo, otherName) {
  const a = norm(orderCargo), b = norm(otherName);
  if (!a || !b) return false;
  if (a === b || a.startsWith(b) || b.startsWith(a)) return true;
  const formula = extractFormula(orderCargo);
  if (formula && String(otherName).includes(formula)) return true;
  const group = synonymGroups().find(g => g.some(name => a.includes(name)));
  if (group && group.some(name => b.includes(name))) return true;
  return wordsMatch(orderCargo, otherName);
}

// Short words to type into KIPIS's Pavadinimas filter, which only matches short text (the
// operators type e.g. "amonio"): the order's first word, then the first word of each synonym, in
// case KIPIS names the cargo in the other language.
function cargoKeywords(orderCargo) {
  const firstWord = s => (String(s || '').match(/\p{L}+/u) || [''])[0];
  let groups = [];
  try { groups = JSON.parse(fs.readFileSync(SYNONYMS_PATH, 'utf8')).groups || []; } catch { /* no synonyms */ }
  const group = groups.find(g => g.some(name => norm(orderCargo).includes(norm(name)))) || [];
  const seen = new Set();
  return [orderCargo, ...group].map(firstWord).filter(w => w && !seen.has(w.toLowerCase()) && seen.add(w.toLowerCase()));
}

// Sums netto per vessel and keeps each vessel's oldest discharge date, oldest-first.
function byVesselOldestFirst(rows) {
  const byVessel = new Map();
  for (const r of rows) {
    if (!byVessel.has(r.vessel)) byVessel.set(r.vessel, { netto: 0, discharged: r.discharged });
    const e = byVessel.get(r.vessel);
    e.netto += r.netto;
    if (r.discharged < e.discharged) e.discharged = r.discharged;
  }
  return [...byVessel.entries()].sort((a, b) => a[1].discharged - b[1].discharged);
}

// Synchronous: given pre-loaded stock rows and a cargo name, returns the single
// vessel that should be used (oldest with >= 24t). Returns:
//   string  — vessel name to display (may be '' if cargo is in stock but all depleted)
//   null    — cargo not found in stock at all
function resolveVessel(cargoName, stockRows) {
  if (!cargoName || !stockRows) return null;

  const matching = matchingRows(cargoName, stockRows);
  if (!matching.length) return null;

  const sufficient = byVesselOldestFirst(matching).filter(([, v]) => v.netto >= MIN_NETTO_KG);
  return sufficient.length ? sufficient[0][0] : '';
}

// Returns all vessels for a cargo with their total netto, sorted oldest-first.
// Each entry: { vessel, nettoKg, sufficient } where sufficient = nettoKg >= MIN_NETTO_KG.
function vesselBreakdown(cargoName, stockRows) {
  if (!cargoName || !stockRows) return [];

  return byVesselOldestFirst(matchingRows(cargoName, stockRows)).map(([vessel, v]) => ({
    vessel,
    nettoKg:   Math.round(v.netto),
    sufficient: v.netto >= MIN_NETTO_KG,
  }));
}

module.exports = { fetchStockRows, resolveVessel, vesselBreakdown, sameCargo, cargoKeywords, matchingRows };
