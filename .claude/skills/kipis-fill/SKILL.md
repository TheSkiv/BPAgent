---
name: kipis-fill
description: Fill a KIPIS document (PRK, PVZ, BDK, VZT) with Playwright, recording every step so it can be turned into a deterministic non-AI algorithm. Use when asked to fill, draft, or explore a KIPIS document, or to build/extend automation for a KIPIS document type.
---

# Filling KIPIS documents

Drive KIPIS with Playwright to fill a document, recording each step so the run can later be
replayed as plain code without AI.

## STEP 0 — Read the rules first (mandatory)

**Read `C:\PortSystem\KIPIS_skills\RULES.md` before doing anything else.** Do not skip it, do not
work from memory of it. It is short and it governs everything below.

The rule that matters most:

> Automation may go up to and including **`Saugoti`** (save draft).
> **`Pateikti` is HUMAN-ONLY — never click it, never script it, never delegate it.**

If a flow seems to need `Pateikti`, stop and hand back to the human.

## Document types

| Code | Document | Folder |
|---|---|---|
| PRK | Prašymas krovai (loading request) | `KIPIS_skills/PRK/` |
| PVZ | PVZ | `KIPIS_skills/PVZ/` |
| BDK | BDK | `KIPIS_skills/BDK/` |
| VZT | Važtaraštis (waybill) | `KIPIS_skills/VZT/` |

PRK is already implemented — read `KIPIS_skills/PRK/navigateToCargo.js` as the reference
pattern before building a new type.

## Workflow

1. **Read RULES.md.**
2. **Open KIPIS.** The server exposes `POST /open-kipis` (port 3001), which launches the
   Playwright browser and logs in, reusing the profile at `C:\PortSystem\session`. Reuse the
   existing page via `src/core/browser.js` `getPage()` — do not launch a second browser.
3. **Map the page before touching it.** Use `src/tools/pageScanner.js`
   (`scanCurrentPage` / `deepScanTabs`) to dump every field, id, name and label. Save output to
   the document type's `maps/` folder. KIPIS is JSF: ids like `_id4:…` are session-generated and
   unstable — prefer suffix selectors (`[id$=":fPavadinimas"]`), roles, and label text.
4. **Fill the form**, one field at a time, from real source data only (RULE 4 — never invent
   values).
5. **Record every step** into the document type's `steps.md` as you go:

   ```
   | # | Page | Action | Selector | Value | Notes |
   |---|------|--------|----------|-------|-------|
   | 1 | Kroviniai | fill | [id$=":fAtgabenimoDokumentas"] | <vessel> | vessel filter |
   ```

6. **Verify before saving.** Check the filled form against the source data. For PRK, reuse
   `KIPIS_skills/PRK/checkPrk.js` → `checkPrkCompletion(page, expected)`.
7. **Save the draft** with `Saugoti`. **Stop there.** Report the result and leave `Pateikti`
   to the operator.
8. **Promote to code.** Once `steps.md` is complete and stable, write a deterministic Playwright
   module in the document folder. From then on AI is only the checker, never the filler.

## Gotchas learned from PRK

Filling the document:
- The Kroviniai results table has a **two-level header**; body `<td>`s align with the *leaf*
  header row, not the flattened `thead th` list.
- Rows use **rowspan grouping** — sub-rows omit the leading columns, so cells shift left by
  `(leafHeaderCount - cellCount)`.
- Pick the available lot by **`Paskutinis dokumentas` = IMP**; `VZT`/`KDA` there means already
  dispatched. An `IMP` in *Saugojimo deklaracija* does **not** count.
- Do not filter `Buvimo vieta` — it over-constrains the search and returns zero rows.
- Weight cells are `pradinis/likutis`; take the value after the `/`.

Navigating and reading KIPIS's other list/document screens (found building the PRK-list
reader and end-of-day `Šalinti` sweep — these generalise to every document type):
- **KIPIS navigation is stateful JSF.** `page.goto()` to a list page's URL can land you on a
  completely different screen (e.g. the PRK list's URL renders *Pranešimai* instead). Reach a
  screen the way a human does — click the menu/shortcut — never assume a direct URL works.
- **A button's hidden/visible state does not mean it's unusable or unreachable** — `force`
  clicks or a raw `element.click()` via `evaluate` can still work when a normal click can't
  find a visible target. But treat this as a fallback, not the first attempt.
- **Two similarly-named columns can collide under a loose regex.** `Krauti iš` (from) and
  `Krauti į` (to) differ by one accented character; a class like `[įi]` matches "iš" for both
  and silently reads the wrong column. Identify such pairs together, then split by the more
  specific one.
- **A row-limit / "max results" field can silently truncate a list.** If the result count
  exactly equals the configured limit, assume truncation, not coincidence — verify or escalate
  the limit rather than trusting the count.
- **JSF action buttons that differ only by index are a trap.** `Pateikti` and `Šalinti` can be
  siblings differing only by `:0:` vs `:1:` in an otherwise identical `name`/`id`. Never select
  by index alone — locate one by its known label, derive the sibling, then **assert the
  derived element's value/label matches what you expect before clicking it**. The `_id…`
  identifiers themselves are session-generated and must never be hardcoded.
- **A page can host multiple controls with the same visible label** doing different things
  (e.g. three different `Šalinti` buttons: delete a saved filter, delete a transport row,
  delete the document). Confirm which section/context a control lives in before wiring it up.
