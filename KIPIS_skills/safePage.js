// Structural enforcement of RULES.md Rule 1: the machine never presses "Pateikti".
//
// A prompt cannot constrain generated code, so the block lives in the page itself: a
// capture-phase click listener cancels any click on a clickable element labelled "Pateikti",
// no matter which code path issued it (page.click, locator.click, evaluate, generated
// workflow modules). Saugoti and everything before it are untouched.

// Runs inside the browser. Must be self-contained — it is serialised to the page.
function guardScript() {
  // Flag <html>, not window or document. `window` survives navigation and `document` survives
  // document.write(), but both wipe listeners — flagging either makes the guard silently stop
  // re-binding. documentElement is replaced whenever listeners are lost, so the flag tracks
  // exactly what we care about.
  const root = document.documentElement;
  if (root && root.__kipisPateiktiGuard) return;
  if (root) root.__kipisPateiktiGuard = true;
  if (typeof window.__kipisPateiktiBlocked !== 'number') window.__kipisPateiktiBlocked = 0;

  // Word-boundary match: "Pateikti" (the button) but not statuses like "PATEIKTAS".
  const PATEIKTI = /\bpateikti\b/i;

  function ownLabel(el) {
    if (!el) return '';
    const value = el.value || '';
    // <input> carries its label in value; button/a carry it in text.
    const text = el.tagName === 'INPUT' ? '' : (el.textContent || '');
    return (value + ' ' + text).replace(/\s+/g, ' ').trim();
  }

  document.addEventListener('click', function (e) {
    const el = e.target && e.target.closest
      ? e.target.closest('input[type="submit"], input[type="button"], button, a')
      : null;
    if (!el || !PATEIKTI.test(ownLabel(el))) return;

    e.preventDefault();
    e.stopImmediatePropagation();
    window.__kipisPateiktiBlocked++;
    console.warn('[PateiktiGuard] BLOCKED click on:', ownLabel(el));
  }, true);
}

// Installs the guard on a page and keeps it installed across navigations.
async function installPateiktiGuard(page) {
  await page.addInitScript(guardScript);      // every future navigation
  try { await page.evaluate(guardScript); } catch { /* page may be blank */ }
  page.on('load', () => { page.evaluate(guardScript).catch(() => {}); });
  console.log('[PateiktiGuard] installed — Pateikti clicks are blocked (RULES.md Rule 1).');
}

// How many Pateikti clicks the guard has blocked on the current document.
async function pateiktiBlockedCount(page) {
  try { return await page.evaluate(() => window.__kipisPateiktiBlocked || 0); } catch { return 0; }
}

// Throws if a locator resolves to a Pateikti control — use before deliberate clicks.
async function assertNotPateikti(locator) {
  const label = await locator.evaluate(el => {
    const value = el.value || '';
    const text  = el.tagName === 'INPUT' ? '' : (el.textContent || '');
    return (value + ' ' + text).replace(/\s+/g, ' ').trim();
  }).catch(() => '');
  if (/\bpateikti\b/i.test(label)) {
    throw new Error(`RULES.md Rule 1: refusing to click "${label}" — Pateikti is human-only.`);
  }
}

module.exports = { installPateiktiGuard, pateiktiBlockedCount, assertNotPateikti };
