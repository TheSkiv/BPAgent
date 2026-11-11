const fs   = require('fs');
const path = require('path');
const { todayString } = require('./dateManager');

// date (YYYY-MM-DD): an earlier day's cache — an order from yesterday keeps its email there.
function cachePath(date) {
  return path.resolve(__dirname, '../../data/email_cache_' + (date || todayString()) + '.json');
}

function loadCache(date) {
  const p = cachePath(date);
  if (!fs.existsSync(p)) return {};
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
}

function saveEmailData(plate, data) {
  const cache = loadCache();
  cache[plate] = data;
  fs.writeFileSync(cachePath(), JSON.stringify(cache));
}

function getEmailData(plate, date) {
  return loadCache(date)[plate] || null;
}

module.exports = { saveEmailData, getEmailData };
