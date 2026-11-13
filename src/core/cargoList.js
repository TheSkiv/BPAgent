const XLSX = require('xlsx');
const fs   = require('fs');
const path = require('path');

const CARGO_FILE = path.resolve(__dirname, '../../config/cargo.xlsx');

function loadCargoList() {
  if (!fs.existsSync(CARGO_FILE)) return [];
  const wb   = XLSX.readFile(CARGO_FILE);
  const ws   = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws);
  return rows
    .map(r => ({
      cargo:  String(r['Cargo']  || '').trim(),
      vessel: String(r['Vessel'] || '').trim(),
    }))
    .filter(r => r.cargo.length > 0);
}

function normalize(s) {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function extractFormula(cargoName) {
  const m = cargoName.match(/\d+[-]\d+[-]\d+(?:[-]\d+)*/);
  return m ? m[0] : null;
}

// Build a map: normalizedKey → { cargo, vessels[] }
// Multiple rows with the same cargo name get their vessels merged.
function buildCargoMap() {
  const list = loadCargoList();
  const map  = new Map();
  for (const item of list) {
    const key = normalize(item.cargo);
    if (key.length < 4) continue;
    if (!map.has(key)) map.set(key, { cargo: item.cargo, vessels: [] });
    if (item.vessel && !map.get(key).vessels.includes(item.vessel)) {
      map.get(key).vessels.push(item.vessel);
    }
  }
  return map;
}

// Returns { cargo, vessel } where vessel is " / "-joined if multiple,
// or null if nothing matched.
function findCargoInText(text) {
  const cargoMap = buildCargoMap();
  if (!cargoMap.size) return null;

  const normText = normalize(text);
  const sorted   = [...cargoMap.entries()]
    .sort((a, b) => b[0].length - a[0].length); // longer keys first

  // Pass 1: normalized full-name substring
  for (const [key, item] of sorted) {
    if (normText.includes(key)) {
      return { cargo: item.cargo, vessel: item.vessels.join(' / ') };
    }
  }

  // Pass 2: 3-part NPK formula literal match (e.g. "8-12-20")
  for (const [, item] of sorted) {
    const formula = extractFormula(item.cargo);
    if (formula && text.includes(formula)) {
      return { cargo: item.cargo, vessel: item.vessels.join(' / ') };
    }
  }

  // Pass 3: split each cargo name on non-alphanumeric boundaries, normalize chunks,
  // search in normalized text. Re-sorted by longest single chunk so entries with a
  // highly specific token (e.g. "yarabela" len=8) beat entries whose only tokens are
  // short common words (e.g. "yara"=4, "axan"=4) — prevents "Yara Bela Axan N27"
  // from stealing a match that belongs to "YaraBela Axan NS27-4 RSK".
  function getChunks(cargoName) {
    return cargoName.split(/[^a-zA-Z0-9]+/).map(c => c.toLowerCase()).filter(c => c.length >= 4);
  }
  const pass3sorted = [...cargoMap.entries()].sort((a, b) => {
    const maxA = Math.max(0, ...getChunks(a[1].cargo).map(c => c.length));
    const maxB = Math.max(0, ...getChunks(b[1].cargo).map(c => c.length));
    return maxB - maxA;
  });
  for (const [, item] of pass3sorted) {
    for (const chunk of getChunks(item.cargo)) {
      if (normText.includes(chunk)) {
        return { cargo: item.cargo, vessel: item.vessels.join(' / ') };
      }
    }
  }

  // Pass 4: a short product word on its own ("DAP", "MAP", "TSP") — too short for pass 3 — names
  // the list entry it starts, when exactly one entry starts with it ("DAP" → "DAP 18-46"; owner,
  // 2026-11-12: DAP was almost never recognised). A whole word only, 3+ letters.
  const words = new Set(String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => /^[a-z]{3}$/.test(w)));
  for (const w of words) {
    const hits = sorted.filter(([, item]) => item.cargo.toLowerCase().split(/[^a-z0-9]+/)[0] === w);
    if (hits.length === 1) return { cargo: hits[0][1].cargo, vessel: hits[0][1].vessels.join(' / ') };
  }

  return null;
}

// Lookup vessels for a known cargo name.
// Pass 1: exact normalized match.
// Pass 2: findCargoInText (handles extra words / different formatting).
// Pass 3: prefix match — saved name is an abbreviation of a cargo.xlsx entry (e.g. "DAP" → "DAP 18-46").
function getVesselForCargo(cargoName) {
  if (!cargoName) return '';
  const key      = normalize(cargoName);
  const cargoMap = buildCargoMap();

  const exact = cargoMap.get(key);
  if (exact) return exact.vessels.join(' / ');

  const match = findCargoInText(cargoName);
  if (match) return match.vessel;

  if (key.length >= 3) {
    const hits = [...cargoMap.entries()].filter(([k]) => k.startsWith(key));
    if (hits.length === 1) return hits[0][1].vessels.join(' / ');
  }

  return '';
}

module.exports = { loadCargoList, findCargoInText, getVesselForCargo };
