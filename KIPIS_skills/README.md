# KIPIS_skills

Home for the agents that fill KIPIS documents. One subfolder per document type.

> **Read [RULES.md](RULES.md) before any KIPIS automation.** The key rule: automation may go up
> to `Saugoti` (save draft) — **only a human may press `Pateikti`**.

## Document types

| Folder | Document | Status |
|---|---|---|
| [PRK/](PRK/) | Prašymas krovai — loading request | Fill + save implemented (Playwright); read-only list/delete-eligibility reader built, `Šalinti` execution not yet |
| [PVZ/](PVZ/) | PVZ | Not started |
| [BDK/](BDK/) | BDK | Not started |
| [VZT/](VZT/) | Važtaraštis — waybill | Not started |

These four are the main daily documents. Rarer document types come later.

## How a document type gets built

1. **Drive it with the Claude Code skill.** `/kipis-fill` opens KIPIS with Playwright and fills
   the document interactively, consulting RULES.md first.
2. **Record every step** (page, selector, action, value) into that document's `steps.md`.
3. **Turn the recorded steps into a deterministic algorithm** — plain Playwright code, no AI in
   the filling path.
4. **Demote the AI to checker.** Once the non-AI algorithm exists, AI is used *only* to verify
   the document was completed correctly (up to `Saugoti`), not to fill it.

That progression is deliberate: AI explores and documents, code executes, AI verifies.

## Layout of a document folder

```
PRK/
  navigateToCargo.js   deterministic filler (Playwright)
  kipisLoad.js         workflow runner for one plate
  checkPrk.js          AI completion checker (up to Saugoti)
  exportPrkList.js      reads the KIPIS document list (Prašymai krovai) live, no download
  prkLedger.js          Rule 7 deletion-eligibility gate (findDeletable)
  steps.md             recorded steps → basis for the algorithm
  maps/                pageScanner output for the relevant KIPIS pages
```

`safePage.js` (the Pateikti guard) lives one level up, in `KIPIS_skills/`, since it applies to
every document type, not just PRK.
