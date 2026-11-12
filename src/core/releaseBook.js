// Our own table of releases (owner, 2026-11-12: "start tracking releases from HELM … we need our own
// table of releases"). Helm announces each release by email — subject "Release 293226", from
// @helmag.com, a fixed bilingual text: CUSTOMER NAME, RELEASE - NR, Quantity (mt), PRODUCT, "In 600 kg
// bb" (absent for bulk), From (date), Product Origin — but no vessel. A new release (Baltic Fert's
// 293226 MAP 11-52) is in the email a day before it reaches Helm's list on the stock server, and a
// buyer that is in no list cannot be set up on the Lots page. So the emails are read into
// config/releases.json; the operator can add a release by hand and set its vessel. owners.js merges
// these with the stock server's list, which stays the authority for what is left when it has them.
const fs   = require('fs');
const path = require('path');

const BOOK_PATH = path.resolve(__dirname, '../../config/releases.json');
const DATA_DIR  = process.env.DATA_DIR || path.resolve(__dirname, '../../data');

// Sellers whose release emails are read, by the sender's domain.
const RELEASE_SENDERS = [{ seller: 'Helm', domain: 'helmag.com' }];

function load() {
  try { return JSON.parse(fs.readFileSync(BOOK_PATH, 'utf8')); } catch { return { releases: {} }; }
}
function save(book) {
  fs.writeFileSync(BOOK_PATH, JSON.stringify(book, null, 1) + '\n');
}
const list = () => Object.values(load().releases);

const senderAddress = from => (String(from || '').match(/<([^>]+)>/) || [, from || ''])[1].trim().toLowerCase();

// The seller whose release this email announces, or null. Only "Release <number>" itself — replies
// ("RE: Release …") and clients' truck orders ("Release 293226 MAP 11-52") are not announcements.
function releaseSeller(email) {
  if (!/^\s*Release\s+\d[\d-]*\s*$/i.test(email.subject || '')) return null;
  const domain = senderAddress(email.from).split('@')[1] || '';
  return (RELEASE_SENDERS.find(s => domain === s.domain || domain.endsWith('.' + s.domain)) || {}).seller || null;
}

// "216 mt" / "2301,6 mt" → kg
const tonnesToKg = s => Math.round(parseFloat(String(s || '').replace(/\s/g, '').replace(',', '.')) * 1000) || 0;
// "12.11.2026" → "2026-11-12"
const isoDate = s => { const m = String(s || '').match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/); return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : ''; };

// The release from the email text, or null when the text does not have the fixed fields.
function parseRelease(email, seller) {
  const lines = String(email.body || '').split(/\r?\n/).map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const field = re => { const l = lines.find(x => re.test(x)); return l ? l.replace(re, '').trim() : ''; };
  const nr = field(/^RELEASE\s*-?\s*NR:\s*/i) || field(/^Release-Nr:\s*/i) || (String(email.subject).match(/(\d[\d-]*)/) || [])[1];
  const buyer = field(/^CUSTOMER NAME:\s*/i);
  const product = field(/^PRODUCT:\s*/i);
  const quantityKg = tonnesToKg(field(/^Quantity:\s*/i));
  if (!nr || !buyer || !product || !quantityKg) return null;
  const packingLine = lines.find(l => /^In \d{3,4}\s*kg\s*bb/i.test(l)) || '';
  return {
    nr, seller, buyer, product, quantityKg,
    packing: packingLine ? packingLine.replace(/^In\s*/i, '') : 'bulk',
    bulk: !packingLine,
    origin: field(/^Product Origin:\s*/i),
    from: isoDate(field(/^From:\s*/i)),
  };
}

// Reads a release email into the book. Keeps what the operator set (vessel). Returns the release
// or null when the email is not a release announcement from a known seller.
function fromEmail(email) {
  const seller = releaseSeller(email);
  if (!seller) return null;
  const parsed = parseRelease(email, seller);
  if (!parsed) { console.warn(`Release email "${email.subject}" from ${senderAddress(email.from)}: the fields were not found — not recorded`); return null; }
  const book = load();
  const old = book.releases[parsed.nr] || {};
  book.releases[parsed.nr] = {
    ...old, ...parsed,
    vessel: old.vessel || '',
    source: { kind: 'email', from: senderAddress(email.from), subject: email.subject, date: email.date ? new Date(email.date).toISOString() : '', messageId: email.id || '' },
    addedAt: old.addedAt || new Date().toISOString(),
  };
  save(book);
  console.log(`Release ${parsed.nr} recorded from ${seller}'s email: ${parsed.buyer}, ${parsed.product}, ${parsed.quantityKg / 1000} t${parsed.bulk ? ' bulk' : ''}`);
  return book.releases[parsed.nr];
}

// Added or changed by hand on the Lots page.
function saveRelease({ nr, seller, buyer, product, quantityKg, bulk, vessel }) {
  nr = String(nr || '').trim();
  if (!/^\d[\d-]{3,}$/.test(nr)) throw new Error('A release number is digits, e.g. 293226');
  const book = load();
  const old = book.releases[nr] || {};
  const r = {
    ...old, nr,
    seller: String(seller ?? old.seller ?? '').trim(),
    buyer: String(buyer ?? old.buyer ?? '').trim(),
    product: String(product ?? old.product ?? '').trim(),
    quantityKg: quantityKg !== undefined ? Math.round(Number(quantityKg)) : old.quantityKg,
    bulk: bulk !== undefined ? !!bulk : !!old.bulk,
    vessel: String(vessel ?? old.vessel ?? '').trim(),
    source: old.source || { kind: 'by hand' },
    addedAt: old.addedAt || new Date().toISOString(),
  };
  if (!r.seller || !r.buyer || !r.product || !(r.quantityKg > 0)) throw new Error('Seller, buyer, product and quantity are needed');
  book.releases[nr] = r;
  save(book);
  return r;
}

function removeRelease(nr) {
  const book = load();
  delete book.releases[String(nr)];
  save(book);
}

// Gross kg PortSystem filed against a release (orders that recorded its number), last 90 days —
// for a release the stock server does not list yet, what is left = quantity − this.
let usedCache = { at: 0, map: new Map() };
function usedKg(nr) {
  if (Date.now() - usedCache.at > 60 * 1000) {
    const map = new Map();
    let files = [];
    try { files = fs.readdirSync(DATA_DIR).filter(f => /^orders_state_\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().slice(-90); } catch { /* none */ }
    for (const f of files) {
      let orders = [];
      try { orders = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8')).orders || []; } catch { continue; }
      for (const o of orders) {
        const n = o.loadsFrom?.releaseNo;
        if (!n || o.state === 'cancelled' || !o.docs?.PRK?.number) continue;
        map.set(n, (map.get(n) || 0) + (Number(o.loadsFrom.grossKg) || 0));
      }
    }
    usedCache = { at: Date.now(), map };
  }
  return usedCache.map.get(String(nr)) || 0;
}

module.exports = { list, fromEmail, releaseSeller, parseRelease, saveRelease, removeRelease, usedKg, BOOK_PATH };
