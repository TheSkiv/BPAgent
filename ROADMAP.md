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
> Outbound email-send (currently impossible — mail intake has no send capability, IMAP or
> otherwise) is only needed for the **final PRK handoff** (step 5), same as the packaged path.

---

## ▶ CURRENT PRIORITY — PRK completes on its own  *(set 2026-11-09)*

*Goal: a confirmed, non-bulk order goes from "ready" to a saved, verified PRK draft in KIPIS with
no operator click. "Complete" means **up to and including `Saugoti`** — `Pateikti` stays
human-only (RULES.md Rule 1); the operator's job shrinks to reviewing and submitting drafts.
No KIPIS API is available or expected, so this is built on the existing Playwright filler.*

**This is the working checklist.** Follow it item by item; amend it in the same turn whenever an
item is finished, found wrong, split, or a new gap turns up (CLAUDE.md requires this). Other
sections below keep their detail; this list is the order of work. Each item was checked against
the code on 2026-11-09.

### Target workflow (agreed 2026-11-09)

```
1. Intake      AI reads each email, judges KIPIS relevance, extracts plate/cargo/weight/bulk
               → creates order records only. AI never acts on KIPIS. (manual RECHECK, D1)
2. Gate        confirmed sender + all required data present → `ready`
               missing data → user told exactly what is missing; filling it in resumes the order
3. Trigger     pre-made as soon as the order is `ready` (D4)
3b. Check-in   driver calls → real plates compared with the PRK → amended if different (A20)
4. File        Playwright fills the PRK → pre-save checks (AI + deterministic) → Saugoti
               → confirm the save, capture the PRK number
5. Notify      "<plate> PRK completed — please check and submit (Pateikti)"
6. Human       operator presses Pateikti in KIPIS (human-only, RULES.md Rule 1)
7. Detect      PRK list shows Pateiktas → continue
8. Hand off    print the PRK; save an email draft (IMAP Drafts, D7) to dispatch with truck details and the
               PRK PDF attached → notify "press Send"
9. Human       operator presses Send
   On any failure: user notified to finish by hand, with the reason.
Far future:    a phone agent takes the driver's check-in call and fires the step-3 trigger.
```

Principle: **AI reads and proposes, code decides and acts.** Every human step stays human.

### Done (the base we build on)
- ✅ Deterministic PRK fill (`KIPIS_skills/PRK/navigateToCargo.js`), all fields per `steps.md`.
- ✅ AI pre-save check (`checkPrk.js`); a failed check (`ok:false`) blocks `Saugoti`.
- ✅ `Saugoti` auto-pressed when `KIPIS_DRY_RUN=false`; Pateikti guard (`safePage.js`) on every page.
- ✅ Confirmed-sender gate: only `ready` orders from confirmed senders are eligible.
- ✅ One-at-a-time worker `POST /queue/process-next` (oldest `ready` non-bulk), `isRunning` mutex.
- ✅ Order state store with per-order history; local idempotency via `doneTracker`.
- ✅ Live IMAP intake (re-pinned 2026-11-09), manual RECHECK only.

