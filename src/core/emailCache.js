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

// An order's own email, found by its message id (the store is keyed by plate, so a later email for
// the same truck — an updated order table, a second trip — replaces the entry under its plate).
// Looks in the order's day and the days either side; null when none has it.
function findByMessageId(messageId, date) {
  if (!messageId) return null;
  const day = d => { const x = new Date(`${date}T12:00:00`); x.setDate(x.getDate() + d); return x.toISOString().slice(0, 10); };
  for (const d of date ? [date, day(-1), day(1)] : [undefined]) {
    const hit = Object.values(loadCache(d)).find(e => String(e.messageId) === String(messageId));
    if (hit) return hit;
  }
  return null;
}

module.exports = { saveEmailData, getEmailData, findByMessageId };
