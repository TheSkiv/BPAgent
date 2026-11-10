const fs   = require('fs');
const path = require('path');
const http = require('http');
const { sameCargo } = require('./stockCache');

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

// Every seller's release rows: { seller, buyer, product, vessel, remainingKg, bulk }.
// All-or-nothing, like the stock reports: a missing seller would make its buyers look release-less.
async function fetchReleases() {
  if (_releases && Date.now() - _releasesAt < RELEASES_TTL_MS) return _releases;
  const { sellers } = loadConfig();
  const lists = await Promise.all(sellers.filter(s => s.releases).map(async s => {
    const raw  = await fetchJson(s.releases);
    const rows = Array.isArray(raw.data) ? raw.data : Array.isArray(raw.rows) ? raw.rows : [];
    if (rows.length < 2) return [];
    const [headers, ...rest] = rows;
    const col = name => headers.findIndex(h => String(h).trim().toLowerCase() === name.toLowerCase());
    const c = { buyer: col('Gavėjas'), product: col('Produktas'), vessel: col('Laivas'), netto: col('Likutis Netto'), bags: headers.findIndex(h => /^likutis (b\.b\.|vnt\.)$/i.test(String(h).trim())) };
    return rest
      .map(r => ({
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
const words = s => (String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().match(/[a-z]{3,}/g) || []);

// An order's cargo vs a release's product. Releases use short names ("AXAN N27-4", "TSP 46") that
// the order's longer name contains, so the words may match either way — guarded by the NPK
// formula: when either side has one, both must.
function releaseMatches(orderCargo, product) {
  if (sameCargo(orderCargo, product)) return true;
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

// Where an order loads from. Returns { owner, vessels, source, note } or { stop }.
// ownLotsOf(company, cargo) → [{ vessel }] from the lot registry (self-loaders' own lots).
async function resolveOrder({ company, cargo, grossKg }, ownLotsOf) {
  if (!company) return { stop: 'the order has no company — name the sender on the dashboard' };

  let releases = [];
  try { releases = await fetchReleases(); } catch (err) { return { stop: `release lists unreachable (${err.message})` }; }

  const { buyer } = buyerFor(company, releases);
  if (buyer) {
    const mine = releases.filter(r => r.buyer === buyer && releaseMatches(cargo, r.product));
    const open = mine.filter(r => r.remainingKg >= grossKg * 0.9);   // net vs gross: bags add ~0.2 %
    if (open.length) {
      const sellers = [...new Set(open.map(r => r.seller))];
      if (sellers.length > 1) return { stop: `${company} has ${cargo} releases from ${sellers.join(' and ')} — set which one on the Lots page` };
      const vessels = [...new Set(open.map(r => r.vessel))];
      return { owner: sellers[0], vessels, source: 'release', note: `${buyer}'s ${sellers[0]} release on ${vessels.join(', ')} (${open.map(r => Math.round(r.remainingKg / 1000) + ' t').join(', ')} left)` };
    }
    if (mine.length && !isSelfLoader(company)) {
      return { stop: `${buyer}'s release for ${cargo} has less than one truck left (${mine.map(r => `${r.vessel} ${Math.round(r.remainingKg / 1000)} t`).join(', ')})` };
    }
  }

  if (isSelfLoader(company)) {
    const vessels = [...new Set(ownLotsOf(company, cargo).map(l => l.vessel))];
    if (!vessels.length) return { stop: `${company} loads its own cargo, but no lot of ${cargo} is marked as theirs — set it on the Lots page` };
    return { owner: company, vessels, source: 'own', note: `${company}'s own cargo on ${vessels.join(', ')}` };
  }

  return { stop: buyer
    ? `no release for ${buyer} covers ${cargo}`
    : `${company} matches no buyer in the Helm/Yara release lists — set who it loads for on the Lots page` };
}

function setCompany(company, { buyer, selfLoader }) {
  company = String(company || '').trim();
  if (!company) throw new Error('Missing company');
  const c = loadConfig();
  c.companies[company] = { buyer: String(buyer || '').trim(), selfLoader: !!selfLoader };
  if (!c.companies[company].buyer && !c.companies[company].selfLoader) delete c.companies[company];
  saveConfig(c);
  return c.companies[company] || null;
}

module.exports = { loadConfig, fetchReleases, resolveOrder, buyerFor, isSelfLoader, setCompany, releaseMatches, sameCompany };
