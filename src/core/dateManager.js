const path = require('path');

const DATA_DIR = process.env.DATA_DIR || 'C:\\PortSystem\\data';

// Returns today's date as YYYY-MM-DD
function todayString() {
  return new Date().toISOString().slice(0, 10);
}

// Returns the full path to today's output file
function todayFilePath() {
  return path.join(DATA_DIR, `${todayString()}_orders.xlsx`);
}

module.exports = { todayString, todayFilePath };
