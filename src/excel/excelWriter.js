const XLSX = require('xlsx');
const fs   = require('fs');
const path = require('path');
const { todayFilePath } = require('../core/dateManager');

const SHEET   = 'Orders';
const COLUMNS = ['Plate', 'From Email', 'Driver', 'Reference', 'Source Email ID', 'Raw Text'];

/**
 * Appends rows to today's Excel file, creating the file if it does not exist.
 * Never overwrites existing data — always reads first, then writes the full set.
 *
 * @param {object[]} rows - Array of row objects keyed by COLUMNS values
 * @returns {string} Absolute path of the file written to
 */
function appendRows(rows) {
  if (!rows.length) return;

  const filePath = todayFilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  // Read existing rows so we never lose prior data
  let existing = [];
  if (fs.existsSync(filePath)) {
    const wb = XLSX.readFile(filePath);
    const ws = wb.Sheets[SHEET];
    if (ws) existing = XLSX.utils.sheet_to_json(ws, { defval: '' });
  }

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet([...existing, ...rows], { header: COLUMNS });
  XLSX.utils.book_append_sheet(wb, ws, SHEET);
  XLSX.writeFile(wb, filePath);

  return filePath;
}

module.exports = { appendRows };
