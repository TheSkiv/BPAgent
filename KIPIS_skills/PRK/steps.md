# PRK — recorded steps

Steps the deterministic algorithm (`navigateToCargo.js`) performs. Keep this in sync with the
code — it is the human-readable spec of the non-AI algorithm.

> Boundary: this flow ends at **`Saugoti`** (save draft). **`Pateikti` is never pressed** — see
> [../RULES.md](../RULES.md).

## Inputs

From today's orders Excel row, matched by plate (`findRowByPlate`):
`Plate`, `Cargo`, `Weight`, `Bulk`. Vessel resolved via 3-tier lookup: BPA stock API →
`config/cargo.xlsx` → `Instructions/Instructions.xlsx`.

## Steps

| # | Page | Action | Selector | Value | Notes |
|---|---|---|---|---|---|
| 1 | Home | click | `text=Sekimas` | — | |
| 2 | Sekimas | click | `text="Kroviniai"` | — | |
| 3 | Kroviniai | fill | `[id$=":fAtgabenimoDokumentas"]` | vessel name | from vessel lookup |
| 4 | Kroviniai | fill | `[id$=":fPavadinimas"]` | cargo name | skipped if empty |
| 5 | Kroviniai | click | `input[type=submit][value="Filtruoti/Atnaujinti"]` | — | apply filters |
| 6 | Kroviniai | retry | clear `[id$=":fPavadinimas"]` | — | only if 0 rows; re-filter on vessel alone |
| 7 | Kroviniai | read | `thead tr:last th` | — | **leaf** header row = column order of body `<td>`s |
| 8 | Kroviniai | select row | — | — | see row-selection rules below |
| 9 | Kroviniai | click | row `input[type=checkbox]` | — | tick chosen lot |
| 10 | Kroviniai | click | `input[type=button][value="Krauti"]` | — | opens popup |
| 11 | Popup | select | `#krova_tag_krauti select` (2nd) | `Klaipėdos konteinerių terminalas, UAB` | terminal |
| 12 | Popup | click | `input[type=submit][value="Krauti"]` | — | opens PRK form |
| 13 | PRK form | fill | role textbox `originalaus dokumento numeris` | plates joined `, ` | |
| 14 | PRK form | fill | role textbox `kita procedūra` | `" "` | single space |
| 15 | PRK form | fill | `[id$=":moketojas:subjf-kodas"]` | `LT242134730` | payer code |
| 16 | PRK form | fill | `[id$=":moketojas:subjf-pav"]` | `UAB "BPA"` | payer name |
| 17 | PRK form | fill | `[id$=":prkr_info:instrukcijos"]` | instructions | see instruction rules |
| 18 | PRK form | check | label `krovos darbų aktą tvirtinti automatiškai` | ✓ | |
| 19 | PRK form | check | label `generuoti važtaraštį automatiškai` | ✓ | |
| 20 | PRK form | click | role button `pridėti` (first) | — | per plate: add transport |
| 21 | Transport | fill | role textbox `markė` | `" "` | |
| 22 | Transport | fill | role textbox `numeris` | plate | |
| 23 | Transport | click | role button `saugoti` | — | saves the transport row |
| 24 | PRK form | click | `a[onclick*="prkr_kroviniai"]` | — | Kroviniai tab |
| 25 | Kroviniai tab | fill | row input 0 (`name*="prkr_kroviniai"`, `:0:`) | weight + bags | Svoris bruto |
| 26 | Kroviniai tab | fill | row input 2 | bags | Vietų skaičius |
| 27 | — | **AI check** | `checkPrk.js` | — | verify against source data |
| 28 | PRK form | click | `input[type=submit][value="Saugoti"]:visible` (last) | — | **STOP HERE** |

## Row selection (step 8)

The results table groups rows by shipment via **rowspan**:

- The **parent** row carries all leaf columns; **sub-rows omit the leading columns**, so a
  sub-row's cells are shifted left by `offset = leafHeaderCount - cellCount`.
