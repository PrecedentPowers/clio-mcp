# Testing spec — clio-mcp 2.1.0 read tools

**Covers:** `main` at `af630ff` (2.1.1): the v2.1 read tools (PrecedentPowers/clio-mcp#4), the write-fields fix (#5), the task-status fix and test tooling (#6), and privacy hardening (#7, **merged** as `af630ff` before its live checks ran — §I; spec `docs/SPEC-privacy-hardening.md`); plus the pending branch `fix/export-auth-redaction-guards` (§J).
**Also covers:** §G, the live **write** test for PrecedentPowers/clio-mcp#5 (write-fields fix) — merged.
**Status:** merged **before** live testing. Run this before the Practice Conductor's next scheduled run, because of the calendar/tasks response-shape change (C2, C3).
**Run by:** Austin, on the Mac that hosts the Claude Desktop connector. Every step is read-only against Clio **except §G**, which writes to a test matter, and §I, which writes one test note.
**Pass bar:** every gate below passes, or a failure is written up with a decision and a fix PR.
**This spec lives in the repo at `docs/TESTING-v2.1-reads.md` and is the master copy.**

---

## 0. What changed, and what to watch

| Tool | Change | Risk to existing callers |
|---|---|---|
| `list_communications` | **New.** Emails and calls from Clio's Communications log | None (new) |
| `list_notes` | **New.** Ported from upstream 2.3.0 | None (new). **Settled:** per the "Run testing reads 2.1" session (2026-09-25), Clio accepts both `matter` and `Matter` and returns the same rows; `list_notes` returned 2 of 2 on a matter with notes. |
| `list_activities` | **New.** Time and expense entries, paged | None (new). `list_time_entries` is unchanged. |
| `list_calendar_entries` | Adds `matter_id`, `calendar_id`, `updated_since`, `limit`, `page_token`, plus `location`, `all_day` and `updated_at` in the output | **The response shape changes from a bare array to `{entries, total_count, has_more, next_page_token}`.** The Practice Conductor's scheduled prompts read this output (Gate C2). |
| `list_tasks` | Adds `complete`, `created_since`, `updated_since`, `page_token`, plus `description`, `completed_at`, `created_at` and `updated_at` in the output | **The response shape changes from a bare array to `{tasks, …, next_page_token}`.** Check anything that reads `list_tasks` (Gate C3). |
| `list_documents` | Adds `created_since`, `updated_since`, plus `updated_at` and `received_at` in the output | None. The envelope is unchanged. |

`list_tasks`'s `status` filter now accepts only `Pending`/`Complete` — Clio rejects other values with a 422, live; fixed on branch `fix/task-status-and-test-tooling`. The same restriction applies to `update_task`'s `status` argument.

No write tool changed on `main`/PR #4. PR #5 (§G) and the status fix above do change write tools. `clio-export` and `auth-status` are untouched.

---

## A. Pre-flight and unit gates

The Claude Desktop config points at this repo's `build/index.js`, so **checking out the branch and building swaps the live connector**. Rollback is in §E.

```bash
cd /path/to/clio-mcp            # the folder claude_desktop_config.json points to
git status                      # must be clean; commit or stash local edits first
git checkout main
git pull
npm ci
npm run build                   # A1
npm test                        # A2
```

`npm ci` also repairs OneDrive-broken `node_modules/.bin` links — without it, `npm test`/`npm run build` fail with `../vitest/vitest.mjs: No such file or directory`.

| # | Check | Pass |
|---|---|---|
| A1 | `npm run build` | Exits 0 with no TypeScript errors |
| A2 | `npm test` | **19 files / 181 tests on `main` (`af630ff`)**, **20 / 189 on `fix/export-auth-redaction-guards`** |
| A3 | `node scripts/with-desktop-env.mjs node scripts/smoke-v2.1-reads.mjs --list-only` | `PASS tool registry — 29 tools`. This makes no Clio calls. |
| A4 | Region | Credentials come from Claude Desktop's config (`claude_desktop_config.json`, `mcpServers.clio.env`), not a `.env` file — this Mac has none. No region is set there, so the client defaults to US `app.clio.com`, and that works for this firm (`auth-status` ok, live reads succeed 2026-09-25). If the firm is ever on Clio Canada, set `CLIO_API_BASE=https://ca.app.clio.com/api/v4` (and the matching `CLIO_AUTH_URL`/`CLIO_TOKEN_URL`) in that same Desktop config `env` block. |
| A5 | `node scripts/with-desktop-env.mjs node build/index.js auth-status` | One JSON line with `"ok": true`. If not, authenticate in Claude first. |

---

## B. Live smoke (automated)

### B0. Pick two matters

- **Matter A:** an open file where Tye has **logged both emails and phone calls** in Clio. Ideally it also has notes, time *and* expense entries, open *and* completed tasks, and calendar entries.
- **Matter B:** any matter with **more than 50 documents**, for the paging check. It can be the same as A.

You need the numeric Clio matter IDs (the number in the matter's Clio URL), not the display numbers.

**Recommended matters:** Matter A — 05259 ST.PIERRE (`1885705940`) or 05272 DIOTTE (`1889052575`), each with 2 logged calls and 2 emails (only 2 of the 80 most recent open matters have any calls). Matter B — 04839 DOUGLAS (`1776367339`): 602 documents across 13 pages; 17 emails across 4 pages.

**Firm-wide limitation:** the 48 most recent tasks and all 200 calendar entries in 2026 are not linked to any matter, so per-matter `list_tasks` and calendar `matter_id` checks pass on empty data by construction and can't be proven on real matches here. 04694-BRASETH remains the weak example on this front — good for emails and documents, zero on calls, notes, activities, tasks and matter calendar entries.

### B1. Run

```bash
node scripts/with-desktop-env.mjs node scripts/smoke-v2.1-reads.mjs --matter <A> --docs-matter <B> --since 2025-09-01
```

The script refuses to run unless `auth-status` reports ok, so it can't pop an OAuth window by surprise. It exits 1 if any check fails. Save the output to paste into the PR.

### B2. What each check means

| Check | Pass means | If it fails |
|---|---|---|
| `tool registry` | 29 tools; all 7 read tools present | Stale build → re-run A1 |
| `list_communications EmailCommunication` / `PhoneCommunication` | Every item has the expected type, all fields are present, paging at 5 per page drains with no duplicate ids | A zero count isn't a failure, but it means Matter A isn't a good test file. The type leaking means Clio ignored the filter. |
| `list_communications include_body` | `body` is plain text (no tags), ≤ 200 chars, and `body_truncated` is present | Tags present → the stripHtml path missed a form |
| `body omitted by default` | No `body` key unless it was asked for | — |
| `list_notes` | Returns notes with `date`, `detail` and `author`, and pages cleanly | Casing is settled (§0): Clio accepts both `matter` and `Matter` and returns the same rows; confirmed 2 of 2 on a matter with notes in the "Run testing reads 2.1" session (2026-09-25). |
| `list_activities (both types)` | Both types come back when `type` is omitted | — |
| `TimeEntry + ExpenseEntry = both` | The per-type counts add up to the combined count | A gap is **not a bug**. It means the matter has HardCost/SoftCost entries, which the unfiltered call includes and the spec's type enum doesn't. Note it. |
| `status=unbilled` | No returned entry has `billed: true` | — |
| `list_time_entries unchanged` | Still a bare array | — |
| `list_tasks` | New fields present; pages cleanly | — |
| `complete=true/false` | Completed tasks all have `completed_at`; open ones don't | — |
| `calendar conductor call` | A `from`/`to`-only call works and returns the envelope | — |
| `calendar matter_id filter` | Every entry belongs to Matter A | Entries from other matters → Clio ignored `matter_id` |
| `list_documents paging` | More than one page, no duplicates, drains to the end | "pick a matter with more than 50 documents" → choose another Matter B |
| `list_documents updated_since` | Every returned doc has `updated_at` ≥ since | — |

A zero count on notes, tasks, activities or calendar entries means that check passed on empty data and proved nothing — choose a Matter A that has them. 04694-BRASETH is the weak example here (§B0).

---

## B′. Manual cross-check against the Clio web UI

The script proves the tools behave consistently. This step proves they match Clio. Use Matter A.

| # | In Clio (web) | Via the tool | Pass |
|---|---|---|---|
| M1 | Matter → Communications tab: count emails and calls in the window | `list_communications` counts from B1 | Counts match |
| M2 | Open 3 logged communications (at least 1 call, 1 email) | The same ids in the tool output | Subject, date, sender, receiver and the logging user all match |
| M3 | Matter → Notes: count, and open one **rich-text** note (bullets or bold) if one exists | `list_notes` | Count matches; the rich note reads cleanly in `detail`, with the markup kept on `detail_html` |
| M4 | Matter → Activities: count time and expense entries in the window; note one billed and one unbilled | `list_activities` | Counts match; `billed` and `bill.number` are correct on the billed one |
| M5 | Matter → Tasks: one completed and one open task | `list_tasks` | `completed_at` and `description` match |
| M6 | Matter → Calendar: next 2 entries | `list_calendar_entries` with `matter_id` | Time, location and all-day flag match |
| M7 | Matter B → Documents: total count | Final count from B1 | Matches (trashed documents are excluded on both sides) |

---

## C. Consumer regression

| # | Consumer | How | Pass |
|---|---|---|---|
| C1 | **Claude Desktop pick-up** | Quit Claude Desktop fully, reopen, start a fresh chat. Ask: *"What Clio tools do you have?"* | `list_communications`, `list_notes` and `list_activities` appear (as `mcp__clio__…`) |
| C2 | **Practice Conductor, calendar contract (spec §4.4)** | Run the morning and weekly prompts from `practice-conductor/SCHEDULED-RUN.md` by hand, as the scheduled run would | The calendar section renders the same as before. **Shape change to watch:** results now sit under `entries`. If a prompt says "the array returned by list_calendar_entries" or similar, reword it. |
| C3 | **Anything reading `list_tasks`** | Search the skills folder for `list_tasks` (`conductor-task`, the conductor prompts) | Any caller that expects a bare array is updated to read `.tasks` |
| C4 | **Headless CLI** | `node scripts/with-desktop-env.mjs node build/index.js auth-status` and one `node scripts/with-desktop-env.mjs node build/index.js clio-export …` run as the weekly job does | Output is the same as on `main` (this code is untouched; this confirms it) |
| C5 | **Natural-language pull** | In Claude: *"List the calls and emails Tye logged on [Matter A] since June, with bodies."* | The model picks `list_communications` with `include_body: true`, pages when there's a next token, and the list matches M1 |
| C6 | **statement-of-account v2.1** | Only after the skill's v2.1 changes in spec §5 are made (a separate round) | The run lists `clio_communications` and `clio_notes` as `swept`; no `clio-communications-not-read` or `clio-notes-not-read` flags appear |

---

## D. Audit log

```bash
tail -n 40 ~/.clio-mcp/audit.log
```

| # | Pass |
|---|---|
| D1 | One line per smoke call, with `tool`, `outcome: "success"`, `result_count` and `matter_id` for the new tools |
| D2 | `args` hold filter values only. **No communication bodies or note text appear in the log**, because only arguments are logged, never results. |

---

## E. Rollback

```bash
git checkout 2ce8dc1 && npm ci && npm run build   # last commit before v2.1 (PR #3 merge)
```

When done, `git checkout main` to return to the tip.

Then quit and reopen Claude Desktop. Nothing in this PR writes to Clio, so there is no data to unwind.

---

## F. Sign-off

- [ ] A1–A5 pass
- [ ] B1 script exits 0, or each FAIL has a note and a decision
- [ ] Notes `type` casing settled (B3 / M3); fix pushed if needed
- [ ] M1–M7 match
- [ ] C1–C5 pass; conductor prompts updated if C2/C3 found bare-array reads
- [ ] D1–D2 pass
- [ ] Smoke output and any follow-up fixes recorded (a new PR if anything needs changing)

---

## G. Write tools — PrecedentPowers/clio-mcp#5 (merged as `952f064`)

**What PR #5 changes:** every create/update tool now asks Clio for `fields`. Before the change, Clio returned only the id, so these tools reported `success: true` with null fields. `conductor-task` depends on the task tools returning a real id and status.
**This section writes to Clio.** Use a **dedicated test matter** (not a client file), and delete what it creates (G5). PR #5 merged before W9–W10 ran, so §G now runs on `main`.

### G1. Build `main`

```bash
git checkout main && git pull
npm ci && npm run build
npm test                             # 19 files, 181 tests (main)
```

Quit and reopen Claude Desktop so it loads this build. Confirm `node scripts/with-desktop-env.mjs node build/index.js auth-status` reports `"ok": true`.

### G2. Set up

- **Test matter:** create or pick one in Clio (e.g. "ZZ TEST — delete me"), and note its numeric id (**T**).
- **Your user id (U):** in Claude, *"list Clio users named Corbett"* (`list_users`).

### G3. Calls and what must come back

Run each call in Claude, naming the tool so the model doesn't improvise, e.g. *"Use create_task on matter T: name 'ZZ smoke task', description 'smoke test', due 2026-10-15."* Paste each JSON result into your notes.

The **before-fix symptom** is a field showing `null` (or `"due_at": null` when a date was given) even though Clio stored it. Any such null is a **FAIL** — except W6's `total`, which may legitimately be `null` on a non-billable entry; that's Clio's own value, not the before-fix symptom, and the key being present is what matters.

| # | Tool and arguments | Must be populated in the response |
|---|---|---|
| W1 | `create_task` — `matter_id: T`, name, description, `due_date: 2026-10-15`, `assignee_id: U` | `task.id`, `name`, `priority: "normal"` (Clio returns priority lowercase), `due_at: "2026-10-15"` |
| W2 | `update_task` — `task_id` from W1, `status: "Pending"`, `priority: "High"` (not "In Progress" — Clio rejects it with a 422, `status must be one of ["complete", "pending"]`) | `status: "pending"`, `priority: "high"`, `due_date`, `matter_id: T` |
| W3 | `complete_task` — `task_id` from W1 | `status: "complete"`, **`completed_at` is a timestamp** (one of the five unverified field names) |
| W4 | `create_note` — `matter_id: T`, subject "ZZ smoke note", body | `note.id`, `subject: "ZZ smoke note"` |
| W5 | `create_calendar_entry` — `summary: "ZZ smoke event"`, `start_at: 2026-10-16T10:00`, `end_at: 2026-10-16T10:30`, `calendar_owner_id` from `list_calendars`, `matter_id: T` | `id`, `summary`, `start_at`, `end_at`, `matter.id: T`. Note: `id` comes back as a string (e.g. `"5174035760"`). |
| W6 | `log_time_entry` — `matter_id: T`, `date: 2026-09-25`, `quantity_in_hours: 0.1`, `note: "ZZ smoke"`, `non_billable: true` | `id`, `quantity_in_hours: 0.1`, `total`, `matter`, `user`, **`non_billable: true`** (unverified field). `total` may be `null` on a non-billable entry. |
| W7 | `create_activity` — `type: "ExpenseEntry"`, `date: 2026-09-25`, `matter_id: T`, `price: 1`, `note: "ZZ smoke expense"` | **`type: "ExpenseEntry"`** (unverified field), `price: 1`, `total`, `matter` |
| W8 | *(optional: creates a matter)* `create_matter` — `client_id` of a test contact, `description: "ZZ smoke matter"`, `originating_attorney_id: U`, `client_reference: "ZZ-SMOKE"` | `display_number`, `client`, **`originating_attorney`** and **`client_reference: "ZZ-SMOKE"`** (unverified fields) |

**If Clio rejects a field name:** the tool returns `isError` with a Clio 400 that names the field. Since PR #7, Clio error messages show the URL path without its query string, so the `fields=` list no longer appears in the error — but Clio's own message text still names the rejected field. Record it; the fix is to drop or rename that one name in PR #5 (`TASK_COMPLETE_FIELDS` in `tasks.ts`, `ACTIVITY_WRITE_FIELDS` in `activities.ts`, `MATTER_CREATE_FIELDS` in `matters.ts`). In testing (W2, 2026-09-25), a 422 validation error left the task unchanged — but always confirm with a read (e.g. `list_tasks` on T) before retrying or assuming nothing was written.

### G4. conductor-task end to end

| # | Step | Pass |
|---|---|---|
| W9 | In a matter session: *"Delegate to Tye in Clio: ZZ smoke — confirm conductor stamp, on matter T, due 2026-10-17."* | The vault task line gets a real `[clio::<id>]` (not `undefined` or `null`), and that id opens the task in Clio |
| W10 | *"Mark the ZZ smoke task done in Clio."* | The skill reports it complete; Clio shows it completed |

### G5. Clean up (in the Clio web UI)

Delete the W1/W9 tasks, the W4 note, the W5 calendar entry, the W6 time entry and the W7 expense. Delete (or close) the W8 matter if you made one, then the test matter if it was created just for this. Remove the W9 line from the vault.

### G6. Audit log

`tail -n 20 ~/.clio-mcp/audit.log`: since PR #7, the audit log records free-text arguments as `"[omitted]"` (keys: `name`, `description`, `subject`, `note`, `summary`, `query`, `file_path`, `client_reference`, `reference`, `body`, `detail`, `location`). Pass = one success line per W-call, `matter_id: T` where recorded, and every free-text arg reads `"[omitted]"`.

### G7. Sign-off for PR #5 (merged before W9–W10)

- [x] G1 unit tests and build pass
- [x] W1–W7 return every listed field populated; `completed_at`, `non_billable` and `type` accepted (2026-09-25, §H)
- [ ] W8, if run: `originating_attorney` and `client_reference` accepted
- [ ] W9–W10 pass
- [ ] G5 cleanup done
- [x] Merged (`952f064`)

---

## H. Results — 2026-09-25

Run by a Claude Code session on Austin's Mac. §§A–D ran against the connector's build in the main checkout (already v2.1, rebuilt 13:15) and the PR #5 worktree; §G ran from a harness against the PR #5 worktree build, not through Claude Desktop (the connector stayed on `main`).

| # | Result |
|---|---|
| A1 | Pass |
| A2 | Pass — 15/162 on the PR #5 worktree |
| A3 | Pass — 29 tools |
| A4 | Pass — no `.env`; credentials from Desktop config; default US region works |
| A5 | Pass — `"ok": true` |

**B1:** Matter A and B = 04694-BRASETH (id 1701593810), `--since 2024-05-10`: **19/19 passed**.

Real data: 11 emails across 3 pages, no duplicates, type filter held; `include_body` gave plain text truncated at 200 chars; body omitted by default; 51 documents across 2 pages; `updated_since` held; conductor-style calendar call returned 48 entries in the envelope.

Passed on empty data (not proven): phone calls, notes, activities, tasks, calendar `matter_id` filter. Notes lowercase `matter`: no 422.

**C2:** checked in source only — the conductor's calendar comes from Outlook, and its Clio data from `clio-export`, which calls Clio directly and doesn't use the changed tools.

**C3:** `conductor-task` step 3b makes no bare-array assumption, but `list_tasks` now returns 25 per page, so a matter with more than 25 pending tasks could escape the duplicate check without following `next_page_token`. `statement-of-account/SKILL.md` lines 286–290 are stale (the 200-row cap heuristic; "no matter filter" on calendar) — scheduled for the C6 round.

**D1–D2:** pass — 20 audit lines, one per call, all success with `result_count`; new tools record `matter_id`; no bodies/subjects/note text.

**G** (T = 04041-Test, id 1408128169; U = 344920268 Austin Corbett; calendar 801512):

| # | Result |
|---|---|
| W1 | Pass — task 1617900050 |
| W2 | First attempt ("In Progress") → 422, task unchanged (confirmed by read). Retry (Pending/High) → pass |
| W3 | Pass — `completed_at` returned (unverified field name now confirmed) |
| W4 | Pass — note 3150655445 |
| W5 | Pass — calendar entry 5174035760 |
| W6 | Pass — time entry 8824500230; `non_billable: true` confirmed; `total: null` |
| W7 | Pass — expense 8824500350; `type: "ExpenseEntry"` confirmed |
| G6 | Pass, with the note-text finding above |

Records to delete in G5 (all on 04041-Test): task 1617900050, note 3150655445, calendar entry 5174035760, time entry 8824500230, expense 8824500350.

From the "Run testing reads 2.1" session (same day):

- **B1:** 19/19 on each of three runs (ST.PIERRE, DOUGLAS, and a matter with notes); DOUGLAS used for document paging.
- Notes casing settled (§0 above).
- **D1–D2:** pass on 60 audit lines.
- **D2a (2026-09-25):** no picklist custom fields — across 533 matters in the Conductor's `clio_export.json` (20:50), no custom field value is an option id; "Private / Legal Aid" is free text.

**Still open:** see §K.

---

## I. Privacy hardening — PR #7 (2.1.1), merged before live checks

PR #7 (privacy hardening, 2.1.1) merged to main as `af630ff` **before** its live verification ran. These checks run now, on `main`. They adapt §5 of `docs/SPEC-privacy-hardening.md` (L1–L7); commands use `node scripts/with-desktop-env.mjs …`.

| # | Step | Pass |
|---|---|---|
| L1 | `ls -la ~/.clio-mcp` **before** pulling/building `af630ff` in the connector folder (the connector is still at `db51fdf`) | Record the current modes (expect 0644/0755) |
| L2 | Build `main` (`af630ff`); `node scripts/with-desktop-env.mjs node build/index.js auth-status` | `"ok": true` with **no re-auth**; afterwards `tokens.enc` is `-rw-------` and `~/.clio-mcp` is `drwx------` |
| L3 | Restart Claude Desktop; `search_contacts` for a real surname; then `create_note` on 04041-Test with subject "ZZ privacy check" | `tail -n 5 ~/.clio-mcp/audit.log` shows `"query":"[omitted]"` and `"subject":"[omitted]"`; `audit.log` is `-rw-------` |
| L4 | After L3–L6: `grep '"outcome":"error"' ~/.clio-mcp/audit.log \| tail` | Any **new** `error_message` has no `?` query string |
| L5 | `node scripts/with-desktop-env.mjs node scripts/smoke-v2.1-reads.mjs --matter 1701593810` (Braseth, for comparability with the 19/19 run) | Same pass count (19/19); the new audit lines hold no free text |
| L6 | `clio-export` as the Conductor runs it | Exit 0; the pages are the same as before the change |
| L7 | Clean up: delete the "ZZ privacy check" note on 04041-Test | — |

**Rollback:** `git checkout db51fdf && npm ci && npm run build` (the last commit before #7), then restart Desktop; `git checkout main` afterwards to return to the tip. Tightened permissions stay tightened, which is harmless, and no data format changed.

**Residual risk (from SPEC §6):** Clio's own error text might still echo a submitted value (unverified — watch L4); the Desktop MCP console log is outside this PR's control; existing pre-#7 log lines keep their free text until a separate cleanup pass.

---

## J. Export auth guard — `fix/export-auth-redaction-guards` (pending)

| # | Check | Result |
|---|---|---|
| J1 | Automated — `src/cli/__tests__/exportAuth.test.ts` | Missing token → exit 2, sign-in never called, no network; expired → refresh + save with carried `clio_user_id`; valid → stored token; audit entries keep `clio_user_id` |
| J2 | Automated — the returned-fields guard in `writeFieldsSelection.test.ts` | Fails naming (e.g. "complete_task reads completed_at but does not request it") |
| J3 | Live, **done 2026-09-25** | With `HOME` pointed at an empty temp folder and `CLAUDE_DESKTOP_CONFIG` at the real config, `clio-export` exited 2 at once with "re-authenticate via the Clio MCP in Claude", no browser, no listener on port 5678, audit line "not authenticated — no tokens stored"; real token file untouched |
| J4 | Live, **after merge** | One `clio-export` run as the Conductor runs it: exit 0, pages same as before, audit line has `session_id: "clio-export-cli"` and `clio_user_id` |

---

## K. Remaining regimen — run in this order

1. In the connector folder: `ls -la ~/.clio-mcp` (I-L1), then `git pull && npm ci && npm run build` (to `af630ff`).
2. I-L2 auth-status + permissions.
3. Quit and reopen Claude Desktop → C1.
4. I-L3 (privacy: search + ZZ privacy note).
5. G4 W9–W10 (conductor-task round trip on 04041-Test).
6. I-L5 smoke on Braseth; optionally B1 on ST.PIERRE + DOUGLAS.
7. C4 / I-L6: clio-export as the Conductor runs it.
8. C2 (Conductor morning run), C5 (natural-language calls/emails on ST.PIERRE), B′ M1–M7 (ST.PIERRE + DOUGLAS).
9. Optional W8 (`create_matter`: `originating_attorney`, `client_reference`).
10. I-L4 error-message check.
11. Cleanup in the Clio web UI: the five §H records, the W9 task (and vault line), the ZZ privacy note, the W8 matter if made.
12. After `fix/export-auth-redaction-guards` merges: pull, build, restart Desktop, J4.
13. Deferred: C6 (statement-of-account round); D7 (conductor-task step 3b paging, after W9–W10 pass).
