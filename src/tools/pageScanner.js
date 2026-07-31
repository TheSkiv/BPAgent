const fs   = require('fs');
const path = require('path');
const { getPage } = require('../core/browser');

const MAPS_DIR = path.resolve(__dirname, '../../tools/maps');

async function scanCurrentPage(label) {
  if (!fs.existsSync(MAPS_DIR)) fs.mkdirSync(MAPS_DIR, { recursive: true });

  const page  = getPage();
  const url   = page.url();
  const title = await page.title();

  const raw = await page.evaluate(() => {
    // ── Label resolution ────────────────────────────────────────────────────
    function resolveLabel(el) {
      // 1. aria-label / aria-labelledby
      const al = el.getAttribute('aria-label');
      if (al && al.trim()) return al.trim();

      const alby = el.getAttribute('aria-labelledby');
      if (alby) {
        const target = document.getElementById(alby);
        if (target) return target.textContent.trim();
      }

      // 2. <label for="id">
      if (el.id) {
        try {
          const lbl = document.querySelector(`label[for="${el.id}"]`);
          if (lbl) return lbl.textContent.trim();
        } catch {}
      }

      // 3. Ancestor <label>
      const anc = el.closest('label');
      if (anc) {
        // Return text content minus the input value to avoid duplication
        return anc.textContent.replace(el.value || '', '').trim();
      }

      // 4. Table layout: previous <td>/<th> siblings in the same <tr>
      const td = el.closest('td, th');
      if (td) {
        let prev = td.previousElementSibling;
        while (prev) {
          const txt = prev.textContent.trim();
          if (txt && !prev.querySelector('input, select, textarea')) return txt;
          prev = prev.previousElementSibling;
        }
        // Fallback: first cell of this row
        const row = td.parentElement;
        if (row) {
          const first = row.querySelector('td, th');
          if (first && first !== td) {
            const txt = first.textContent.trim();
            if (txt) return txt;
          }
        }
      }

      // 5. placeholder / title
      if (el.placeholder) return `[placeholder] ${el.placeholder}`;
      if (el.title)       return `[title] ${el.title}`;

      // 6. Buttons: use value
      if ((el.type === 'button' || el.type === 'submit' || el.type === 'reset') && el.value)
        return el.value;

      return '';
    }

    // ── Section resolution ───────────────────────────────────────────────────
    function resolveSection(el) {
      let cur = el.parentElement;
      while (cur && cur !== document.body) {
        // fieldset > legend
        if (cur.tagName === 'FIELDSET') {
          const leg = cur.querySelector(':scope > legend');
          if (leg) return leg.textContent.trim();
        }
        // heading just before this element's block
        let prev = cur.previousElementSibling;
        while (prev) {
          if (/^H[1-6]$/.test(prev.tagName)) return prev.textContent.trim();
          // also accept <td class="...header...">
          if (/header|title|heading/i.test(prev.className) && !prev.querySelector('input, select, textarea'))
            return prev.textContent.trim();
          prev = prev.previousElementSibling;
        }
        // table caption
        if (cur.tagName === 'TABLE') {
          const cap = cur.querySelector('caption');
          if (cap) return cap.textContent.trim();
          // first <th colspan> row often acts as section header
          const firstTh = cur.querySelector('thead th[colspan], tr th[colspan]');
          if (firstTh) return firstTh.textContent.trim();
        }
        cur = cur.parentElement;
      }
      return '(page root)';
    }

    // ── Collect elements ─────────────────────────────────────────────────────
    const seen    = new Set();
    const results = [];

    const elems = Array.from(document.querySelectorAll(
      'input, select, textarea, button'
    ));

    for (const el of elems) {
      if (seen.has(el)) continue;
      seen.add(el);

      const tag     = el.tagName.toLowerCase();
      const type    = (el.getAttribute('type') || tag).toLowerCase();
      const rect    = el.getBoundingClientRect();
      const visible = rect.width > 0 && rect.height > 0 && el.offsetParent !== null;

      // options list for <select>
      let options = null;
      if (tag === 'select') {
        options = Array.from(el.options).map(o => ({
          value: o.value,
          text:  o.textContent.trim(),
          selected: o.selected,
        }));
      }

      results.push({
        tag,
        type,
        id:       el.id         || '',
        name:     el.name       || '',
        label:    resolveLabel(el),
        section:  resolveSection(el),
        value:    tag === 'select'   ? (el.selectedOptions[0]?.textContent?.trim() || '')
                : type === 'checkbox' || type === 'radio' ? String(el.checked)
                : (el.value || ''),
        options,
        visible,
        required:  el.required  || false,
        readonly:  el.readOnly  || false,
        disabled:  el.disabled  || false,
      });
    }

    return results;
  });

  // ── Group by section ───────────────────────────────────────────────────────
  const sections = {};
  for (const f of raw) {
    const sec = f.section || '(page root)';
    if (!sections[sec]) sections[sec] = [];
    sections[sec].push(f);
  }

  // ── Build Markdown ─────────────────────────────────────────────────────────
  const ts   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const slug = (label || 'scan').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  const filename = `${ts}_${slug}.md`;
  const filepath = path.join(MAPS_DIR, filename);

  const lines = [];
  lines.push(`# KIPIS Page Scan: ${label || title}`);
  lines.push('');
  lines.push(`**URL:** \`${url}\``);
  lines.push(`**Page title:** ${title}`);
  lines.push(`**Scanned:** ${new Date().toLocaleString('lt-LT')}`);
  lines.push(`**Total fields:** ${raw.length}`);
  lines.push('');

  for (const [section, fields] of Object.entries(sections)) {
    lines.push(`## ${section}`);
    lines.push('');
    lines.push('| # | Label | Tag/Type | ID | Name | Visible | Value / Options |');
    lines.push('|---|---|---|---|---|---|---|');

    fields.forEach((f, i) => {
      const tagType = f.tag === 'input' ? `input[${f.type}]` : f.tag;
      const valCell = f.options
        ? f.options.map(o => `${o.selected ? '▶' : ''}${o.text}`).join(', ').slice(0, 100)
        : f.value.slice(0, 80);
      const vis  = f.visible   ? 'yes'  : '**hidden**';
      const flag = [f.required ? 'required' : '', f.readonly ? 'readonly' : '', f.disabled ? 'disabled' : ''].filter(Boolean).join(', ');
      const label = f.label ? f.label.replace(/\|/g, '\\|').replace(/\n/g, ' ') : '—';
      const id    = f.id   ? `\`${f.id}\``   : '—';
      const name  = f.name ? `\`${f.name}\`` : '—';
      lines.push(`| ${i + 1} | ${label} | ${tagType}${flag ? ` *(${flag})*` : ''} | ${id} | ${name} | ${vis} | ${valCell || '—'} |`);
    });

    lines.push('');
  }

  const md = lines.join('\n');
  fs.writeFileSync(filepath, md, 'utf8');
  console.log(`[pageScanner] Saved: ${filepath} (${raw.length} fields, ${Object.keys(sections).length} sections)`);

  return {
    filename,
    filepath,
    url,
    title,
    fieldCount:   raw.length,
    sectionCount: Object.keys(sections).length,
    sections:     Object.keys(sections),
  };
}

