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
- The cargo/weight figures are consistent with the expected order (gross weight = order weight + number of bags; bags = weight / 600 for packaged cargo).
- The payer code and name are filled.
- The loading instructions field matches the expected instructions (empty is correct for BULK cargo with no match).
- No required field that the expected data provides was left empty.

Do NOT demand values the expected data does not contain. Ignore cosmetic differences in spacing or letter case.

Return a JSON object:
{ "ok": <bool>, "issues": [ { "field": string, "expected": string, "found": string, "severity": "high"|"low" } ], "summary": string }
ok = true only when there are no "high" severity issues.`;

// Verifies the PRK form is correctly completed up to (not including) Saugoti.
// Returns { ok, issues, summary } — or { ok:null, summary } when the check could not run.
async function checkPrkCompletion(page, expected) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return { ok: null, issues: [], summary: 'OPENAI_API_KEY not set — PRK check skipped' };

  const state = await captureFormState(page);

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
            '\n\nForm fields currently on the page:\n' + JSON.stringify(state.fields, null, 1) +
            '\n\nButtons present:\n' + JSON.stringify(state.buttons) },
      ],
    }),
  });

  if (!resp.ok) {
    return { ok: null, issues: [], summary: `OpenAI API ${resp.status} — PRK check failed` };
  }

  const data   = await resp.json();
  const parsed = JSON.parse(data.choices?.[0]?.message?.content || '{}');
  return {
    ok:      typeof parsed.ok === 'boolean' ? parsed.ok : null,
    issues:  Array.isArray(parsed.issues) ? parsed.issues : [],
    summary: parsed.summary || '',
  };
}

module.exports = { checkPrkCompletion, captureFormState };