- Read `Paskutinis dokumentas` at `leafIndex - offset`.
- **Eligible** = that cell contains `IMP` and does **not** contain `VZT` or `KDA`
  (`VZT`/`KDA` = already loaded onto a truck). An `IMP` in *Saugojimo deklaracija* does not count
  — only the `Paskutinis dokumentas` column.
- Among eligible rows pick the largest `Svoris bruto, kg`; warn if below 24 000 kg.
- Never set the `Buvimo vieta` filter — it over-constrains and returns zero rows.

## Derived values

```
bags        = round(orderWeight / 600)
grossWeight = orderWeight + bags
```

## Deleting a saved draft (`Šalinti`) — end-of-day sweep

Mapped from `krova/prasymas-krovai.jsp` on a real `Ruošiamas` draft (`260720-005851-PRK`).

**`Šalinti` only exists after `Saugoti`** — there is no document to delete before that.

### ⚠️ Three different `Šalinti` buttons live on this page

| Section | Name attr | Deletes |
|---|---|---|
| `Krova` → *Į autotransportą* (visible) | *(none)* | a **transport row**, not the document |
| `Patvirtinkite operacijos vykdymą` (hidden) | `…:prkr_info:transportas:_id986` | confirms the transport-row deletion |
| **`Prašymas krovai`** (visible) | **`…:_id4598:1:_id4599`** | **the document** |
| `Patvirtinkite operacijos vykdymą` (hidden) | `…:_id4598:1:old:_id4700` | confirms the document deletion |

### ☠️ `Pateikti` and `Šalinti` are siblings differing only by index

```
…:_id4598:0:_id4599  → Pateikti   (submit — HUMAN ONLY, RULES.md Rule 1)
…:_id4598:1:_id4599  → Šalinti    (delete draft)
```

An off-by-one submits a customs document instead of deleting a draft. **Never select these by
index alone.** The `_id…` numbers are JSF session-generated and change between sessions, so they
must never be hardcoded either.

### Safe selection procedure

1. Locate the visible **`Pateikti`** button in the `Prašymas krovai` action bar and read its
   `name` (do not click it — the guard blocks it anyway).
2. Derive the sibling by replacing `:0:` with `:1:` in that name.
3. **Assert the derived element's `value` is exactly `Šalinti`** before clicking. If it is not,
   abort.
4. Confirm the page header shows the expected document number and `Ruošiamas` status.
5. Click `Šalinti`, then click `Šalinti` again in the `Patvirtinkite operacijos vykdymą` dialog.

## PRK list scraper (`exportPrkList.js`) — validated

Reads the **Prašymai krovai** list directly from the rendered DOM table — no download needed
(an XLS-export path was tried and dropped: same data, more moving parts, and it could not
reach the list via direct URL either).

- **Navigation is stateful JSF** — `page.goto()` to the list URL lands on *Pranešimai*
  instead. Reach it the way a human does: the left-hand **Prašymai krovai** shortcut, falling
  back to **Krova → Prašymai krovai** in the top menu.
- **`Krauti iš` vs `Krauti į`**: a loose regex class matches "iš" for both columns and both
  resolve to the source. Identify the pair, then split by which one contains "iš".
- **Row-limit truncation**: the *Maks. įrašų skaičius* field caps results server-side. Matching
  exactly that many rows means the tail is invisible, not that today happens to have that many
  documents. `readFullPrkList()` re-queries with a higher limit until untruncated, up to 5000.
- **Validated against a live draft**: `260720-005851-PRK` (Ruošiamas, plate `KPN123/KP123`)
  was correctly found and correctly blocked by Rule 7 (`no matching PortSystem order today` —
  it was hand-made, not machine-filed).
- **Known gap**: matching is plate-only. A machine-filed PRK that saved before its transport
  row was added would have no plate and could never match an order, so the sweep could never
  clean it up. Once PRK numbers are recorded at save time (Phase 2 — capture the generated PRK
  document), match on document number too.

Only proceed when all five Rule 7 conditions hold, and only after a human has approved the
proposed deletion list.

## Instructions (step 17)

1. Match in `Instructions.xlsx` → use that text.
2. No match + BULK → leave blank.
3. No match + non-BULK → default bagged-goods text (`DEFAULT_INSTRUCTIONS`).
