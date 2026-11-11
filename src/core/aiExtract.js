const { stripHtml } = require('./emailExtract');
const { todayString } = require('./dateManager');

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL      = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const BATCH_SIZE = 10;   // emails per AI call
const MAX_BODY   = 4000; // chars of body text per email sent to the model

// Reply threads (Transwina etc.) re-quote every prior message below the new one, each time
// with a growing chain. Left in, the model re-extracts the same already-ordered plate from
// the quoted history as if it were new — cut the body at the first quote marker or
// "<name> wrote:" / "<name> rašė:" attribution line so only the new content is sent.
function stripQuotedReply(text) {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (/^>/.test(line)) return lines.slice(0, i).join('\n');
    if (/(wrote|rašė):\s*$/i.test(line)) return lines.slice(0, i).join('\n');
  }
  return text;
}

function systemPrompt(today) {
  return `You read freight-forwarding emails and extract truck loading orders for the port terminal BPA in Klaipėda. Today's date is ${today}.
You are given up to 10 emails. Each email block starts with a line "Subject:". Return one result per input email, in the same order.

First decide relevance. A relevant email is a concrete instruction that one or more trucks will come to load specific cargo. Ignore everything else — security alerts, vessel schedules, price lists, marketing, general correspondence, and quoted cargo from an unrelated thread that is not what THIS truck is loading. When unsure, set relevant=false.

An email whose own text says it is correcting, recapping, or changing something about loadings already arranged (e.g. a customer-name change on an existing release, a CMR correction) is NOT a new loading instruction even if it lists real plates — set relevant=false for it. This is different from a normal multi-truck loading list (e.g. "Pasikrovimas" batches), which IS a fresh instruction and should have every truck in it extracted as usual.

A subject line alone that names a specific vehicle plate and driver under a transport heading (e.g. "Transportas: MAN, valst. Nr. AAA111 Vairuotojas: Vardas Pavardė") is relevant even when the body is empty or just a signature block with no cargo or loading language — extract the plate(s) and driver from the subject; leave cargo/weight null unless the "Attachment text" section below supplies them.

Some emails include an "Attachment text:" section — text extracted from a PDF or spreadsheet attachment (a waybill/važtaraštis, CMR, loading list, or similar transport document; spreadsheets appear as CSV rows). It is often the most complete and authoritative source for cargo, weight and plate, especially when the body is just a signature block. Treat it the same as body text for extraction, and prefer its values over vaguer or missing ones in the subject/body when they'd otherwise conflict. Weight there may use a comma as the decimal separator (European format) — e.g. "24,000 t" means 24 tonnes = 24000 kg, not 24000 tonnes. A loading-list row is keyed by plate — match the row whose "Truck license.../driver" cell contains this email's plate, then read weight and bulk strictly by CSV column header, never by which number looks weight-like. "Release no." is an unrelated reference number (often 6 digits) — never use it as weight even though it's the larger number. The "Bulk or big bags" (or similar) column literally saying BULK sets bulk=true for that truck. The "Quantity, mt" (or similar) column is a planned/nominal amount, NOT the actual weight — for a BULK truck the real weight is only known after loading and weighing, reported later by a different message; leave weight null for BULK trucks even when a loading-list quantity is present. Only use "Quantity, mt" as weight for a NON-bulk (bagged) truck.

For a relevant email, extract each truck as one order:
- plates: the truck's licence plates (tractor and trailer when both are given), UPPERCASE, no spaces, each plate a separate array element. Plates may be written separated by "/" or "\\" — split them. Never include a vehicle make/model (DAF, VOLVO, MAN, SCANIA, RENAULT, MERCEDES, etc.) or a container number as a plate.
- driver: the driver's name, or "" if absent.
- cargo: the goods this truck is loading, exactly as written; null if not stated.
- weight: total gross weight in kilograms as an integer (tonnes ×1000); null if not stated. A "600 kg" or "500 kg" bag size is a packaging size, NOT the total weight. When the attachment text holds SEVERAL waybills (važtaraščiai, separated by "---") for the SAME truck, each is a separate consignment loaded onto that one truck: the weight is the SUM of their quantities (two waybills of 12,000 t each → 24000), never just one of them.
- bulk: true ONLY if the email explicitly calls the cargo BULK. Bags, big bags (BB), and pallets are NOT bulk. Exception: MOP potash cargo (MOP, gMOP, sMOP, "Kalio chloridas") always ships bulk at this terminal — set bulk=true for it even without the word BULK appearing.

Return exactly this JSON shape:
{ "emails": [ { "index": <int 0-based>, "relevant": <bool>, "orders": [ { "plates": ["AAA111","BBB222"], "driver": "", "cargo": "", "weight": null, "bulk": false } ] } ] }`;
}

// The model is told never to include a vehicle make as a plate (see systemPrompt) but
// occasionally does anyway — strip the common ones defensively rather than let a bogus token
// like "DAF" ride along in the plate string (breaks dedup/PRK filing downstream).
const VEHICLE_MAKES = new Set(['DAF', 'VOLVO', 'MAN', 'SCANIA', 'RENAULT', 'MERCEDES', 'IVECO', 'MAZ', 'BENZ', 'MB']);

