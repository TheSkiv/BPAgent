const fs   = require('fs');
const path = require('path');
const { todayString } = require('./dateManager');

function donePath() {
  return path.resolve(__dirname, '../../data/done_' + todayString() + '.json');
}

function loadDone() {
  const p = donePath();
  if (!fs.existsSync(p)) return new Set();
  return new Set(JSON.parse(fs.readFileSync(p)));
}

function normalizePlate(str) {
  return str.replace(/[\s/\\]+/g, '').toLowerCase();
}

function markDone(plate) {
  const done = loadDone();
  normalizePlate(plate).split('').length; // just normalize
  done.add(normalizePlate(plate));
  fs.writeFileSync(donePath(), JSON.stringify([...done]));
}

function unmarkDone(plate) {
  const done = loadDone();
  done.delete(normalizePlate(plate));
  fs.writeFileSync(donePath(), JSON.stringify([...done]));
}

function isDone(plate) {
  return loadDone().has(normalizePlate(plate));
}

module.exports = { markDone, unmarkDone, isDone, loadDone, normalizePlate };