// Finds all visible tab-like links on the current page, clicks each one,
// scans the resulting content, and saves a file per tab.
async function deepScanTabs(baseLabel) {
  const page = getPage();

  // Words that indicate action buttons, not navigation tabs
  const ACTION_RE = /^(saugoti|šalinti|atšaukti|pasirinkti|pridėti|ieškoti|filtruoti|krauti|perduoti|tvarkyti|apžiūrėti|grįžti|atgal|uždaryti|versija|spausdinimui|importuoti|eksportuoti)/i;

  const tabs = await page.evaluate(() => {
    const ACTION_RE = /^(saugoti|šalinti|atšaukti|pasirinkti|pridėti|ieškoti|filtruoti|krauti|perduoti|tvarkyti|apžiūrėti|grįžti|atgal|uždaryti|versija|spausdinimui|importuoti|eksportuoti)/i;
    const seen = new Set();
    const result = [];

    for (const a of document.querySelectorAll('a[onclick]')) {
      const text = a.textContent.trim();
      if (!text || text.length > 50) continue;
      if (ACTION_RE.test(text)) continue;
      if (seen.has(text)) continue;

      const rect = a.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0 || !a.offsetParent) continue;

      seen.add(text);
      result.push({ text, onclick: a.getAttribute('onclick') });
    }

    return result;
  });

  console.log(`[deepScan] Found ${tabs.length} tab candidates:`, tabs.map(t => t.text));

  if (tabs.length === 0) {
    const single = await scanCurrentPage(baseLabel || 'deep-scan');
    return { scanned: [single], note: 'No tabs detected — single page scan saved' };
  }

  const scanned = [];

  for (const tab of tabs) {
    console.log(`[deepScan] Clicking tab: "${tab.text}"`);

    // Click via evaluate so we match the exact onclick value without selector escaping
    await page.evaluate((oc) => {
      const el = Array.from(document.querySelectorAll('a[onclick]'))
        .find(a => a.getAttribute('onclick') === oc);
      if (el) el.click();
    }, tab.onclick);

    await page.waitForLoadState('networkidle');

    const label = baseLabel ? `${baseLabel} – ${tab.text}` : tab.text;
    const result = await scanCurrentPage(label);
    scanned.push({ tab: tab.text, ...result });
    console.log(`[deepScan] "${tab.text}": ${result.fieldCount} fields → ${result.filename}`);
  }

  return { scanned };
}

module.exports = { scanCurrentPage, deepScanTabs };
