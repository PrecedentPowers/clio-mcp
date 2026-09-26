# SPEC — dropdown (picklist) custom fields show labels, not option ids (plan T3)

**Status:** DRAFT v0.1 (2026-09-26). Not built; needs a go-ahead.
**Base:** `main` at `af630ff` (2.1.1). Line numbers below are from that commit.
**Plan:** `docs/PLAN-upstream-port-and-merge.md` §3 T3. In scope because matters use dropdown custom fields (§5 #4). Its own PR, because it changes what `clio-export` writes.

---

## 1. The problem

`get_matter` and `clio-export` turn Clio's `custom_field_values` into a flat map, e.g. `{ "Docket Number": "ABC-123" }`. This is done by `flattenCustomFields` (`src/tools/matters.ts` 38–51), shared by both. For each value it takes `cfv.value` first (line 44), and only falls back to `picklist_option.option` when `value` is null.

For a **picklist** (dropdown) field, `value` is reportedly the selected option's **id**, not its label:
- Upstream says so in `src/utils/customFields.ts` (commit 8c617f6): "for `picklist` fields it is the selected option's *id*, not its label (e.g. "9002")". That commit fixed a firm's report that its dropdowns read as numbers.
- The Clio OpenAPI copy types `CustomFieldValue.value` as a string without saying what a picklist's string holds. Its matter filter compares picklist fields with `=` against an id (`?custom_field_values[1]=42`), which is consistent with the id reading.

**Not verified on this account.** The fork's own live check (`matters.ts` 21–25, 2026-06-05) covered currency, checkbox and text fields only. §4 step 0 settles it before any code is written.

`MATTER_DETAIL_FIELDS` (line 30) doesn't request `picklist_option`, so the fallback on line 45 never fires. **If the id reading is right, every dropdown value in `get_matter` and in the Conductor's `clio-export` pages today is a number, not what Clio shows.**

---

## 2. Design

### 2.1 Resolve labels from the field definitions; don't touch the matter field string

Two ways to get the label:

| | A. Request `picklist_option` on the matter read | B. Look the id up in `/custom_fields.json` (**recommended**) |
|---|---|---|
| Change to `MATTER_DETAIL_FIELDS` | Add bare `picklist_option` inside `custom_field_values{…}` | **None** |
| Risk | Clio rejects nested braces here with a 400 that takes out *every* matter read: upstream 2.2.0 shipped exactly that. A bare association is reportedly accepted, but the fork's 2026-06-05 check found `custom_field{}` rejected. And whether the bare association even carries the label is unverified (upstream says so). | One extra read, only when a matter has a picklist value. If it fails, only the labels are affected. |
| Extra calls | None | `get_matter`: one paged read of definitions per call, and only when the matter has a picklist value. `clio-export`: at most one per run, reused across pages. |

**Recommendation: B.** It can't break matter reads, which the Conductor depends on. It works whether or not Clio would inline the label.

### 2.2 Mechanics

- **New module `src/utils/picklistLabels.ts`:**
  - `PICKLIST_DEFINITION_FIELDS = "id,name,field_type,picklist_options{id,option}"`. One brace level, on the top-level resource, which is the form upstream uses.
  - `fetchPicklistLabels(parentType: "Matter")` → `Map<optionIdAsString, label>`. It pages `/custom_fields.json?parent_type=Matter&limit=200` with `extractNextPageToken` until done, capped at 10 pages. It includes options that have a `deleted_at`, so a matter still holding a since-deleted option shows its old label.
  - `needsPicklistLabels(cfvs)`: true if any value has `field_type === "picklist"` and a non-null `value`.
- **`flattenCustomFields(cfvs, labels?)`:** same flat `{ name: value }` shape. It gains an optional labels map and returns `{ fields, unresolved }`:
  - Non-picklist fields: unchanged (`value`).
  - Picklist fields: the label from `labels`. **If there's no label, `null`, never the id**, and the field name goes in `unresolved`. A picklist with no selection stays `null` and isn't counted as unresolved.
  - `picklist_option.option` stays as the first choice if Clio ever sends it inline.
  - **Signature break:** `export.ts` line 5 imports this function. Both call sites are updated in this PR. Nothing else imports it (verified by grep).
- **`get_matter`** (`matters.ts` ~120–137): if `needsPicklistLabels`, call `fetchPicklistLabels("Matter")` once. Then:
  - `custom_fields`: the flat map with labels.
  - **`custom_fields_warnings`** (new, only when non-empty): e.g. `["Dropdown label unavailable for: Charge Type. Shown as null, not the option id."]`, or the definitions read failed with its status (a 403 is the known case upstream).
  - `custom_field_values_raw`: **unchanged**. It still carries Clio's raw `value` (the id), for inspection.
- **`clio-export`** (`export.ts` `mapMatter`, ~64–81):
  - One lazily loaded label map per run: fetched the first time any page has a picklist value, then reused for later pages.
  - If that read fails, the export **still completes**. Affected picklists are `null`, the matter carries `custom_fields_warnings`, and one `console.error` line explains why. The export's exit code is unchanged.
  - Page shape: the only change is the optional `custom_fields_warnings` key on a matter, present only when needed.
- **No caching across calls in the server.** The label map lives for one `get_matter` call or one export run. That's simpler, it's correct in HTTP multi-user mode (no cross-firm labels, the same reason upstream gives), and dropdown edits in Clio show up immediately.

### 2.3 Also seen, not in this PR
- **`contact` and `matter` type custom fields** probably hold an id too (the matter filter compares them with `=` against an id, as for picklists). They'd show as numbers the same way. Resolving them needs a contact or matter read per field. See decision D2.
- The README's `get_matter` row doesn't mention `custom_fields`. This PR adds one line saying dropdowns show their label.

---

## 3. Out of scope
- Writing custom fields (upstream's `update_matter`, `create_custom_field`).
- Contacts: the fork's contact tools don't read custom fields.
- Changing `custom_field_values_raw`.

---

## 4. Build steps

0. **Confirm the symptom (live, before any code).** On the Mac: `get_matter` on a matter that has a dropdown set, via Claude Desktop or the Inspector, then compare `custom_field_values_raw` with the Clio UI.
   - **If a picklist's `value` is an id,** save that JSON (with names changed to "ZZ") as the test fixture and continue.
   - **If `value` is already the label,** upstream was wrong for this account. Stop: add one test pinning that behaviour and close T3 with no code change.
   - **Also record:** does `field_type` read `"picklist"`? And does `/custom_fields.json?parent_type=Matter&fields=id,name,field_type,picklist_options{id,option}` return 200? That's a quick curl via `with-desktop-env`, or run it in step 5.
1. Branch from `main`.
2. `picklistLabels.ts` with its unit tests.
3. Change `flattenCustomFields`; update `get_matter` and `export.ts`.
4. Tests (§5), `npm test`, `npm run build`, and a self-review of the diff.
5. Live verification (§6).
6. README line; version bump (D3); PR.

---

## 5. Tests

| # | File | Asserts |
|---|---|---|
| P1 | `src/utils/__tests__/picklistLabels.test.ts` (new) | Paging across 2 pages builds one map; ids are keyed as strings; options with `deleted_at` are included; the page cap stops a runaway loop; the request uses `parent_type=Matter` and the definition fields; **the fields string has exactly one brace level** |
| P2 | same | `needsPicklistLabels`: true only for a picklist with a non-null value |
| P3 | `src/tools/__tests__/matters.test.ts` (extend) | `flattenCustomFields`: text, currency and checkbox are unchanged; a picklist with a label shows the label; a picklist with no label is `null` and in `unresolved`, **and the id never appears**; a picklist with no selection is `null` and not unresolved; inline `picklist_option.option` wins |
| P4 | same | `get_matter`: with no picklist, `/custom_fields.json` is **not** called. With a picklist, it's called once and shows the label. When it 403s, the picklist is `null`, `custom_fields_warnings` is present, the tool doesn't error, and `custom_field_values_raw` is unchanged. |
| P5 | same | **`MATTER_DETAIL_FIELDS` is unchanged**, byte for byte, and has no `picklist_option` or second brace level inside `custom_field_values`. This guards the design decision. |
| P6 | `src/cli/__tests__/export.test.ts` (extend) | Three pages with picklists fetch definitions **once**; a run with no picklists never fetches; a failed definitions read still exits 0, with `null` plus warnings; existing expectations (`"Docket Number": "ABC-123"`) still pass |
| P7 | whole suite | `npm test` and `npm run build` pass, with no existing test weakened, and `auditPrivacy.test.ts` still passes (no new tool inputs) |

---

## 6. Live verification (Mac)

| # | Step | Pass |
|---|---|---|
| L1 | `get_matter` on the step-0 dropdown matter | `custom_fields["<field>"]` equals the label shown in Clio; `custom_field_values_raw` still shows the id; no `custom_fields_warnings` |
| L2 | `get_matter` on a matter with no dropdown value | Same output as before the change |
| L3 | `clio-export` as the Conductor runs it (`with-desktop-env`) | Exit 0; the dropdown matter's page shows the label; pages for matters without dropdowns are unchanged, apart from the dropdown fields themselves |
| L4 | The Conductor's next scheduled run reads the pages | No errors. See D1: anything that matched on the old numeric ids now sees labels. |
| L5 | Audit log tail | The usual `get_matter` / `clio_export_cli` lines; no free text (2.1.1 rules) |

**Rollback:** check out the previous `main` and rebuild. Nothing is stored, so there's nothing to migrate.

---

## 7. Decisions needed

| # | Question | Recommendation |
|---|---|---|
| D1 | Does anything downstream (Conductor prompts, the vault, statement-of-account) match on the **numeric** dropdown values from `clio-export` or `get_matter`? If so, it must switch to labels when this merges. | Check `practice-conductor/SCHEDULED-RUN.md` and the vault's matter notes for dropdown fields before merging. **Needs your answer.** |
| D2 | Also resolve `contact`/`matter` type custom fields to names? | **Not in this PR.** First confirm in step 0 whether any matter uses them and what `value` holds; then a follow-up (T3b). |
| D3 | Version | **2.1.2**: a fix to output values, with no new tool or input |
| D4 | When a label can't be resolved: `null` plus a warning, or keep the id plus a warning? | **`null` plus a warning.** An id reads as data in a brief or an export, and upstream made the same call after a firm's report. |
