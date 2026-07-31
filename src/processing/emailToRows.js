/**
 * Full email → Excel rows transformation.
 *
 * Steps (all happen here):
 *   1. Clean the email body with textCleaner.
 *   2. Extract plates from cleaned text.
 *   3. Extract driver and reference from cleaned text.
 *   4. Build one row per plate.
 *
 * Returns an empty array when no plates are found.
 *
 * Columns (exact order matches excelWriter COLUMNS):
 *   Plate, From Email, Driver, Reference, Source Email ID, Raw Text
 *
 * "Raw Text" contains the cleaned text, not the original body.
 */

const { cleanText }    = require('./textCleaner');
const { extractPlates } = require('../extractors/plateExtractor');

// "Driver: Jonas Jonaitis"  /  "Vairuotojas: ..."  /  "Kierowca: ..."
const DRIVER_RE = /\b(?:driver|vairuotojas|kierowca|водитель)[:\s]+([^,]{2,60})/i;

// "Ref: ORD-123"  /  "Reference: ..."  /  "Order: ..."  /  "BK-9921"
const REF_RE = /\b(?:ref|reference|order|užsakymas)[:\s#]+([A-Z0-9][A-Z0-9\-]{2,29})/i;

function extractDriver(text) {
  const m = text.match(DRIVER_RE);
  return m ? m[1].trim() : '';
}

function extractReference(text) {
  const m = text.match(REF_RE);
  return m ? m[1].trim() : '';
}

function emailToRows(email) {
  const cleaned   = cleanText(`${email.subject}\n${email.body}`);
  const plates    = extractPlates(cleaned);

  if (!plates.length) return [];

  const driver    = extractDriver(cleaned);
  const reference = extractReference(cleaned);

  return plates.map((plate) => ({
    'Plate':           plate,
    'From Email':      email.from,
    'Driver':          driver,
    'Reference':       reference,
    'Source Email ID': email.messageId,
    'Raw Text':        cleaned,
  }));
}

module.exports = { emailToRows };
