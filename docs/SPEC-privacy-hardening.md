# SPEC — privacy-hardening PR (plan T1 + T2)

**Status:** DRAFT v0.1 (2026-09-26). Not built; needs a go-ahead.
**Base:** `main` at `db51fdf` (2.1.0). Line numbers below are from that commit.
**Plan:** `docs/PLAN-upstream-port-and-merge.md` §3 T1 + T2, shipped as one PR (§5 #3). Cleaning up existing log entries is out of scope (deferred as T6, §5 #2).
**Goal:** make the README's promise true. The audit log should hold metadata, "not Clio content" (README line 99), and the files holding credentials or client metadata should be readable only by the user.

---

## 1. Findings (inventory of `main`)

### 1.1 Free text written to `~/.clio-mcp/audit.log`

| Tool | Key(s) logged | File:line | What it can contain |
|---|---|---|---|
| `create_task` | `name` | `tasks.ts` 128, 151 | Task wording, e.g. "Call complainant re statement" |
| `update_task` | `name`, `description` | `tasks.ts` 193, 217 | Same, plus instructions |
| `create_note` | `subject` | `notes.ts` 37, 58 | Note subject line |
| `log_time_entry` | `note` | `activities.ts` 199, 226 | Time entry narrative: the services-rendered text |
| `create_activity` | `note` | `activities.ts` 259, 285, 313 | Same |
| `create_calendar_entry` | `summary` | `calendar.ts` 164, 178 | Event title, often "Trial — R v [client]" |
| `create_matter` | `description`, `client_reference` | `matters.ts` 206–211, 236–239 | Matter description, external reference |
| `search_contacts` | `query` | `contacts.ts` 32, 54 | **A person's name**: client, complainant, witness |
| `list_documents` | `query` | `documents.ts` 105, 135 | Document-name search, often a name |
| `upload_document` | `file_path`, `name` | `documents.ts` 275, 289 | **Local path and file name**, e.g. `~/Clients/Smith, J/Disclosure/…` |
| `list_users` | `name` | `users.ts` 43, 65 | Staff name. Low sensitivity, but caught by the same rule. |

### 1.2 Free text through `error_message`
`clioFetch` builds `Clio API error ${status} on ${url}: ${msg}` with the **full URL, including its query string** (`clioClient.ts` line 64). A failed `search_contacts` therefore logs `?query=<name>` in `error_message`, even once §1.1 is fixed. Clio's own error text (`msg`) could also echo a submitted value. That is **not verified**, and is treated as residual risk (§6).

### 1.3 File permissions

| File | Today | Where |
|---|---|---|
| `~/.clio-mcp/` | Created with default mode (typically 0755 under umask 022) | `tokenStorage.ts` 63; `auditLog.ts` `appendAuditLog` (`fs.mkdir(AUDIT_DIR, { recursive: true })`) |
| `~/.clio-mcp/tokens.enc` | Default mode (typically 0644) | `tokenStorage.ts` 77 |
| `~/.clio-mcp/audit.log` | Default mode (typically 0644) | `auditLog.ts` `fs.appendFile(AUDIT_FILE, …)` |
| `~/.clio-mcp/key.hex` (fallback only) | 0600 ✓ | `tokenStorage.ts` 57 |
| `clio-export` pages (`--out-dir`) | Default mode; content includes client `date_of_birth` | `cli/export.ts` 92, 97 — **see decision D3** |

`tokens.enc` is encrypted, but any local account can copy it, and it only needs the key (keychain or `key.hex`) to be read. `audit.log` is plaintext.

---

## 2. Design

### 2.1 Audit log: omit free text centrally, and fail closed in tests

Handle it in one place, not by hand-editing 20 call sites:

- **`auditLog.ts`:** add `FREE_TEXT_KEYS = {name, description, subject, note, summary, query, file_path, client_reference, body, detail, location}`. In `redactArgs` (the function that already masks secrets), a free-text key with a non-empty string value becomes `"[omitted]"`. An empty or undefined value passes through unchanged, so the log still shows whether a value was supplied. The rule applies at any nesting depth, as `redactArgs` already recurses.
  - Secrets (`REDACTED_KEYS`) keep `"[REDACTED]"`. The two markers stay distinct, so a reader can tell "secret" from "client content".
- **Why a key-name rule plus a test, not upstream's per-tool allowlist:** the fork has 29 tools and no registry (`src/tools/index.ts` doesn't exist here). A per-tool allowlist means about 29 hand-kept lists. The key rule covers every current call site with one set. The test in §4 T-A1 makes it **fail closed**: any new string input on any tool must be classified, or CI fails.
- **`upload_document`:** stop passing `file_path` and `name` into `args` at all (`documents.ts` 275, 289). On success, log `document_id` instead. The rule would already mask them; removing them makes the intent obvious.
- **No call-site changes otherwise.** Existing keys stay, so the log's shape is unchanged and `export_audit_log` / `readAuditLog` work as before.

