#!/usr/bin/env node
// Run a command with the Clio MCP server's environment from Claude Desktop's config.
//
// The connector's CLIO_CLIENT_ID / CLIO_CLIENT_SECRET live in
// claude_desktop_config.json (mcpServers.clio.env), not in a .env, so a bare
// `node build/index.js auth-status` fails with "missing required env var(s)".
// This wrapper merges that env block into the command's environment. Values are
// never printed.
//
//   node scripts/with-desktop-env.mjs [--server <name>] <command> [args...]
//
// e.g.
//   node scripts/with-desktop-env.mjs node build/index.js auth-status
//   node scripts/with-desktop-env.mjs node scripts/smoke-v2.1-reads.mjs --list-only
//
// --server  the mcpServers key to read (default: clio)
// CLAUDE_DESKTOP_CONFIG overrides the config path (default: macOS location).

import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";

const argv = process.argv.slice(2);
let server = "clio";
if (argv[0] === "--server") {
  server = argv[1];
  argv.splice(0, 2);
}
if (!server || argv.length === 0) {
  console.error("Usage: node scripts/with-desktop-env.mjs [--server <name>] <command> [args...]");
  process.exit(2);
}

const configPath = process.env.CLAUDE_DESKTOP_CONFIG
  ?? path.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");

let serverEnv;
try {
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const entry = config.mcpServers?.[server];
  if (!entry) {
    console.error(`No mcpServers.${server} entry in ${configPath}.`);
    process.exit(2);
  }
  serverEnv = entry.env ?? {};
} catch (err) {
  console.error(`Could not read ${configPath}: ${err.message}`);
  process.exit(2);
}

// Names only, so a missing credential is visible without exposing any value.
console.error(`[with-desktop-env] ${server}: ${Object.keys(serverEnv).sort().join(", ") || "(no env keys)"}`);

const res = spawnSync(argv[0], argv.slice(1), {
  stdio: "inherit",
  env: { ...process.env, ...serverEnv },
});
if (res.error) {
  console.error(`Could not run ${argv[0]}: ${res.error.message}`);
  process.exit(1);
}
process.exit(res.status ?? 1);
