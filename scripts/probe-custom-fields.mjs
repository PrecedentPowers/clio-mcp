#!/usr/bin/env node
// Step 0 of docs/SPEC-picklist-labels.md: what does Clio put in `value` for a
// dropdown (picklist) custom field on this account: the option id, or its label?
//
// Read-only. Calls Clio directly with the connector's stored token (no MCP
// server, no writes). Refuses to run unless auth-status reports ok, so it never
// opens the OAuth flow.
//
//   node scripts/with-desktop-env.mjs node scripts/probe-custom-fields.mjs --matter <id> [--matter <id> ...]
//   node scripts/with-desktop-env.mjs node scripts/probe-custom-fields.mjs --scan 200
//
// --matter  a matter id to inspect (repeatable)
// --scan N  look through up to N open matters for ones with a dropdown value set
//
// Privacy: prints field names, field types and dropdown option ids/labels only.
// Other custom field values (text, dates, amounts) are never printed, only their
// type. Nothing is written to disk.

import { spawnSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(root, "build", "index.js");

const argv = process.argv.slice(2);
const matterIds = [];
let scan = 0;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--matter") matterIds.push(Number(argv[++i]));
  else if (argv[i] === "--scan") scan = Number(argv[++i]);
}
if ((matterIds.length === 0 && !(scan > 0)) || matterIds.some((n) => !Number.isInteger(n))) {
  console.error("Usage: node scripts/probe-custom-fields.mjs (--matter <id> [--matter <id> ...] | --scan <N>)");
  process.exit(2);
}

// Same guard as the smoke script: an unauthenticated call would open a browser.
const probe = spawnSync(process.execPath, [entry, "auth-status"], { cwd: root, encoding: "utf8" });
let status = null;
try { status = JSON.parse(probe.stdout.trim().split("\n").pop()); } catch { /* reported below */ }
if (status?.ok !== true) {
  console.error(`auth-status did not report ok=true (${probe.stdout.trim() || probe.stderr.trim()}). Authenticate first.`);
  process.exit(1);
}

const { clioGet, extractNextPageToken } = await import(path.join(root, "build", "utils", "clioClient.js"));

// The exact sub-selection get_matter and clio-export use today (MATTER_DETAIL_FIELDS).
const CFV = "custom_field_values{id,value,field_type,field_name}";
const DEFINITION_FIELDS = "id,name,field_type,picklist_options{id,option}";
const MAX_PAGES = 10;

async function getAll(p, params) {
  const out = [];
  let token;
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await clioGet(p, { ...params, limit: "200", ...(token && { page_token: token }) });
    out.push(...(data.data ?? []));
    token = extractNextPageToken(data.meta);
    if (!token) break;
  }
  return out;
}

// 1. Field definitions: does the lookup the fix relies on work on this account?
console.log("== /custom_fields.json?parent_type=Matter");
const idToLabel = new Map();
const labelToId = new Map();
let definitionsOk = false;
try {
  const defs = await getAll("/custom_fields.json", { parent_type: "Matter", fields: DEFINITION_FIELDS });
  definitionsOk = true;
  const byType = {};
  for (const d of defs) byType[d.field_type] = (byType[d.field_type] ?? 0) + 1;
  console.log(`   200 OK: ${defs.length} matter custom fields by type ${JSON.stringify(byType)}`);
  for (const d of defs.filter((x) => x.field_type === "picklist")) {
    const opts = d.picklist_options ?? [];
    console.log(`   dropdown "${d.name}" (field ${d.id}): ${opts.length} options`);
    for (const o of opts) {
      idToLabel.set(String(o.id), o.option);
      labelToId.set(o.option, String(o.id));
    }
  }
} catch (err) {
  console.log(`   FAILED: ${err.message}`);
  console.log("   (A 403 here means the fix's label lookup would fail on this account; see spec §2.2.)");
}

// 2. Which matters to inspect.
let targets = matterIds;
if (scan > 0) {
  console.log(`\n== scanning up to ${scan} open matters for dropdown values`);
  const matters = [];
  let token;
  while (matters.length < scan) {
    const data = await clioGet("/matters.json", {
      status: "open",
      fields: `id,display_number,${CFV}`,
      limit: String(Math.min(200, scan - matters.length)),
      ...(token && { page_token: token }),
    });
    matters.push(...(data.data ?? []));
    token = extractNextPageToken(data.meta);
    if (!token) break;
  }
  const withPicklist = matters.filter((m) => (m.custom_field_values ?? []).some((v) => v.field_type === "picklist" && v.value != null));
  const withRef = matters.filter((m) => (m.custom_field_values ?? []).some((v) => ["contact", "matter"].includes(v.field_type) && v.value != null));
  console.log(`   ${matters.length} scanned; ${withPicklist.length} with a dropdown set; ${withRef.length} with a contact/matter-type field set`);
  targets = [...new Set([...withPicklist.slice(0, 3), ...withRef.slice(0, 2)].map((m) => m.id))];
  if (targets.length === 0) console.log("   Nothing to inspect: no dropdown or contact/matter-type values set on the scanned matters.");
}

// 3. Inspect each matter with the same field selection get_matter uses.
const verdicts = { id: 0, label: 0, unknown: 0 };
const refTypes = [];
for (const id of targets) {
  const { data: m } = await clioGet(`/matters/${id}.json`, { fields: `id,display_number,${CFV}` });
  console.log(`\n== matter ${m.id} (${m.display_number})`);
  for (const v of m.custom_field_values ?? []) {
    const type = v.field_type;
    if (type === "picklist") {
      let verdict = "unknown";
      if (v.value == null) verdict = "no selection";
      else if (idToLabel.has(String(v.value))) verdict = `OPTION ID -> label "${idToLabel.get(String(v.value))}"`;
      else if (labelToId.has(String(v.value))) verdict = "LABEL (already human-readable)";
      if (verdict.startsWith("OPTION ID")) verdicts.id++;
      else if (verdict.startsWith("LABEL")) verdicts.label++;
      else if (v.value != null) verdicts.unknown++;
      console.log(`   [picklist] "${v.field_name}": value=${JSON.stringify(v.value)} (${typeof v.value}) -> ${verdict}`);
    } else if (type === "contact" || type === "matter") {
      refTypes.push(type);
      console.log(`   [${type}] "${v.field_name}": value is ${v.value == null ? "null" : `${typeof v.value} ${JSON.stringify(v.value)}`}`);
    } else {
      console.log(`   [${type}] "${v.field_name}": ${v.value == null ? "null" : typeof v.value} (value not printed)`);
    }
  }
}

// 4. Verdict for the spec.
console.log("\n== step 0 result");
if (!definitionsOk) console.log("   Definitions read FAILED: the planned label lookup would not work on this account.");
if (verdicts.id > 0 && verdicts.label === 0) console.log(`   Dropdown values are OPTION IDS (${verdicts.id} seen). T3 is needed: build per the spec.`);
else if (verdicts.label > 0 && verdicts.id === 0) console.log(`   Dropdown values are already LABELS (${verdicts.label} seen). T3 closes with a pinning test, no code change.`);
else if (verdicts.id + verdicts.label === 0) console.log(`   No dropdown values could be classified${verdicts.unknown ? ` (${verdicts.unknown} matched neither an option id nor a label)` : ""}. Try --scan or another matter.`);
else console.log(`   Mixed: ${verdicts.id} ids, ${verdicts.label} labels. Report this output before building.`);
console.log(`   contact/matter-type fields seen: ${refTypes.length ? [...new Set(refTypes)].join(", ") : "none"} (decides plan T3b)`);