### 2.2 Error messages: no query string

In `clioFetch` (`clioClient.ts` line 64), build the message from `origin + pathname` only (e.g. `…/api/v4/contacts.json`), dropping `?…`. That also removes page tokens and `fields=` from what the user sees. They're not useful to the reader, and the status code plus Clio's message still identify the failure.

### 2.3 File permissions

- **One helper,** `ensurePrivateDir(dir)`: `mkdir(dir, { recursive: true, mode: 0o700 })`, then `chmod(dir, 0o700)`. The `chmod` tightens existing installs, since `mkdir`'s mode only applies when it creates the folder.
- **`saveTokens`:** `ensurePrivateDir(TOKEN_DIR)`; write to `tokens.enc.tmp` with `mode: 0o600`, then `rename` over `tokens.enc` (atomic, so a crash mid-write can't leave a torn token file), then `chmod(TOKEN_FILE, 0o600)`.
  - **The 16-byte IV and file format are unchanged. No re-auth.**
- **`appendAuditLog`:** `ensurePrivateDir(AUDIT_DIR)`; `appendFile(AUDIT_FILE, …, { mode: 0o600 })`, which applies on creation. Once per process, `chmod(AUDIT_FILE, 0o600)` for existing logs, with a module-level flag so it isn't run on every line.
- **Failure handling:** a `chmod` failure (e.g. a filesystem without POSIX modes) logs one `console.error` warning and carries on. It never blocks a token save or an audit write. On Windows the calls are effectively no-ops; behaviour is unchanged.
- **Also tighten on read.** `loadTokens` does the same one-time `chmod` on an existing `tokens.enc`. The Conductor's `auth-status` probe only reads (and refreshes, which saves), so this tightens installs that never re-save.

### 2.4 Docs and version
- **README:**
  - Trust Model (line 99): state that free-text arguments are logged as `"[omitted]"` and error messages carry no query strings.
  - Audit log reference section: add the `"[omitted]"` marker and the list of keys.
  - Mention the 0600/0700 permissions under Compliance & Security.
- **`package.json` and `server.json`:** 2.1.0 → **2.1.1** (patch: no tool, parameter or response change).

---

## 3. Out of scope
- Cleaning up existing `audit.log` entries (T6, deferred).
- Upstream's IV change to 12 bytes (it forces a re-auth, and has no security benefit at this scale), and upstream's sink and allowlist machinery.
- What tools **return** to Claude. This PR is about what gets **written to disk**.
- `clio-export` page permissions, unless D3 says otherwise.

---

## 4. Tests (vitest; all new unless noted)

| # | File | Asserts |
|---|---|---|
| T-A1 | `src/utils/__tests__/auditPrivacy.test.ts` | **Schema sweep (fail closed):** register every tool (the fork's `register*` functions, as in `writeFieldsSelection.test.ts`). For every string-typed input key, the key must be in `FREE_TEXT_KEYS` or in an explicit `SAFE_STRING_KEYS` set: dates, `page_token`, enum-backed keys, `content_type`, `from`/`to`, `received_*`, `*_since`, and so on. An unclassified key fails with its tool and key name. |
| T-A2 | same | **Sentinel sweep:** call every tool with the sentinel `ZZ-PRIVATE-SENTINEL` in each free-text input (mock `clioGet`/`clioPost`/`clioPatch`/`clioPut`, and a real `appendAuditLog` writing to a temp HOME; set `HOME` and `vi.resetModules()` before importing, because `AUDIT_DIR` is fixed at module load). The sentinel appears **nowhere** in the log file. Run once with success mocks and once with every mock rejecting (error path). |
| T-A3 | same | Empty or undefined free-text values pass through as-is; secrets still read `"[REDACTED]"`; nested objects are handled |
| T-A4 | same | `upload_document` success entry has `document_id` and no `file_path`/`name` |
| T-C1 | `src/utils/__tests__/clioClient.test.ts` (new) | A 422 on `GET /contacts.json?query=Smith` produces a `ClioApiError` message containing `/contacts.json` but not `query` or `Smith`. Mock `fetch` via `vi.stubGlobal`. |
| T-P1 | `src/auth/__tests__/tokenStorage.test.ts` (new) | With a temp HOME and `ENCRYPTION_KEY` set, `saveTokens` leaves `tokens.enc` at 0600 and `~/.clio-mcp` at 0700 (skipped on win32). A pre-existing 0644 `tokens.enc` is tightened to 0600 by `loadTokens`. Round trip: save then load returns the same tokens (format unchanged). |
| T-P2 | `src/utils/__tests__/auditLog.test.ts` (**existing**, extend) | A new `audit.log` is 0600; a pre-existing 0644 one is tightened after the first append; a failing `chmod` doesn't throw |
| T-R | whole suite | `npm test` and `npm run build` green. The count rises from 15 files / 162 tests, with no existing test weakened. |

---

## 5. Live verification (on the Mac, after build and before merge)

Use the helper, since credentials live in the Desktop config: `node scripts/with-desktop-env.mjs …`.

| # | Step | Pass |
|---|---|---|
| L1 | `ls -la ~/.clio-mcp` **before** switching branch | Record the current modes (expect 0644/0755) |
| L2 | Build the PR branch; `node scripts/with-desktop-env.mjs node build/index.js auth-status` | `"ok": true` with **no re-auth**; afterwards `tokens.enc` is `-rw-------` and `~/.clio-mcp` is `drwx------` |
| L3 | Restart Claude Desktop; `search_contacts` for a real surname; then `create_note` on 04041-Test with subject "ZZ privacy check" | `tail -n 5 ~/.clio-mcp/audit.log` shows `"query":"[omitted]"` and `"subject":"[omitted]"`; `audit.log` is `-rw-------` |
| L4 | After L3–L6: `grep '"outcome":"error"' ~/.clio-mcp/audit.log \| tail` | Any **new** `error_message` has no `?` query string. There's no reliable way to force a Clio error live: 404s on get tools are logged as success, and bad arguments are rejected before any call. So T-C1 is the proof, and L4 checks whatever errors do occur. |
| L5 | `node scripts/with-desktop-env.mjs node scripts/smoke-v2.1-reads.mjs --matter 1701593810` | Same pass count as the 2026-09-25 run (19/19); the new audit lines hold no free text |
| L6 | The Conductor's scheduled run, or `clio-export` by hand as the Conductor runs it | Exit 0; the pages are the same as before the change (D3 permitting) |
| L7 | Clean up: delete the "ZZ privacy check" note on 04041-Test | — |

**Rollback:** `git checkout main && npm ci && npm run build`, then restart Desktop. Tightened permissions stay tightened, which is harmless, and no data format changed.

---

## 6. Residual risk (stated, not fixed here)
- Clio's own error text (`msg` in `clioFetch`) might echo a submitted value. That's not verified. If L4 or later use shows it does, add a `msg` scrub keyed on the submitted values.
- `console.error` output (Claude Desktop's MCP log) can include error messages. §2.2 removes query strings there too, but the Desktop log is outside this PR's control.
- Existing log lines keep their free text until T6 runs.

---

## 7. Decisions needed

| # | Question | Recommendation |
|---|---|---|
| D1 | Mask `search_contacts` / `list_documents` `query`? This makes the audit trail say *that* a contact search ran, not *for whom*. | **Yes.** A name in a plaintext log is the exact exposure; `result_count` and the timestamp still show the access |
| D2 | Marker for omitted text: `"[omitted]"` or a length (`"[omitted:42]"`) | `"[omitted]"`. A length adds little and leaks a little. |
| D3 | Also make `clio-export` pages 0600 (they include client dates of birth)? | **Not in this PR.** First confirm how the Conductor reads `--out-dir`: a sandbox mount or another user id could lose read access. Then do it as a follow-up. |
| D4 | Version | 2.1.1 |
