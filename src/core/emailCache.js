const fs   = require('fs');
const path = require('path');
const { todayString } = require('./dateManager');

function cachePath() {
  return path.resolve(__dirname, '../../data/email_cache_' + todayString() + '.json');
}

function loadCache() {
  const p = cachePath();
  if (!fs.existsSync(p)) return {};
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
}

function saveEmailData(plate, data) {
  const cache = loadCache();
  cache[plate] = data;
  fs.writeFileSync(cachePath(), JSON.stringify(cache));
}

function getEmailData(plate) {
  return loadCache()[plate] || null;
}

module.exports = { saveEmailData, getEmailData };
