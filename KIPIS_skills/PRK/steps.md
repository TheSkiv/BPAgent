# PRK — recorded steps

Steps the deterministic algorithm (`navigateToCargo.js`) performs. Keep this in sync with the
code — it is the human-readable spec of the non-AI algorithm.

> Boundary: this flow ends at **`Saugoti`** (save draft). **`Pateikti` is never pressed** — see
> [../RULES.md](../RULES.md).

## Inputs

From today's orders Excel row, matched by exact plate (`findRowByPlate`; several rows for one plate → the order's cargo and received time pick one, A6):
`Plate`, `Cargo`, `Weight`, `Bulk`, `Sender`. **Whose cargo and which vessel** (`owners.resolveOrder`):
the sender's company → its buyer name in the Helm release'ai / Yara perdavimai lists → that
release's seller and vessel(s); no release and the company loads its own cargo
(`config/owners.json`, e.g. Agrokoncernas) → its own confirmed lots' vessels. Anything else
stops and is set on the **Lots & owners** page (`/lots.html`). Lot owners: `config/lots.json`.

## Steps

| # | Page | Action | Selector | Value | Notes |
|---|---|---|---|---|---|
| 1 | Home | click | `text=Sekimas` | — | |
| 2 | Sekimas | click | `text="Kroviniai"` | — | |
| 3 | Kroviniai | fill | `[id$=":fAtgabenimoDokumentas"]` | `""` | cleared — the vessel is **not** searched here (see below) |
| 4 | Kroviniai | fill | `[id$=":fPavadinimas"]` | cargo keyword | most specific first: formula (`11-11-21`) → order words except brand/filler `broadWords` (`AXAN`, not `YARA`) → synonyms' words → broad words; matches anywhere in the name |
| 5 | Kroviniai | fill | `[id$=":limit"]` | `500` | default 50 can cut lots off |
| 6 | Kroviniai | click | `input[type=submit][value="Filtruoti/Atnaujinti"]` | — | apply filters; next keyword if no row matches or the result hits the 500-lot cap |
| 7 | Kroviniai | read | `thead tr:last th` | — | **leaf** header row = column order of body `<td>`s |
| 8 | Kroviniai | select row | — | — | see row-selection rules below |
| 9 | Kroviniai | click | row `input[type=checkbox]` | — | tick the chosen lot's **storage** row |
| 10 | Kroviniai | click | `input[type=button][value="Krauti"]` | — | opens popup |
| 11 | Popup | select | `#krova_tag_krauti select` (2nd) | `Klaipėdos konteinerių terminalas, UAB` | terminal |
| 12 | Popup | click | `input[type=submit][value="Krauti"]` | — | opens PRK form |
| 13 | PRK form | wait | role textbox `originalaus dokumento numeris` | — | **left empty** (operator, 2026-11-09; used to carry the plates) — only waited on as the "form loaded" signal; read-back checks it is empty |
| 14 | PRK form | fill | role textbox `kita procedūra` | `" "` | single space |
| 15 | PRK form | fill | `[id$=":moketojas:subjf-kodas"]` | `LT242134730` | payer code |
| 16 | PRK form | fill | `[id$=":moketojas:subjf-pav"]` | `UAB "BPA"` | payer name |
| 17 | PRK form | fill | `[id$=":prkr_info:instrukcijos"]` | instructions | see instruction rules |
| 17b | PRK form | select | `[id$=":prkr_info:siuntejas:subjf-valst"]` | `Lietuva` | only when empty — Pateikti is refused without the sender's country (operator, 2026-11-10) |
| 17a | PRK form | select | `[id$=":prkr_info:gavejas:subjf-valst"]` | company's *Receiver country* | only when empty and the company has the setting (Agrokoncernas → Lietuva); KIPIS will not open the Kroviniai tab without it ("Valstybė: Reikšmė privaloma"). Receiver code/name/address stay empty |
| 18 | PRK form | check | label `krovos darbų aktą tvirtinti automatiškai` | ✓ | |
| 19 | PRK form | check | label `generuoti važtaraštį automatiškai` | ✓ | |
| 20 | PRK form | click | role button `pridėti` (first) | — | per plate: add transport |
| 21 | Transport | fill | role textbox `markė` | `" "` | |
| 22 | Transport | fill | role textbox `numeris` | plate, single slash (`KPB950/GV865`) | the orders write `//`; KIPIS and people search with one slash (2026-11-10) |
| 23 | Transport | click | role button `saugoti` | — | saves the transport row |
| 24 | PRK form | click | `a[onclick*="prkr_kroviniai"]` | — | Kroviniai tab |
| 25 | Kroviniai tab | fill | row input 0 (`name*="prkr_kroviniai"`, `:0:`) | weight + bags | Svoris bruto |
| 26 | Kroviniai tab | fill | row input 2 | bags | Vietų skaičius — bagged only; BULK leaves it empty (owner, 2026-11-12) |
| 27 | — | **AI check** | `checkPrk.js` | — | verify against source data — bagged only; BULK saves on the field read-back (owner, 2026-11-12, S52) |
| 28 | PRK form | click | `input[type=submit][value="Saugoti"]:visible` (last) | — | **STOP HERE** |
| 29 | PRK form | wait/read | text `Prašymas krovai: <nnnnnn-nnnnnn-PRK>, Ruošiamas, …` | — | proof of save + PRK number (`confirmSaved`); missing or not Ruošiamas → order failed |
| 30 | PRK draft | click | the lot link (*Siuntos numeris*, `a` with text e.g. `260924-001330-L`) | — | **bagged only** — opens the cargo line, "KIPIS - Krovinys", same window |
| 31 | Cargo line | select | `[id$=":kr_informacija:pakuotesRusis"]` | option starting `43, Krepšys` | default `NE, Nesupakuota`; Pateikti is refused without it (operator) |
| 32 | Cargo line | click | `input[type=submit][value="Saugoti"]:visible` | — | stores it in the document only: "Informacija apie krovinį išsaugota, nepamirškite išsaugoti dokumento!" — back on the PRK |
| 33 | PRK draft | click + read | Saugoti (last visible), then `confirmSaved` | — | saves the document; then the cargo line is reopened to read `43` back, and Atgal. A failure leaves the draft saved and marks the truck "set the packaging by hand" |

