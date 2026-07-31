# PortSystem — Roadmap

End goal (far future): fully automated port-loading workflow, eventually with AI phone
agents handling escalations. This roadmap covers the path to **reliable, mostly-automated
order processing with a human in the loop**, which is the prerequisite for everything else.

---

## The two workflows (central concept)

Cargo type determines the *order of operations*, not just a form field. Every phase below
must respect this branch.

### Packaged cargo (bigbags / pallets / 500kg / 600kg bags)
1. Capture order from email (plates, cargo, **bag count → weight**).
2. **File the PRK in KIPIS** (weight is automatic: `bags × 600 kg`, rare exceptions aside).
3. Print the generated PRK document **and** email it to terminal dispatch.

### Bulk cargo (BULK — literal word, or MOP/gMOP/sMOP potash, which is always bulk here)
1. Capture order from email (plates, cargo; **no weight yet** — a loading-list attachment may
   give a planned quantity, but that's nominal, not the real post-loading weight).
2. **Terminal orders loading itself** — sends its own gate-pass request to KKT dispatch.
   PortSystem observes this inbound (`gate_pass_ordered` state) — it does not send this email.
3. Terminal returns the real weight on paper → **operator enters weight by hand** (built: the
   Pipeline row-click modal's Weight field).
4. File the PRK in KIPIS with the correct weight (still manual — see remaining gap #5).
5. Print + email the PRK document (not built — Phase 3).

> Corrected implication (was: outbound send blocks step 2 — it doesn't, see "Current state").
> Outbound email-send (currently impossible — Gmail scope is `readonly`) is only needed for the
> **final PRK handoff** (step 5), same as the packaged path.

---

## Current state (verified against the code — last updated 2026-07-31)

Working: Gmail polling, sender Check/Not-Check classification, **AI-based email extraction**
(plates/cargo/weight/bulk/relevance — regex extractor still present, paused behind
`AI_EXTRACT=false`), **confirmed-sender gate** (unconfirmed senders' orders held at
`needs_human`, never auto-filed), daily Excel, 3-tier vessel resolution (stock API →
`cargo.xlsx` → `Instructions.xlsx`), **order state store** (`orderStore.js` — per-order
lifecycle, handles the same plate ordered twice in a day), full PRK fill-and-save flow with an
**AI completion check** before `Saugoti`, a **Pateikti guard** (structural, blocks the submit
click regardless of code path), a one-at-a-time **queue worker** for non-bulk orders, a
**read-only KIPIS PRK-list reader** with a Rule 7 deletion-eligibility gate (export/delete UI
not built yet), and a two-column dashboard (plates/pipeline on the left, KIPIS controls on the
right) reachable from other machines on the office LAN.

**Built since the 07-20 snapshot:**
- **PDF and Excel attachment parsing** (`gmail.js` `fetchAttachmentText`) — waybills, CMRs and
  HELM AG-style loading-list `.xlsx` attachments are parsed and fed to the AI extractor
  alongside the email body. This is often the *only* source for cargo grade, BULK status and
  quantity — the order email itself frequently just says "MOP" or "DAP" with a bare plate.
  (The PDF path existed as dead code for a while — it called `pdf-parse` with the v1 API against
  a v2 dependency and threw on every call; nobody noticed because nothing exercised it. Fixed,
  and extended to spreadsheets.)
- **Bulk gate-pass tracking.** New order state `gate_pass_ordered`, sitting between `ready` and
  `done`: when terminal@bpa.lt emails a BULK truck's gate-pass request to KKT dispatch
  (`dispecerine@terminalas.lt` / `ktdispecerine@terminalas.lt`), the order moves here instead of
  straight to `done` — the real weight is still pending. A non-bulk truck's terminal
  confirmation still goes straight to `done`. This is effectively the "awaiting weight" state
  Phase 4 called for, built without needing outbound send (see the note under Phase 4).
  **Important architectural correction to the two-workflows section above: terminal initiates
  its own gate-pass email to KKT dispatch — PortSystem observes it inbound, it does not need to
  send the "order loading" email itself.** That send was assumed to block this on the Gmail
  `send` scope; it does not.
- **MOP-potash bulk exception.** MOP/gMOP/sMOP cargo is always bulk at this terminal even when
  the source email never says the word BULK — a documented exception to the literal-word-only
  rule (see `CLAUDE.md`'s BULK detection section), because the grade (g vs s) and BULK status
  routinely aren't known until terminal's confirmation or a loading-list attachment reveals them.
- **Quote-chain phantom-order fix.** Reply-thread emails (Transwina etc.) re-quote the entire
  prior conversation below each new line; the extractor was re-reading old, already-ordered
  plates out of that quoted history as if they were new orders every time the thread grew. Now
  strips everything from the first quote marker before extraction. A same-day backfill of
  cargo/weight from attachments (`updateOrderCargo`, gap-fill only, never overwrites) also
  exists for orders that were saved before an attachment was parsed correctly.
- **Manual escape hatches:** a **Done** button on every Pipeline row (marks an order done
  directly, bypassing PRK filing — no undo yet), and a cargo/weight/gross-weight/BULK edit modal
  reachable by clicking any row (writes to both Excel and the order store immediately). Gross
  weight auto-fills as `net + net/600` for a bagged order and is disabled for BULK (no bag count
  applies).
- **Company attribution per order**, derived from the sender's email domain, with a fallback to
  the display name for free-mail senders (Transwina dispatch from a personal Gmail account) and
  a manual-override path (`config/sender_companies.json`, `POST /sender-company`) for whatever
  neither heuristic can resolve.
- **Dashboard rebuilt.** The old Truck List (a second, parallel queue view built on
  `doneTracker` directly) was removed as a duplicate of Pipeline; its cargo/weight/BULK editing
  moved into Pipeline's own row-click modal. **The Tasks panel and page-scanner tooling were
  removed** (see below) — the roadmap language further down that still describes them as
  shipped/available is now aspirational again, not current.
- **Legacy Microsoft Graph/Outlook email-ingestion pipeline removed** (`src/run.js` and
  everything under `ingestion/`, `processing/`, `excel/`, `extractors/`) — predated the Gmail
  integration, was never wired into `server.js`, but `npm start`/`npm run dev` still pointed at
  it. Fixed to point at `src/server.js`. The project now also has a git repository (there wasn't
  one before), with `credentials/`, `session/`, `data/`, `.env` gitignored per `SECURITY.md`.

### Remaining gaps
1. **Gmail is still read-only.** Scope `gmail.readonly` — cannot send the final PRK handoff
   (Phase 3) or any other outbound mail. No longer believed to block the bulk "order loading"
   step — see the gate-pass note above. Outbound is planned via **Outlook COM drafts** instead
   (no Gmail re-auth needed) — currently paused per operator decision, KIPIS foundations
   prioritized first.
2. **Packaging specifics hardcoded.** Bag weight is a literal `600`; payer `LT242134730` and
   terminal are hardcoded in the form filler. No per-client/cargo/packaging rules layer. (The
   dashboard's gross-weight helper uses the same hardcoded `600` — one hardcode, two call sites
   now, worth consolidating when this gets a real rules layer.)
3. **PRK numbers are not captured at save time.** `docs.PRK.number` in the order store is
   always `null`. This is also why the delete-sweep can only match by plate (see "End-of-day
   status sweep" below).
4. **KIPIS password needs rotating** — it was hardcoded and printed to logs before being moved
   to `.env`; moving it doesn't undo that exposure.
5. **`gate_pass_ordered` orders never get auto-filed once their weight is known.** The queue
   worker (`nextReadyNonBulk`) excludes every BULK order unconditionally, regardless of state —
   there's no "BULK order with weight now entered → eligible to file" transition back into the
   automated queue. Right now the operator must file these manually via RUN PRK.
6. **No undo on the manual Done button.** Once clicked, only a direct data edit can revert it
   (done twice already this session, correcting mis-clicks/mis-corrections).

~~Weight never captured~~, ~~KIPIS flow never submits (`page.pause()`)~~ — both fixed;
see Phase 1.

---

## Phase 1 — Finish one packaged order end-to-end through KIPIS  ✅ *(DONE)*
*Goal: a packaged plate goes capture → filed PRK in KIPIS, no manual Excel editing,
no `page.pause()`.*

- ✅ **Weight capture:** AI extraction returns weight directly (regex fallback also handles
  `24t`/`24000 kg`/`24 000 kg`, and treats a bare `600`/`600kg` as the bigbag signal, not
  the total).
- ✅ **KIPIS submit:** `page.pause()` is gone. The flow fills the form, runs the AI completion
  check, and presses `Saugoti` (real draft, `KIPIS_DRY_RUN=false`) — never `Pateikti`.
- ✅ **Idempotency:** `doneTracker` + the order state store; a plate already filed is skipped.
- ✅ **Selector resilience:** rebuilt against real KIPIS quirks — two-level headers, rowspan
  sub-rows, `Krauti iš`/`į` ambiguity, JSF `_id…:0:`/`:1:` siblings — all documented in
  `KIPIS_skills/PRK/steps.md` with the fix, not just the symptom.
- ✅ **Dry-run toggle:** `KIPIS_DRY_RUN` env var, currently off (drafts are real).

## Confirmed-sender gate — anti-spoofing control  ✅ *(SHIPPED)*
*Goal: a forged/spoofed order email must not reach an auto-filed PRK. Sender addresses are
spoofable and being in the sender "Check" column was never proof of trust — unknown senders
auto-add themselves there. This closes that gap before any autonomous filing goes live.*

- A **separate, explicit confirmation record** (`config/confirmed_senders.json`) is the only
  thing that authorises auto-filing — distinct from the old Check/Not-Check classification.
- New orders from an unconfirmed sender land at **`needs_human`** and are never queued; the
  dashboard's **Awaiting confirmation** panel groups them per source email with **Confirm
  sender** / **Confirm once** / **Never** actions (`senders.js`, `orderStore.js`
  `pendingConfirmations`/`applyToMessage`/`applyToSender`, `POST /confirmations/decide`).
- The queue worker (`/queue/process-next`) only ever picks `ready` orders, so an unconfirmed
  order structurally cannot be auto-filed.

## AI operator task list  *(BUILT, then REMOVED FROM THE UI — 2026-07-30)*
*Goal: a live, right-hand panel listing the concrete actions a human still needs to take.*

- On demand, the current order state was sent to the **OpenAI API**, which returned a JSON list
  of human tasks (file PRK, fill missing cargo/weight, send bulk order email, enter weight,
  print/email PRK). Rendered in a sticky right-side panel, refreshed by a button.
- The dashboard's Tasks panel was removed during a UI cleanup pass — it was one of several
  panels operators found cluttered the daily workflow, and nothing downstream consumed the
  generated list automatically. The module (`src/core/aiTasks.js`) is still on disk, unwired
  from `server.js`, in case this gets rebuilt with a narrower scope later.
- **Far down the line:** if rebuilt, prefer a *deterministic* task generator (derive the same
  list from order state with rules) as a token-saving default, keeping the LLM as an optional
  enrichment.

## KIPIS PRK-list reader + end-of-day `Šalinti` sweep  *(PARTIALLY BUILT)*
*Goal: a reliable answer to "does a PRK already exist for this truck, and what is its status?",
and at end of shift, delete the `Ruošiamas` drafts the terminal never used.*

**Decisions taken:**
| Question | Decision |
|---|---|
| Button | **`Šalinti`** (delete) for `Ruošiamas` drafts. `Anuliuoti` is for submitted documents — **human-only, never automated** (RULES.md Rule 7) |
| Scope | Only PRKs **PortSystem created** *and* whose truck was **due today** — never a human's draft, never a draft pre-made for tomorrow |
| Autonomy | **Propose, human confirms.** The sweep lists what it would delete; the operator approves |

**Built and validated** (`KIPIS_skills/PRK/exportPrkList.js`, `prkLedger.js`):
- The document-list screen is mapped (**Prašymai krovai**, reached via the left shortcut or
  **Krova → Prašymai krovai** — navigation is stateful JSF, a direct URL lands elsewhere).
- `readFullPrkList()` reads the list straight from the rendered DOM table (no download/export
  needed — an XLS-export path was tried and dropped as unnecessary). Auto-detects KIPIS's own
  server-side row cap and re-queries at a higher limit rather than silently truncating, capped
  at `MAX_LIMIT = 500` (a full day's volume; raising it has a real memory cost).
- `findDeletable()` applies the Rule 7 gate (status, ours-today via the order store, human
  approval placeholder) and was validated against a **live** `Ruošiamas` draft — correctly
  found it and correctly blocked it (hand-made, not machine-filed → not deletable).
- `POST /prk/export` exposes this; **read-only**, deletes nothing.

**Not yet built:**
- **No persisted ledger file** (`data/prk_<date>.json`) — every call re-reads KIPIS live. Fine
  for the sweep; will matter once other code needs the list without a round-trip.
- **PRK numbers still not captured at save time**, so matching a document to an order is
  **plate-only**. A machine-filed PRK that saved before its transport row was added would have
  no plate and could never be matched — see Phase 2 below.
- **Dedup-before-filing is not wired up.** The reader currently only feeds the delete-sweep
  check; filing still relies on `doneTracker` alone, so a PRK filed manually outside the app
  would not block a duplicate auto-file.
- **The actual `Šalinti` click is not implemented.** Mapped and documented in
  `KIPIS_skills/PRK/steps.md` (two-step confirm; a dangerous `Pateikti`/`Šalinti` sibling-index
  trap — verify the label before clicking, never trust the index alone) but not yet coded.
- **No dashboard UI** to review the proposed deletion list and approve it.

## Batch pre-made PRKs for packaged cargo  *(PARTIALLY BUILT — one-at-a-time exists)*
*Goal: every non-bulk order has a PRK pre-created in KIPIS, ready for the user to open, check,
submit and print — no per-truck clicking.*

Confirmed: KIPIS **"Saugoti" saves a reviewable draft** — the operator opens, checks, then
submits and prints. So pre-making is safe: a stray duplicate is a draft the user can delete,
never a live filing.

**Built:** `POST /queue/process-next` (+ *Process next PRK* dashboard button) takes the oldest
**confirmed-sender**, `ready`, non-bulk order and files it — one click per PRK, but still one
click per PRK.

**Not yet built:**
1. A true batch loop: iterate **all** eligible non-bulk orders in one call, not just the next
   one.
2. Record the created PRK number against the plate (blocked on Phase 2 below — the number is
   not captured at save time yet); flip the order to "premade — needs review" in the UI.
3. Continue past per-order errors; return a summary (made / skipped / failed).
4. UI: a single "PRE-MAKE ALL PRKs" action + a per-order "premade" badge.

- **Dedup:** currently `doneTracker` + the order store (skip plates already filed via the app).
  The PRK-list reader above upgrades this to also catch PRKs filed manually / outside the app —
  not wired up yet (see previous section).

## Phase 2 — Capture the generated PRK document
*Goal: after filing, grab the KIPIS-generated PRK (number + PDF) as the handoff artifact.*

- Trigger / locate the generated document ("Versija spausdinimui" / važtaraštis).
- Download the PDF to `downloads/`, record the document number against the order.

## Phase 3 — Document handoff: print + email (packaged path)
*Goal: generated PRK auto-printed AND emailed to terminal dispatch.*

- **Print:** silent Windows print to the configured printer.
- **Add Gmail `send` scope** (re-auth) → email the PDF to a dispatch address resolved from a
  routing table (per terminal / cargo). Templated subject + body.
- Audit log of every send (recipient, document, timestamp) — this is a customs workflow.

## Phase 4 — Bulk path  *(PARTIALLY BUILT — the state tracking and weight entry pieces exist)*
*Goal: support the bulk ordering sequence end-to-end.*

- ✅ **State tracking for "awaiting weight".** `gate_pass_ordered` (see "Current state" above) —
  a BULK order sits here between terminal's gate-pass request and the real weight being known.
- ✅ **Operator weight entry** in the UI — the Pipeline row-click modal's Weight field is
  editable and persists to Excel + the order store. (Gross weight is a separate, auto-computed
  helper field for bagged cargo, not the bulk actual-weight entry.)
- ❌ **Outbound "order loading" email to the terminal — turned out not to be needed.** Terminal
  sends its own gate-pass request to KKT dispatch; PortSystem only needed to observe that
  inbound, which required no new Gmail scope. What Phase 3's outbound send is still needed for
  is the *final PRK handoff*, not the bulk gate-pass step this phase originally assumed it
  blocked.
- ❌ **Auto-file once weight is entered.** No transition exists yet from
  "`gate_pass_ordered` + weight now known" back into the automated filing queue — see remaining
  gap #5 above. Filing a bulk order once weight is known is still a manual RUN PRK today.
- Then file KIPIS with the entered weight + print/email PRK (print/email — Phase 3, not built).

## Phase 5 — The "what to do" rules brain
*Goal: per-client / per-cargo / per-packaging specifics are data-driven, not hardcoded.*

- Consolidate scattered logic (cargo.xlsx, Instructions.xlsx, hardcoded `600`, hardcoded
  payer/terminal) into one rules lookup: payer, instructions, terminal, bag weight, handling.
- **Confidence + human-in-the-loop:** flag low-confidence extractions (unknown sender, no
  cargo match, ambiguous plates) for one-click review in the UI instead of silent guessing.
- *(Optional first real use of AI):* LLM fallback extractor when regex fails — structured
  output with a confidence score, gated behind human review.

## Phase 6 — Status watch & escalation
*Goal: detect stalls in KIPIS and chase the responsible party automatically.*

- Poll KIPIS per filed PRK; persist a state machine (filed → accepted → loaded → …).
- SLA timers per state; on breach, notify customs / terminal / other party (email first).
- Operator dashboard with live status + overdue items.

## Phase 7 — Orchestration & autonomy
*Goal: queue-driven processing with approval gates, not click-per-plate.*

- Auto-advance ready orders through the pipeline; human approval only where confidence is low
  or customs/financial risk is high. Central audit log + retry/recovery.

## Phase 8 (far future) — AI phone agents
- Voice agents call dispatch/customs for Phase 6 escalations. Only after the state machine and
  notification layer are proven.

---

## Agent architecture — PortSystem as an office worker  *(DESIGN, decided)*

*Goal: the system does the daily manual labour — read email, fill KIPIS documents, send docs to
dispatch — and only escalates real decisions to a human.*

**Decisions taken:**
| Question | Decision |
|---|---|
| Execution model | **Hybrid** — LLM agents now, hardened into deterministic code per workflow |
| Outbound email | **Outlook COM drafts** — no Gmail `send` scope / re-auth needed |
| AgentCreator autonomy | **Self-deploys, locked to dry-run** until a human promotes it to live |
| HUMAN routing | **AI decides**, human can override either way |

### The invariant: an order state store (build first, even in agent phase)

Agents must **not** message each other. Each advances an order's state in a durable, append-only
store. This is the seam that lets an LLM agent be swapped for generated code later without
touching anything else — and it is what gives crash recovery, idempotency and a customs audit
trail.

```
received → needs_human | ready → filing → drafted → verified
        → doc_captured → email_drafted → sent → confirmed → done | cancelled | failed
```

Each order: `{ plate, state, docs:{prk:{number,status}}, needsHuman, reason, history:[…] }`.
"Head confirms completion" = **reconciling state**, never an agent asserting it finished.

### Roles

| Role | Does | Today |
|---|---|---|
| **Head** | Intake (extract + relevance), route, flag HUMAN, reconcile at end of shift | `aiExtract` + confirmed-sender gate route to `ready`/`needs_human`; `orderStore` is the state; no end-of-shift reconciliation loop yet |
| **KIPIS** | Fills documents. Serialized — one browser session only | PRK fill+save done (deterministic, `isRunning` mutex); PRK-list read + Rule 7 delete-gate done (read-only); `Šalinti` execution not built |
| **Email** | Composes **Outlook drafts** with the document attached | Not started — paused per operator decision |
| **AgentCreator** | Records a workflow → emits `steps.md` + module → registers it in dry-run | `kipis-fill` skill is the seed; PRK's `steps.md` is the first real output of this pattern |
| **Verifier** | AI checks the work was done correctly | `checkPrk.js` (pre-Saugoti) exists; no post-hoc verifier against the live KIPIS status yet |

### Safety rails — structural, not prompt-based

Because AgentCreator writes code that drives a customs system, RULES.md alone is not enough:

1. ✅ **`safePage` guard** — `KIPIS_skills/safePage.js`, a capture-phase click listener that
   blocks any click/submit matching `/\bpateikti\b/i`, installed on every page `browser.js`
   creates. Verified: blocks `Pateikti` as both `<input>` and `<a>`, allows `Saugoti` and other
   buttons, re-arms across navigation (an earlier version that flagged `window`/`document`
   silently stopped guarding after the first navigation — fixed by flagging
   `documentElement`, which is what actually gets replaced when listeners are lost).
2. **Workflow registry** — every generated workflow has `mode: dry-run | live`. Self-deploy is
   allowed; **only a human flips it to live.** Not built — no AgentCreator-generated workflow
   exists yet beyond PRK, which was built by hand.
3. ✅ **One KIPIS session lock** — the existing `isRunning` mutex in `server.js` covers this.
4. **Drafts everywhere** — ✅ on the KIPIS side (`Saugoti` not `Pateikti`); Outlook side paused.
5. **Append-only audit log** — partially: each order's `history[]` in the state store is
   append-only, but there is no single unified log across orders/actions yet.

### Build order

**A — Foundations**
1. ✅ Order state store (`orderStore.js`). Audit log is per-order `history[]` only so far, not
   a unified log.
2. ✅ `safePage` Pateikti guard.
3. Outlook COM draft helper — **paused per operator decision**; KIPIS foundations prioritized
   first. Still verified available when resumed (classic Outlook 2016, 32-bit COM server).
4. KIPIS document ledger — **partially built**: live PRK-list reader + Rule 7 gate exist and
   are validated, but only feed the delete-sweep, not a pre-filing dedup check; no persisted
   ledger file. See "KIPIS PRK-list reader + end-of-day sweep" above.

**B — Agents (hybrid)**
5. Head: intake → route → emit tasks — ✅ intake/route done (AI extraction + confirmed-sender
   gate); task-emission existed as the Tasks panel, removed from the UI 2026-07-30 (see above) —
   nothing currently consumes/emits a task list.
6. KIPIS worker: PRK via existing deterministic module — ✅ done; other types LLM-driven via
   `kipis-fill` — not started (PVZ/BDK/VZT).
7. Email worker: Outlook drafts, document attached, recipient from a routing table — not
   started (paused).

**C — Hardening loop**
8. AgentCreator records each LLM-driven workflow → module + `steps.md` → registers dry-run —
   the pattern is proven manually for PRK; no automatic recorder exists yet.
9. Human promotes to live; AI demoted to Verifier for that workflow — not started.

**D — Shift autonomy**
10. 08:00–18:00 worker advancing ready orders; 18:00 reconcile + cancel unused PRKs — not
    started; depends on A3/A4 and the `Šalinti` execution step above.

### Open items

- **Which mailbox do outbound drafts come from?** Intake reads `bpaterminal1@gmail.com` (Gmail
  API), but Outlook COM will draft from whatever account classic Outlook is configured with.
  These may differ — confirm before building the Email worker (currently paused, so not urgent).
- Both classic and new Outlook are installed; COM drives **classic**, so drafts appear there.

## Autonomous shift operation (the end game) — sequenced
*Goal: 08:00–18:00 the system files/creates documents and executes its own task list; the
operator only watches and handles flagged exceptions. At 18:00 it reconciles and cancels
unused PRKs. This refines Phases 6–7 into a concrete build order and depends on the KIPIS
ledger above.*

1. **Make tasks executable.** Map every task `step` to a machine action: `file_prk` → batch
   fill+save; `email_terminal` / `email_prk` → outbound Gmail (needs the `send` scope,
   Phase 3); `print_prk` → silent print. Steps with no automation stay as human tasks.
2. **Confidence gating.** Auto-execute only high-confidence items — **confirmed sender (built,
   see above)**, resolved cargo, existing vessel/stock, unambiguous plates. Low confidence →
   leave a human task instead of a silent guess.
3. **Shift worker.** A scheduler runs the pipeline on an interval during 08:00–18:00: ingest
   email → pre-make PRKs → send bulk order emails → advance ready orders. Idempotent, backed
   by `doneTracker` and the order store (a persisted PRK ledger is not built yet — see above).
4. **End-of-shift reconciliation (18:00).** Scrape every PRK filed today (reader exists);
   any still **`Ruošiamas`** that the terminal never used → **`Šalinti`** (delete), per Rule 7
   and with human approval — execution not built yet. A PRK that was actually **submitted**
   but unused is a different, harder case: `Anuliuoti` is **human-only** (Rule 7), so the
   autonomous worker can only flag it as a task, never annul it itself. Emit a shift report.
5. **Audit log.** Persist every automated action (file / save / send / print / cancel) with
   document, plate, status, timestamp — this is a customs workflow.
6. **Watch dashboard.** Some panel becomes the supervision surface: what the system did, what
   it is about to do, what needs a human — with one-click override. (The Tasks panel that once
   existed for this was removed for being cluttered before autonomy needed it — whatever
   replaces it here should be designed for this job specifically, not just resurrected as-is.)

## Cross-cutting (do alongside, not after)

- **Secrets:** ✅ done — KIPIS credentials moved to `.env` (`KIPIS_USER`/`KIPIS_PASS`), OpenAI
  key likewise. See `SECURITY.md`. **Still open:** the KIPIS password was exposed in logs
  before the move and should be rotated.
- **Per-phase verification:** manual UI + console check, per CLAUDE.md. No test suite exists,
  so the dry-run toggle (now `KIPIS_DRY_RUN=false` by default) and the AI completion check are
  the main safety nets.

