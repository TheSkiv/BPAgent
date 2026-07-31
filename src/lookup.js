/**
 * Plate lookup — shared logic + CLI runner.
 *
 * Shared exports used by lookupInteractive.js:
 *   normalisePlate(raw)  → uppercase, strip spaces/dashes
 *   searchPlate(query)   → read today's Excel, return result object
 *
 * CLI:  node src/lookup.js ABC123
 */

require('dotenv').config();

const XLSX = require('xlsx');
const fs   = require('fs');
const { todayFilePath, todayString } = require('./core/dateManager');

const SHEET = 'Orders';

// ── shared ────────────────────────────────────────────────────────────────────

function normalisePlate(raw) {
  return String(raw).trim().toUpperCase().replace(/[\s\-]/g, '');
}

/**
 * Search today's Excel file for rows matching `query`.
 *
 * A row matches when the normalised query equals:
 *   - the full Plate value         (e.g. "ABC123" matches "ABC123")
 *   - either half of a pair        (e.g. "ABC123" matches "ABC123/AB1234")
 *   - the full pair                (e.g. "ABC123/AB1234" matches "ABC123/AB1234")
 *
 * Returns:
 *   { found: false, reason: 'no-file' | 'no-sheet' | 'no-match', query, filePath }
 *   { found: true,  query, matches: object[], filePath }
 */
function searchPlate(query) {
  const filePath = todayFilePath();
  const normalised = normalisePlate(query);

  if (!fs.existsSync(filePath)) {
    return { found: false, reason: 'no-file', query: normalised, filePath };
  }

  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets[SHEET];
  if (!ws) {
    return { found: false, reason: 'no-sheet', query: normalised, filePath };
  }

  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

  const matches = rows.filter((row) => {
    const cell = normalisePlate(String(row['Plate'] || ''));
    // Match full value or either side of a pair
    const parts = cell.split('/');
    return cell === normalised || parts.includes(normalised);
  });

  if (!matches.length) {
    return { found: false, reason: 'no-match', query: normalised, filePath };
  }

  return { found: true, query: normalised, matches, filePath };
}

// ── CLI runner ────────────────────────────────────────────────────────────────

function printResult(result) {
  if (!result.found) {
    console.log(`\nNOT FOUND: ${result.query}`);
    if (result.reason === 'no-file') {
      console.log(`No orders file for today (${todayString()}): ${result.filePath}`);
    }
    return;
  }

  console.log(`\nFOUND: ${result.query} — ${result.matches.length} record(s)`);
  for (const row of result.matches) {
    console.log(`  Plate:     ${row['Plate']}`);
    console.log(`  Driver:    ${row['Driver']     || '—'}`);
    console.log(`  Reference: ${row['Reference']  || '—'}`);
    console.log(`  From:      ${row['From Email'] || '—'}`);
    console.log('');
  }
}

if (require.main === module) {
  const query = process.argv[2];
  if (!query) {
    console.error('Usage: node src/lookup.js <plate>');
    process.exit(1);
  }
  printResult(searchPlate(query));
}

module.exports = { normalisePlate, searchPlate };
