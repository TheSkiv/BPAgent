// Structural enforcement of RULES.md Rule 1: the machine never presses "Pateikti".
//
// A prompt cannot constrain generated code, so the block lives in the page itself: a
// capture-phase click listener cancels any click on a clickable element labelled "Pateikti",
// no matter which code path issued it (page.click, locator.click, evaluate, generated
// workflow modules). Saugoti and everything before it are untouched.
//
// The page cannot tell a Playwright click from the operator's (both are trusted input events),
// so the guard is ARMED ONLY WHILE AUTOMATION DRIVES THE PAGE: withAutomation() sets a flag in
// the tab's sessionStorage (it survives the run's same-origin navigations) and clears it after.
// Outside a run the operator can press Pateikti in this window (operator, 2026-11-10 — the
// always-on guard blocked the human too). If the flag cannot be read, the guard stays armed.

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

  // The operator's last click / keypress in this window (not automation's: those happen while
  // armed). Automatic jobs skip their turn while the operator is working here (ROADMAP A18).
  const noteHuman = function () {
    try {
      if (window.sessionStorage.getItem('__kipisAutomation') !== '1') window.sessionStorage.setItem('__kipisHumanAt', String(Date.now()));
    } catch { /* storage unavailable */ }
  };
  document.addEventListener('mousedown', noteHuman, true);
  document.addEventListener('keydown', noteHuman, true);

  document.addEventListener('click', function (e) {
    const el = e.target && e.target.closest
      ? e.target.closest('input[type="submit"], input[type="button"], button, a')
      : null;
    if (!el || !PATEIKTI.test(ownLabel(el))) return;

    let armed = true;
    try { armed = window.sessionStorage.getItem('__kipisAutomation') === '1'; } catch { armed = true; }
    if (!armed) return;   // no automation running: this is the operator's click

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
  console.log('[PateiktiGuard] installed — Pateikti is blocked while automation drives the page (RULES.md Rule 1).');
}

async function setAutomation(page, on) {
  await page.evaluate(v => {
    try { if (v) window.sessionStorage.setItem('__kipisAutomation', '1'); else window.sessionStorage.removeItem('__kipisAutomation'); } catch { /* guard stays armed */ }
  }, on);
}

// Runs fn with the Pateikti guard armed. Call it after any navigation to another origin (e.g.
// the login page): sessionStorage is per origin.
async function withAutomation(page, fn) {
  await setAutomation(page, true);
  try {
    return await fn();
  } finally {
    await setAutomation(page, false).catch(() => {});
  }
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

// Whether the operator clicked or typed in the KIPIS window within the last `ms` — an automatic
// job then waits, rather than pull the page away mid-review. Unknown → treated as active.
async function operatorActiveWithin(page, ms) {
  try {
    const at = await page.evaluate(() => Number(window.sessionStorage.getItem('__kipisHumanAt')) || 0);
    return Date.now() - at < ms;
  } catch {
    return true;
  }
}

module.exports = { installPateiktiGuard, pateiktiBlockedCount, assertNotPateikti, withAutomation, setAutomation, operatorActiveWithin };
