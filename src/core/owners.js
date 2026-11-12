const fs   = require('fs');
const path = require('path');
const http = require('http');
const { sameCargo, matchingRows, fetchStockRows } = require('./stockCache');

// Whose cargo an order loads (operator, 2026-11-10). KIPIS does not show ownership, and one
// vessel's cargo can belong to several owners in separate lots:
//   - sellers (Helm, Yara) publish stock reports and releases (Helm "release'ai", Yara
//     "perdavimai") naming each buyer, product, vessel and what is left on the release;
//   - buyers (Linas Agro, Baltic Agro, …) order trucks against a seller's release;
//   - self-loaders (Agrokoncernas) also load their own cargo, which is in no report we see.
// An order's company is matched to a release buyer; a release gives the seller and the vessel.
// No release → a self-loader loads its own lots. Anything else stops and asks on the Lots page.

const CONFIG_PATH = path.resolve(__dirname, '../../config/owners.json');
const RELEASES_TTL_MS = 5 * 60 * 1000;

const DEFAULT_CONFIG = {
  sellers: [
    { name: 'Helm', stockReport: 'Helm AG', releases: 'http://192.168.1.146:3000/api/stock_helm_sheet4' },
    { name: 'Yara', stockReport: 'GBL',     releases: 'http://192.168.1.146:3000/api/stock_gbl_sheet4' },
  ],
  // company (as the dashboard names it) → { buyer: release "Gavėjas" name, selfLoader: bool }
  companies: {},
};

function loadConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return { sellers: Array.isArray(c.sellers) ? c.sellers : DEFAULT_CONFIG.sellers, companies: c.companies || {} };
  } catch {
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }
}

function saveConfig(c) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 1));
}

// "Linas Agro, AB" / "UAB Baltic Agro" / "Balticagrolt" → comparable keys without legal forms.
function companyKey(s) {
  return String(s || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\b(uab|ab|ltd|lt|as|sia|ou|oy|gmbh)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
}

const sameCompany = (a, b) => {
  const x = companyKey(a), y = companyKey(b);
  return x.length >= 4 && y.length >= 4 && (x.startsWith(y) || y.startsWith(x));
};

const parseKg = v => parseFloat(String(v || 0).replace(/,/g, '')) || 0;

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject).setTimeout(15000, function () { this.destroy(new Error('timeout')); });
  });
}

let _releases = null, _releasesAt = 0;

// Every seller's release rows: { numbers, seller, buyer, product, vessel, remainingKg, bulk }.
// All-or-nothing, like the stock reports: a missing seller would make its buyers look release-less.
async function fetchReleases() {
  return [...await fetchListedReleases(), ...bookReleases(_releases || [])];
}

// Our own release book (releaseBook.js, from Helm's release emails and the Lots page) — a release
// the stock server's list does not have yet. What is left = its quantity − PortSystem's PRKs on it.
// A release with no vessel (the emails name none) gets it from the seller's stock report when
// filing (resolveOrder).
function bookReleases(listed) {
  const { list, usedKg } = require('./releaseBook');
  const known = new Set(listed.flatMap(r => r.numbers.map(n => n.value)));
  return list().filter(b => !known.has(b.nr)).map(b => ({
    numbers: [{ label: 'Release', value: b.nr }],
    seller: b.seller, buyer: b.buyer, product: b.product, vessel: b.vessel || '',
    remainingKg: Math.max(0, (b.quantityKg || 0) - usedKg(b.nr)),
    bulk: !!b.bulk, fromBook: true, quantityKg: b.quantityKg, from: b.from || '', source: b.source?.kind || '',
  }));
}

async function fetchListedReleases() {
  if (_releases && Date.now() - _releasesAt < RELEASES_TTL_MS) return _releases;
  const { sellers } = loadConfig();
  const lists = await Promise.all(sellers.filter(s => s.releases).map(async s => {
    const raw  = await fetchJson(s.releases);
    const rows = Array.isArray(raw.data) ? raw.data : Array.isArray(raw.rows) ? raw.rows : [];
    if (rows.length < 2) return [];
    const [headers, ...rest] = rows;
    const col = name => headers.findIndex(h => String(h).trim().toLowerCase() === name.toLowerCase());
    const c = { buyer: col('Gavėjas'), product: col('Produktas'), vessel: col('Laivas'), netto: col('Likutis Netto'), bags: headers.findIndex(h => /^likutis (b\.b\.|vnt\.)$/i.test(String(h).trim())) };
    // The release's own numbers, printed on the waybill (owner, 2026-11-11): Helm has one
    // ("Release"); Yara has three (Invoice, Delivery, Contract) — all three are printed.
    const numberCols = ['Release', 'Invoice', 'Delivery', 'Contract'].map(label => ({ label, i: col(label) })).filter(n => n.i >= 0);
    return rest
      .map(r => ({
        numbers:     numberCols.map(n => ({ label: n.label, value: String(r[n.i] || '').trim() })).filter(n => n.value),
        seller:      s.name,
        buyer:       String(r[c.buyer] || '').trim(),
        product:     String(r[c.product] || '').trim(),
        // "EASTERN VANQUISH (08-02)" → the vessel name as KIPIS and the stock reports write it
        vessel:      String(r[c.vessel] || '').replace(/\(.*?\)/g, '').trim(),
        remainingKg: parseKg(r[c.netto]),
        bulk:        /bulk/i.test(String(r[c.bags] || '')),
      }))
      .filter(r => r.buyer && r.product && r.vessel);
  }));
  _releases = lists.flat();
  _releasesAt = Date.now();
  return _releases;
}