## Row selection (step 8)

The results table groups rows by shipment via **rowspan**:

- The **parent** row carries all leaf columns; **sub-rows omit the leading columns**, so a
  sub-row's cells are shifted left by `offset = leafHeaderCount - cellCount`, and a sub-row
  belongs to the lot (*Siuntos numeris*) of the parent row above it.
- **Vessel:** keep rows whose *Transportas* cell names one of the order's vessels (from its
  release, or the self-loader's own lots), as a whole word
  (`Laivas ULSAN 1078092, Maršalo s.`). Neither the *Atgabenimo dokumentas* nor the
  *Atgabenęs transportas (pavadinimas)* filter found ULSAN (2026-11-09), so the vessel is matched
  in the results, not in a filter.
- **Cargo:** keep rows whose *Pavadinimas* is the ordered cargo (`sameCargo`: either name starts
  the other, same NPK formula, or same synonym group) — a vessel can carry two cargoes.
- **Already filed (Rule 6):** a row of this cargo, on any vessel, whose *Krauti/pakrauta į* is
  `Autotransportas <plate>` (KIPIS writes `MLL371/RZ817`) and whose last document is dated today
  or the 2 days before — any type: `PRK`, or `VZT` / `KDA` once submitted and loaded → stop,
  report it, file nothing. Older documents are the truck's earlier trips.
- **Loadable = in our storage** (operator rule, 2026-11-09): *Krauti/pakrauta į* is
  `Saugojimo vieta — Vieta Ro-Ro ir generalinių krovinių terminalo sandėlis, Minijos g. 180` or
  `Saugojimo vieta — Vieta Konteinerių terminalo sandėlis, Perkėlos g. 8`. Rows loading to
  *Autotransportas* / *Vagonai* are other loads — ignored. (Replaces the old rule "last document
  contains IMP, not VZT/KDA": these lots have PTA/PRK last documents and no IMP at all.)
- **Which lot** (`lotRegistry.chooseLot`): a KIPIS lot is an **ownership** unit — it can hold BB
  and bulk across both terminals, and KIPIS shows neither its owner nor its packaging (operator,
  2026-11-10). Every candidate lot's owner must be confirmed on the Lots & owners page (suggested
  from the stock reports by weight), else stop. Among the order owner's lots: the operator's
  loading order (`#`), else the lot trucks are already loading from, else the oldest lot number —
  the first that still holds one truck's gross weight. Packaging comes from the order only.
