#!/usr/bin/env node
// Live smoke test for the v2.1 read tools (SPEC-clio-mcp-v2.1-reads.md §6).
//
// Read-only: calls list_* tools only. Spawns build/index.js over stdio exactly
// as Claude Desktop does, so it uses the same stored token and .env.
//
//   node scripts/smoke-v2.1-reads.mjs --matter <id> [--docs-matter <id>]
//        [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--list-only]
//
// --matter       an open matter where Tye has logged communications
// --docs-matter  a matter with more than 50 documents (defaults to --matter)
// --since/until  window for communications/activities/calendar (default: last 365 days)
// --list-only    only check the tool list; makes no Clio calls
//
// Exits 1 if any check fails. Every call is recorded in ~/.clio-mcp/audit.log.

import { spawnSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(root, "build", "index.js");

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const listOnly = process.argv.includes("--list-only");
const matterId = Number(arg("matter"));
const docsMatterId = Number(arg("docs-matter") ?? arg("matter"));
const today = new Date();
const until = arg("until") ?? today.toISOString().slice(0, 10);
const since = arg("since") ?? new Date(today.getTime() - 365 * 864e5).toISOString().slice(0, 10);

if (!listOnly && !Number.isInteger(matterId)) {
  console.error("Usage: node scripts/smoke-v2.1-reads.mjs --matter <id> [--docs-matter <id>] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--list-only]");
  process.exit(2);
}

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

// Refuse to run against an unauthenticated server: a tool call would open the
// OAuth browser flow instead of failing.
if (!listOnly) {
  const probe = spawnSync(process.execPath, [entry, "auth-status"], { cwd: root, encoding: "utf8" });
  let status = null;
  try { status = JSON.parse(probe.stdout.trim().split("\n").pop()); } catch { /* reported below */ }
  if (status?.ok !== true) {
    console.error(`auth-status did not report ok=true (${probe.stdout.trim() || probe.stderr.trim()}). Authenticate first.`);
    process.exit(1);
  }
  record("auth-status", true, "token valid");
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entry],
  cwd: root,
  env: { ...getDefaultEnvironment(), ...process.env, TRANSPORT: "stdio" },
  stderr: "inherit",
});
const client = new Client({ name: "smoke-v2.1-reads", version: "1.0.0" });
await client.connect(transport);

// Returns the parsed JSON envelope, or { empty: true } for "No X found.", or throws on isError.
async function call(name, args) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? "";
  if (res.isError) throw new Error(text);
  if (/^No .* found\.$/.test(text)) return { empty: true, text };
  return JSON.parse(text);
}

// Follows next_page_token to the end; checks for duplicate ids across pages.
async function drain(name, args, key, maxPages = 50) {
  const seen = new Set();
  let pages = 0, dupes = 0, token, first;
  do {
    const r = await call(name, { ...args, ...(token && { page_token: token }) });
    pages++;
    if (r.empty) break;
    first ??= r;
    for (const item of r[key]) { if (seen.has(item.id)) dupes++; seen.add(item.id); }
    token = r.next_page_token;
  } while (token && pages < maxPages);
  return { pages, count: seen.size, dupes, first, capped: Boolean(token) };
}

function hasKeys(obj, keys) {
  const missing = keys.filter((k) => !(k in obj));
  return missing.length ? `missing ${missing.join(", ")}` : null;
}