const formulaOf = s => (String(s || '').match(/\d{1,2}-\d{1,2}-\d{1,2}/) || [null])[0];
// Lithuanian case endings dropped from longer words, so "karbamido" (of urea), "karbamidu",
// "karbamidas" all compare as "karbamid" — MML743//SN216's "karbamido" missed Agrokoncernas' Helm
// urea release on 2026-11-12 and fell through to "own cargo".
const stem = w => (w.length >= 6 ? w.replace(/(iams|ioms|ams|oms|ims|ems|iai|ai|ei|ui|as|is|ys|us|os|es|o|a|u|e|i|y)$/, '') : w);
const words = s => (String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().match(/[a-z]{3,}/g) || []).map(stem);

// An order's cargo vs a release's product. Releases use short names ("AXAN N27-4", "TSP 46") that
// the order's longer name contains, so the words may match either way — guarded by the NPK
// formula: when either side has one, both must.
function releaseMatches(orderCargo, product) {
  if (sameCargo(orderCargo, product)) return true;
  // A 2-letter abbreviation ("Gran AS") drops out of the words and leaves "gran", which would
  // match "Granular urea" — such names match by synonym only (stockCache.wordsMatch, same rule).
  const abbrev = s => /\b(?!KG\b|PO\b)[A-Z]{2}\b/.test(String(s || ''));
  if (abbrev(orderCargo) || abbrev(product)) return false;
  const fa = formulaOf(orderCargo), fb = formulaOf(product);
  if ((fa || fb) && fa !== fb) return false;
  const a = words(orderCargo), b = words(product);
  const within = (x, y) => x.length > 0 && x.every(w => y.some(v => v.startsWith(w) || w.startsWith(v)));
  return within(b, a) || within(a, b);
}

// The release buyer an order company stands for: the operator's setting, else a name match.
function buyerFor(company, releases) {
  const set = loadConfig().companies[company];
  if (set && set.buyer) return { buyer: set.buyer, auto: false };
  const hit = releases.find(r => sameCompany(company, r.buyer));
  return hit ? { buyer: hit.buyer, auto: true } : { buyer: '', auto: false };
}

const isSelfLoader = company => !!(loadConfig().companies[company] || {}).selfLoader;
const sellerFor    = company => (loadConfig().companies[company] || {}).seller || '';
// The receiver's country to put on the PRK when KIPIS requires it and the lot leaves it empty
// (operator, 2026-11-10: Agrokoncernas's own loads → "Lietuva", nothing else of the receiver).
const receiverCountryFor = company => (loadConfig().companies[company] || {}).receiverCountry || '';

// One release line, as a stable key for "trucks already filed against it".
const releaseKey = r => [r.seller, r.buyer, r.vessel, r.product].join('|');

