# Plan: what's left from upstream, and what's left to do

**Status:** v0.5 (2026-09-26). Decisions in §5 and the privacy spec's D1–D4 made by Austin. Nothing in §3 is built. Each PR still needs its own go-ahead to build.
**Fork:** PrecedentPowers/clio-mcp `main` at `db51fdf` (2.1.0, 29 tools): PRs #4 (v2.1 reads), #5 (write-field selection) and #6 (task status restricted to Pending/Complete; smoke script; Desktop-env helper; testing spec with the 2026-09-25 results).
**Upstream:** oktopeak/clio-mcp `main` at `44916ad` (2.3.0). None of its 35 commits since `d85f3be` is in the fork. PR #5 ported the write-field fix by hand.

---

## 1. Decision: drop the full upstream merge

v0.2's Phase B (merge upstream 2.3.0) is **withdrawn** (decided 2026-09-26, §5 #1). What it was for is either done or doesn't apply here:

| Upstream 2.3.0 | Status for this fork |
|---|---|
| Paging on list tools, `list_notes`, write-field selection | **Done**: PRs #4 and #5, live-tested 2026-09-25 (testing spec §H) |
| Regions us/eu/ca/au | **Not needed**: the default US region works (§H, A4) |
| HTTP API key, token broker, library entry point | **Not used**: the connector runs over stdio under Claude Desktop |
| `update_matter`, matter stages, relationships, folders, custom-field tools, `matter_activity_summary` | **Not used** by the Practice Conductor, `conductor-task` or statement-of-account |
| "Unbreak every matter read" (8c617f6) | **Doesn't apply**: it fixed a field string upstream introduced in 2.2.0, which the fork never had |

The cost is unchanged from v0.2: 10 conflicted files, and two silent breakages. The token file format changes (12- vs 16-byte IV), forcing a re-auth, and `requireSessionContext` breaks `clio-export` as the Conductor runs it.

**Consequence:** the fork now diverges from upstream on purpose. Future upstream fixes get ported one at a time, only when they fix something that affects this fork. §4 is the watch list.

---

## 2. Finish the v2.1 round first

These come from the testing spec, §H "Still open". They take priority over §3.

| # | Item | Where |
|---|---|---|
| 1 | **Delete the §G test records** on 04041-Test: task 1617900050, note 3150655445, calendar entry 5174035760, time entry 8824500230, expense 8824500350 | Clio web UI |
| 2 | **Restart Claude Desktop** so the connector serves `main` (C1: the session was still on the pre-v2.1 build) | Mac |
| 3 | **Re-run the B1 smoke on a richer matter**: calls, notes, time and expense entries, tasks, calendar entries. Those checks passed on empty data. | `scripts/smoke-v2.1-reads.mjs` via `scripts/with-desktop-env.mjs` |
| 4 | B′ M1–M7 (cross-check against the Clio UI), C2 live Conductor run, C4, C5 | Testing spec |
| 5 | **W8**: `create_matter` with `originating_attorney_id` and `client_reference`. Those two field names are still not verified live. | Testing spec §G |
| 6 | **W9–W10**: `conductor-task` end to end | Testing spec §G |
| 7 | **`conductor-task` paging (C3):** its duplicate check reads one page of `list_tasks` (25). A matter with more than 25 pending tasks could get a duplicate. It should follow `next_page_token`. | Skill, outside this repo |
| 8 | **statement-of-account v2.1** (spec §5, C6), including the stale lines at `SKILL.md` 286–290 (the 200-row cap; "no matter filter" on calendar) | Skill, outside this repo |

---

## 3. Targeted changes (replace Phase B)

