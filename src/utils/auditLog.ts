import fs from "fs/promises";
import path from "path";
import os from "os";
import { randomUUID } from "crypto";
import { loadTokens } from "../auth/tokenStorage.js";
import { getSessionContext } from "./sessionContext.js";
import { ensurePrivateDir, restrictMode } from "./privateFs.js";

const STDIO_SESSION_ID = randomUUID();

const AUDIT_DIR = path.join(os.homedir(), ".clio-mcp");
const AUDIT_FILE = path.join(AUDIT_DIR, "audit.log");

const REDACTED_KEYS = new Set([
  "access_token", "refresh_token", "client_secret", "password", "token", "encryption_key",
]);

/**
 * Argument keys that carry free text: client content (task wording, note
 * subjects, time-entry narratives, event titles, matter descriptions), search
 * terms (often a person's name) and local file paths. The audit log records
 * that such a value was supplied, never the value: a non-empty string becomes
 * "[omitted]". auditPrivacy.test.ts fails if any tool gains a string input that
 * is neither listed here nor classified as safe.
 */
export const FREE_TEXT_KEYS = new Set([
  "name", "description", "subject", "note", "summary", "query", "file_path",
  "client_reference", "reference", "body", "detail", "location",
]);

export const OMITTED = "[omitted]";

// Existing audit.log files predate owner-only permissions; tighten once per process.
let auditPermissionsChecked = false;

function detectMachineIp(): string | undefined {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === "IPv4" && !addr.internal) return addr.address;
    }
  }
}
const MACHINE_IP: string | undefined = detectMachineIp();

export interface AuditEntry {
  timestamp: string;
  session_id: string;
  machine_ip?: string;
  tool: string;
  args: Record<string, unknown>;
  outcome: "success" | "error" | "not_found";
  error_message?: string;
  clio_user_id?: string;
  matter_id?: number;
  result_count?: number;
}

export interface AuditLogFilter {
  date_from?: string;
  date_to?: string;
  matter_id?: number;
  limit?: number;
  offset?: number;
}

export interface ReadAuditLogResult {
  entries: AuditEntry[];
  total_matched: number;
  truncated: boolean;
}

function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (REDACTED_KEYS.has(k.toLowerCase())) {
      out[k] = "[REDACTED]";
    } else if (FREE_TEXT_KEYS.has(k.toLowerCase()) && typeof v === "string" && v.length > 0) {
      out[k] = OMITTED;
    } else if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      out[k] = redactArgs(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export async function appendAuditLog(
  entry: Omit<AuditEntry, "timestamp" | "session_id" | "machine_ip" | "clio_user_id"> & { clio_user_id?: string; result_count?: number }
): Promise<void> {
  try {
    if (auditPermissionsChecked) {
      await fs.mkdir(AUDIT_DIR, { recursive: true, mode: 0o700 });
    } else {
      await ensurePrivateDir(AUDIT_DIR);
    }

    const ctx = getSessionContext();
    const session_id = ctx?.sessionId ?? STDIO_SESSION_ID;

    let clio_user_id = entry.clio_user_id;
    if (!clio_user_id) {
      if (ctx) {
        clio_user_id = ctx.getTokens()?.clio_user_id;
      } else {
        try { clio_user_id = (await loadTokens())?.clio_user_id; } catch { /* non-fatal */ }
      }
    }

    const full: AuditEntry = {
      timestamp: new Date().toISOString(),
      session_id,
      ...(MACHINE_IP !== undefined && { machine_ip: MACHINE_IP }),
      tool: entry.tool,
      args: redactArgs(entry.args),
      outcome: entry.outcome,
      ...(entry.error_message && { error_message: entry.error_message }),
      ...(clio_user_id && { clio_user_id }),
      ...(entry.matter_id !== undefined && { matter_id: entry.matter_id }),
      ...(entry.result_count !== undefined && { result_count: entry.result_count }),
    };

    await fs.appendFile(AUDIT_FILE, JSON.stringify(full) + "\n", { encoding: "utf8", mode: 0o600 });
    if (!auditPermissionsChecked) {
      await restrictMode(AUDIT_FILE, 0o600);
      auditPermissionsChecked = true;
    }
  } catch (err: any) {
    console.error(`[audit] WARNING: Failed to write audit log: ${err.message}`);
  }
}

export async function readAuditLog(filter: AuditLogFilter = {}): Promise<ReadAuditLogResult> {
  const limit = Math.min(filter.limit ?? 500, 1000);
  const offset = filter.offset ?? 0;

  let raw: string;
  try {
    raw = await fs.readFile(AUDIT_FILE, "utf8");
  } catch (err: any) {
    if (err.code === "ENOENT") return { entries: [], total_matched: 0, truncated: false };
    throw err;
  }

  const matched: AuditEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let entry: Partial<AuditEntry>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (filter.date_from && (!entry.timestamp || entry.timestamp.slice(0, 10) < filter.date_from)) continue;
    if (filter.date_to && (!entry.timestamp || entry.timestamp.slice(0, 10) > filter.date_to)) continue;
    if (filter.matter_id !== undefined && entry.matter_id !== filter.matter_id) continue;
    matched.push(entry as AuditEntry);
  }

  const total_matched = matched.length;
  const page = matched.slice(offset, offset + limit);
  return { entries: page, total_matched, truncated: offset + page.length < total_matched };
}
