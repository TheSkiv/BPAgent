// CMRs printed by PortSystem instead of Avilda (ROADMAP S28, owner 2026-11-11). This module fills a
// CMR for an order — every box pre-filled for the operator to check and change before printing —
// remembers what the operator confirmed (per release; per company for own cargo), keeps the
// register of issued CMRs, and draws the PDF (cmrPdf.js). Data:
//   config/cmr.json            settings, sender per seller, per-release parties, customs codes
//   data/cmr_register.jsonl    one line per printed CMR (with everything printed on it)
const fs   = require('fs');
const path = require('path');
const owners          = require('./owners');
const senderCompanies = require('./senderCompanies');
const releaseStamp    = require('./releaseStamp');
const dispatchEmail   = require('./dispatchEmail');
const { terminalFor } = require('./terminals');
const { todayString } = require('./dateManager');
const { buildCmr }    = require('./cmrPdf');

const CONFIG_PATH   = path.resolve(__dirname, '../../config/cmr.json');
const REGISTER_PATH = path.resolve(__dirname, '../../data/cmr_register.jsonl');

const loadConfig = () => JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const saveConfig = c => fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2) + '\n');
const four = a => [...(a || []), '', '', '', ''].slice(0, 4);

function register() {
  try {
    return fs.readFileSync(REGISTER_PATH, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch { return []; }
}

// "B" + MMDD + a two-digit series for the day: B111101, B111102, … (the owner: any number will
// do — "initials of the person, date and a series number").
function nextNumber(prefix) {
  const d = todayString();
  const stem = `${prefix}${d.slice(5, 7)}${d.slice(8, 10)}`;
  const used = register().filter(r => String(r.number || '').startsWith(stem)).length;
  return `${stem}${String(used + 1).padStart(2, '0')}`;
}

// The customs code for a cargo: the saved name it matches (exact, else the release rule —
// NPK formula and words), e.g. "NPK(S) 10-13-25 (9)+Mg+Bor (YARA, FI)" → "YaraMila NPK 10-13-25".
function hsCodeFor(cargo, codes) {
  const name = dispatchEmail.cargoName(cargo).toLowerCase();
  const exact = Object.keys(codes).find(k => k.toLowerCase() === name);
  if (exact) return codes[exact];
  const hit = Object.keys(codes).find(k => owners.releaseMatches(cargo, k));
  return hit ? codes[hit] : '';
}

// "Iškrovimo vieta: Mauručiai, Šilėnų g.4, …" — the delivery place as Agrokoncernas writes it
// (in the email for new farmers, on their važtaraštis otherwise). Returns '' when none.
function deliveryFromText(text) {
  const m = String(text || '').match(/(?:I[sš]krovimo vieta|Pristatymo (?:vieta|adresas)|Iškrovimo adresas|Pristatyti)\s*[:\-]\s*([^\n]+)/i);
  return m ? m[1].replace(/[,\s]+$/, '').trim() : '';
}

// Everything a CMR for this order needs, pre-filled. releaseId picks one release when the order
// could be on several; extraText: the email body and attached PDFs' text, for the address.
async function draftFor(order, { releaseId, date, extraText = '' } = {}) {
  const c = loadConfig();
  const fileDate = date || todayString();
  const company = senderCompanies.deriveCompany(order.email?.from || '');
  const { own, releases } = await releaseStamp.releasesFor(order).catch(() => ({ own: false, releases: [] }));
  const release = releases.find(r => r.id === releaseId) || (releases.length === 1 ? releases[0] : releases.find(r => r.remainingKg > 0) || releases[0] || null);

  // Saved parties: this release's, else the company's (own cargo / no release), else the
  // nearest: the same seller's sender, the same buyer's last release.
  const key = release ? release.id : `company:${company}`;
  const saved = (release ? c.releases[release.id] : c.companies[company]) || {};
  const sameBuyer = release && Object.entries(c.releases).find(([id, v]) => id !== release.id && v.buyer && v.buyer === releaseBuyer(release));
  const seller = release ? release.seller : '';
  const sender = saved.sender || (seller && c.sellers[seller]?.sender) || (own ? c.companies[company]?.sender : null) || [];
  const consignee = saved.consignee || sameBuyer?.[1].consignee || [release ? releaseBuyer(release) : company, '', '', 'Lietuva'];
  const textDelivery = deliveryFromText(`${order.email?.subject || ''}\n${extraText}`);
  const delivery = (own && textDelivery) ? { place: textDelivery, address: '', extra: '' }
    : saved.delivery || sameBuyer?.[1].delivery || { place: textDelivery, address: '', extra: '' };

  const bagKg = require('../../KIPIS_skills/PRK/navigateToCargo').getBagKg(order.cargo);
  const net = Number(order.weight) || 0;
  const bags = !order.bulk && net ? Math.round(net / bagKg) : 0;
  const gross = Number(order.grossWeight) || (net ? net + bags : 0);
  const name = dispatchEmail.cargoName(order.cargo);
  const goods = order.bulk
    ? [`Birios trąšos ${name} (palaidas)`, net ? `Netto ${net} kg` : '']
    : [`${bags ? `${bags} big bags - ` : ''}trąšos ${name}`, net ? `Netto ${net} kg` : ''];

  const terminal = terminalFor({ vessel: order.loadsFrom?.vessel || release?.vessel || '', cargo: order.cargo });
  const loading = c.settings.loading[terminal] || { place: '', address: '' };
  const driver = (dispatchEmail.excelRow(fileDate, order.plateNorm) || {}).Driver || '';

  return {
    orderId: order.id, plate: order.plate, key, own, company, terminal,
    releases: releases.map(r => ({ id: r.id, text: r.text, vessel: r.vessel, remainingKg: r.remainingKg })),
    releaseId: release ? release.id : null,
    cmr: {
      number: nextNumber(c.settings.prefix || 'B'),
      sender: four(sender), consignee: four(consignee), carrier: four(saved.carrier),
      delivery: { place: delivery.place || '', address: delivery.address || '', extra: delivery.extra || '' },
      loading: { place: loading.place, address: loading.address, date: todayString() },
      reservations: c.settings.reservations, documents: release ? release.text : '',
      goods: goods.filter(Boolean).map((text, i) => ({ text, indent: i > 0 })),
      statNo: hsCodeFor(order.cargo, c.hsCodes || {}), grossKg: gross ? String(gross) : '',
      instructions: c.settings.instructions, establishedIn: c.settings.establishedIn, date: todayString(),
      driver, plates: String(order.plate || '').replace(/\/+/g, '/'),
    },
  };
}

function releaseBuyer(release) {
  return (release && release.buyer) || '';
}

// Print: draw the PDF, write the register line, and remember what the operator confirmed.
async function issue({ order, key, releaseId, terminal, cmr, remember = true }) {
  const pdf = await buildCmr(cmr);
  const entry = { at: new Date().toISOString(), number: cmr.number, orderId: order.id, plate: order.plate, terminal: terminal || null, bulk: !!order.bulk, releaseId: releaseId || null, consignee: cmr.consignee[0], delivery: cmr.delivery.place, goods: cmr.goods.map(g => g.text).join(' / '), grossKg: cmr.grossKg, cmr };
  fs.appendFileSync(REGISTER_PATH, JSON.stringify(entry) + '\n');
  if (remember) {
    const c = loadConfig();
    const parties = { sender: cmr.sender, consignee: cmr.consignee, delivery: cmr.delivery, carrier: cmr.carrier };
    const row = releaseId && (await owners.fetchReleases().catch(() => [])).find(r => r.numbers.map(n => n.value).join('|') === releaseId);
    if (key && key.startsWith('company:')) c.companies[key.slice(8)] = parties;
    else if (key) c.releases[key] = { ...(c.releases[key] || {}), ...parties, ...(row ? { buyer: row.buyer } : {}) };
    const seller = row && row.seller;
    if (seller && cmr.sender.some(Boolean)) c.sellers[seller] = { ...(c.sellers[seller] || {}), sender: cmr.sender };
    if (terminal && cmr.loading.place) c.settings.loading[terminal] = { place: cmr.loading.place, address: cmr.loading.address };
    const name = dispatchEmail.cargoName(order.cargo);
    if (name && cmr.statNo) c.hsCodes = { ...(c.hsCodes || {}), [name]: cmr.statNo };
    saveConfig(c);
  }
  return { pdf, entry };
}

// A printed CMR again, exactly as it was (from the register).
async function reprint(number) {
  const e = register().reverse().find(r => r.number === number);
  return e ? buildCmr(e.cmr) : null;
}

// The CMRs printed for one order, newest first.
const forOrder = orderId => register().filter(r => r.orderId === orderId).reverse();

// How many paper copies (owner, 2026-11-11): CMR — Ro-Ro 5, KKT 1 (our archive; KKT gets it by
// email); PRK — 1 for our archive, 2 for bulk (one goes to the driver).
const copiesOf = ({ terminal, bulk }) => ({ cmr: terminal === 'kkt' ? 1 : 5, prk: bulk ? 2 : 1 });

// One PDF to print in one go: the CMR × its copies, then the PRK × its copies.
async function printPack(parts) {
  const { PDFDocument } = require('pdf-lib');
  const out = await PDFDocument.create();
  for (const { buffer, copies } of parts) {
    if (!buffer || !copies) continue;
    const src = await PDFDocument.load(buffer);
    for (let i = 0; i < copies; i++) for (const p of await out.copyPages(src, src.getPageIndices())) out.addPage(p);
  }
  return Buffer.from(await out.save());
}

module.exports = { draftFor, issue, reprint, register, forOrder, copiesOf, printPack, deliveryFromText, hsCodeFor };