try {
  // 1. Registry
  const { tools } = await client.listTools();
  const names = new Set(tools.map((t) => t.name));
  const expected = ["list_communications", "list_notes", "list_activities", "list_calendar_entries", "list_tasks", "list_documents", "list_time_entries"];
  const absent = expected.filter((n) => !names.has(n));
  record("tool registry", tools.length === 29 && absent.length === 0, `${tools.length} tools${absent.length ? `; absent: ${absent.join(", ")}` : ""}`);

  if (!listOnly) {
    const m = { matter_id: matterId };

    // 2. list_communications — both types, window, paging at a small page size
    for (const type of ["EmailCommunication", "PhoneCommunication"]) {
      const d = await drain("list_communications", { ...m, type, received_since: since, received_before: until, limit: 5 }, "communications");
      const shapeErr = d.first ? hasKeys(d.first.communications[0], ["id", "type", "subject", "date", "senders", "receivers", "user", "matter"]) : null;
      const wrongType = d.first ? d.first.communications.some((c) => c.type !== type) : false;
      record(`list_communications ${type}`, !shapeErr && !wrongType && d.dupes === 0 && !d.capped,
        `${d.count} across ${d.pages} page(s)${shapeErr ? `; ${shapeErr}` : ""}${wrongType ? "; type filter leaked" : ""}${d.dupes ? `; ${d.dupes} duplicate ids` : ""}`);
    }
    const withBody = await call("list_communications", { ...m, include_body: true, body_max_chars: 200, limit: 5 });
    if (withBody.empty) record("list_communications include_body", false, "no communications on this matter — pick a matter where Tye has logged calls/emails");
    else {
      const c = withBody.communications[0];
      const ok = "body" in c && "body_truncated" in c && (c.body === null || c.body.length <= 200) && !/<[a-z]/i.test(c.body ?? "");
      record("list_communications include_body", ok, `body ${c.body === null ? "null" : `${c.body.length} chars`}, truncated=${c.body_truncated}`);
    }
    const noBody = await call("list_communications", { ...m, limit: 1 });
    record("list_communications body omitted by default", noBody.empty || !("body" in noBody.communications[0]));

    // 3. list_notes — lowercase type filter is the open question; a 422 surfaces here
    try {
      const d = await drain("list_notes", { ...m, limit: 50 }, "notes");
      const shapeErr = d.first ? hasKeys(d.first.notes[0], ["id", "subject", "date", "detail", "author", "matter", "created_at", "updated_at"]) : null;
      record("list_notes", !shapeErr && d.dupes === 0, `${d.count} across ${d.pages} page(s)${shapeErr ? `; ${shapeErr}` : ""}`);
    } catch (e) {
      record("list_notes", false, `${e.message} — if this is a 422 on "type", switch the filter in src/tools/notes.ts to "Matter"`);
    }

    // 4. list_activities — both types, then each type, then a status filter
    const all = await drain("list_activities", { ...m, start_date: since, end_date: until, limit: 50 }, "activities");
    const shapeErr = all.first ? hasKeys(all.first.activities[0], ["id", "type", "date", "total", "billed", "non_billable", "bill", "user", "matter"]) : null;
    record("list_activities (both types)", !shapeErr && all.dupes === 0, `${all.count} across ${all.pages} page(s)${shapeErr ? `; ${shapeErr}` : ""}`);
    let byType = 0;
    for (const type of ["TimeEntry", "ExpenseEntry"]) {
      const d = await drain("list_activities", { ...m, type, start_date: since, end_date: until, limit: 50 }, "activities");
      byType += d.count;
      record(`list_activities ${type}`, d.dupes === 0, `${d.count}`);
    }
    record("list_activities TimeEntry + ExpenseEntry = both", byType === all.count, `${byType} vs ${all.count} (a gap means hard/soft cost entries exist on this matter)`);
    const unbilled = await call("list_activities", { ...m, status: "unbilled", limit: 50 });
    record("list_activities status=unbilled", unbilled.empty || unbilled.activities.every((a) => !a.billed), unbilled.empty ? "none" : `${unbilled.activities.length}`);
    const legacy = await call("list_time_entries", { ...m, limit: 5 });
    record("list_time_entries unchanged (bare array)", legacy.empty || Array.isArray(legacy));

    // 5. list_tasks — paging, completion filter, new fields
    const tasks = await drain("list_tasks", { ...m, limit: 25 }, "tasks");
    const tShape = tasks.first ? hasKeys(tasks.first.tasks[0], ["description", "completed_at", "created_at", "updated_at"]) : null;
    record("list_tasks", !tShape && tasks.dupes === 0, `${tasks.count} across ${tasks.pages} page(s)${tShape ? `; ${tShape}` : ""}`);
    const done = await call("list_tasks", { ...m, complete: true, limit: 50 });
    const open = await call("list_tasks", { ...m, complete: false, limit: 50 });
    record("list_tasks complete=true/false", (done.empty || done.tasks.every((t) => t.completed_at)) && (open.empty || open.tasks.every((t) => !t.completed_at)),
      `${done.empty ? 0 : done.tasks.length} complete, ${open.empty ? 0 : open.tasks.length} open`);

    // 6. list_calendar_entries — conductor-style call (no new params), then matter filter
    const conductor = await call("list_calendar_entries", { from: until, to: new Date(Date.parse(until) + 7 * 864e5).toISOString().slice(0, 10) });
    record("list_calendar_entries conductor call (from/to only)", conductor.empty || Array.isArray(conductor.entries), conductor.empty ? conductor.text : `${conductor.entries.length} entries, envelope shape`);
    const cal = await drain("list_calendar_entries", { from: since, to: until, ...m, limit: 50 }, "entries");
    const offMatter = cal.first ? cal.first.entries.filter((e) => e.matter?.id !== matterId).length : 0;
    record("list_calendar_entries matter_id filter", offMatter === 0 && cal.dupes === 0, `${cal.count} entries${offMatter ? `; ${offMatter} on other matters` : ""}`);

    // 7. list_documents — paging past 50 on the docs matter
    const docs = await drain("list_documents", { matter_id: docsMatterId, limit: 50 }, "documents");
    const dShape = docs.first ? hasKeys(docs.first.documents[0], ["updated_at", "received_at"]) : null;
    record("list_documents paging", docs.pages > 1 && docs.dupes === 0 && !docs.capped && !dShape,
      `${docs.count} docs across ${docs.pages} page(s) on matter ${docsMatterId}${docs.pages <= 1 ? " — pick a matter with more than 50 documents" : ""}${dShape ? `; ${dShape}` : ""}`);
    const recent = await call("list_documents", { matter_id: docsMatterId, updated_since: `${since}T00:00:00Z`, limit: 50 });
    record("list_documents updated_since", recent.empty || recent.documents.every((d) => d.updated_at >= `${since}`), recent.empty ? "none" : `${recent.documents.length} on first page`);
  }
} catch (e) {
  record("unexpected error", false, e.message);
} finally {
  await client.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
process.exit(failed.length ? 1 : 0);
