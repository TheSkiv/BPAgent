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
- [x] **A1. Never save an unverified form.** *BUILT 2026-11-09; live-verified the same day — first
  draft saved with both checks passing, confirmed correct by the operator.*
  Save rule in `navigateToCargo.js`: the read-back (A2) must pass **and** the AI check must not
  have failed; AI unavailable (`ok:null`) + read-back passed → save (D2). `checkPrkCompletion`
  now returns `ok:null` on a network error or malformed reply instead of crashing the run. A
  blocked save leaves the form open in KIPIS, sets the order to `failed` with the reason (not
  `needs_human` — that state feeds the sender-confirmation panel), and the dashboard shows
  "Not saved — <reason>". Proper fix-and-resume prompts are A15. **Bug found live
  2026-11-09, fixed same day:** the AI check snapshotted the form after the Kroviniai tab was
  opened, when the main tab's fields are hidden and skipped, so it reported plate, payer and
  instructions as empty and blocked a correct form (the read-back had passed). It now gets the
  main tab's snapshot taken before the tab switch plus the Kroviniai tab's. **Second false
  block, live 2026-11-09 (MFR324//NU551, Axan):** read-back passed, but the model demanded
  fields this process never fills (Užsakymo numeris, sender/receiver codes, Siuntos numeris —
  "expected: not empty") despite the prompt. Fixed: the prompt names the only fields to check,
  and a high-severity issue now blocks **only if its expected value is one of the order values
  we filled** — others are logged as "not blocking". Field values in the snapshot are no longer
  cut at 120 characters (the model saw the instructions truncated). Tested offline on the live
  reply (passes) and on wrong payer / wrong weight (still block).
- [x] **A2. Deterministic pre-save field check.** *BUILT 2026-11-09; live-verified (passed on
  three real forms, incl. the transport-row check).* `readBackIssues()` in `checkPrk.js` reads each field straight from the form and
  compares exactly (whitespace/case-insensitive text, numbers, checkboxes): Originalaus
  dokumento numeris, payer code + name, Instrukcijos, both auto checkboxes, a transport row per
  plate, then Svoris bruto and Vietų skaičius. Main-tab fields are read right after the
  transport rows are added (the re-render most likely to wipe a fill). Comparison logic tested
  offline with stand-in fields. **To verify on the first live run:** that a saved transport row
  shows its plate as page text (the transport check looks for that) — if not, every save will
  be blocked with "Transportas <plate>: not on the page" and the check needs a different locator.
- [x] **A3 + A4 DONE — live 2026-11-10:** KPG387//IA977 (Axan, lot 260801-000106-L) saved as
  `261110-002200-PRK` (Ruošiamas); the number was read from the header and stored on the order.
  Built 2026-11-09: `confirmSaved()` waits up to
  20 s after Saugoti for KIPIS's saved-document header
  `Prašymas krovai: <nnnnnn-nnnnnn-PRK>, Ruošiamas, …` (it replaces "Naujas dokumentas"). Found →
  the number and status go on the order (`docs.PRK.number`) and to the dashboard message. Not
  found, or a status other than Ruošiamas → the run throws and the order is `failed`, never
  `done` on a guess; if KIPIS did save it, the rerun's existing-PRK check finds it on the lot.
  - 2026-11-10 live run (KPG387//IA977, Axan) stopped before Saugoti: read-back passed, but the
    AI check reported the plate empty. A saved transport row is page text, not an input, so the
    AI snapshot never contained it (the first run's pass was the model letting it slide). Fixed:
    the snapshot now carries each transport row's text. The rerun on the fix passed and saved.
- [x] **A3. Confirm the save actually happened.** After clicking `Saugoti` the code sets
  `submitted = true` without looking. Wait for the saved-document state (PRK number in the
  header, status `Ruošiamas`, no KIPIS error message) and fail the order if absent.
- [x] **A4. Capture the PRK number at save time** (Phase 2, first half) into
  `docs.PRK.number`. Needed by A3, by dedup (A5) and by the `Šalinti` sweep.
- [~] **A5. Check KIPIS for an existing PRK before filing** (Rule 6). *First part BUILT
  2026-11-09 (replica-tested, not yet live):* the lot search sees a `Autotransportas <plate>` row
  with a PRK and stops; the order goes to `done` with the PRK number and status recorded. Still
  missing: the PRK-list check for PRKs not visible on the lot (e.g. different cargo name). Wire
  `exportPrkList.js` into the worker so a PRK filed by hand, or by a run that crashed after
  saving, blocks a duplicate. `doneTracker` alone cannot see those. **Proven needed
  2026-11-09:** the test truck `MLL371//RZ817` already had a hand-filed PRK
  (`261109-005045-PRK`, *Patvirtintas*) on the ULSAN lot — had the search worked, the run would
  have filed a duplicate. Cheap first check, on the page the filler is already on: a lot sub-row
  with *Krauti/pakrauta į* = `Autotransportas <plate>` (KIPIS writes `MLL371/RZ817`, one slash)
  means a PRK exists for that truck → skip and report.
  - **Second half BUILT 2026-11-10 (live-read, not yet seen stopping a real order):** the batch
    (A8, so also auto-filing) reads KIPIS's PRK list once per batch — the Ruošiamas drafts plus
    documents submitted in the last 2 days (`exportPrkList.recentPrks`) — and skips any ready
    order whose plate is on a PRK there, whoever made it and whatever its cargo; the order gets
    that PRK (`drafted` if Ruošiamas, else `done`). A PRK already on another order of the same
    plate is that trip's, so a same-day second trip is not stopped by it. Live read 2026-11-10:
    120 PRKs; every PortSystem order matched its own number and the hand-filed ones were found
    (KPB950 included). Read-only check: `GET /prk/recent`. RUN PRK (one plate, by hand) still
    relies on the lot check.
  - **Single-slash plates — 2026-11-10:** plates go into KIPIS as `KPB950/GV865` (KIPIS's and
    people's form), not the orders' `KPB950//GV865` — a person searching KIPIS for KPB950 did not
    find its draft. **List filters cleared:** every job that filters the PRK list (cleanup,
    Pateikti watch, the A5 read) clears the status and date filters afterwards, so the
    operator's list in the same window is not left showing only Ruošiamas.
- [x] **A6 DONE 2026-11-10 (tested on today's 48 orders):** exact plate match (normalised: case,
  spaces, slashes); with several Excel rows for one plate, the order being filed picks its row by
  cargo and received time, and still-ambiguous → the order fails with "cannot tell which one to
  file" instead of filing the first row. The batch, Process next and RUN PRK pass the order.
- [ ] **A6. Exact order matching.** `findRowByPlate` matches the Excel row with
  `.includes()` (a short plate can match a longer one) and reads the Excel, not the order the
  worker picked — a same-day second trip can be filed with the first trip's row. File from the
  order-store record by id; exact plate match only.
- [x] **A7. Low stock is a stop — DONE 2026-11-10.** The lot must hold the truck's gross weight
  (lotRegistry.chooseLot, A27), and the release must too, **after our own unsubmitted drafts**:
  each saved order records `loadsFrom` (owner, vessel, lot, gross, release key =
  seller|buyer|vessel|product); `orderStore.pendingReleaseKg` sums today's and yesterday's
  `drafted` orders on that key, and `owners.resolveOrder` takes it off the release's "left"
  (lines with the same key are summed first — Linas Agro has two TSP lines on OSLO CARRIER 2).
  Live: OSLO CARRIER 2 "1 686 t left after 192 t of our drafts". Today's drafts were backfilled.
  Assumption: once an order is done (dispatch email) the release list has caught up.
- [~] **A8. Batch worker — BUILT 2026-11-10 (tested with an empty queue; not yet on real trucks).**
  Dashboard *File all ready* / `POST /queue/file-all`: every ready non-bulk order, oldest first,
  each once; continues past a blocked or failed order; checks the KIPIS session before each and
  stops the whole batch once if KIPIS is logged out or closed. Summary per truck: saved (PRK
  number), already filed, not filed (reason), failed. *Process next* uses the same per-order
  step (`fileOrder`).
- [~] **A9 BUILT 2026-11-10 (tested live; keep-alive effect over hours not yet seen):**
  `browser.probeSession()` — a background request with the window's own cookies to the KIPIS
  app: redirected to `/auth/realms/…` = logged out (verified: a cookie-less request lands there).
  It touches nothing on screen (a menu click would pull the page away from the operator), and
  runs every 10 minutes while idle as the **keep-alive**. Every KIPIS job (RUN PRK, Process next,
  lot search/scan, PRK open/delete, cleanup) checks it first and stops once with "KIPIS is logged
  out — press Open KIPIS and enter the MFA code. No order was touched." *Open KIPIS* on an open
  but logged-out window now logs in again on it (before: "reusing existing page" and nothing
  happened, seen 2026-11-10). Dashboard: "KIPIS: logged in / logged out — … / not open" under
  the buttons, refreshed every minute; session changes are logged with the time, so the real
  idle timeout will show in the server log. Still open: notifications (A17) when it logs out.
- [~] **A9. KIPIS session handling.** *Part BUILT 2026-11-09:* RUN PRK and Process next refuse
  to start while the KIPIS window is not open, and touch no order. Expiry detection mid-run and
  keep-alive still to do. Login needs a human MFA code, so the machine cannot log
  itself back in. The worker must detect an expired session once, stop the whole run (not fail
  every order in turn), and raise a single human task "reopen KIPIS". Keep-alive approved (D3):
  while idle, periodically click between read-only menu pages (e.g. Sekimas → Kroviniai) —
  menu navigation only, never a form action button. Still to find out: the idle timeout, to
  set the interval. **Seen live 2026-11-09:** pressing *Process next PRK* with KIPIS not open
  (or its window closed) takes an order, fails it with "Browser not initialized" / "Target page
  … has been closed", and moves on — two good orders were marked `failed` this way. The worker
  must check the browser is open *before* taking an order and leave the order untouched if not.
- [~] **A10 BUILT 2026-11-10 (classifier tested offline; no live failure yet):** the batch and
  Process next retry an order once on a transient error (timeout, `net::ERR_`, "Užklausa
  negalioja", page re-render) — only if Saugoti was never pressed (`error.saveClicked`; a draft
  may exist, Rule 6) and KIPIS is still logged in. Every run starts at the KIPIS home page, which
  clears the half-filled form and any dialog. Data errors (no lot, no weight, plate not in the
  orders, Kroviniai tab refused) are not retried; they fail with the reason. RUN PRK (operator
  present) does not retry. Still open: retrying `failed` orders in a later batch.
- [ ] **A10. Recover from a failed run.** A failure mid-form leaves a popup or half-filled form;
  `failed` orders are never retried. Define: reset to home, retry once for transient errors
  (timeouts), leave data errors (no vessel, no IMP lot, no weight) at `needs_human` with the reason.
- [x] **A11 DONE — live 2026-11-10:** five TSP trucks (NDL364, MPK262, JJJ792, MTR105, MZS371)
  saved as 261110-002385/-002395/-002400/-002407/-002410-PRK and listed under "Waiting for
  you"; closing them via the dispatch email still to be seen live. Built: a saved draft (and an existing
  Ruošiamas PRK found on the lot) now leaves the order `drafted`, with its PRK number. The
  dashboard lists those under "Waiting for you — check the draft in KIPIS and press Pateikti";
  terminal@bpa.lt's dispatch email (sent after Pateikti) moves it to `done`, as does the Done
  button. The plate stays in the done list, so RUN PRK still refuses to file it twice. Still
  open: dry-run `drafted` orders (no number) are not picked by the worker.
- [ ] **A11. Separate "draft saved" from "done".** A saved draft currently moves the order to
  `done`, though the operator still has to press `Pateikti`. Add a `drafted`-awaiting-review
  view so the operator gets a clear "drafts waiting for you" list. (Dry-run `drafted` orders are
  also stuck today: the worker only picks `ready`.)
- [~] **A12. Filing without a click — BUILT 2026-11-10 (not yet seen live).** Intake stays manual
  (D1): mail is fetched only on RECHECK. What runs on its own is filing: when a RECHECK
  (`GET /gmail/emails`) finishes, and every 15 minutes 08:00–18:00, `autoFile` runs the A8 batch
  — only if something is ready, nothing else is running and KIPIS is logged in (else it notes
  why and the next tick tries again). No mail polling timer. Dashboard line under RECHECK: last
  auto-filing run and its result (`GET /queue/auto`).
  **Mail timer added 2026-11-10 (D1 reversed, see D1):** the server checks mail itself every
  `MAIL_CHECK_MINUTES` (`.env`, default 5, 0 = off), round the clock — a check reads today's mail
  only, so an order arriving after the day's last manual check used to be lost. `mailTick` in
  `server.js` calls `gmailRoute.checkMail` (the same function as the Check mail button; one check
  at a time) and, during 08:00–18:00, runs the filing round when a truck was saved. Only unseen
  emails go to OpenAI — same data as before, sent more often. If the extraction cannot run
  (OpenAI unreachable) the fetched emails are un-marked as seen (`imapMail.unmarkSeen`) and read
  again at the next check. Emails with plates that were not read as an order are kept for the day
  in `data/mail_missed_<date>.json` and listed on the dashboard ("Checking mail" row) until the
  operator presses "I have checked them" (`GET /gmail/last`, `POST /gmail/missed/clear`).
  Not yet seen live with a real new order arriving on the timer.
- [x] **A13 BUILT 2026-11-10 (not yet seen on a real filing):** `data/prk_filings.jsonl`, one line
  per filing attempt (batch, Process next, RUN PRK, and orders the A5 list check skipped): time,
  actor, outcome (saved / existing / blocked / failed / dry), order id, plate, cargo, PRK number
  and status, lot and owner, field read-back and AI check results, block reason, packaging
  warning, error, retried.
- [ ] **A13. Unified audit log** of every automated filing (order id, plate, PRK number,
  check result, timestamp) — this is a customs workflow.
- [x] **A14. Keep the server alive — BUILT 2026-11-11 (operator's OK).** `start-portsystem.cmd`
  runs the server in a loop: if it stops, it starts again after 10 seconds (tested by killing
  the process). Output goes to `server.log` / `server.err`. A file in the user's Windows Startup
  folder (`PortSystem.cmd`) runs it at logon with no window (S19); delete that file to undo.
  Limits: it starts at Windows **logon**, not at power-on (the PC has to log in); and every
  start logs KIPIS out, so a person still presses Open KIPIS and enters the MFA code.

- [~] **A21. Vessel lookup misses stock it should find.** *BUILT 2026-11-09 (causes 1–4 below),
  tested against the live stock reports, not yet in a live PRK run.* `stockCache.js` reads GBL +
  Helm AG Sheet3 (all-or-nothing: if one report fails, stock counts as unreachable), maps both
  product-column names, and adds a synonym pass from `config/cargo_synonyms.json` (operator
  editable, applied without restart). **Decision (operator, 2026-11-09): stock is the
  authority** — if the stock app is reachable and the cargo is in neither report, or every
  vessel has under 24 t, the run stops with the reason ("not found in either stock report…")
  instead of using `cargo.xlsx`; `cargo.xlsx` / `Instructions.xlsx` are used only while the stock
  app is down. Live check on today's orders: Amonio sulfatas → ULSAN, Karbamidas → HEINZ; three
  cargos now stop for the operator — `YARA BELA AXAN 27-04` (stock has `Yara Bela Axan N27,
  S3,7% (RSK)` on EASTERN VANQUISH; same product? → synonym), `Trigubas superfosfatas 0-46-0`
  (8 orders, in neither report — are the reports complete?), `Amonio salietra (N-34,4)`.
  **First live PRK run after the fix (2026-11-09):** ULSAN resolved from stock correctly, but
  KIPIS *Kroviniai* returned **0 rows for `Atgabenimo dokumentas` = ULSAN** even without the
  cargo filter — so the stock reports' vessel name does not find this cargo in KIPIS. The
  operator finds it by typing `amonio` in *Pavadinimas*, and the vessel is shown on the row.
  **Likely cause (from the page map):** the filler types the vessel into
  `Atgabenimo dokumentas` (`fAtgabenimoDokumentas`, the *arrival document* filter), but the
  vessel lives in **`Atgabenęs transportas (pavadinimas)`** (`fAtgTranspPavad`; rows show e.g.
  `Laivas SATURN J 9546174, S.Kristoferis`). It only worked before when an arrival document
  happened to contain the vessel name. Also the full order cargo text
  (`Amonio sulfatas (600) gran.`) is too specific for the *Pavadinimas* filter. **Checked by the
  operator 2026-11-09: `Atgabenęs transportas (pavadinimas)` = ULSAN does not find it either**,
  so the vessel field is not the (only) cause. **Seen in the operator's screenshot
  (2026-11-09), `Pavadinimas` = `amonio`:** the vessel is in the *Transportas* column
  (`Laivas ULSAN 1078092, Maršalo s.`); KIPIS cargo names are `AMONIO SULFATAS` and
  `Amonio sulfato trąšos (granuliuotos)`; four ULSAN lots. **Last documents are PTA/PRK — no
  IMP anywhere**, so the current IMP-based row rule (steps.md step 8) could never pick a lot
  here even with the right filters.
  **Selection rule given by the operator (replaces the IMP rule):** use only rows whose
  *Krauti/pakrauta į* is one of our two terminal storage places —
  `Saugojimo vieta — Vieta Ro-Ro ir generalinių krovinių terminalo sandėlis, Minijos g. 180` or
  `Saugojimo vieta — Vieta Konteinerių terminalo sandėlis, Perkėlos g. 8`. Sub-rows loading to
  `Autotransportas` / `Vagonai` are other trucks' and wagons' loads — ignore them.
  Planned search: *Pavadinimas* = a short cargo keyword (first word, e.g. `Amonio`), then keep
  rows whose *Transportas* contains the stock vessel, then apply the rule above.
  **New KIPIS search BUILT 2026-11-09** (see `steps.md` "Row selection"): cargo keyword in
  *Pavadinimas*, limit 500, vessel matched in *Transportas*, storage-place rule, lot marks.
  Tested against a replica of the operator's ULSAN screenshot — correct rows, existing PRK
  found for MLL371//RZ817, right storage row ticked. **Live run 2026-11-09 (MLL371//RZ817):**
  ULSAN from stock → keyword `Amonio` → 15 rows, 9 ULSAN ammonium sulphate → existing PRK
  `261109-005045-PRK (Patvirtintas)` found, nothing filed, order `done` with the number
  recorded. **Live run 2 (NYY603//ID290, Karbamidas):** HEINZ from stock → `Karbamidas` 0 rows
  → synonym keyword `Urea` → lot `260903-001557-L` "GRANULAR UREA 46% N IN BULK", the only lot
  → used unmarked → form filled → **field read-back PASSED** (incl. the transport-row check,
  so that locator works) → AI check falsely failed (see A1) → not saved, form left open.
  **Choosing between lots — answered (operator, 2026-11-09):** lot 4 (`260924-001330-L`) is the
  bagged lot **and** the one BPA agreed with the terminal to load first — often by phone, with no
  paper trail. Nothing in KIPIS or the stock reports shows this, so the machine cannot derive
  it: the operator's mark (A22) decides whenever more than one lot qualifies.
- [~] **A23. Confirm the chosen lot is the ordered cargo.** *BUILT 2026-11-09 with the new
  search (replica-tested):* only rows whose name passes `sameCargo` are considered; the old
  vessel-only retry is gone. When the cargo-name filter returns
  nothing, the filler retries with the vessel alone and takes the heaviest IMP lot — without
  checking that lot's cargo name. A vessel carrying two cargoes (stock shows ELECTRAMAR with
  NPK 11-11-21 and NPK 8-12-22) can get the wrong one. Read the row's cargo name and match it
  to the order (same matching as the stock lookup, incl. synonyms); no match → stop.
  Original finding: on the first live test
  (2026-11-09): order cargo `Amonio sulfatas (600) gran.` failed all three tiers with "No vessel
  found", although the cargo is in stock (ULSAN, `AMMONIUM SULPHATE`, Helm AG report, ~5 842 t
  at KKT). Four separate causes, all to fix:
  1. **`stockCache.js` reads only the GBL report** (`stock_gbl` Sheet3). The Helm AG report
     (`stock_helm` Sheet3) is never consulted by the PRK lookup — only by `syncCargo.js`.
  2. **The Helm report names its product column `Product Name`, not `Produktas`** (GBL), so
     adding the URL alone would still drop every Helm row. Packaging column also differs
     (`Įpakavimas` vs `Capacity`).
  3. **Lithuanian vs English names.** Orders say `Amonio sulfatas`, stock says
     `AMMONIUM SULPHATE`; none of the three match passes links them. Needs a cargo-name synonym
     list (LT ↔ EN, common spellings) kept as data.
  4. **`cargo.xlsx` goes stale silently.** `syncCargo` only adds cargo names it hasn't seen;
     it never updates the vessel of an existing row, so `Ammoniuim Sulphate` → RIX SPIRIT (an
     old vessel, per the operator) stays forever. Proposed: when the stock lists have no row for
     a cargo, an unattended run stops and asks instead of trusting `cargo.xlsx` (operator to
     confirm).
  Also seen: the order says 600 kg bags, the stock row says `BULK`. **Not a block** (operator,
  2026-11-09): bulk is often bagged internally without documents, so stock and KIPIS say `BULK`
  for cargo that ships packed. When order and stock disagree on packaging, the order wins.

- [x] **A22. Superseded 2026-11-10 by A27 (lots are chosen by owner).** *Was: v1 BUILT 2026-11-09
  (replica-tested, not yet live):* `src/core/lotMarks.js` + `config/lot_marks.json`; dashboard
  *Lots* panel lists lots a stopped run is waiting on (lot, KIPIS name, tonnes in storage, place,
  trucks already loading) with bagged/bulk + load order, shows marked lots, and has a manual
  "mark a lot" form for when a vessel is delivered. Rule: one lot → used; several → all must be
  marked, lowest load order of the order's packaging that still holds one truck wins; when it
  has less than a truck left the next one is used (**to confirm with the operator** — "clean out
  one lot first" may mean the remainder should be asked about instead). **Live 2026-11-10:**
  operator marked OSLO CARRIER 2 TSP (260417-000725-L) bagged, load order 1, leaving the
  ADAROSE and SEA CARRIER lots unmarked; added the rule that a lot marked load order 1 for the
  order's packaging is used while it holds a truck even with other lots unmarked (nothing can
  load before it). A run that picks a lot clears that cargo's "waiting for your mark" entry.
  Five TSP drafts filed from it. **Panel redesigned 2026-11-10** (operator: too much text, split
  by vessel): one card per cargo waiting → vessel (with the stock reports' rows: BB / Bulk /
  Off-spec, tonnes, KKT / RoRo) → one line per lot: lot · KKT/RoRo · tonnes · ▶ trucks loading ·
  [BB / Bulk / Off-spec] · [#] · Save. The select is preselected from the stock row in the same
  terminal with the closest weight (±10 %, `src/core/lotStock.js`); the operator still saves.
  New mark **Off-spec**: never loaded, takes no loading order. Marked lots are grouped by vessel.
  Seen on ULSAN AS: the Helm report holds 5 842 t bulk in KKT but only 54 t in RoRo, while KIPIS
  shows three RoRo lots (1 250 / 9 100 / 5 746 t) — those get no suggestion. Operator, 2026-11-09: most
  cargo reads `BULK` in KIPIS and the stock reports even when part of it is bagged; the bulk and
  packaged amounts are usually separate lots in KIPIS, but both may say bulk. The filler
  (step 8 of `steps.md`) picks the heaviest eligible IMP lot regardless, so a bagged order can be
  filed against the bulk lot, or the reverse. Needs a manual marking the operator sets once per
  lot (e.g. per shipment number in the dashboard), which the filler then uses to pick a lot
  matching the order's packaging. Unattended rule: if a vessel/cargo has more than one eligible
  lot and none is marked, stop and ask — don't guess. **Confirmed required 2026-11-09:** the
  right lot is both a packaging fact and an internal loading-order agreement with the terminal
  (often by phone), invisible in any system. A lot is identified by its shipment number
  (`Siuntos numeris`, e.g. `260924-001330-L`). Proposed v1: when a run stops on "several lots,
  none marked", the dashboard lists the candidate lots (number, KIPIS name, storage place,
  weight left, whether trucks are already loading from it) with a *Use this lot* button; the
  mark is saved per vessel + cargo + packaging and reused for later orders until the lot is
  empty or the operator changes it.

- [~] **A28. Several waybills for one truck — their weights add up.** *BUILT 2026-11-10 (tested
  on the real case; not yet seen on a new email).* MLL371//RZ817's email had two waybill PDFs
  (Važtaraštis-20/-21, 12,000 t each) and the AI extraction took 12 000 kg instead of 24 000; the
  operator amended the PRK in KIPIS. Fixed twice: the extraction prompt says several waybills for
  the same truck are summed; and without the model, `emailExtract.waybillWeightKg` reads each
  PDF's quantity ("(TRGATKAR501) t 12,000" → 12 000 kg) and a one-truck, non-bulk order with 2+
  readable waybills gets their sum when the extracted weight differs (logged). MLL371's order
  record corrected to 24 000 kg.
- [~] **A24. Bag size is hardcoded at 600 kg — wrong for 500 kg bags.** *BUILT 2026-11-09 for
  PRK filing:* `getBagKg()` reads `(500)` / `(600)` / `po 600 kg` from the order's cargo text;
  no size written → 600 (operator: 500 kg is rare but real). The AI check gets the bag size.
  Dashboard gross-weight helper still assumes 600. Seen live 2026-11-09:
  `Karbamidas (500) gran.` was filled as 40 bags / 24 040 kg gross; with 500 kg bags it is
  48 bags / 24 048 kg. Today's order texts carry the size as `(600)`, `(500)` or `po 600 kg`;
  `Gran Urea` carries none. Read the bag size from the order text (rule to confirm with the
  operator: what to do when no size is written). Same hardcode in the dashboard's gross-weight
  helper (Remaining gap #2). Blocks saving any non-600 kg order correctly.
- [~] **A25. Order cargo names vs the stock reports' names.** *BUILT 2026-11-09.* Operator: the
  stock reports at `http://192.168.1.146:3000/` are the list the office rechecks daily — take
  cargo names and vessels from there and keep updating from there. Done three ways:
  1. **Word match** (stock lookup pass 5, and KIPIS lot matching): every word of the order's
     name starts a word of the stock name — `YARA BELA AXAN 27-04 po 600 kg` → `Yara Bela Axan
     N27, S3,7% (RSK)` (EASTERN VANQUISH), `Gran Urea` → `GRANULAR UREA`. A grade formula in the
     order must also be in the stock name (else `NPK` alone matched every NPK). Two different
     products matching → stop, no guess.
  2. **`cargo.xlsx` refreshed from stock on every RECHECK** (`syncCargo`, which existed but was
     never called): adds new stock names and re-points every name still in stock at its current
     vessel. First run fixed 10 stale vessels (e.g. ammonium sulphate RIX SPIRIT → ULSAN, Axan
     KREETE → EASTERN VANQUISH, TSP 46 → SEA CARRIER / OSLO CARRIER 2).
  3. Synonym added: `Trigubas superfosfatas` = `TSP 46` (Helm AG: OSLO CARRIER 2, SEA CARRIER,
     ADAROSE) — 9 orders today. `Amonio salietra` is in neither report.
- [x] **A26. Superseded 2026-11-10 by A27: the vessel comes from the order's release or own lots.** *Was: BUILT 2026-11-09 (operator: marks
  decide):* `getVesselNames` returns every stock vessel with ≥ 24 t of the cargo; KIPIS lots on
  all of them are candidates, so with several lots the operator's marks choose across vessels
  (unmarked → stop and ask). The chosen lot's vessel goes to the AI check; the Lots panel shows
  and saves each lot's vessel. Live stock: TSP → OSLO CARRIER 2, SEA CARRIER, ADAROSE; NPK
  11-11-21 → SKAGENBANK, ELECTRAMAR. **Live run 3 (MFR324//NU551, Yara Axan, 2026-11-09):**
  EASTERN VANQUISH from stock, 40 bags → keyword `YARA` → the run sat for minutes: KIPIS
  returned a very large table and it was read row by row (with the browser's 50 ms slowMo).
  Fixed: the table is read in one browser call (3 300 rows in ~2 s in a replica), and a result
  at the 500-lot cap now stops the run ("some lots may be missing") instead of choosing from an
  incomplete list. **Live run 4:** `YARA` did hit the 500-lot cap → stopped, nothing filed.
  Operator: YARA is a company with many products — search `AXAN` (KIPIS's Pavadinimas filter
  matches anywhere in the name). Fixed: search words now go most-specific first — grade formula
  (`11-11-21`), the order's own words minus `broadWords` (`Yara`, `Bela`, `YaraBela`, `NPK`,
  `Gran`, editable in `cargo_synonyms.json`), synonyms' words, broad words last; a word that hits
  the cap is skipped for the next one. Axan → `AXAN`, NPK 11-11-21 → `11-11-21`. **Live run 5:**
  `AXAN` → 4 lots, one in our storage (`260801-000106-L`, EASTERN VANQUISH, 174 t) → form filled
  → read-back PASSED → AI check falsely blocked again (fixed, see A1). **Live run 6 — FIRST PRK
  DRAFT SAVED by the new code (MFR324//NU551, 2026-11-09):** `AXAN` → lot `260801-000106-L`
  (EASTERN VANQUISH, 150 t) → read-back PASSED → AI check PASSED → `Saugoti` → order `done`.
  Save itself not yet confirmed by code (A3) — **the operator checked the draft in KIPIS and
  confirmed it is correct.**
  **Operator decision, same day: `Originalaus dokumento numeris` stays empty** (it carried the
  plates). The filler no longer fills it (still waits on it as the form-loaded signal), the
  read-back checks it is empty, and the AI check is told it is empty on purpose. Was: The stock lookup picks one vessel
  (oldest discharge with ≥ 24 t) *before* KIPIS is searched, so the operator's lot marks only
  choose among that vessel's lots. TSP 46 sits on three vessels (OSLO CARRIER 2 picked, as
  oldest); if the terminal is loading from SEA CARRIER first, the run picks the wrong vessel.
  Proposed: search KIPIS for the lots of *every* stock vessel carrying the product and let the
  lot marks decide across vessels (several unmarked lots → stop and ask, as now). To confirm
  with the operator.
- [~] **A27. Lots are chosen by owner — replaces A22's bagged/bulk marks and A26's "every vessel".**
  *BUILT 2026-11-10; live the same day:* owners confirmed by the operator; 3 Linasagro TSP
  (Helm release → OSLO CARRIER 2) and 1 Agrokoncernas Urea (its Helm release → HEINZ, 500 kg
  bags) saved as 261110-003720/-003724/-003727/-003729-PRK; NGU792 (PRK) and LNF355 (VZT) found
  already filed and skipped. Agrokoncernas's own AS lot on ULSAN: KIPIS requires the receiver's
  country (Gavėjas → Valstybė), empty on that lot — operator: "Lietuva only". Now a per-company
  *Receiver country* setting (Lots & owners page), filled only when the field is empty, read back
  as the selected option. 5 AS trucks then saved from lot 260924-001330-L:
  261110-003786/-003789/-003791/-003792/-003794-PRK. Operator: a KIPIS
  lot is an ownership unit, not a packaging one — ULSAN's ~6 000 t lot is all Helm's, from both
  terminals (KIPIS says KKT), the other three are Agrokoncernas's; a lot holds BB and bulk
  together; KIPIS shows no owner; Agrokoncernas's own stock is on a list we do not get; off-spec
  often is not in KIPIS at all and is never loaded (dropped from the system). Helm and Yara sell
  to buyers (Linas Agro, Baltic Agro, …); Agrokoncernas loads its own cargo for local farmers
  (and also buys Urea from Helm). Built, one system for every client:
  - `src/core/owners.js` + `config/owners.json`: sellers (Helm, Yara) with their stock report and
    release list (Helm *release'ai* `/api/stock_helm_sheet4`, Yara *perdavimai*
    `/api/stock_gbl_sheet4`: buyer, product, vessel, what is left). An order's company → its
    buyer name in those lists (auto by name, e.g. Linasagro → "Linas Agro, AB") → the seller and
    vessel(s) of a release with a truck left. No release + company loads its own cargo → its own
    lots' vessels. Else stop. Live data: Linasagro TSP → Helm OSLO CARRIER 2 (1 878 t), Baltic
    Agro Axan → Yara EASTERN VANQUISH, Agrokoncernas AS → own lots, Transwina → to set (a
    forwarder; Rotogran has the Gran AS / Urea releases).
  - `src/core/lotRegistry.js` + `config/lots.json`: every lot a run or a KIPIS search saw, with its
    owner (confirmed by the operator) and an optional loading-order override. Owner suggested by
    weight: a seller's stock-report total for the product (all packaging, both terminals) ↔ the
    lot with the closest weight (±10 %); the vessel's other lots → the self-loader, only when a
    seller lot was matched (HEINZ Urea: one lot, report drifted → no suggestion rather than a
    wrong one). Lot choice: all candidate lots confirmed, else stop; the owner's lots by override,
    else already loading, else oldest; must hold one truck.
  - **Lots & owners page** (`/lots.html`, separate from the dashboard, which now only links to it
    with a count of what needs the operator): vessels → lots (lot, KIPIS name, tonnes, ▶ trucks
    loading, owner, #), Confirm per vessel; "Find lots in KIPIS" by cargo word (read-only);
    companies (buyer name, own cargo); the release lists. Everything editable any time. Vessels in
    no stock/release list are collapsed apart and not counted.
  - Still open: release remaining vs trucks already filed today (A7); per-buyer choice when two
    sellers release the same product (stops and asks today).
  - 2026-11-10, later: "Buys from" seller per company (Transwina → Helm: the seller's stock-report
    vessels with the cargo). Found and fixed: "Gran AS" matched GRANULAR UREA (the 2-letter "AS"
    dropped out of word matching, leaving "gran") — names with a 2-letter abbreviation now match
    by synonym only; "Gran AS" added to the ammonium sulphate group. Rule 6 widened: any recent
    document (PRK/VZT/KDA) on the truck's row, on any vessel, counts as already filed (LNF355//
    NR385 had a hand-filed VZT the PRK-only check missed). Axan: EASTERN VANQUISH's lot has no
    storage left in KIPIS, while the Yara report shows 126 t and Baltic Agro's release 102 t —
    to check with Yara / the terminal.

### To do — less operator interaction (audit 2026-11-10, in order)
From a full read of the code with one goal: the operator touches the system only for Pateikti,
Send and the KIPIS MFA code.
- [x] **S1. Mail checked by the server** — built 2026-11-10 (A12, D1 reversed).
- [x] **S2. "Possibly missed" emails stay on the dashboard** — built 2026-11-10 with S1.
- [x] **S3. Alerts (A17) — built 2026-11-11, in the browser.** The tab title carries the count of
  things waiting ("Needs you" trucks, senders to confirm, KIPIS logged out). With the **Alerts**
  button on (remembered per browser; the click is what lets a browser play sound), anything newly
  waiting gives a two-tone sound, a sticky toast and — where the browser allows it (localhost or
  https) — a desktop notification. Works only while the dashboard tab is open; nothing reaches a
  phone. Not yet heard by the operator.
- [x] **S4. Fixing an order resumes it (A15) — built 2026-11-11.** A failed filing records why it
  stopped (`order.lastFailure.kind`: `transient` / `data` / `after-save`). `POST /set-cargo` puts
  a failed order back to `ready` (`orderStore.requeue`) and starts a filing round — never one
  that failed after Saugoti or already has a PRK. Trucks that failed before this change have no
  `lastFailure` and still need "Try again".
- [x] **S5. Stopped trucks retried in a later round (A10 remainder) — built 2026-11-11.**
  `retryStopped` at the start of each automatic round: `transient` failures only, 10+ minutes
  after the failure, at most twice per truck. Rules tested on a throwaway day file; not yet seen
  on a real KIPIS hiccup.
- [x] **S6. Yesterday's open trucks on the desk — built 2026-11-11.** `GET /pipeline` adds
  yesterday's orders that have a PRK and are still `drafted` or `submitted`, tagged "from
  yesterday". An order id starts with its day, and the order store now finds the day file from
  the id (`dateOf`), so Send email and Mark done work on them. Not carried: yesterday's trucks
  that never got a PRK, and bulk trucks.
- [x] **S7. Faster rounds — built 2026-11-11.** The 15-minute round is now a one-minute
  `shiftTick` (08:00–18:00): a ready truck is filed within a minute of KIPIS being free (seen
  live: the round ran one minute after login), and the Pateikti watch reads the PRK list every
  5 minutes while drafts wait. Before, a truck waited up to 15 minutes after a KIPIS login.
- [~] **S8. Dispatch email made ready when Pateikti is seen — built 2026-11-11, not yet seen
  live.** `prepareDispatches` in the shift tick fetches the PRK PDF of every `submitted` truck
  into memory (never to disk, D10), so Send email opens at once without waiting for the KIPIS
  window. Sending stays the operator's click (D11). No truck was in `submitted` to test it on.
  Seen the same day: JMR442//HF039 went order 10:40 → draft 10:41 → Pateikti and the email sent
  by hand from the mail program → closed by the terminal's copy 10:50, without the dashboard's
  Send.
  **Operator, 2026-11-11: the emails are usually sent from Outlook today; the goal is to send
  them from the dashboard.** So the dashboard's Send has to be the quicker way.
- [x] **S20. Send email appears right after Pateikti — built 2026-11-11. Seen live the same day:
  MOB272//PS118 moved to submitted by the read "after your Pateikti" and its PDF was in memory
  within two minutes (S8 seen live too).**
  First full run through the dashboard, 2026-11-11: draft 10:36 → operator's Pateikti 11:03 →
  Send from the dashboard 11:16 → closed by the terminal's copy 11:21. The operator's only
  actions were Pateikti and Send. The
  Send button used to appear only after the next PRK-list read (up to 5 minutes, plus the
  3-minute wait while the operator uses the KIPIS window) — long enough to send from Outlook
  instead. The page guard now notes the operator's own Pateikti click (`__kipisPateiktiAt`;
  it is never blocked — only automation's clicks are), and the shift tick reads the PRK list as
  soon as the KIPIS window has been still for 30 seconds, then fetches the PDF (S8). Expected:
  Send email on the dashboard one to two minutes after Pateikti. Guard tested on a blank page:
  automation's click blocked, the operator's click goes through and is noted.
- [x] **S9. Bulk trucks: file the PRK by itself once the weight is entered — built 2026-11-11.**
  Owner: "after the Gate pass step there is no next step where it gets the loaded weight from the
  user and continues with automatic PRK, then prints the needed docs." Bulk route on the desk:
  Order · Gate pass · **Weight** · **PRK** · Print · Done. Once the loading is ordered (email sent
  from the dashboard, or the terminal's gate-pass copy) the truck is in "Needs you" with
  **Enter the loaded weight**: a kg box + **File PRK** (Enter works too). `POST
  /order/loaded-weight` writes it as net **and** gross (bulk has no bags — the filer would
  otherwise add 1 kg per 600 kg) to the order and to today's Excel row the filer reads, sets
  `loadedKg`, puts the truck back in line (`setLoadedWeight` → `ready`) and starts a round. The
  queue now uses one rule, `orderStore.isFileable`: ready, and for bulk only with `loadedKg` — a
  weight typed earlier in "Fix order" never files a PRK before loading. Then as for bagged: draft
  → the operator's Pateikti → **Print** (PRK × 2, one for the driver, + CMR/važtaraštis) → Done.
  The dispatch email step is not repeated for bulk (the loading order was the email).
  **Limits:** the weight is refused for a truck not in today's orders file (yesterday's bulk truck
  — its PRK must be filed by hand); while the operator works in the KIPIS window the automatic
  round waits (3 min rule) — the shift tick or "File now" files it.
  Checked: rules on throwaway data (7 cases); the endpoint refuses 5 kg and a bagged truck;
  NRN729//OZ416 shows the weight step on the desk. Not yet run end to end on a real loaded truck.
- [x] **S10. KIPIS opened by the server — built 2026-11-11.** During the shift, if the KIPIS
  window is closed or logged out, `shiftTick` opens it and types the login; only the MFA code is
  left for a person (`KIPIS_AUTO_OPEN=false` in `.env` turns it off). One login at a time
  (`openKipisOnce`, shared with the button). Seen live after a restart: KIPIS came back logged in
  with no code asked. Not yet seen: a real logout with the MFA prompt.
- [x] **S11. Start with Windows, restart after a crash (A14)** — built 2026-11-11, see A14.
- [ ] **S12. Driver check-in and plate change (A16 + A20).**
- [ ] **S13. Trust a whole company domain** instead of one address at a time — operator's
  decision (sender addresses can be forged).
- [~] **S14. Clean-up.** Legacy `POST /run` removed 2026-11-11. Still open: file from the order
  record instead of the Excel row.
- [ ] **S15. Browser login for staff (D5).**

#### Found in the live run of 2026-11-11
- [x] **S16. Earlier trips no longer block a new order — built 2026-11-11 (operator's
  decision, Rule 6 amended in `KIPIS_skills/RULES.md`).** MOB272//PS118 loaded on 2026-11-10
  (PRK 261110-002973, Užbaigtas) and was ordered again on 2026-11-11; the 2-day look-back
  matched yesterday's PRK and closed today's order with no PRK. Now a document dated before the
  order's own day that shows the truck already loaded (a VZT/KDA, or a PRK that is Atliktas /
  Užbaigtas / Anuliuotas) is the earlier trip: `listedPrkFor` in `server.js` (list check) and
  `earlierTripDoc` in `navigateToCargo.js` (lot check). Same-day documents and earlier-day PRKs
  still in Ruošiamas / Pateiktas / Patvirtintas block as before. Seen live: the order was
  reopened and filed by the next round — draft 261111-002125-PRK saved.
- [x] **S21. Things that are not plates no longer become trucks — built 2026-11-11.** UHB's
  "Release 291568" loading table had a second row with no truck yet, only an ID number; the
  model returned `02513238` as that truck's plates and it showed as a second bulk truck (operator
  spotted it). `aiExtract.normalizeOrders` now keeps a token only if it has letters and digits
  (Cyrillic allowed — Ukrainian plates), is 4–10 characters, has fewer than 6 digits, and is not
  a container number; "JMV 187" written with a space is joined back first. Also dropped now:
  `LP-154702`-style document numbers and `BENZ`, which rode along as extra plates
  (`BENZ//JZG061//HP913//LP-154702`, 2026-11-11). Run against all 941 plate tokens stored since
  July: only non-plates were dropped. Not changed: the model still decides what is a truck row;
  a row with no truck number is simply not an order until an email names the truck.
- [x] **S22. The dispatch-email window shows the text at once — built 2026-11-11.** The operator
  saw an empty window for 5–10 s after "Send email" / "Order loading" and thought the email
  was being written by AI. It is not (the text is a template); the wait was the PRK PDF fetched
  from KIPIS (about 8 s when not already in memory, e.g. after a restart) plus the inbox check
  for a hand-sent copy (about 1.3 s). `GET /dispatch/preview?quick=1` now returns the text
  without either (about 0.1 s); the dashboard shows it, says it is getting the PDF, then asks
  again for the PDF and the warnings. Send stays off until that second step is done. Timed on
  MOB272//PS118 and NCB196//LR111; the owner confirmed it in the browser (2026-11-11).
- [x] **S23. Dark theme and Lithuanian — built 2026-11-11 (owner's request).** A switch in the
  bottom-left corner of both pages: ☾/☀ flips the theme at once; EN | LT reloads the page in the
  other language. Both are remembered per browser (`localStorage` `theme`, `lang`); default is
  light and English. `public/i18n.js` holds the switch and the Lithuanian text (English text is
  the key, `I18N.t()`); `ui.css` has a `[data-theme="dark"]` colour set (new `--bar` and
  `--warn-ink` variables replace fixed colours). Translated: everything the two pages write
  themselves, and the server's fixed messages (KIPIS not open / logged out, already running,
  …). **Stays English:** messages the server builds from live data (most "not filed" reasons,
  order notes, `/lots/data` warnings), and the dispatch email text, which goes to the terminal.
  Checked in the browser by Claude (LT + dark on both pages, no script errors). Owner: "pretty
  good" but Lithuanian too bunched up → spacing pass: top bar stays on one line from 1366 px
  (search box shrinks first, brand subtitle hidden under 1500 px), wider route column with
  smaller letter-spacing on the step names, side column 300 → 320 px, balanced wrapping on
  status labels, and shorter LT titles/buttons in "Runs by itself" (e.g. "Juodraščių šalinimas",
  "Šalinti visus"). Measured at 1366 and 1920 px in LT and EN; owner confirmed it in the browser (2026-11-11).
- [x] **S24. A closed truck came back as a second order — fixed 2026-11-11.** UHB sends an
  updated table for the day that still lists trucks already ordered. The operator closed
  NCB196//LR111 (`Mark done`) and a second NCB196 order appeared at once. Cause:
  `orderStore.syncFromExcel` (run on every `/pipeline` load) links each Excel row to the
  *latest* cached email naming the plate (the updated table), so its key differed from the
  order's, and once the order was closed the "open truck blocks a repeat" rule no longer held.
  The Excel has one row per plate per day, so the sync now skips any plate that already has a
  record today. Checked: a `/pipeline` load after the restart created nothing. The duplicate
  (2026-11-11-022) was closed with Mark done at the owner's request.
  **Owner's decision (2026-11-11): same sender + same subject = same truck.** An updated table
  that arrives *after* a truck is closed no longer makes a second order: `ensureOrder` returns
  the closed record when the sender address matches and the subject matches once
  Re:/Fw:/Fwd:/AW:/SV:/ATS:/PERS: and leading punctuation are dropped. A different subject from
  the same sender, or another sender, still counts as a new trip. Run against all 16 day files:
  of 25 same-day repeats, none that the rule now merges ever got two PRKs. Caveat: Rotogran keeps
  one thread ("Re: MOP imonei Rotogran") all day, so a real second trip of the same truck in that
  thread would be missed; none in the data so far.
- [x] **S25. Delete our leftover drafts for trucks finished on another PRK — built 2026-11-11
  (owner's request).** Colleagues often file their own PRK for a truck PortSystem already
  drafted; the terminal's copy of their dispatch email closes our order (`drafted → done — PRK
  confirmed by terminal@bpa.lt`) and our `Ruošiamas` draft is left in KIPIS until the 2-day
  cleanup. The "Juodraščių šalinimas" row now lists those trucks with a **Delete these** button
  (confirmation lists plate + PRK). Gates: PortSystem saved the draft; order `done`; email
  proven (dashboard Send or terminal copy); KIPIS's Ruošiamas list and the document header
  still say Ruošiamas right before Šalinti. Any age, today's included. The order stays `done`
  (not `cancelled`); audit log as for every Šalinti; KIPIS reason "nepanaudotas juodraštis
  (krovinys įformintas kitu PRK)". Rule 7 amended. Code: `prkDelete.finishedDrafts` /
  `sweepFinished`, `GET /prk/finished`, `POST /prk/cleanup-finished`, `prkNumbersFiled` now
  returns `emailed` and the recorded KIPIS status. First list: JJJ792//ZN358, NHA730//ZN525
  (2026-11-10), JMR442//HF039 (2026-11-11). **First run (owner, 2026-11-11):** JMR442's draft
  deleted (audit log, order stays done). JJJ792's and NHA730's were not in KIPIS's Ruošiamas
  list: a colleague had submitted *our* drafts (Atliktas / Užbaigtas), but the orders had
  closed before the Pateikti watch saw it, so our records still said Ruošiamas and the line kept
  listing them. Fixed: the run now reads (read-only, universal search) the real status of any
  listed draft KIPIS no longer shows as Ruošiamas, records it, and reports it as "already used,
  kept". The two stale records were corrected by hand from KIPIS's answer.
- [x] **S26. Dispatch emails carry the BPA signature — built 2026-11-11 (owner's request).** The
  emails ended in a bare "Pagarbiai, UAB "BPA"". Now they end in the office's own Outlook
  signature (taken from Gordey Sebastjanovic's, quoted in the terminal's reply threads) without
  a person's name: "Pagarbiai,", the BPA logo, UAB "BPA", S.Daukanto str. 37, LT-92229 Klaipeda,
  tel +370-46-355770, mobile +370-641-81754, e-mail terminal@bpa.lt, www.bpa.lt — Calibri,
  links in Outlook blue. The email is now HTML with a plain-text copy; the logo
  (`public/bpa-logo.png`, 123×45) is embedded (Content-ID), not linked; the PRK PDF stays a
  normal attachment. The signature is added at Send (`dispatchEmail.withSignature`), so the
  editable text no longer has the closing lines; the send window shows it under the text
  ("Parašas (pridedamas siunčiant)"). Checked: a built message parses back with text + HTML +
  inline logo + PDF and no personal name; the window shows it with the logo. Owner approved the
  look in the send window (2026-11-11). Not yet seen in a recipient's mail client — the next
  real Send is the first.
- [x] **S27. The release number on the važtaraštis before printing — built 2026-11-11 (owner's
  request).** "For us and the client to know which release it belongs to." The važtaraštis comes
  as a PDF with the order email (Agrokoncernas "Važtaraštis-N.pdf", Linas Agro
  "LAV…PackSlip_….pdf"); without one the office issues its own CMR in Avilda (CMR: owner will
  send examples — not built). Owner's decisions: stamp the PDF (new npm package **pdf-lib**
  1.17.1, MIT, approved); one line below everything else; Helm prints "Release N", Yara all three
  numbers (Invoice, Delivery, Contract). The release lists (`owners.fetchReleases`) now keep
  those columns. `src/core/releaseStamp.js`: the order's release(s) from its recorded release
  line (`loadsFrom.releaseKey`) or, unfiled, from company + cargo; own cargo has none. Before
  stamping it reads the PDF (pdfjs-dist, already present via pdf-parse): a release already on it
  — as a whole number token, dashes ignored (Linas Agro prints "Krovos numeris 2282853" for Helm
  228285-3) — leaves it unchanged. Order window: per PDF attachment "✓ … already on it" + Print,
  or "Print with Release N" (one button per release when the order could be on more than one —
  Linas Agro's TSP line holds 228285-3 and 256589; the waybill decides, not a guess). In memory
  only, opened in the browser for printing; nothing saved (like D10). Checked: MML743's
  važtaraštis gets "Release 273870" under the last line; NGZ189's is found to carry 228285-3;
  LLE718 (own cargo) gets none. **Limit:** the order window finds the source email only for
  today's orders (`emailCache` is per day), so yesterday's trucks show no attachments.
  From the owner's CMR examples (Avilda printouts, scanned): the office already types the release
  into CMR box 5, Yara as "Inv 0620860510 / DL 697302240 / Kont 30289178". Hence (1) the
  "already on it" check ignores leading zeros, (2) Yara's line is now written the office's way,
  "Inv. … / DL … / Kont. …" (Helm stays "Release N"). Tested against that box-5 text.
- [x] **S28. PortSystem prints the CMR instead of Avilda — built 2026-11-11, layout approved by the
  owner; first real CMR not printed yet.** For a
  truck with no važtaraštis attached, the office issues a CMR in Avilda, which prints straight to
  paper. Owner: "print out the same style CMRs instead of Avilda — fill in all the data". Owner's
  decisions: (a) sender / consignee / place of delivery / carrier come from a table filled once
  **per release**; Agrokoncernas is the exception — new farmers' addresses come in the order
  email, so PortSystem pre-fills from the email; the operator always checks before printing;
  (b) the corner number is free-form — initials + date + series, e.g. D111101 / A111102;
  (c) Avilda keeps a register of issued CMRs, so PortSystem keeps its own; (d) box 10 (customs
  statistical number, e.g. 31052090) from a table per product; (e) new npm package
  @pdf-lib/fontkit approved, to print Lithuanian letters in Arial. Layout to match the owner's
  examples (`Y:\Scaner_Agensy\CMR templates.pdf`, 27 boxes, A4).
  **Step 1 done (2026-11-11):** `src/core/cmrPdf.js` draws the whole form on blank A4 (all 27
  boxes, bilingual labels, grey CMR mark, corner number) and fills it — positions taken from the
  owner's scan, Arial embedded (@pdf-lib/fontkit 1.1.1 installed). A sample with the data of the
  owner's KPG386/IA976 example was sent for a side-by-side check; the owner approved it.
  **Step 2 done:** `src/core/cmr.js` + `config/cmr.json` + `public/cmr.html`.
  - *Data* (`config/cmr.json`): settings (corner-number prefix "B", "Surašyta KLAIPĖDA", box 13 and
    18 texts, loading place per terminal), sender per seller, parties per release (consignee,
    place of delivery, carrier, buyer), parties per company for own cargo, customs codes per
    cargo name. Seeded only from the owner's two CMRs: Yara's sender; Scandagra (Šilutės
    sandėlis) and Baltic Agro (Pakruojis) releases; 31052090 (YaraMila NPK 10-13-25), 31052010
    (NPK 18-11-13). Ro-Ro's loading place set the same as KKT's (Minijos 180) — the owner's CMR
    for a truck our routing calls Ro-Ro (LNV103) says KKT; correct once in the window if wrong.
  - *Pre-fill* (`draftFor`): the order's release (picker when it could be several); saved parties
    for that release, else the same seller's sender and the same buyer's last delivery place;
    own cargo (Agrokoncernas) reads "Iškrovimo vieta / Pristatymo adresas" from the email text,
    then from the attached važtaraštis; goods "N big bags - trąšos <cargo>" + "Netto N kg" (bulk:
    "Birios trąšos … (palaidas)"); gross = recorded gross or net + 1 kg per bag; customs code by
    cargo name (NPK formula / words); driver from the day's Excel; number B+MMDD+series.
    Box 16 (carrier) is empty by default: in the examples it is the carrier's own stamp.
  - *Window*: the order window's **CMR** button → every box editable, a yellow line naming empty
    must-haves, "remember … for this release / for <company>" (on by default), **Print CMR** →
    PDF in a new tab. Printing writes `data/cmr_register.jsonl` (everything printed) and saves
    what was confirmed (parties, seller's sender, loading place, customs code). A number already
    in the register is refused.
  - *Register*: `/cmr.html` (top menu "CMR register"), searchable, "Print again" redraws any CMR
    exactly as printed.
  Checked: LNV103's pre-filled CMR equals the owner's Avilda example 1 box for box (printed once
  as TEST-LNV103 with "remember" off, the test line then removed from the register);
  MOB272 (own cargo) picks its delivery place from the važtaraštis; MML743 (Helm) opens with
  sender / place of delivery / customs code flagged empty — Helm's sender has to be typed once.
  A truck with two releases (KPG386) needs one CMR per release: pick the release, edit the goods.
- [x] **S29. Print pack, CMR to KKT by email, truck log — built 2026-11-11 (owner's request).**
  Owner's rules: CMR — Ro-Ro **5 paper copies**, KKT **1** (our archive) and KKT also gets it **by
  email**; PRK — **1** copy for our archive, **2** for bulk (one goes to the driver); print the CMR
  "immediately, along with the PRK".
  - *Print pack*: **Print CMR** now opens one PDF: CMR × 5 or × 1, then the PRK × 1 or × 2
    (`cmr.copiesOf`, `cmr.printPack`, server `sendPack`). The PRK comes from memory or from KIPIS
    (read-only "Spausdinti", `prkPdfFor`); not submitted yet / KIPIS busy → the pack has the CMR
    only and the message says why. The truck window lists its CMRs and has **Print pack** (its
    latest CMR + PRK) — also for yesterday's and older trucks, from the log.
  - *KKT email*: when the dispatch email goes to KKT and the truck has a CMR, the latest one is a
    second attachment (`buildMime` takes several); the send window shows "CMR … goes to KKT too"
    or warns that there is none (Send is not blocked — a truck with a važtaraštis needs none).
    Ro-Ro emails never carry it. The dispatch log records the CMR number.
  - *Truck log*: `/log.html` (menu "Truck log" / "Žurnalas"): every order of any date range up to
    a year — plates, company, cargo, net, vessel, PRK + status, when and where the email went,
    CMRs, state — searchable, a click shows its history with Print pack and its CMRs, "Download for
    Excel" (CSV). Read straight from `data/orders_state_<date>.json` (`GET /log`).
  - *Keeping a year*: nothing in PortSystem deletes those day files (oldest order file 2026-07-29,
    oldest data 2026-04-07). Size measured 2026-11-11: all data 3.9 MB, a busy day 100–260 KB, so
    roughly 50–100 MB a year; 166 GB free on C:. **Do not add a cleanup that deletes day files
    younger than a year.** Risk not covered: everything is on this one PC's disk — no backup.
  - Menu links have short Lithuanian names (Partijos, CMR, Žurnalas) so the bar fits at 1366 px.
  Checked: log 2 days = 89 trucks (0.1 s), a year = 440 (0.05 s), > 1 year refused; Ro-Ro pack for
  LNV103 = CMR × 5 + PRK × 1 (7 pages, PRK from KIPIS in 8 s); a KKT email built (not sent) carries
  PRK + CMR; the TEST CMR was removed from the register afterwards.
- [x] **S30. The Print step: Email → Print → Done — built 2026-11-11 (owner's request).** "Another
  step after EMAIL and before DONE, which is PRINT. It suggests documents for printing: a
  CMR/važtaraštis (with the required amendments) and the PRK."
  - Route on the desk: Order · Draft · Pateikti · Email · **Print** · Done (bulk: Order · Gate pass ·
    **Print** · Done). A truck whose email went from the dashboard, or that something closed by
    itself, sits in "Needs you" with **Print documents**.
  - `orderStore.setState`: an automatic "done" (terminal's copy of the email, KIPIS "Atliktas", …)
    becomes the new state **`to_print`** for a truck PortSystem drove (it saved the PRK or sent the
    email) created from 2026-11-11 14:00 UTC (`PRINT_STEP_FROM`) and not yet printed. The
    operator's own "Mark done" still closes at once. Older trucks and trucks filed entirely by
    people close as before. `to_print` carries over to the next day like drafts do.
  - **Print documents** opens the print pack — the CMR, or without one the važtaraščiai from the
    order email with the release added where missing (`transportDocsFor`) — × Ro-Ro 5 / KKT 1,
    then the PRK × 1 / bulk 2 — and then marks the truck printed (`setPrinted`, `POST
    /order/printed`) → **Done**, without waiting for the terminal's copy. A pack with no CMR and
    no važtaraštis is opened but does **not** mark the truck: "make the CMR in its window, then
    print again". A važtaraštis takes the CMR's copy count (Ro-Ro 5, KKT 1) — confirmed by the
    owner 2026-11-11.
  - `emailCache.getEmailData(plate, date)` reads an earlier day's cache, so yesterday's trucks
    still find their važtaraštis. Route names are 9.5 px without letter-spacing to fit six steps.
  Checked: the rules on a throwaway data copy (8 cases: terminal copy → to_print, a second
  automatic close stays, printed → done, emailed + printed → done, older truck and hand-filed
  truck → done as before, Mark done → done, bulk with PRK printed → done); packs for LLE718
  (KKT: važtaraštis × 1) and MML743 (Ro-Ro: važtaraštis × 5 with "Release 273870"), both without
  PRK because their PRKs still wait for Pateikti; six route steps on one line at 1366 px, LT and EN.
- [x] **S31. Cancel a truck that is not a real order — built 2026-11-11 (owner's request).** An
  email read as a truck order by mistake (NDR243 — Agrokoncernas "didmaišiai 5 paletės į
  Micaičius", failed: no weight) had only "Mark done", which counts it as a finished truck. Every
  open truck now has **Cancel** next to Mark done (not while it is being filed); a confirmation
  explains it, and mentions a PortSystem PRK draft if there is one (it stays in KIPIS for the
  draft cleanup — KIPIS is not touched). `POST /order/cancel` → `cancelled`, history "cancelled
  by hand — not a real truck order". Not re-created: the Excel sync skips a plate with any record
  today (S24) and a repeat of the same email thread finds the closed record. No undo yet.
  Checked: refuses an already-closed truck and an unknown id. NDR243 left for the owner to cancel.
- [x] **S32. The desk matches KIPIS's open PRKs; a swapped truck replaces the old one — built
  2026-11-11 (owner's request).** Owner: the trucks left for today did not come — were they added
  for wrong reasons, and does the desk show as many trucks as KIPIS has PRKs? Found (read-only
  check): NGZ189//ZG485 was a stale duplicate — Linas Agro sent važtaraštis LAV00110184 for it,
  then an *updated* LAV00110184 for LTK202//TK202 (truck swapped) and PortSystem made a second
  truck; MTE728//NT605 had loaded on a colleague's PRK 261111-000640 (Atliktas) unnoticed. KIPIS
  had 10 open PRKs, the desk 4: our submitted-not-loaded PRKs (LLE718, HRK308) counted as done,
  and colleagues' PRKs for trucks PortSystem never saw (BO9077ET, JML150, LOZ024, AC0878IB).
  Owner's decisions → built:
  - NGZ189 cancelled, MTE728 marked done (their drafts left for the cleanup).
  - **Swapped truck** (`gmailRoute.replaceSwappedTrucks`): the same važtaraštis number (file name
    "LAV…PackSlip") from the same, **confirmed** sender naming another, newer truck cancels the
    older one; if its PRK is already submitted it only gets a history note for the operator.
  - **KIPIS sync** (`src/core/kipisSync.js`, `syncWithKipis` in server.js): reads the PRK list of
    the last 2 days (read-only) on the first shift tick after a start, then every 10 min 08–18, and
    on "Matching KIPIS → Check now" in the side panel. Road transport only (storage moves are not
    trucks). Our PRKs: status kept current, loaded → done. An open truck loaded on a person's PRK →
    done (no Print step; all its open orders, as repeated bulk emails left NND844/LID098/MOU324
    open twice). A person's open PRK for our truck without one → recorded. An open PRK for a truck
    PortSystem never had → a truck "from KIPIS" (drafted / submitted), closed when it loads,
    cancelled when annulled.
  - **Desk**: a done truck whose PRK is Pateiktas/Patvirtintas (number known) stays in Waiting as
    "Submitted — waiting for the truck to load" until KIPIS says loaded (today's and yesterday's).
  Checked: dry run on a copy of the day files with the real KIPIS list (stable: second pass 0
  changes); then live — 157 PRKs read, 32 corrections, desk 9 trucks = KIPIS's 9 open truck PRKs
  (KIPIS lists 11; NGZ189's and MTE728's unused drafts are not trucks). `/prk/recent` now also
  returns the list itself (read-only).
- [x] **S33. A cancelled važtaraštis cancels its truck — built 2026-11-12.** Linas Agro's system sent
  "Atšauktas (-i) krovinio gabenimo važtaraštis (-čiai)" for JCV034//OG708 (LAV00110374); the AI
  read it as "not a truck order" and the truck stayed ready to file (cancelled by hand at the
  owner's request). Owner asked whether AI should handle cancellations / plate changes and how
  the industry builds this; agreed plan: (1) fixed rules for machine-generated emails, (2) an
  evaluation set from stored emails, (3) then one-email-per-call extraction with a stronger model
  and an *intent* field (new order / cancel / change plate / change weight / not an order) with
  an evidence quote, acting automatically only when safe, else a card for the operator. No
  multi-model "pyramid" (low volume, fixed task). **Step 1 built:** `gmailRoute.cancelForWaybill`:
  a confirmed sender's "Atšauktas … važtaraštis" email is handled by a rule, not the AI — the
  document number (LAV…, attachment name and text) and the plates ("…valstybinis numeris: X",
  "…puspriekabės valstybinis numeris: Y") find the open truck from the same sender (today's and
  yesterday's), which is cancelled; with an already submitted PRK it only gets a note (Anuliuoti is
  a person's). Linas Agro's machine emails over 45 days: 72 new, 4 updated (covered by S32's swap
  rule / one truck per plate), 1 cancelled. Checked on the real JCV034 email against a copy of the
  day file: cancelled with the reason in its history, nothing else touched, a second run changes
  nothing. Steps 2 and 3 not started.
- [ ] **S17. A hand-filed PRK that is submitted but not loaded closes the order.**
  `recordExistingPrk` sets `done` for every status except Ruošiamas, so a Pateiktas /
  Patvirtintas PRK made by a person never shows "Send the dispatch email" (LNV103//OO974,
  2026-11-11). Option: set `submitted` instead, so the email step stays visible.
- [ ] **S18. Orders that arrive while the server is down are filed by people, then show as
  ready.** Worked correctly on 2026-11-11 (6 trucks, all found in KIPIS and not duplicated), but
  the dashboard said "ready" for them until the first round ran.
- [x] **S19. The server window was closed by accident** (2026-11-11, about 10:26 — the operator
  closed the minimised "PortSystem server" window; nine minutes without mail checks). From the
  next logon the Startup entry starts PortSystem with no window at all. To stop it on purpose:
  `stop-portsystem.cmd`. Not yet seen through a real logoff/logon.

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
- [x] **A18. Detect Pateikti — DONE 2026-11-10 (live).** `KIPIS_skills/PRK/prkWatch.js` reads the
  PRK list filtered by *Pateikimo data* yesterday–today (31 documents today; drafts have no
  submission date so they are not in it) and moves our drafted orders by status: Pateiktas /
  Patvirtintas → new state **`submitted`** (dashboard group "Submitted — send the dispatch
  email"), Atliktas / Užbaigtas → `done`, Anuliuotas → `cancelled`; the status cell's first line
  only ("Anuliuotas\nKLAIDA"). Runs after each RECHECK and on the 15-minute shift timer (after
  auto-filing), and from the dashboard's *Check submitted*. Live: MLL371, MIA722, LDC323 →
  submitted (Patvirtintas); 11 drafts unchanged. Also: the list's status and date filters stay
  set in KIPIS between reads, so every read now sets both (a "read all" after a Ruošiamas read
  would have silently returned only Ruošiamas). **Operator guard:** automatic jobs (auto-filing,
  this check, the daily cleanup) skip their turn when the operator clicked or typed in the KIPIS
  window in the last 3 minutes (`safePage.operatorActiveWithin`; the system's own clicks don't
  count) — they would pull the page away from a draft being checked.
- [~] **A19. Dispatch email — REWORKED 2026-11-10 to send from the dashboard (D11).** The Drafts
  version below worked but was invisible to the office (POP3). Now: a submitted truck has an
  **Email** button → preview (`GET /dispatch/preview`: routing-table recipients RoRo/KKT + Cc,
  subject, text, PRK PDF fetched into memory and viewable at `/dispatch/pdf`; warns if the truck
  was already emailed today) → the operator may edit subject/text or switch terminal → **Send**
  (`POST /dispatch/send`, `src/core/smtpSend.js`: SMTP over TLS 465 to mail.bpa.lt, same account
  and pinned cert as IMAP, minimal client — no new dependency) → recorded on the order
  (`dispatchSent`, never twice), logged to `data/dispatch_sent.jsonl`, PDF dropped from memory;
  the Cc copy closes the order on the next RECHECK. SMTP login verified; first real send not yet
  done. The automatic Drafts step is removed. *Earlier (Drafts) version, kept for the record:*
  For every `submitted` order without one, in the
  automatic round after the Pateikti check and on *Check submitted*:
  1. **Already sent?** The office Cc's `terminal@bpa.lt`, so a hand-sent dispatch email is in the
     inbox (from terminal@bpa.lt, to a dispatch address, naming the tractor plate) → no draft,
     order marked "email sent". (Sent folder is empty — the copies live in the inbox.)
  2. **PDF:** the PRK opened from the list (submission date yesterday–today), *Spausdinti*, the
     download caught in memory (`browser.captureDownload`, `KIPIS_skills/PRK/prkPdf.js`) — the
     downloads folder handler is bypassed, Playwright's temp file deleted at once.
  3. **Email** (`src/core/dispatchEmail.js`, format from the office's own emails): subject
     "VESSEL CARGO PLATES"; body: cargo – N big bags, "Atgabenta: laivas VESSEL", plates,
     driver (from that day's orders Excel); PDF attached. Recipients from the routing table
     (`src/core/terminals.js`): **KKT** for ULSAN ammonium sulphate and NPK 14-14-21 (operator)
     → ktdispecerine@, vidas@, gates@, lina.armonaitiene@terminalas.lt; **RoRo** otherwise →
     dispecerine@terminalas.lt; Cc terminal@bpa.lt. Hand-built MIME (no new dependency).
  4. **Appended to `INBOX.Drafts`** (`\Draft \Seen`) — the one mailbox write allowed; never sent.
     Recorded on the order (`dispatchDraft`), so never twice; dashboard: "email draft ready
     (RoRo/KKT)" / "email sent". The terminal's Cc copy, once the operator sends it, closes the
     order on the next RECHECK.
  Live: NDL364 and GRJ153 recognised as already emailed; a `[TEST PortSystem — delete me]` draft
  for LDC323 read back correct (To/Cc, subject, body, 49.7 KB PDF). Also: the in-page guard now
  blocks *Anuliuoti* as well as Pateikti while automation drives (it sits next to Spausdinti).
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

- [x] **Cleanup "Delete all now" — 2026-11-10.** A run that deleted nothing read like a failure:
  the result now says how many drafts are ours but under 2 days old and how many are other
  people's (never touched), and a busy/not-run press says so. Operator: the dashboard button
  now deletes **all** of PortSystem's unsubmitted drafts, today's included (confirmation says
  so); the automatic daily run keeps the 2-day rule. RULES.md Rule 7 updated.
- [~] **A32. Emails the batch skips are read again alone — BUILT 2026-11-10.** UHB's three
  "Release 291568 DAP" emails (loading table with JSB303/IA973 and NEZ584/ZB927, bulk DAP from
  ADAROSE) were judged "not a truck order" each time they were in a batch of 10, so neither
  truck was logged (the office emailed the terminal by hand); read alone, both trucks come out
  every time. Now an email the batch drops whose text has plate-like numbers is extracted again
  on its own; still nothing → the log and the Check mail message name it ("has plates but was
  not read as an order"). The summary no longer files these under "ignored (Not Check)": it
  counts "not truck orders" and "from Not-Check senders" separately. Tested on the 15:41 email.
  The two trucks themselves were not recreated (already handled by hand).
- [~] **A31. MML743//SN216: wrongly bulk, gross weight ignored, cargo renamed — FIXED 2026-11-10.**
  (1) The AI extraction (10 emails per call) marked it bulk although its email and waybill say
  "Amonio sulfatas (600) gran."; run alone it says bagged every time — the flag bled over from a
  neighbouring bulk email. Now bulk stays only on evidence in the truck's own email (BULK /
  palaidas / birios, or MOP cargo); a bag size in the cargo name is never bulk; corrections are
  logged. (2) The PRK computed gross itself and ignored the operator's figure: a gross weight
  entered on the dashboard now goes into the PRK as written (empty = weight + 1 kg per bag), and
  the AI check accepts it. The dashboard's suggested gross used 600 kg bags for everything — it
  now reads the bag size from the cargo name and is only a hint. (3) Saving the order editor
  replaced the cargo with the cargo list's name ("Amonio sulfatas (600) gran." → "Gran AS"),
  losing the bag size — the cargo is now kept as typed.
- [~] **A30. Bulk loading-order email — BUILT 2026-11-10 (preview tested; first send not yet).**
  Bulk is ordered by email first; the PRK follows once the terminal reports the loaded weight.
  A bulk truck not yet ordered is under *Needs you* with **Order loading** → the same preview and
  Send as A19, in the format of Dalius's 15:41 email: subject "PLATES - CARGO (palaidas)"; body
  plates + driver, company, "Laivas VESSEL", "(ORDERED / LT NAME) - palaidas", and the three
  loading lines (40 t gross, report the exact weight for the PRK, clean cargo); no attachment.
  Vessel from the order's release or seller (`owners.resolveOrder`); terminal by the same rule;
  recipients from `BULK_DISPATCH_RECIPIENTS` — KKT bulk goes to vidas@, ktdispecerine@, vbs@,
  gates@ (vbs@ instead of lina.armonaitiene@ used for bagged), Ro-Ro to dispecerine@. Sending
  sets the order to `gate_pass_ordered` ("Loading ordered — waiting for the loaded weight").
  Preview for LID098//ID448 matched Dalius's email and warned it was already sent.
- [~] **A29. What Pateikti needs on the PRK — BUILT 2026-11-10 (live on one draft).** Operator:
  Pateikti is refused without (1) the sender's country — *Siuntėjas → Valstybė* = Lietuva, filled
  when empty, like the receiver's; (2) for bagged cargo, the cargo line's *Pakuotės rūšis* =
  "43, Krepšys": after the draft is saved, the lot link opens the cargo line, the packaging is
  set, its Saugoti only stores it in the document, so the PRK is saved again and the cargo line
  reopened to read it back (steps.md 30–33). A packaging failure keeps the draft and shows "set it
  by hand". `POST /prk/amend` brings drafts filed earlier up to date (sender country + packaging);
  live on MOB153's 261110-003789-PRK, read back from KIPIS.
- [~] **UI redesign — BUILT 2026-11-10 (operator: too much on one page, unclear next step,
  dated/cramped, hard to find a truck).** "Truck desk": one list of trucks, each with a route
  line (Order · Draft · Pateikti · Email · Done; bulk: Order · Gate pass · Done) marking where it
  stands and **one button for its next step** (Send email, Try again, Fix order, File now). Tabs
  with counts — **Needs you** (default) · System working · Waiting · Done · All; search by plate,
  company, cargo, PRK (`/` focuses it). Sender confirmations sit at the top of *Needs you*. The
  automation (auto-filing, Pateikti check, draft cleanup, manual filing, Lots & owners) moved to
  a side column; action results show as a toast. Light "harbour fog" look; status colours from
  the maritime signal flags (yellow needs you, blue system, red failed, green done); Barlow
  Condensed / Public Sans / IBM Plex Mono. Shared styles in `public/ui.css`; Lots & owners uses
  them too. `/pipeline` now also returns each order's vessel and last note. Waiting for the
  operator's verdict; then the BPA Platform (VesselCalc) in the same look.

### Decisions (the operator's call — record the answer here)
- **D1. Mail intake stays manual (RECHECK) for now** — decided 2026-11-09. Only filing is
  automated (A12). Revisit later.
  **Reversed 2026-11-10:** the operator asked for as little interaction as possible; the server
  now checks mail by itself (A12). Set `MAIL_CHECK_MINUTES=0` in `.env` to go back to manual.
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
- **D8. The operator may press Pateikti in the automation's browser window** — decided
  2026-11-10. The in-page Pateikti guard now arms only while automation drives the page
  (`withAutomation`, `safePage.js`); the machine still never presses it (RULES.md Rule 1).
  *Direction (not in force):* move step by step to automatic submission, with the human check
  moving to the dispatch email — the email is the gate that lets the terminal load a truck.
  Needs an explicit change to Rule 1 by the operator before any automation targets Pateikti.
- **D11. The dispatch email is sent from the dashboard** — decided 2026-11-10, replacing D7's
  IMAP Drafts (every office PC reads terminal@bpa.lt over POP3, which never shows server-side
  Drafts; the office uses Outlook). The operator opens the preview (Email button on a submitted
  truck), checks recipients, text and the PRK PDF, may edit the text or switch RoRo/KKT, and
  presses Send; PortSystem sends it over SMTP. Fits D5 (browser) and D8 (the email is the human
  gate). SECURITY.md §5 updated.
- **D10. No PRK PDF copies kept on the PC** — decided 2026-11-10. The PRK lives in KIPIS and in
  the dispatch email; A19 fetches the PDF only to attach it to the email draft and keeps no file
  (A19a "save the PDF" is folded into A19b).
- **D9. Transwina buys from Helm** — 2026-11-10. Companies with no release line of their own get
  a "Buys from" seller on the Lots & owners page (`config/owners.json`).
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
| Autonomy | ~~Propose, human confirms~~ → **automatic daily cleanup of drafts 2+ days old**, approved in advance by the operator (2026-11-10); every deletion logged |

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
- ~~The actual `Šalinti` click~~ and ~~a dashboard UI~~ — **BUILT 2026-11-10** (operator: a
  button; only PortSystem's drafts; keep drafts for later trucks; no second approval — the press
  is the approval; RULES.md Rule 7 updated). `KIPIS_skills/PRK/prkDelete.js`: open by number via
  Universali paieška (verified live, read-only), header must show that number + Ruošiamas, derive
  the `:1:` sibling of Pateikti and click it only if labelled `Šalinti`, same in the confirm
  dialog (reason filled), check the header no longer shows the draft. `sweepDrafts`: KIPIS PRK
  list → Ruošiamas drafts whose number PortSystem saved on an order **2+ days old**
  (operator, 2026-11-10: "leave them hanging and auto delete in two days if unused — we never
  use PRKs older than two days, it is always for today or tomorrow"). **Runs by itself** once a
  day, the first time after 06:00 that KIPIS is open and idle; retried hourly until a complete
  run; last run in `data/prk_cleanup.json`, shown under "Waiting for you" with *Run cleanup now*
  (`orderStore.prkNumbersFiled`, history "PRK draft saved" — a PRK merely found in KIPIS is
  excluded) → delete one by one, stop at the first failure; each deletion logged to
  `data/prk_deletions.jsonl` and its order set `cancelled`. Dashboard: *Run cleanup now* (with a
  browser confirm) and the last run's result. Mock-tested (deletes on the real layout; refuses swapped buttons and
  submitted documents; Pateikti never pressed). **Live 2026-11-10:** the full PRK list is past
  KIPIS's 500-row cap, so the sweep first sets the list's *Būsenos* filter to Ruošiamas (27
  drafts: 14 PortSystem's, 13 colleagues' back to 2019 — left alone). `POST /prk/delete` (one
  draft, same gates) refused a colleague's draft and deleted GRJ153//FF276's 261110-003794-PRK:
  searching it afterwards gives KIPIS's error page and it left the Ruošiamas list. The truck was
  re-filed as 261110-003968-PRK. The dashboard button itself has not been pressed yet.
  Matching is now by PRK number (captured at save, A4), not plate. Open: orders have no due
  date; the age is the order's arrival day. Needs KIPIS open (MFA) to run — a day with KIPIS
  closed is caught up the next time it is open.

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