### To do — in order (each one blocks unattended filing)
- [ ] **A1. Never save an unverified form.** Today `check.ok === null` (OpenAI down, no key,
  bad JSON) still saves with nothing verified — `navigateToCargo.js` only blocks on
  `ok === false`. Per D2: AI `null` + deterministic check (A2) passes → save; AI `null` +
  deterministic fails (or A2 not built yet) → block (→ `needs_human`, reason "check
  unavailable"). Build A1 and A2 together.
- [ ] **A2. Deterministic pre-save field check** alongside the AI one: read back plate, payer
  code/name, gross weight, bags and instructions from the form and compare exactly. Cheap,
  can't hallucinate, and is enough on its own to save when the AI check is down (D2).
- [ ] **A3. Confirm the save actually happened.** After clicking `Saugoti` the code sets
  `submitted = true` without looking. Wait for the saved-document state (PRK number in the
  header, status `Ruošiamas`, no KIPIS error message) and fail the order if absent.
- [ ] **A4. Capture the PRK number at save time** (Phase 2, first half) into
  `docs.PRK.number`. Needed by A3, by dedup (A5) and by the `Šalinti` sweep.
- [ ] **A5. Check KIPIS for an existing PRK before filing** (Rule 6). Wire
  `exportPrkList.js` into the worker so a PRK filed by hand, or by a run that crashed after
  saving, blocks a duplicate. `doneTracker` alone cannot see those.
- [ ] **A6. Exact order matching.** `findRowByPlate` matches the Excel row with
  `.includes()` (a short plate can match a longer one) and reads the Excel, not the order the
  worker picked — a same-day second trip can be filed with the first trip's row. File from the
  order-store record by id; exact plate match only.
- [ ] **A7. Treat low stock as a stop, not a warning.** A chosen lot under 24 000 kg only logs a
  warning and files anyway. Unattended: → `needs_human` unless the order weight fits the lot.
- [ ] **A8. Batch worker.** Loop all eligible orders in one run; continue past per-order
  failures; return made / skipped / failed. (Was "Batch pre-made PRKs" item 1 and 3.)
- [ ] **A9. KIPIS session handling.** Login needs a human MFA code, so the machine cannot log
  itself back in. The worker must detect an expired session once, stop the whole run (not fail
  every order in turn), and raise a single human task "reopen KIPIS". Keep-alive approved (D3):
  while idle, periodically click between read-only menu pages (e.g. Sekimas → Kroviniai) —
  menu navigation only, never a form action button. Still to find out: the idle timeout, to
  set the interval.
- [ ] **A10. Recover from a failed run.** A failure mid-form leaves a popup or half-filled form;
  `failed` orders are never retried. Define: reset to home, retry once for transient errors
  (timeouts), leave data errors (no vessel, no IMP lot, no weight) at `needs_human` with the reason.
- [ ] **A11. Separate "draft saved" from "done".** A saved draft currently moves the order to
  `done`, though the operator still has to press `Pateikti`. Add a `drafted`-awaiting-review
  view so the operator gets a clear "drafts waiting for you" list. (Dry-run `drafted` orders are
  also stuck today: the worker only picks `ready`.)
- [ ] **A12. Filing without a click.** Intake stays manual (D1): mail is fetched only on
  RECHECK. What runs on its own is filing: after each RECHECK, and on a timer during the shift
  (08:00–18:00), the batch worker (A8) files every eligible order. No mail polling timer.
- [ ] **A13. Unified audit log** of every automated filing (order id, plate, PRK number,
  check result, timestamp) — this is a customs workflow.
- [ ] **A14. Keep the server alive.** No process supervisor; a crash or a closed terminal stops
  everything silently (startup is a manual `node --use-system-ca src/server.js`).

### To do — the rest of the target workflow (after A1–A14)
- [ ] **A15. Specific missing-info prompts** (step 2). Every block reason becomes an action the
  user can take, e.g. "MLL365//RZ815: no weight in the email" with a field to fill that sends
  the order back to `ready`. Most reasons already exist as error messages in
  `navigateToCargo.js` / the gate; they need to reach the user, not just the log.
- [ ] **A16. Driver check-in event** (step 3b). A "Driver checked in" action per order, taking
  the plates the driver gives — entered by the operator during the call today, by a phone agent
  later. Built as an event so the phone agent plugs in without changes. Matching the caller to
  an order must work on the truck (tractor) plate alone, since the trailer part is the one that
  usually changes. Marks arrival and hands any plate difference to A20.
- [ ] **A17. Notifications in the web UI** (steps 5, 8, failures; D5). One notification path used
  by every step, shown in the browser: a notifications panel/list plus browser notifications
  while the page is open. No desktop-app install. Starts in PortSystem's own dashboard; moves to
  the platform front door when that exists.
- [ ] **A18. Detect Pateikti** (step 7). Poll the PRK list (`exportPrkList.js`) for our drafts
  changing `Ruošiamas` → `Pateiktas`; record the status on the order. Needs A4 (PRK number).
- [ ] **A19. Print + email draft to dispatch** (step 8, was Phase 3 — no longer paused):
  fetch the submitted PRK PDF, silent print, and build the dispatch email (truck details, PRK
  PDF attached, dispatch address from a routing table) as a MIME message appended to the
  `terminal@bpa.lt` Drafts folder over IMAP (D7; `mailparser`/`imapflow` already installed —
  composing MIME may need a new dependency, ask first). Never sends. Find the server's Drafts
  folder name (may be `INBOX.Drafts`). Printing needs the office PC's printer.
- [ ] **A20. Amend plates at check-in** (step 3b; D4). Compare the driver's plates with the PRK;
  if they differ, update both the `Originalaus dokumento numeris` field and the transport row,
  then `Saugoti`, and run the A2/A3 checks again. Map the amend screens first (`kipis-fill`,
  record in `steps.md`). Drafts only (D6): check the status is `Ruošiamas` before editing;
  submitted PRK → human task via A15/A17.

### Later (not needed for packaged-cargo autonomy)
- [ ] Bulk orders: `gate_pass_ordered` + weight entered → back into the queue (Remaining gap #5).
- [ ] Payer, terminal and 600 kg bag weight out of code into rules (Phase 5).
- [ ] End-of-day `Šalinti` sweep execution (needs A4). Required now that D4 = pre-make — unused
  drafts pile up otherwise. Candidate to move up once A1–A20 are under way.
- [ ] Phone agent for driver check-in calls (Phase 8) — only once A1–A19 run reliably.

### Decisions (the operator's call — record the answer here)
- **D1. Mail intake stays manual (RECHECK) for now** — decided 2026-11-09. Only filing is
  automated (A12). Revisit later.
- **D2. AI check unavailable + deterministic check passes → save** — decided 2026-11-09. A
  wrong `Ruošiamas` draft can be deleted afterwards, so saving is the accepted risk.
- **D3. Keep-alive by clicking between pages is allowed** — decided 2026-11-09 (A9).
- **D4. Pre-make the PRK at `ready`; check-in confirms the plates** — decided 2026-11-09.
  Operators used to wait for the call because the actual plates often differ from the order
  (usually the trailer part). KIPIS lets plates be amended, even on a submitted PRK, so
  pre-making is fine: at check-in the real plates are compared and the PRK amended if they
  differ (A20). Unused drafts still need the `Šalinti` sweep.
- **D5. Everything is used through a browser, no local install** — decided 2026-11-09. The goal
  is a browser-based CRM; notifications live in that web UI (A17). The worker itself (Playwright,
  KIPIS with MFA, stock API, mail) still runs on the office PC — only the people move to the
  browser. Cross-project direction recorded in `C:\BPA\CLAUDE.md`.
- **D6. Automation amends plates on `Ruošiamas` drafts only** — decided 2026-11-09. A submitted
  (`Pateiktas`) PRK with wrong plates is never edited by the machine: it becomes a human task
  ("<plate>: PRK already submitted, driver arrived with <new plates> — amend by hand").
  Written into `KIPIS_skills/RULES.md` as Rule 8.
- **D7. Dispatch email drafts go straight into the `terminal@bpa.lt` Drafts folder over IMAP**
  — decided 2026-11-09, replacing the earlier Outlook COM decision. The draft is visible in any
  mail client or webmail (fits D5), and the operator presses Send there. The only write allowed
  is appending a new message to Drafts — no sending, no changes to other mail; intake stays
  read-only (`EXAMINE`). Recorded in `SECURITY.md` §5.
- *Open:* none.

---

## Current state (verified against the code — last updated 2026-07-31)

Working: IMAP polling directly against the real mailbox, sender Check/Not-Check classification, **AI-based email extraction**
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
- **PDF and Excel attachment parsing** (`fetchAttachmentText`, originally in `gmail.js`, now
  `imapMail.js` — see the IMAP migration bullet below) — waybills, CMRs and
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
- **Automatic background mail polling (server-side `setInterval`, `GMAIL_POLL_INTERVAL_MS`)
  was added then reverted the same day.** Mail is fetched only on a manual RECHECK click again
  (`GET /gmail/emails`, `gmailRoute.js`) — no timer runs `pollAndProcessEmails` on its own. The
  dashboard's own soft-refresh timer (`public/index.html`) still re-fetches the
  Pipeline/Confirmations panels every 2 min, but that only re-renders already-stored state; it
  does not touch the mailbox.
- **Migrated intake from Gmail API to direct IMAP** (`src/core/imapMail.js`, replacing
  `src/core/gmail.js`). Root cause of the "sometimes lags by 10-20 minutes" complaint:
  `bpaterminal1@gmail.com` was never the real inbox — it was a POP3 import mirror of
  `terminal@bpa.lt`@`mail.bpa.lt`, and Gmail's own POP3 fetch schedule (observed 2-15 min lag in
  `X-Gmail-Fetch-Info` headers) was outside our control no matter how fast we polled Gmail's API.
  Connecting straight to `mail.bpa.lt` via `imapflow` removes that hop. Read-only `EXAMINE` (not
  `SELECT`) so the shared human-used mailbox's unread state is never touched; a per-day
  `data/seen_<date>.json` tracks which UIDs were already processed, replacing Gmail's history-ID
  cursor. Attachment fetch/parse (PDF via `pdf-parse`, `.xlsx`/`.xls` via `xlsx`) carried over
  unchanged, now sourced from raw MIME via `mailparser` instead of the Gmail API's part tree.
  No OAuth: `IMAP_HOST`/`IMAP_PORT`/`IMAP_USER`/`IMAP_PASSWORD` in `.env`, so the UI's mail-status
  badge dropped its "Reconnect" button entirely — there's no auth flow to reconnect, just
  credentials that either work or don't. `src/core/gmail.js` and the OAuth credential files under
  `credentials/` are retired but not yet deleted (kept until the new path is confirmed stable in
  production). **Live-tested 2026-07-31**: 26 emails processed through the new path in one poll,
  0 errors, dedup and terminal-confirmation matching both correct (see CLAUDE.md's "Mail
  credentials" section for the TLS certificate-pinning workaround this needed — Avast Mail
  Shield locally intercepts the connection and IT access wasn't available to add an exclusion;
  the pinned cert needs renewing before 2026-10-06). **Broke after Avast re-issued its cert on
  2026-11-05** (new fingerprint → every IMAP connection refused); re-pinned 2026-11-09, next
  expiry 2027-02-03. Avast re-issues about every 90 days, so this recurs until IT adds a Mail
  Shield exclusion for `mail.bpa.lt`.
- **Duplicate-order policy: state-aware, not presence-aware.** Previously, a plate already
  present anywhere in today's Excel silently blocked any repeat (`ordersExcel.js`'s
  `allKnownPlates()`), while `orderStore.ensureOrder` did the opposite — it always created a
  fresh record for a repeat plate from a new message-ID (by design, so a truck doing two
  legitimate trips got two records). The gap between those two rules let a still-open truck
  become a visible duplicate in the Pipeline whenever the *same* booking got re-parsed from a
  new message: Transwina reply-threads routinely re-quote earlier bookings, which re-triggers
  extraction of the same plate under a new message-ID, and this session's Gmail→IMAP cutover
  itself produced a one-time wave of these (email already processed by Gmail, then re-fetched
  and re-processed again under a new IMAP UID once Gmail was retired mid-session). Fixed by
  making both `ensureOrder` and `appendOrderRow` check `orderStore.activeOrderForPlate()` first:
  a plate with any open (non-`done`/`cancelled`) order today is blocked outright, regardless of
  source email; only once that order is closed does a repeat plate count as a legitimate second
  trip and get its own record. Cleaned up 9 pre-existing duplicate/mixup records from today's
  data as part of this fix (8 were the Gmail/IMAP cutover artifact described above; one plate,
  `MGP677//RP152`, had a genuine cross-thread cargo mixup — two records claimed gMOP/MOP potash
  and one claimed DAP 18-46 — resolved as DAP per operator confirmation, not guessed).