Each is small and needs no upstream merge. **T1 and T2 ship together as one "privacy hardening" PR** (§5 #3). **T3 is in scope**: matters do use dropdown custom fields (§5 #4). It goes in its own PR after the privacy one, because it touches `clio-export` output.

### T1. Keep Clio content out of the audit log (privacy-hardening PR)
**Full spec:** `docs/SPEC-privacy-hardening.md` (v0.2; D1–D4 accepted: search `query` masked, marker `"[omitted]"`, `clio-export` pages deferred to T7, version 2.1.1). Its inventory also found `search_contacts`/`list_documents` `query`, `upload_document` `file_path`, `create_matter` `client_reference`, query strings inside `error_message`, and `audit.log` itself at default permissions.
**Problem:** the README says the audit log holds metadata, "not Clio content". But on `main`, write tools log free text in `args`:
- `create_task`: `name` (`tasks.ts` 128, 151)
- `update_task`: `name`, `description` (193, 217)
- `create_note`: `subject` (`notes.ts` 37, 58)
- `log_time_entry` and `create_activity`: `note` (`activities.ts` 199–313)
- `create_calendar_entry`: `summary` (`calendar.ts` 164, 178)
- `create_matter`: `description` (`matters.ts` 206)

On a criminal defence file those fields can name a complainant or describe instructions. The log is unencrypted (README, Trust Model).

**Fix:** drop the free-text keys from those `args` objects, and log a boolean such as `has_note: true` where knowing a value was supplied helps. Upstream took the same approach with a per-tool allowlist (`auditLog.ts`: `create_note: ["matter_id"]`; `create_task` without `name`). Porting its allowlist machinery isn't needed.
**Test:** one test that runs every write tool with sentinel text in each free-text field and asserts the sentinel never reaches `appendAuditLog`.
**Existing entries — deferred (§5 #2):** this PR fixes logging going forward only. Lines already in `~/.clio-mcp/audit.log` stay as written for now; scrubbing them is a later, separate task (§3 T6). The log is append-only by design (README), so a scrub has to be an explicit one-off script, not a change to the connector.

### T2. Lock down the token file (privacy-hardening PR)
**Problem:** the fork writes `~/.clio-mcp/tokens.enc` with default permissions and creates the folder without a mode (`tokenStorage.ts` 63, 77). Only the key-file fallback gets 0600/0700 (lines 50, 57).
**Fix:** `mkdir` with `mode: 0o700`, `writeFile` with `mode: 0o600`, and `chmod` both on each save so existing installs are tightened. This matches upstream's permissions. **Keep the 16-byte IV**, so no re-auth is needed.
**Test:** save tokens into a temp HOME and assert the file mode is 0600 and the folder is 0700.

### T3. Picklist custom fields read as option ids (own PR, after T1+T2)
**Problem (not verified on your data):** `flattenCustomFields` takes `cfv.value` first (`matters.ts` ~44), and `MATTER_DETAIL_FIELDS` doesn't request `picklist_option`. Upstream (8c617f6) says a picklist's `value` is the option **id**. So any dropdown-type custom field would reach `get_matter` and `clio-export` as a number, not its label.
**Confirm the symptom first:** run `get_matter` on a matter that has a dropdown custom field, and compare `custom_fields` with the Clio UI. Save that output as the "before" fixture for the PR's test.
**Fix:** port upstream's approach narrowly. Take the label from the response when present; otherwise do one read of `custom_fields.json` per call to map option ids to labels. Never present the id as the value. Keep the flat-map shape that `clio-export` consumers expect.

### T4. Longer back-off on rate limits — **optional**
The fork retries 429s 3 times (1, 2 and 4 s; `clioClient.ts` 26). Upstream retries 6 times with jitter, capping at 30 s per wait and 90 s in total. Port it only if statement-of-account sweeps start failing with "rate limit exceeded after 3 retries".

### T5. Tidy-ups — **optional, with the next code change**
- `create_matter` requests `MATTER_DETAIL_FIELDS` on create, which pulls `client.date_of_birth` and custom fields it doesn't return. Use a lean write field set.
- The legacy `list_time_entries` still returns a bare array with no paging. Leave it until nothing calls it, then remove it.

### T7. Lock down `clio-export` pages — **follow-up** (privacy spec D3)
`clio-export` writes its matter pages, including client `date_of_birth`, with default permissions (`cli/export.ts` 92, 97). **Before changing it:** confirm how the Practice Conductor reads `--out-dir`, because a sandbox mount or a different user id could lose read access at 0600. Then write the pages at 0600 and create the folder at 0700 when the export creates it. Test: one scheduled Conductor run reads the pages.

### T6. Scrub existing audit-log entries — **deferred** (§5 #2)
After T1 merges, a one-off script (not part of the connector) could rewrite `~/.clio-mcp/audit.log` to drop the free-text `args` keys T1 stops logging. Before running it, back up the original somewhere encrypted, and decide whether the original is kept or destroyed. Not scheduled.

---

## 4. Upstream watch list

Port from upstream only for these kinds of change, each as its own PR:
- security fixes to token storage, OAuth or the stdio transport;
- Clio API fixes to endpoints the fork calls (matters, contacts, documents, tasks, calendar, activities, notes, communications, users, billing);
- live-verified field-name corrections.

To check for new upstream commits: `git fetch upstream && git log --oneline 44916ad..upstream/main`.

---

## 5. Decisions (Austin, 2026-09-26)

| # | Question | Decision |
|---|---|---|
| 1 | Withdraw the full upstream merge and run the fork as a deliberate divergence | **Yes.** Phase B is withdrawn (§1); upstream is ported per the watch list (§4) |
| 2 | T1: also scrub existing audit-log entries? | **Fix later.** T1 fixes logging going forward; the scrub is deferred (T6) |
| 3 | T1 and T2 as one PR or two | **One PR** ("privacy hardening") |
| 4 | Do matters use dropdown custom fields? | **Yes.** T3 is in scope as its own PR |

## 6. Order

1. Finish the v2.1 items in §2 (test-record cleanup, restart Desktop, the rich-matter smoke run, W8–W10).
2. **PR: privacy hardening** (T1 + T2, version 2.1.1): **built** on `claude/pensive-cerf-om7l6c`, per `docs/SPEC-privacy-hardening.md` v0.3; live checks L1–L7 pending. Gates: `npm test`, `npm run build`, the sentinel audit test and the file-mode test. Live check: one write, then `tail` the audit log to confirm no free text, and `ls -l ~/.clio-mcp` to confirm the permissions.
3. **PR: picklist labels** (T3). Gates: unit tests with the "before" fixture. Live: `get_matter` and one `clio-export` run on the dropdown matter, checking that labels show, not ids, and the flat-map shape is unchanged for the Conductor.
4. **T7** (`clio-export` page permissions), once the Conductor's read path is confirmed.
5. T4, T5 and T6 only as needed.
