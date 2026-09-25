# Plan: port upstream's write-fields fix, then merge upstream 2.3.0

**Status:** DRAFT v0.1 (2026-09-25). Nothing here is built. Each phase needs its own go-ahead.
**Fork:** PrecedentPowers/clio-mcp `main` at `47a4569` (2.1.0, 29 tools).
**Upstream:** oktopeak/clio-mcp `main` at `44916ad` (2.3.0, 36 tools). Merge base `d85f3be` (2.0.0); 35 upstream commits since.
**Basis:** a trial merge and trial cherry-pick on the fork, both aborted. Claims marked ✔ were re-checked by hand against the source; the rest come from the trial-merge analysis, which cites the commit or file for each.

---

## 1. Why two phases

The write-fields fix (upstream `44916ad`, PR #29) is small, separable and urgent. `conductor-task` depends on write tools returning real ids and status. The full merge is large: 10 conflicted files, plus several auto-merges that are wrong without showing a conflict. Two of those break the Practice Conductor's headless CLI. Doing A first means B can't hold it hostage.

---

## 2. Phase A — write-field selection (small PR)

### What's wrong today
Clio's write endpoints return a minimal record unless `?fields=` is sent. The fork's `clioPost`/`clioPatch` can't send one. ✔ Upstream added a `params` argument to `clioPost` and `clioPatch` only; `clioPut` is unchanged (upstream `src/utils/clioClient.ts`: `clioPost` line 158, `clioPatch` line 172, `clioPut` line 194). The fork's handlers use optional chaining, so the likely symptom is `success: true` with null or missing fields, not an error. What Clio's default write response contains is **not verified**; the live test in A4 settles it.

### Steps
1. **Branch** from `main`, e.g. `fix/write-fields-selection`.
2. **Client:** add an optional `params?: Record<string,string>` to `clioPost` and `clioPatch` in `src/utils/clioClient.ts`, set on the URL the way `clioGet` does. Port this by hand: cherry-picking `44916ad` conflicts only because the surrounding lines include upstream's `clioGetAllPages`.
3. **Call sites** (8 tools):

   | Tool | File | Fields |
   |---|---|---|
   | `create_task`, `update_task`, `complete_task` | `tasks.ts` | `TASK_FIELDS` **plus `completed_at`**. `complete_task` returns `completed_at` but never asks for it, which is also true upstream. |
   | `create_note` | `notes.ts` | `id,subject` |
   | `create_calendar_entry` | `calendar.ts` | `CALENDAR_FIELDS` |
   | `log_time_entry`, `create_activity` | `activities.ts` | `ACTIVITY_FIELDS` (`create_activity` also reads `type`, `non_billable`; add them) |
   | `create_matter` | `matters.ts` | **New `MATTER_WRITE_FIELDS`**. The fork's `MATTER_DETAIL_FIELDS` pulls `client{…,date_of_birth}` (not needed on create) and lacks `originating_attorney`/`client_reference`, which `create_matter` outputs. |

   `upload_document` already puts `?fields=` in its paths. Leave it alone.
4. **Tests:**
   - Adapt upstream's `writeFieldsSelection.test.ts`. It imports `REGISTRARS` from upstream's `src/tools/index.ts`, which the fork lacks, so use an explicit list of the fork's `register*` functions and drop the `update_matter` case.
   - Update `tasks.test.ts`, where `toHaveBeenCalledWith` gains a third argument.
   - Add a test that every field a write tool *returns* is in the fields it *requests*. That's the check that would have caught `completed_at`.
5. **Gates:** `npm test`, `npm run build`, and a self-review of the diff.
6. **Live test (A4):** this writes to Clio, so use a dedicated test matter and delete what it creates.
   - `create_task`, then `update_task(status)`, then `complete_task`: id, name, status and `completed_at` come back populated.
   - `create_note`, `create_calendar_entry`, `log_time_entry`, `create_activity(ExpenseEntry)`: each returns populated fields.
   - Run `conductor-task` once end-to-end and confirm it stamps a real `[clio::id]`.

**Size:** about 6 lines in the client, 8 call-site edits, one new test file. One PR.

---

## 3. Phase B — merge upstream 2.3.0 (separate branch, after A)

### What it brings
Regions us/eu/**ca**/au with validated `CLIO_REGION`; a READ_ONLY mode; a tool registry with MCP annotations; an allowlisted audit-arg redaction; paging on every list tool; `clioGetAllPages`; longer 429 backoff; custom fields read/write (`list_custom_fields`, `create_custom_field`, `update_matter`); matter stages; relationships; folders; `matter_activity_summary`; a token-broker install mode; and a library entry point.

### Conflicts and how to resolve them

| File | Keep from fork | Take from upstream |
|---|---|---|
| `src/index.ts` | `clio-export` / `auth-status` dispatch | Region check and `registerAllTools`. Put the CLI dispatch after env/region validation. |
| `src/server/http.ts` | **`getAllowedHosts()` and DNS-rebinding options on the transport.** Upstream has none. | `createApp`/`startHttpServer` structure and the constant-time API key. HTTP now always needs a key of 24+ characters (or `MCP_ALLOW_UNAUTHENTICATED=true`). |
| `src/tools/matters.ts` | `date_of_birth` in `client{…}`; `responsible_attorney`; the `responsible_attorney_id` filter; default-attorney logic; **exported `MATTER_DETAIL_FIELDS` and `flattenCustomFields`**, ✔ both imported by `src/cli/export.ts` line 5 | Custom-field machinery, `matter_stage`, `update_matter`, field-fallback reads |
| `calendar.ts`, `tasks.ts` | The v2.1 filters and extra fields | Decide the empty-result form and the default `limit` (§5) |
| `notes.ts` | — | Identical except the default `limit` (50 vs 25) |
| `README.md`, `.env.example`, `package.json`, `server.json` | Fork env vars and v2.1 tool rows | Upstream structure. The tool count must equal `TOOL_META`, because `docsCounts.test.ts` enforces it. |

### Auto-merges that go wrong without a conflict
1. **Headless CLI breaks.** ✔ Upstream's `clioClient` calls `requireSessionContext()`, which throws unless `TRANSPORT=stdio` (upstream `src/utils/sessionContext.ts`, `requireSessionContext`). `TRANSPORT` defaults to `http`, so `clio-export` run as the Conductor runs it would exit 2 with "no valid Clio token". **Fix:** run the CLI inside a session context built from `loadTokens`/`refreshTokensPure` that never opens OAuth.
2. **Stored tokens become unreadable.** ✔ Upstream's `tokenStorage.ts` uses a 12-byte IV; the fork's uses 16 (fork `src/auth/tokenStorage.ts` lines 66 and 91–93; upstream `IV_LENGTH = 12`). After the merge, `~/.clio-mcp/tokens.enc` would fail to decrypt, `auth-status` would report `ok:false`, and an unattended stdio call could try to open a browser. **Fix:** have `loadTokens` read both layouts and re-save in the new one, or schedule a one-time re-auth before the next unattended run.
3. **`list_communications` disappears.** Upstream's registry doesn't know it. `list_activities` would be treated as a write tool (hidden under READ_ONLY) and fail `registry.test.ts`. Add both to `TOOL_META`, `REGISTRARS` and `AUDIT_ARG_ALLOWLIST`.
4. **Audit log redacts the new filters.** Anything not allowlisted logs as `"[redacted]"`: all args of `list_communications`, `list_activities` and `clio_export_cli`, plus the v2.1 filters. Extend the allowlist.
5. **`list_matters` double-wraps** to `matters.matters`. Fix in the resolution.
6. **`get_matter` `date_of_birth` always null**, because upstream's field string doesn't request it. Fix in the resolution.
7. **`list_time_entries` becomes an envelope** upstream. The fork's `readTools.test.ts` expects a bare array. Decide (§5).
8. **Startup gets stricter.** An unrecognised `CLIO_REGION` becomes fatal. Check the Mac's `.env` before the switch.

✔ Already in the fork, independent of the merge: `getValidAccessToken` starts `runOAuthFlow()` when no tokens exist (fork `src/auth/oauth.ts`, `getValidAccessToken`). Fix 1 should close this for the CLI path as well.

### Steps
1. Branch from `main` after Phase A lands, e.g. `merge/upstream-2.3.0`.
2. `git merge upstream/main` as a merge commit, which keeps upstream history for future merges. Resolve per the table.
3. Apply fixes 1–8.
4. **Gates:** `tsc -p tsconfig.build.json`; full vitest suite (upstream's registry, docsCounts, auditRedaction, writeFieldsSelection, plus the fork's cli and readTools); `npm run verify:no-secrets`; upstream's `scripts/smoke-stdio.mjs`; this repo's `scripts/smoke-v2.1-reads.mjs`.
5. **Live:**
   - Re-run the whole v2.1 testing spec (`docs/TESTING-v2.1-reads.md`).
   - `auth-status` returns `ok:true` **without re-auth** if fix 2 took the read-both route.
   - Run `clio-export` with the Conductor's exact environment (no `TRANSPORT`), and diff its JSON against a pre-merge run for the same matters. Check `date_of_birth` and the `custom_fields` shape.
   - Confirm READ_ONLY hides exactly the write tools.
   - In HTTP mode, a wrong `Host` header is rejected.
6. PR, review, then merge before the Conductor's next unattended run, or pause that run for the switch-over.

---

## 4. Order

1. **Now:** run `docs/TESTING-v2.1-reads.md` on the merged v2.1 (it went in untested).
2. **Phase A** PR, with its live write test.
3. **Phase B** PR, with its gates and the full re-test.
4. **After B:** statement-of-account skill v2.1 changes (spec §5).

---

## 5. Decisions needed before Phase B

| # | Question | Options |
|---|---|---|
| 1 | Fork version after merge | `2.3.0-pp.1` (recommended: shows the base and the fork) · keep the fork's own numbering |
| 2 | Empty list result | Plain-text "No X found." (fork today) · empty JSON envelope (upstream; easier for paging loops) |
| 3 | Default `limit` | `list_calendar_entries`: Clio default (fork) · 25 (upstream). `list_notes`: 50 · 25 |
| 4 | `list_time_entries` | Keep it as a legacy bare array · adopt upstream's envelope (`list_activities` covers the new use) |
| 5 | `custom_fields` on `get_matter` and in the export | Fork's flat map · upstream's array with picklist **labels** (the fork's map shows picklist option **ids**) · both |
| 6 | Existing token file | Read both formats (no re-auth) · one-time re-auth |
| 7 | HTTP mode | Accept "API key always required" and keep the DNS-rebinding layer (recommended) |
| 8 | Upstream's new write tools (`update_matter`, `create_custom_field`, `create_folder`) | Take them (READ_ONLY can hide them) · exclude |
