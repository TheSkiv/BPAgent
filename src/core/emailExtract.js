const { findCargoInText } = require('./cargoList');

const PLATE_RE = /\b([A-Z]{2,3})[\s\\/]*(\d{3,4})\b/g;
// Common abbreviations that look like plates but aren't
const PLATE_BLACKLIST = new Set(['NR', 'VG', 'OK', 'ETA', 'REF', 'PCS', 'KGS', 'KG']);

function stripHtml(text) {
  return text
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#\d+;/g, ' ')
    .trim();
}

function extractPlates(text) {
  const upper = text.toUpperCase();
  const results = [];
  let m;
  PLATE_RE.lastIndex = 0;
  while ((m = PLATE_RE.exec(upper)) !== null) {
    const digits = m[2];
    if (digits.length === 4 && +digits >= 1900 && +digits <= 2099) continue;
    if (PLATE_BLACKLIST.has(m[1])) continue;
    // Skip weight expressions like "600 kg", "24 tona"
    const after = upper.slice(m.index + m[0].length).match(/^\s*([A-Z]+)/);
    if (after && /^(KG|T|TON|TONA|TNE|VNT)$/.test(after[1])) continue;
    results.push(m[1] + m[2]);
  }
  return [...new Set(results)];
}

function extractDriver(text) {
  const labeled = text.match(/(?:driver|vairuotojas)\s*:\s*(.+)/i);
  if (labeled) return labeled[1].trim();

  const infoLine = text.match(/info\s*[-–]\s*(.+)/i);
  if (infoLine) {
    const cleaned = infoLine[1]
      .replace(/\b[A-Z]{2,3}[\s\\/]*\d{3,4}\b/g, '')
      .replace(/\b[A-Z]{2,5}\b/g, '')
      .replace(/[\\\/]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (cleaned.length > 2) return cleaned;
  }

  const plateLineRe = /\b[A-Z]{2,3}[\s\\/]*\d{3,4}\b/i;
  for (const line of text.split(/\r?\n/)) {
    if (!plateLineRe.test(line)) continue;
    const cleaned = line
      .replace(/\b[A-Z]{2,3}[\s\\/]*\d{3,4}\b/gi, '')
      .replace(/\b\d{6,}\b/g, '')
      .replace(/[\\\/]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (cleaned.length > 2) return cleaned;
  }

  return '';
}

function extractCargo(text, subject = '') {
  const fromList = findCargoInText(text) || (subject ? findCargoInText(subject) : null);
  if (fromList) return fromList.cargo;

  const labeled = text.match(/(?:cargo|load|goods|prek[eė]|krovinys|ve[zž]ama)\s*:\s*(.+)/i);
  if (labeled) return labeled[1].trim();

  const krautis = text.match(/krautis\s+(.+?)\s+(?:imone|imonei|kompanijai?|i\s+imone)/i);
  if (krautis) return krautis[1].trim();

  if (subject) {
    const parts = subject.split(/\s+[-–]\s+/);
    if (parts.length >= 3) {
      const cargo = parts[parts.length - 1].replace(/\s*\(\d+\)\s*$/, '').trim();
      if (cargo.length > 2) return cargo;
    }
  }

  const lines = text.split(/\r?\n/);
  const headerIdx = lines.findIndex(l => /prekes_pavadinimas/i.test(l));
  if (headerIdx !== -1) {
    const headers = lines[headerIdx].split(/\t+/).map(h => h.trim());
    const colIdx  = headers.findIndex(h => /prekes_pavadinimas/i.test(h));
    for (let i = headerIdx + 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      const cols = lines[i].split(/\t+|\s{2,}/);
      if (cols.length > colIdx && cols[colIdx].trim()) return cols[colIdx].trim();
    }
  }

  return '';
}

// For emails with multiple shipments: finds lines that each contain exactly 2 plates
// and extracts {plates, driver} per line.
function extractPlatePairs(text) {
  const clean = stripHtml(text);
  const pairs = [];
  for (const line of clean.split(/\r?\n/)) {
    const platesOnLine = extractPlates(line);
    if (platesOnLine.length !== 2) continue;
    const driver = line
      .replace(/\b[A-Z]{2,3}[\s\\/]*\d{3,4}\b/gi, '')
      .replace(/\b\d{6,}\b/g, '')
      .replace(/[\\\/]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    pairs.push({ plates: platesOnLine, driver: driver.length > 2 ? driver : '' });
  }
  return pairs;
}

function extractIsBulk(text) {
  if (!text) return false;
  return /\bBULK\b/i.test(text);
}

// Total truck weight from the email, normalized to kg.
// Tonnes ("24t", "24,5 tona") are ×1000; kg values ("24000 kg", "24 000 kg") taken as-is.
// A "600" / "600 kg" bigbag size is NOT a weight: the kg pattern needs 4+ digits, so it is
// never captured, and tonnes are capped at 40t. The truck total is the largest candidate.
function extractWeight(text) {
  if (!text) return 0;
  const candidates = [];
  let m;

  const tRe = /(\d{1,2}(?:[.,]\d+)?)\s*t(?:onn?(?:a|os|ų|u)?|n)?\b/gi;
  while ((m = tRe.exec(text)) !== null) {
    const val = parseFloat(m[1].replace(',', '.'));
    if (val >= 1 && val <= 40) candidates.push(Math.round(val * 1000));
  }

  const kgRe = /(\d{1,3}(?:[ .,]\d{3})+|\d{4,6})\s*kg\b/gi;
  while ((m = kgRe.exec(text)) !== null) {
    const val = parseInt(m[1].replace(/[ .,]/g, ''), 10);
    if (val >= 1000) candidates.push(val);
  }

  return candidates.length ? Math.max(...candidates) : 0;
}

// The quantity on one waybill (važtaraštis) PDF, in kg. The terminal's waybills put it in the
// "Kiekis" table as unit then amount after the product code: "(TRGATKAR501) t	12,000" — tonnes
// with a decimal comma (12,000 t = 12 000 kg). Returns 0 unless exactly one quantity is found.
function waybillWeightKg(text) {
  const found = [];
  for (const m of String(text || '').matchAll(/\)\s*(t|kg)\s+(\d{1,6}(?:[.,]\d{1,3})?)(?!\d)/gi)) {
    const n = parseFloat(m[2].replace(',', '.'));
    const kg = m[1].toLowerCase() === 't' ? Math.round(n * 1000) : Math.round(n);
    if (kg >= 100 && kg <= 45000) found.push(kg);
  }
  return found.length === 1 ? found[0] : 0;
}

function extractAll(text, subject = '') {
  const clean = stripHtml(text);
  const plates = extractPlates(clean);
  const finalPlates = plates.length ? plates : extractPlates(subject);
  return {
    plates:      finalPlates,
    driver_name: extractDriver(clean),
    cargo:       extractCargo(clean, subject),
    is_bulk:     extractIsBulk(clean) || extractIsBulk(subject),
    weight:      extractWeight(clean) || extractWeight(subject),
  };
}

module.exports = { extractAll, extractPlatePairs, extractPlates, extractDriver, extractCargo, extractIsBulk, extractWeight, waybillWeightKg, stripHtml };
