const fs   = require('fs');
const path = require('path');

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL      = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const RULES_PATH = path.resolve(__dirname, '../RULES.md');

// RULES.md is prepended to every check so the model always operates under the hard rules.
function loadRules() {
  try { return fs.readFileSync(RULES_PATH, 'utf8'); } catch { return ''; }
}

// Snapshot every filled field currently on the PRK page, plus which action buttons exist.
async function captureFormState(page) {
  return page.evaluate(() => {
    const fields = [];
    for (const el of document.querySelectorAll('input, select, textarea')) {
      const type = (el.getAttribute('type') || el.tagName).toLowerCase();
      if (type === 'hidden') continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;

      // Nearest readable label: explicit <label>, else preceding cell text
      let label = el.getAttribute('aria-label') || '';
      if (!label && el.id) label = document.querySelector(`label[for="${el.id}"]`)?.textContent?.trim() || '';
      if (!label) {
        const cell = el.closest('td, th');
        let prev = cell?.previousElementSibling;
        while (prev && !label) {
          const t = prev.textContent.replace(/\s+/g, ' ').trim();
          if (t && !prev.querySelector('input, select, textarea')) label = t;
          prev = prev.previousElementSibling;
        }
      }

      const value = el.tagName === 'SELECT'
        ? (el.selectedOptions[0]?.textContent?.trim() || '')
        : (type === 'checkbox' || type === 'radio' ? String(el.checked) : (el.value || ''));

      if (!label && !value) continue;
      fields.push({ label: label.slice(0, 60), name: el.name || '', type, value: String(value).slice(0, 120) });
    }

    const buttons = [...document.querySelectorAll('input[type="submit"], input[type="button"], button')]
      .map(b => (b.value || b.textContent || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean);

    return { fields, buttons };
  });
}

const SYSTEM_PROMPT = `You verify that a KIPIS "Prašymas krovai" (PRK) loading-request form has been filled correctly, BEFORE the Saugoti (save draft) button is pressed.

You are given the expected order data and a snapshot of every visible field currently on the form.

Check that:
- The truck plate(s) appear in the original-document-number field.
- The cargo/weight figures are consistent with the expected order (gross weight = order weight + number of bags; bags = order weight / bagKg, the bag size in kg).
- The payer code and name are filled.
- The loading instructions field matches the expected instructions (empty is correct for BULK cargo with no match).
- No required field that the expected data provides was left empty.

Do NOT demand values the expected data does not contain. Ignore cosmetic differences in spacing or letter case.

Return a JSON object:
{ "ok": <bool>, "issues": [ { "field": string, "expected": string, "found": string, "severity": "high"|"low" } ], "summary": string }
ok = true only when there are no "high" severity issues.`;

// Verifies the PRK form is correctly completed up to (not including) Saugoti.
// mainTabFields: the main tab's snapshot, taken before the Kroviniai tab was opened — once it is,
// the main tab's fields are hidden and captureFormState skips them, so the model would report
// plate, payer and instructions as empty (seen live 2026-11-09).
// Returns { ok, issues, summary } — or { ok:null, summary } when the check could not run.
async function checkPrkCompletion(page, expected, mainTabFields = []) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return { ok: null, issues: [], summary: 'OPENAI_API_KEY not set — PRK check skipped' };

  const current = await captureFormState(page);
  const state   = { fields: [...mainTabFields, ...current.fields], buttons: current.buttons };

  // A network failure or malformed reply means "check unavailable" (ok:null), not a crashed run —
  // the caller then relies on the deterministic read-back alone (ROADMAP D2).
  let parsed;
  try {
    const resp = await fetch(OPENAI_URL, {
      method:  'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model:           MODEL,
        temperature:     0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: `${loadRules()}\n\n---\n\n${SYSTEM_PROMPT}` },
          { role: 'user',   content:
              'Expected order data:\n' + JSON.stringify(expected, null, 1) +
              '\n\nForm fields (the main tab, then the Kroviniai tab):\n' + JSON.stringify(state.fields, null, 1) +
              '\n\nButtons present:\n' + JSON.stringify(state.buttons) },
        ],
      }),
    });
    if (!resp.ok) return { ok: null, issues: [], summary: `OpenAI API ${resp.status} — PRK check failed` };
    const data = await resp.json();
    parsed = JSON.parse(data.choices?.[0]?.message?.content || '{}');
  } catch (err) {
    return { ok: null, issues: [], summary: `AI check unavailable — ${err.message}` };
  }

  return {
    ok:      typeof parsed.ok === 'boolean' ? parsed.ok : null,
    issues:  Array.isArray(parsed.issues) ? parsed.issues : [],
    summary: parsed.summary || '',
  };
}

const normText = s => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
const normNum  = s => Number(String(s ?? '').replace(/\s/g, '').replace(',', '.'));

// Deterministic read-back: reads each field straight from the form and compares it exactly with
// the value that was filled. Catches what the AI check cannot be trusted with — a field a JSF
// re-render wiped (e.g. after adding a transport row), or a fill that never took — and still works
// when OpenAI is down.
// checks: [{ field, locator, expected, kind: 'value' | 'number' | 'checked' | 'present' }]
async function readBackIssues(checks) {
  const issues = [];
  for (const { field, locator, expected, kind = 'value' } of checks) {
    const count = await locator.count();
    if (kind === 'present') {
      if (count === 0) issues.push({ field, expected: String(expected), found: '(not on the page)', severity: 'high' });
      continue;
    }
    if (count !== 1) {
      issues.push({ field, expected: String(expected), found: count ? `(${count} matching fields)` : '(field not found)', severity: 'high' });
      continue;
    }
    if (kind === 'checked') {
      const checked = await locator.isChecked();
      if (checked !== expected) issues.push({ field, expected: String(expected), found: String(checked), severity: 'high' });
      continue;
    }
    const found = await locator.inputValue();
    const same  = kind === 'number' ? normNum(found) === normNum(expected) : normText(found) === normText(expected);
    if (!same) issues.push({ field, expected: String(expected), found, severity: 'high' });
  }
  return issues;
}

module.exports = { checkPrkCompletion, captureFormState, readBackIssues };
