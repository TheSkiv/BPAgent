const XLSX = require('xlsx');
const fs   = require('fs');
const path = require('path');
const { todayFilePath, todayString } = require('./dateManager');
const { isDone, normalizePlate }     = require('./doneTracker');

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL      = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const DATA_DIR   = process.env.DATA_DIR || 'C:\\PortSystem\\data';

const TASK_STEPS = [
  'fill_cargo', 'fill_weight', 'email_terminal', 'enter_weight',
  'file_prk', 'print_prk', 'email_prk', 'review_sender', 'other',
];

// Stable identity for a task so a manual dismissal survives the LLM rewording it next run:
// fixed steps key on plate+step; free-form ("other") falls back to plate+text slug.
function taskKey({ plate, step, task }) {
  const p = normalizePlate(plate || '');
  const s = TASK_STEPS.includes(step) ? step : 'other';
  if (s !== 'other') return `${p}|${s}`;
  const slug = String(task || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  return `${p}|other|${slug}`;
}

function resolvedPath() {
  return path.join(DATA_DIR, `tasks_${todayString()}.json`);
}
function loadResolved() {
  const p = resolvedPath();
  if (!fs.existsSync(p)) return {};
  try { return JSON.parse(fs.readFileSync(p)); } catch { return {}; }
}
function resolveTask(id, status) {
  const r = loadResolved();
  r[id] = { status: status || 'done', at: Date.now() };
  fs.writeFileSync(resolvedPath(), JSON.stringify(r));
}
function unresolveTask(id) {
  const r = loadResolved();
  delete r[id];
  fs.writeFileSync(resolvedPath(), JSON.stringify(r));
}

const SYSTEM_PROMPT = `You are the operations assistant for PortSystem, a port truck-loading workflow.
From the current list of truck orders, produce a JSON list of concrete tasks a HUMAN operator still needs to do. A task is any concrete action the software will NOT do on its own.

Workflow facts:
- Packaged cargo (bigbags / pallets / 500kg / 600kg bags): the operator files a PRK in KIPIS, then prints and emails the generated PRK document to the terminal.
- Bulk cargo (bulk = true): the operator must first email the terminal to order loading, then hand-enter the weight from the terminal's paper, then file the PRK.
- An order becomes "done" once its PRK is confirmed by the terminal.
- An order with no cargo name, or (for packaged cargo) no weight, cannot be filed yet and needs the operator to fill it in.

Rules:
- Only produce tasks for orders where done = false.
- Never invent orders or data; base every task on the orders provided.
- One concrete action per task, and reference the plate it concerns.
- Order the list by urgency, blockers first.
- Tag each task with a "step" code identifying which workflow action it is:
  - fill_cargo    - cargo name is missing and must be entered
  - fill_weight   - weight is missing for packaged cargo
  - email_terminal- bulk: email the terminal to order loading
  - enter_weight  - bulk: hand-enter the weight from the terminal's paper
  - file_prk      - file the PRK in KIPIS
  - print_prk     - print the generated PRK document
  - email_prk     - email the generated PRK document to the terminal
  - review_sender - an unknown/unreviewed sender needs checking
  - other         - anything that does not fit the above

Return a JSON object of the shape:
{ "tasks": [ { "task": string, "plate": string | null, "step": string, "urgency": "high" | "normal" } ] }`;

function readOrders() {
  const fp = todayFilePath();
  if (!fs.existsSync(fp)) return [];
  const wb   = XLSX.readFile(fp);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
  return rows.map(r => {
    const plate = r['Plate'] || '';
    return {
      plate,
      cargo:     r['Cargo'] || '',
      bulk:      r['Bulk'] === '1' || r['Bulk'] === 1,
      hasWeight: !!String(r['Weight'] || '').trim(),
      sender:    r['Sender'] || '',
      done:      isDone(plate),
    };
  });
}

async function generateTasks() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY is not set in .env');

  const orders = readOrders();
  if (!orders.length) return [];

  const resp = await fetch(OPENAI_URL, {
    method:  'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model:           MODEL,
      temperature:     0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: 'Current orders (JSON):\n' + JSON.stringify(orders) },
      ],
    }),
  });

  if (!resp.ok) {
    throw new Error(`OpenAI API ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  }

  const data    = await resp.json();
  const content = data.choices?.[0]?.message?.content || '{}';
  const parsed  = JSON.parse(content);
  const raw     = Array.isArray(parsed.tasks) ? parsed.tasks : [];

  const resolved = loadResolved();
  return raw
    .map(t => ({ ...t, id: taskKey(t) }))
    .filter(t => !resolved[t.id]);
}

module.exports = { generateTasks, resolveTask, unresolveTask };