- **Cargo names in KIPIS vary** — e.g. OSLO CARRIER 2's TSP is `Trąšos - TSP low Cd ''CE
  Fertilizers''`. When a vessel's lot is not found, look with `GET /kipis/lots?q=<word>&v=<vessel>`
  (read-only) and add the spelling to a group in `config/cargo_synonyms.json`.
- Never set the `Buvimo vieta` filter — it over-constrains and returns zero rows.

## Derived values

```
bagKg       = bag size from the order's cargo text — "(500)", "(600)", "po 600 kg";
              600 when none is written (500 kg is rare but real)
bags        = round(orderWeight / bagKg)
grossWeight = orderWeight + bags
```

## Correcting the plates on a saved draft (`setTransportPlates`) — S59, 2026-11-13

Our own `Ruošiamas` draft only, opened with `openFromDraftList` (KIPIS confirms the status). The
transport table is `tbody[id*=":prkr_info:transportas:"][id$=":tbody_element"]`: one row per truck,
columns ☐ · Registruota įmonėje · Tipas · Markė · **Numeris** (a link) · Valstybė · Vairuotojai ·
Pagrindinis transportas. Seen live on `261113-001050-PRK`: one row, Numeris `MML745`, Tipas Vilkikas.

| # | Action | Target | Check |
|---|---|---|---|
| 1 | read | transport rows' Numeris | exactly one row (more → stop); already the new plates → nothing to do |
| 2 | check | that row's checkbox (tbody, not the select-all in thead) | — |
| 3 | click | `input[type=button][value="Šalinti"][onclick*="transportas_jspf_remove"]` | the transport section's button, not the document's |
| 4 | click | `#transportas_jspf_remove input[type=submit][value="Šalinti"]` | its `name` must contain `:prkr_info:transportas:` — else stop |
| 5 | read | transport rows | none left |
| 6 | click | `input[type=submit][value="Pridėti"][name*=":prkr_info:transportas:"]` | — |
| 7 | fill | Markė `" "`, Numeris `ABC123/DEF456` (one slash) → Saugoti | as in filing (steps 18–21) |
| 8 | read | transport rows | exactly one, the new plates — else stop, nothing saved |
| 9 | click | document `Saugoti` (last visible) → `confirmSaved` | same number, still Ruošiamas, new plates shown |

Never on a `Pateiktas` / later PRK or one a person made (refused before KIPIS is opened).

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

**Built 2026-11-10** (`prkDelete.js`): `openFromDraftList` opens a draft the way a person does —
the PRK list with *Būsenos* = Ruošiamas, then its number, a link in the *KIPIS numeris* column — so
KIPIS also confirms it is still Ruošiamas right before deleting; the header is read once it names
the document (it renders late). Buttons seen live: `_id3:_id4602:0:_id4603` Pateikti / `…:1:…`
Šalinti. (`openDocument` via the **Universali paieška** dialog — `input.ieskojimoMygtukas` →
`[id$=":ieskomasNumeris"]`, Tab → "Ieškoti" — works sometimes but often lands on "Užklausa
negalioja…": not used for deleting.) `deleteDraft` follows the procedure below; `sweepDrafts` runs it for every PortSystem draft whose order is 2+ days old — daily, by
itself (server), or via the dashboard's *Run cleanup now*. The list is read with the *Būsenos*
filter set to Ruošiamas (the full list is past KIPIS's 500-row cap).

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

1. Match in `Instructions.xlsx` → use that text. Several rows for one cargo → the row whose
   `Cargo Type` fits the truck (Bulk / BB), else a row with no type.
2. No match + BULK → leave blank.
3. No match + non-BULK → default bagged-goods text (`DEFAULT_INSTRUCTIONS`).
