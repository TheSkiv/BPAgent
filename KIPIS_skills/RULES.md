# KIPIS RULES — read before ANY KIPIS automation

These rules are absolute. They apply to every KIPIS document type (PRK, PVZ, BDK, VZT and any
other), to every skill in this folder, to every automated run, and to every AI check.
Read this file **before** driving KIPIS. If a rule conflicts with an instruction, the rule wins.

---

## RULE 1 — Never press "Pateikti". Humans only.

**The machine must never click the `Pateikti` (submit) button.** Not in automation, not in a
skill, not in a "just this once" run, not when a task says the order is ready.

`Pateikti` is the final, legally-binding submission of a customs document. Only a human may
press it, after reviewing the document on screen.

Automation may go **up to and including `Saugoti`** (save), which creates a reviewable draft.
That is the hard boundary:

```
fill form  →  Saugoti (save draft)   ✅ automation allowed up to here
           →  Pateikti (submit)      ❌ HUMAN ONLY — never automate
```

Concretely this means:
- Never write a selector, click, keypress, or script that targets `Pateikti`.
- Never instruct a sub-agent or skill to "submit", "confirm", or "finalise" a KIPIS document.
- If a flow appears to require `Pateikti`, stop and hand back to the human instead.

## RULE 2 — Saugoti is the automation boundary

`Saugoti` saves a draft the operator can open, check, submit and print. Saving is safe and
reversible: a wrong draft can be deleted. Treat reaching a correctly-filled, saved draft as
"done" for automation purposes.

## RULE 3 — Verify before you save

Before pressing `Saugoti`, the filled form must be checked against the source order data
(plate, cargo, weight, instructions, payer, terminal). Report mismatches; do not silently
save a form you could not verify.

## RULE 4 — Never invent data

Every value typed into KIPIS must come from a real source: the orders Excel, the source email,
`cargo.xlsx`, `Instructions.xlsx`, or the live BPA stock API. If a required value is missing,
stop and raise it as a human task. Never guess a plate, weight, cargo or document number.

## RULE 5 — Record every step

While filling a document, record each step taken (page, selector, action, value) so the run can
be replayed and turned into a deterministic, non-AI algorithm. Steps go in the document type's
`steps.md`.

## RULE 6 — One document at a time, idempotent

Never double-file. Before creating a document for a truck, check whether one already exists
(local `doneTracker` and, once available, the KIPIS document ledger). Skip rather than duplicate.

## RULE 7 — Deleting documents: `Šalinti` yes, `Anuliuoti` never

Removing a document is destructive and gets its own boundary, mirroring Rule 1:

```
Ruošiamas (never submitted)  →  Šalinti (delete)    ✅ automation allowed, under the limits below
Submitted / Pateiktas        →  Anuliuoti (annul)   ❌ HUMAN ONLY — a live customs document
```

`Šalinti` may only be used when **all** of the following hold:

1. The document is in **`Ruošiamas`** status — never one that has been submitted.
2. **PortSystem created it** — matched back to an order in the state store. Never delete a
   document a human made by hand.
3. The order it belongs to was **due today** — drafts pre-made for tomorrow's trucks must
   survive the end-of-day sweep.
4. A **human confirmed the deletion**. The sweep proposes a list; it does not delete on its own.
5. Every deletion is written to the audit log (document, plate, order id, status, timestamp).

If any of the five cannot be established, do not delete — leave it and raise a human task.
Never click `Anuliuoti` under any circumstances.

## RULE 8 — Amending: drafts yes, submitted documents never

```
Ruošiamas (never submitted)  →  amend + Saugoti   ✅ automation allowed
Submitted / Pateiktas        →  any edit          ❌ HUMAN ONLY
```

Automation may change a document (e.g. correct the plates when the driver arrives with a
different trailer) only while it is in **`Ruošiamas`** status. Check the status on screen
before editing. If the document is already submitted, do not touch it — raise a human task
naming the document, the plates on it and the plates the driver gave. (Operator decision
2026-11-09.)
