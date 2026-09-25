# Testing spec — clio-mcp 2.1.0 read tools

**Covers:** `main` at `47a4569` (PrecedentPowers/clio-mcp#4, merged 2026-09-25), implementing `SPEC-clio-mcp-v2.1-reads.md` (Phase 6).
**Also covers:** §G, the live **write** test for PrecedentPowers/clio-mcp#5 (write-fields fix, not yet merged). It runs on that PR's branch, not on `main`.
**Status:** merged **before** live testing. Run this before the Practice Conductor's next scheduled run, because of the calendar/tasks response-shape change (C2, C3).
**Run by:** Austin, on the Mac that hosts the Claude Desktop connector. Every step is read-only against Clio.
**Pass bar:** every gate below passes, or a failure is written up with a decision and a fix PR.

---

## 0. What changed, and what to watch

| Tool | Change | Risk to existing callers |
|---|---|---|
| `list_communications` | **New.** Emails and calls from Clio's Communications log | None (new) |
| `list_notes` | **New.** Ported from upstream 2.3.0 | None (new). **Open question:** the `type` filter is sent lowercase (`matter`). Upstream says Clio returns 422 on `Matter`; the third-party OpenAPI copy lists `Matter`. Gate B3 settles it. |
| `list_activities` | **New.** Time and expense entries, paged | None (new). `list_time_entries` is unchanged. |
| `list_calendar_entries` | Adds `matter_id`, `calendar_id`, `updated_since`, `limit`, `page_token`, plus `location`, `all_day` and `updated_at` in the output | **The response shape changes from a bare array to `{entries, total_count, has_more, next_page_token}`.** The Practice Conductor's scheduled prompts read this output (Gate C2). |
| `list_tasks` | Adds `complete`, `created_since`, `updated_since`, `page_token`, plus `description`, `completed_at`, `created_at` and `updated_at` in the output | **The response shape changes from a bare array to `{tasks, …, next_page_token}`.** Check anything that reads `list_tasks` (Gate C3). |
| `list_documents` | Adds `created_since`, `updated_since`, plus `updated_at` and `received_at` in the output | None. The envelope is unchanged. |

No write tool changed. `clio-export` and `auth-status` are untouched.

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

| # | Check | Pass |
|---|---|---|
| A1 | `npm run build` | Exits 0 with no TypeScript errors |
| A2 | `npm test` | **14 files, 154 tests, all passing** |
| A3 | `node scripts/smoke-v2.1-reads.mjs --list-only` | `PASS tool registry — 29 tools`. This makes no Clio calls. |
| A4 | Region | The fork's client only knows the `us` and `eu` regions. If the firm is on Clio Canada, `.env` must set `CLIO_API_BASE=https://ca.app.clio.com/api/v4` (and the matching `CLIO_AUTH_URL`/`CLIO_TOKEN_URL`). This should already be set if 2.0 works today; confirm it is. |
| A5 | `node build/index.js auth-status` | One JSON line with `"ok": true`. If not, authenticate in Claude first. |

---

## B. Live smoke (automated)

### B0. Pick two matters

- **Matter A:** an open file where Tye has **logged both emails and phone calls** in Clio. Ideally it also has notes, time *and* expense entries, open *and* completed tasks, and calendar entries.
- **Matter B:** any matter with **more than 50 documents**, for the paging check. It can be the same as A.

You need the numeric Clio matter IDs (the number in the matter's Clio URL), not the display numbers.

### B1. Run

```bash
node scripts/smoke-v2.1-reads.mjs --matter <A> --docs-matter <B> --since 2025-09-01
```

The script refuses to run unless `auth-status` reports ok, so it can't pop an OAuth window by surprise. It exits 1 if any check fails. Save the output to paste into the PR.

### B2. What each check means

| Check | Pass means | If it fails |
|---|---|---|
| `tool registry` | 29 tools; all 7 read tools present | Stale build → re-run A1 |
| `list_communications EmailCommunication` / `PhoneCommunication` | Every item has the expected type, all fields are present, paging at 5 per page drains with no duplicate ids | A zero count isn't a failure, but it means Matter A isn't a good test file. The type leaking means Clio ignored the filter. |
| `list_communications include_body` | `body` is plain text (no tags), ≤ 200 chars, and `body_truncated` is present | Tags present → the stripHtml path missed a form |
| `body omitted by default` | No `body` key unless it was asked for | — |
| `list_notes` | Returns notes with `date`, `detail` and `author`, and pages cleanly | **A 422 mentioning `type` settles the casing question in favour of `Matter`**: change `type: matter_id ? "matter" : "contact"` in `src/tools/notes.ts` and re-run |
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
| C4 | **Headless CLI** | `node build/index.js auth-status` and one `node build/index.js clio-export …` run as the weekly job does | Output is the same as on `main` (this code is untouched; this confirms it) |
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

## G. Write tools — PrecedentPowers/clio-mcp#5 (before merging it)

**What PR #5 changes:** every create/update tool now asks Clio for `fields`. Before the change, Clio returned only the id, so these tools reported `success: true` with null fields. `conductor-task` depends on the task tools returning a real id and status.
**This section writes to Clio.** Use a **dedicated test matter** (not a client file), and delete what it creates (G5). §§A–F are unaffected: they run on `main`, which doesn't contain PR #5.

### G1. Switch to the PR branch

```bash
git checkout main && git pull        # finish §§A–F on main first
git fetch origin
git checkout claude/cool-lovelace-01393d
npm ci && npm run build
npm test                             # 15 files, 162 tests, all passing
```

Quit and reopen Claude Desktop so it loads this build. Confirm `node build/index.js auth-status` reports `"ok": true`.

### G2. Set up

- **Test matter:** create or pick one in Clio (e.g. "ZZ TEST — delete me"), and note its numeric id (**T**).
- **Your user id (U):** in Claude, *"list Clio users named Corbett"* (`list_users`).

### G3. Calls and what must come back

Run each call in Claude, naming the tool so the model doesn't improvise, e.g. *"Use create_task on matter T: name 'ZZ smoke task', description 'smoke test', due 2026-10-15."* Paste each JSON result into your notes.

The **before-fix symptom** is a field showing `null` (or `"due_at": null` when a date was given) even though Clio stored it. Any such null is a **FAIL**.

| # | Tool and arguments | Must be populated in the response |
|---|---|---|
| W1 | `create_task` — `matter_id: T`, name, description, `due_date: 2026-10-15`, `assignee_id: U` | `task.id`, `name`, `priority: "Normal"`, `due_at: "2026-10-15"` |
| W2 | `update_task` — `task_id` from W1, `status: "In Progress"`, `priority: "High"` | `status: "in_progress"`, `priority: "High"`, `due_date`, `matter_id: T` |
| W3 | `complete_task` — `task_id` from W1 | `status: "complete"`, **`completed_at` is a timestamp** (one of the five unverified field names) |
| W4 | `create_note` — `matter_id: T`, subject "ZZ smoke note", body | `note.id`, `subject: "ZZ smoke note"` |
| W5 | `create_calendar_entry` — `summary: "ZZ smoke event"`, `start_at: 2026-10-16T10:00`, `end_at: 2026-10-16T10:30`, `calendar_owner_id` from `list_calendars`, `matter_id: T` | `id`, `summary`, `start_at`, `end_at`, `matter.id: T` |
| W6 | `log_time_entry` — `matter_id: T`, `date: 2026-09-25`, `quantity_in_hours: 0.1`, `note: "ZZ smoke"`, `non_billable: true` | `id`, `quantity_in_hours: 0.1`, `total`, `matter`, `user`, **`non_billable: true`** (unverified field) |
| W7 | `create_activity` — `type: "ExpenseEntry"`, `date: 2026-09-25`, `matter_id: T`, `price: 1`, `note: "ZZ smoke expense"` | **`type: "ExpenseEntry"`** (unverified field), `price: 1`, `total`, `matter` |
| W8 | *(optional: creates a matter)* `create_matter` — `client_id` of a test contact, `description: "ZZ smoke matter"`, `originating_attorney_id: U`, `client_reference: "ZZ-SMOKE"` | `display_number`, `client`, **`originating_attorney`** and **`client_reference: "ZZ-SMOKE"`** (unverified fields) |

**If Clio rejects a field name:** the tool returns `isError` with a Clio 400 that names the field. Record it; the fix is to drop or rename that one name in PR #5 (`TASK_COMPLETE_FIELDS` in `tasks.ts`, `ACTIVITY_WRITE_FIELDS` in `activities.ts`, `MATTER_CREATE_FIELDS` in `matters.ts`). A 400 means the write did **not** happen, so there's nothing to clean up for that call.

### G4. conductor-task end to end

| # | Step | Pass |
|---|---|---|
| W9 | In a matter session: *"Delegate to Tye in Clio: ZZ smoke — confirm conductor stamp, on matter T, due 2026-10-17."* | The vault task line gets a real `[clio::<id>]` (not `undefined` or `null`), and that id opens the task in Clio |
| W10 | *"Mark the ZZ smoke task done in Clio."* | The skill reports it complete; Clio shows it completed |

### G5. Clean up (in the Clio web UI)

Delete the W1/W9 tasks, the W4 note, the W5 calendar entry, the W6 time entry and the W7 expense. Delete (or close) the W8 matter if you made one, then the test matter if it was created just for this. Remove the W9 line from the vault.

### G6. Audit log

`tail -n 20 ~/.clio-mcp/audit.log`: one `outcome: "success"` line per W-call, with `matter_id: T` where the tool records it. `create_note` logs `subject` in its args (by design today); no note body or task description is logged.

### G7. Sign-off for PR #5

- [ ] G1 unit tests and build pass
- [ ] W1–W7 (and W8 if run) return every listed field populated, and none of the five unverified names is rejected; or a fix is pushed to PR #5 and W-calls re-run
- [ ] W9–W10 pass
- [ ] G5 cleanup done
- [ ] Merge PR #5, then `git checkout main && git pull && npm run build` and restart Claude Desktop
