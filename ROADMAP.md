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

### Bulk cargo (literal `BULK` in the email)
1. Capture order from email (plates, cargo; **no weight yet**).
2. **Email the terminal to order loading** (outbound — happens *before* KIPIS).
3. Terminal returns the real weight on paper → **operator enters weight by hand**.
4. File the PRK in KIPIS with the correct weight.
5. Print + email the PRK document.

> Implication: outbound email-send (currently impossible — Gmail scope is `readonly`) is
> required *early* for the bulk path, not just as the final handoff.

---

## Current state (verified against the code — last updated 2026-07-20)

Working: Gmail polling, sender Check/Not-Check classification, **AI-based email extraction**
(plates/cargo/weight/bulk/relevance — regex extractor still present, paused behind
`AI_EXTRACT=false`), **confirmed-sender gate** (unconfirmed senders' orders held at
`needs_human`, never auto-filed), daily Excel, 3-tier vessel resolution (stock API →
`cargo.xlsx` → `Instructions.xlsx`), **order state store** (`orderStore.js` — per-order
lifecycle, handles the same plate ordered twice in a day), full PRK fill-and-save flow with an
**AI completion check** before `Saugoti`, a **Pateikti guard** (structural, blocks the submit
click regardless of code path), a one-at-a-time **queue worker** for non-bulk orders, a
**read-only KIPIS PRK-list reader** with a Rule 7 deletion-eligibility gate (export/delete UI
not built yet), page-scanner tooling, and a dashboard with Awaiting-confirmation / Pipeline /
Tasks panels.

### Remaining gaps
1. **Gmail is still read-only.** Scope `gmail.readonly` — cannot send the bulk "order loading"
   email or the final PRK handoff. Outbound is planned via **Outlook COM drafts** instead (no
   Gmail re-auth needed) — currently paused per operator decision, KIPIS foundations prioritized
   first.
2. **Packaging specifics hardcoded.** Bag weight is a literal `600`; payer `LT242134730` and
   terminal are hardcoded in the form filler. No per-client/cargo/packaging rules layer.
3. **PRK numbers are not captured at save time.** `docs.PRK.number` in the order store is
   always `null`. This is also why the delete-sweep can only match by plate (see "End-of-day
   status sweep" below).
4. **KIPIS password needs rotating** — it was hardcoded and printed to logs before being moved
   to `.env`; moving it doesn't undo that exposure.

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

## AI operator task list  ✅ *(SHIPPED)*
*Goal: a live, right-hand panel listing the concrete actions a human still needs to take.*

- On demand, the current order state is sent to the **OpenAI API**, which returns a JSON list
  of human tasks (file PRK, fill missing cargo/weight, send bulk order email, enter weight,
  print/email PRK). Rendered in a sticky right-side panel, refreshed by a button.
- A "task" = any concrete action the machine will not do itself. The list shrinks over time as
  more of the workflow is automated.
- **Far down the line:** add a *deterministic* task generator (derive the same list from order
  state with rules) as a token-saving default, keeping the LLM as an optional enrichment.

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

## Phase 4 — Bulk path
*Goal: support the bulk ordering sequence end-to-end.*

- **Outbound "order loading" email** to the terminal (reuses Phase 3 send capability).
- **Operator weight entry** in the UI for bulk orders (manual, from the terminal's paper).
- Then file KIPIS with the entered weight + print/email PRK.
- State tracking so bulk orders sit in a "awaiting weight" state between steps.

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
   gate); the Tasks panel emits tasks but nothing consumes them automatically yet.
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
6. **Watch dashboard.** The task panel becomes the supervision surface: what the system did,
   what it is about to do, what needs a human — with one-click override.

## Cross-cutting (do alongside, not after)

- **Secrets:** ✅ done — KIPIS credentials moved to `.env` (`KIPIS_USER`/`KIPIS_PASS`), OpenAI
  key likewise. See `SECURITY.md`. **Still open:** the KIPIS password was exposed in logs
  before the move and should be rotated.
- **Per-phase verification:** manual UI + console check, per CLAUDE.md. No test suite exists,
  so the dry-run toggle (now `KIPIS_DRY_RUN=false` by default) and the AI completion check are
  the main safety nets.