// Where an order loads from. Returns { owner, vessels, source, note, releases? } or { stop }.
// ownLotsOf(company, cargo) → [{ vessel }] from the lot registry (self-loaders' own lots).
// pendingKgFor(releaseKey) → gross kg of PortSystem drafts on that release not yet submitted and
// loaded (ROADMAP A7): the release list's "left" does not count them yet, so they are taken off
// before deciding a truck still fits.
async function resolveOrder({ company, cargo, grossKg }, ownLotsOf, pendingKgFor = () => 0) {
  if (!company) return { stop: 'the order has no company — name the sender on the dashboard' };

  let releases = [];
  try { releases = await fetchReleases(); } catch (err) { return { stop: `release lists unreachable (${err.message})` }; }

  const { buyer } = buyerFor(company, releases);
  if (buyer) {
    // One balance per seller+buyer+vessel+product: Linas Agro has two TSP lines on OSLO CARRIER 2
    // (one used up, one with 1 878 t) — our drafts must come off their sum once, not off each.
    const merged = new Map();
    let candidates = releases.filter(x => x.buyer === buyer && releaseMatches(cargo, x.product));
    // A release from our book without a vessel (Helm's emails name none): the vessels in the
    // seller's stock report that hold this cargo with at least a truck's worth.
    if (candidates.some(r => !r.vessel)) {
      let stockRows = [];
      try { stockRows = await fetchStockRows(); } catch (err) { return { stop: `stock reports unreachable (${err.message})` }; }
      candidates = candidates.flatMap(r => {
        if (r.vessel) return [r];
        const s = loadConfig().sellers.find(x => x.name === r.seller);
        const perVessel = new Map();
        for (const row of matchingRows(cargo, stockRows.filter(x => x.report === (s && s.stockReport)))) perVessel.set(row.vessel, (perVessel.get(row.vessel) || 0) + row.netto);
        const vessels = [...perVessel].filter(([, kg]) => kg >= grossKg * 0.9).map(([v]) => v);
        return vessels.map(vessel => ({ ...r, vessel }));
      });
      if (!candidates.length) return { stop: `${buyer}'s release for ${cargo} names no vessel and the seller's stock report has no ${cargo} with a truck left — set the vessel for the release on the Lots page` };
    }
    for (const r of candidates) {
      const k = releaseKey(r);
      if (merged.has(k)) merged.get(k).remainingKg += r.remainingKg;
      else merged.set(k, { ...r });
    }
    const mine = [...merged.values()];
    const left = r => r.remainingKg - pendingKgFor(releaseKey(r));
    const open = mine.filter(r => left(r) >= grossKg * 0.9);   // net vs gross: bags add ~0.2 %
    const show = r => `${r.vessel} ${Math.round(left(r) / 1000)} t left${pendingKgFor(releaseKey(r)) ? ` after ${Math.round(pendingKgFor(releaseKey(r)) / 1000)} t of our drafts` : ''}`;
    if (open.length) {
      const sellers = [...new Set(open.map(r => r.seller))];
      if (sellers.length > 1) return { stop: `${company} has ${cargo} releases from ${sellers.join(' and ')} — set which one on the Lots page` };
      const vessels = [...new Set(open.map(r => r.vessel))];
      return {
        owner: sellers[0], vessels, source: 'release',
        releases: open.map(r => ({ key: releaseKey(r), vessel: r.vessel, no: r.numbers?.[0]?.value || null })),
        note: `${buyer}'s ${sellers[0]} release (${open.map(show).join(', ')})`,
      };
    }
    if (mine.length && !isSelfLoader(company)) {
      return { stop: `${buyer}'s release for ${cargo} has less than one truck left (${mine.map(show).join(', ')})` };
    }
  }

  // Buys from a seller without a line of its own in the release list (operator, 2026-11-10:
  // Transwina buys from Helm): that seller's vessels holding this cargo, from its stock report.
  const seller = (loadConfig().companies[company] || {}).seller;
  if (seller) {
    const s = loadConfig().sellers.find(x => x.name === seller);
    let rows = [];
    try { rows = (await fetchStockRows()).filter(r => r.report === (s && s.stockReport)); } catch (err) { return { stop: `stock reports unreachable (${err.message})` }; }
    const perVessel = new Map();
    for (const r of matchingRows(cargo, rows)) perVessel.set(r.vessel, (perVessel.get(r.vessel) || 0) + r.netto);
    const vessels = [...perVessel].filter(([, kg]) => kg >= grossKg * 0.9).map(([v]) => v);
    if (vessels.length) return { owner: seller, vessels, source: 'seller', note: `${company} buys from ${seller}: ${[...perVessel].map(([v, kg]) => `${v} ${Math.round(kg / 1000)} t`).join(', ')}` };
    if (!isSelfLoader(company)) return { stop: `${company} buys from ${seller}, but ${seller}'s stock report has no ${cargo} with a truck left` };
  }

  if (isSelfLoader(company)) {
    const vessels = [...new Set(ownLotsOf(company, cargo).map(l => l.vessel))];
    if (!vessels.length) return { stop: `${company} loads its own cargo, but no lot of ${cargo} is marked as theirs — set it on the Lots page` };
    return { owner: company, vessels, source: 'own', note: `${company}'s own cargo on ${vessels.join(', ')}` };
  }

  return { stop: buyer
    ? `no release for ${buyer} covers ${cargo}`
    : `${company} matches no buyer in the Helm/Yara release lists — set who it buys from on the Lots page` };
}

function setCompany(company, { buyer, seller, selfLoader, receiverCountry }) {
  company = String(company || '').trim();
  if (!company) throw new Error('Missing company');
  const c = loadConfig();
  seller = String(seller || '').trim();
  if (seller && !c.sellers.some(s => s.name === seller)) throw new Error(`Unknown seller: ${seller}`);
  c.companies[company] = { buyer: String(buyer || '').trim(), seller, selfLoader: !!selfLoader, receiverCountry: String(receiverCountry || '').trim() };
  const e = c.companies[company];
  if (!e.buyer && !e.seller && !e.selfLoader && !e.receiverCountry) delete c.companies[company];
  saveConfig(c);
  return c.companies[company] || null;
}

module.exports = { loadConfig, fetchReleases, resolveOrder, releaseKey, buyerFor, sellerFor, receiverCountryFor, isSelfLoader, setCompany, releaseMatches, sameCompany };