- **Follow-up same day: `NHY624//UL387` still showed 2x after the dedup fix above.** Root cause
  this time was upstream of dedup — a Helm AG "customer name change" email quoted a multi-week
  table of already-arranged loadings (dates 23–31 July) and the AI extractor pulled all ~17
  trucks in it out as if they were fresh orders (it correctly created only 15 records, not 17,
  for reasons unrelated to this fix). 14 of the 15 phantom orders had already been cleared via
  the new **Cancel once** button before this was reported; the 15th (`NHY624//UL387`) escaped
  because a genuine terminal@bpa.lt gate-pass confirmation — meant for the *real* order, already
  `done` — landed 2 seconds after the phantom was created and `activeOrderForPlate` misapplied it
  to the phantom instead, since the real order was no longer "active" to match against. Fixed
  the extraction side in `aiExtract.js`'s prompt: an email whose own text is correcting/recapping
  already-arranged loadings (not issuing a fresh instruction) is now explicitly non-relevant,
  even when it lists real plates. **First version of this fix caused a real regression** — it
  made the model under-extract genuine same-day multi-truck batches (Scandagra's "Pasikrovimas
  x2/x3/x4" emails dropped to 1 truck each) — caught by regression-testing against known-good
  emails before shipping, and fixed by making the instruction contrast explicitly against normal
  multi-truck loading lists rather than reasoning from date patterns alone.
- **Server crash on a transient IMAP disconnect, fixed.** Found 2026-08-04: the background
  auto-poll timer died with an uncaught `ECONNRESET` and took the whole Node process down with
  it — no auto-restart, so the app just stayed dead until manually noticed and restarted.
  Root cause: `imapflow` emits a socket-level `error` event separately from rejecting the
  in-flight operation's promise, and an `EventEmitter` `error` event with no listener is fatal
  in Node by default. Our own try/catch around each poll already handled the promise-rejection
  side fine; the raw socket event just had nothing listening for it. Fixed with a listener on
  the client in `imapMail.js`'s `withClient()` that logs and swallows it instead. No process
  supervisor exists yet (`node --use-system-ca src/server.js` run directly) — a future crash
  from an unrelated cause would still require a manual restart.

### Remaining gaps
1. **Mail intake is still read-only.** IMAP connects read-only (`EXAMINE`) and has no send
   capability — cannot send the final PRK handoff (Phase 3) or any other outbound mail. No longer
   believed to block the bulk "order loading" step — see the gate-pass note above. Outbound is
   planned as **drafts appended to the IMAP Drafts folder** (D7, 2026-11-09 — replaced the
   earlier Outlook COM plan); the operator sends them. Tracked as A19 in the current-priority
   checklist.
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
- **Outbound as an IMAP draft** (D7, replaced Outlook COM) → the PDF to a dispatch address
  resolved from a routing table (per terminal / cargo), templated subject + body, saved to
  Drafts for the operator to send. Tracked as A19.
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
  inbound, which required no send capability on our side. What Phase 3's outbound send is still
  needed for is the *final PRK handoff*, not the bulk gate-pass step this phase originally
  assumed it blocked.
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
| Outbound email | ~~Outlook COM drafts~~ → **IMAP Drafts folder** (D7, 2026-11-09) — draft only, the operator sends |
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
| **Email** | Saves **IMAP drafts** (Drafts folder) with the document attached (D7) | Not started — A19 |
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
4. **Drafts everywhere** — ✅ on the KIPIS side (`Saugoti` not `Pateikti`); email side = IMAP
   Drafts folder, never send (D7, not built — A19).
5. **Append-only audit log** — partially: each order's `history[]` in the state store is
   append-only, but there is no single unified log across orders/actions yet.

### Build order

**A — Foundations**
1. ✅ Order state store (`orderStore.js`). Audit log is per-order `history[]` only so far, not
   a unified log.
2. ✅ `safePage` Pateikti guard.
3. Email draft helper — now an **IMAP Drafts-folder** append (D7, 2026-11-09), not Outlook COM.
   Tracked as A19.
4. KIPIS document ledger — **partially built**: live PRK-list reader + Rule 7 gate exist and
   are validated, but only feed the delete-sweep, not a pre-filing dedup check; no persisted
   ledger file. See "KIPIS PRK-list reader + end-of-day sweep" above.

**B — Agents (hybrid)**
5. Head: intake → route → emit tasks — ✅ intake/route done (AI extraction + confirmed-sender
   gate); task-emission existed as the Tasks panel, removed from the UI 2026-07-30 (see above) —
   nothing currently consumes/emits a task list.
6. KIPIS worker: PRK via existing deterministic module — ✅ done; other types LLM-driven via
   `kipis-fill` — not started (PVZ/BDK/VZT).
7. Email worker: IMAP drafts (D7), document attached, recipient from a routing table — not
   started (A19).

**C — Hardening loop**
8. AgentCreator records each LLM-driven workflow → module + `steps.md` → registers dry-run —
   the pattern is proven manually for PRK; no automatic recorder exists yet.
9. Human promotes to live; AI demoted to Verifier for that workflow — not started.

**D — Shift autonomy**
10. 08:00–18:00 worker advancing ready orders; 18:00 reconcile + cancel unused PRKs — not
    started; depends on A3/A4 and the `Šalinti` execution step above.

### Open items

- ~~Which mailbox do outbound drafts come from?~~ Resolved by D7 (2026-11-09): drafts go into
  `terminal@bpa.lt`'s own Drafts folder over IMAP, the same account intake reads. Outlook COM is
  no longer used.

## Autonomous shift operation (the end game) — sequenced
*Goal: 08:00–18:00 the system files/creates documents and executes its own task list; the
operator only watches and handles flagged exceptions. At 18:00 it reconciles and cancels
unused PRKs. This refines Phases 6–7 into a concrete build order and depends on the KIPIS
ledger above.*

1. **Make tasks executable.** Map every task `step` to a machine action: `file_prk` → batch
   fill+save; `email_terminal` / `email_prk` → IMAP Drafts-folder drafts (D7 / A19, see the
   "Outbound email" decision above — the operator sends); `print_prk` →
   silent print. Steps with no automation stay as human tasks.
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