// A licence plate has letters and digits. UHB's loading table had a second row with no truck yet,
// only an ID/passport number, and the model returned "02513238" as that truck's plates
// (2026-11-11) — it showed on the dashboard as a second bulk truck. A token of digits only or
// letters only is never a plate, and neither is a container number (4 letters + 7 digits:
// MSNU2642503); an order left without a plate is dropped. Letters may be Cyrillic — Ukrainian
// trucks are written "АХ4530НО". Checked against every plate stored since July 2026.
const PLATE_SHAPE = /^(?=.*\p{L})(?=.*\d)[\p{L}\d-]{4,10}$/u;
const CONTAINER_NO = /^[A-Z]{4}\d{7}$/;
function looksLikePlate(p) {
  // 6+ digits is a document number, not a plate ("LP-154702" rode along as a third plate, 2026-11-11).
  if (PLATE_SHAPE.test(p) && !CONTAINER_NO.test(p) && (p.match(/\d/g) || []).length < 6) return true;
  console.warn(`AI extraction: "${p}" is not a licence plate — dropped`);
  return false;
}

// "JMV 187" written with a space arrives as two tokens — put a short letter group and the digit
// group after it back together before the shape check, or the plate would be dropped.
function joinSplitPlates(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    if (/^\p{L}{1,3}$/u.test(tokens[i]) && /^\d{2,5}$/.test(tokens[i + 1] || '')) { out.push(tokens[i] + tokens[i + 1]); i++; }
    else out.push(tokens[i]);
  }
  return out;
}

function normalizeOrders(orders) {
  if (!Array.isArray(orders)) return [];
  return orders.map(o => ({
    plates: joinSplitPlates((Array.isArray(o.plates) ? o.plates : [])
      .flatMap(p => String(p).toUpperCase().split(/[\\/\s]+/))
      .map(p => p.trim())
      .filter(Boolean)
      .filter(p => !VEHICLE_MAKES.has(p))).filter(looksLikePlate),
    driver: o.driver ? String(o.driver).trim() : '',
    cargo:  o.cargo  ? String(o.cargo).trim()  : '',
    weight: Number.isFinite(o.weight) ? Math.round(o.weight) : (parseInt(o.weight, 10) || ''),
    bulk:   !!o.bulk,
  })).filter(o => o.plates.length > 0);
}

async function callOpenAI(batch) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY is not set in .env');

  const userContent = batch.map((e, i) => {
    let block = `Subject: ${e.subject || ''}\nFrom: ${e.from || ''}\nEmailIndex: ${i}\nBody:\n${stripQuotedReply(stripHtml(e.body || '')).slice(0, MAX_BODY)}`;
    if (e.attachmentText) block += `\nAttachment text:\n${e.attachmentText.slice(0, MAX_BODY)}`;
    return block;
  }).join('\n\n');

  const resp = await fetch(OPENAI_URL, {
    method:  'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model:           MODEL,
      temperature:     0.1,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt(todayString()) },
        { role: 'user',   content: userContent },
      ],
    }),
  });

  if (!resp.ok) {
    throw new Error(`OpenAI API ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  }

  const data    = await resp.json();
  const content = data.choices?.[0]?.message?.content || '{}';
  const parsed  = JSON.parse(content);
  return Array.isArray(parsed.emails) ? parsed.emails : [];
}

// Slots the model's per-item results onto the batch by index, falling back to arrival order on
// a collision. Returns null (not a default) for any position the model just never returned a
// result for, so the caller can tell "genuinely irrelevant" apart from "the model dropped it".
function slotBatchResults(parsed, batchLength) {
  const slots = new Array(batchLength).fill(null);
  let seq = 0;
  for (const item of parsed) {
    let idx = (typeof item.index === 'number' && item.index >= 0 && item.index < batchLength) ? item.index : seq;
    if (slots[idx]) idx = seq; // index collision — fall back to arrival order
    if (idx < batchLength) slots[idx] = item;
    seq++;
  }
  return slots;
}

// Returns an array aligned to `emails`: [{ relevant, orders: [{plates,driver,cargo,weight,bulk}] }]
async function extractOrders(emails) {
  const result = new Array(emails.length);

  for (let start = 0; start < emails.length; start += BATCH_SIZE) {
    const batch = emails.slice(start, start + BATCH_SIZE);
    let slots   = slotBatchResults(await callOpenAI(batch), batch.length);

    // The model returned fewer results than emails sent — a silent drop otherwise (the missing
    // email would default to relevant:false with no trace). One retry before accepting the loss;
    // real truck orders going missing without a log line is the actual bug this guards against.
    if (slots.some(s => s === null)) {
      const missing = slots.map((s, i) => s === null ? i : -1).filter(i => i >= 0);
      console.error(`AI extraction: batch returned ${slots.filter(Boolean).length}/${batch.length} results, missing index(es) ${missing.join(',')} — subjects: ${missing.map(i => JSON.stringify(batch[i].subject)).join(', ')}. Retrying batch once.`);
      const retrySlots = slotBatchResults(await callOpenAI(batch), batch.length);
      slots = slots.map((s, i) => s || retrySlots[i]);
      const stillMissing = slots.map((s, i) => s === null ? i : -1).filter(i => i >= 0);
      if (stillMissing.length) {
        console.error(`AI extraction: still missing after retry — index(es) ${stillMissing.join(',')}, subjects: ${stillMissing.map(i => JSON.stringify(batch[i].subject)).join(', ')}. Treating as not relevant.`);
      }
    }

    for (let i = 0; i < batch.length; i++) {
      const it = slots[i];
      result[start + i] = it
        ? { relevant: !!it.relevant, orders: normalizeOrders(it.orders) }
        : { relevant: false, orders: [] };
    }
  }

  return result;
}

module.exports = { extractOrders };
