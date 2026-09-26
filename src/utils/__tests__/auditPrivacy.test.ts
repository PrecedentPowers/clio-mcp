/**
 * The audit log must hold metadata, never client content (README, Trust Model).
 *
 * Two sweeps over every registered tool:
 *  1. Schema: every input that accepts arbitrary text is classified, either as
 *     free text (omitted from the log) or as a known-safe string (dates, cursors).
 *     A new text input that is neither fails here, so the rule fails closed.
 *  2. Sentinel: every free-text input is filled with a sentinel and each tool is
 *     run on its success path and its error path against the real audit writer.
 *     The sentinel must never reach audit.log.
 */
import { vi, describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";

const { home, previousHome, mockClioGet, mockClioPost, mockClioPatch, mockClioPut, MockClioApiError } = vi.hoisted(() => {
  // auditLog.ts fixes its directory from os.homedir() at import, so HOME must
  // point at a scratch directory before any module under test loads.
  const previousHome = process.env.HOME;
  const home = `${process.env.TMPDIR ?? "/tmp"}/clio-audit-privacy-${process.pid}-${Date.now()}`;
  process.env.HOME = home;
  class MockClioApiError extends Error {
    statusCode: number;
    constructor(statusCode: number, message: string) {
      super(message);
      this.statusCode = statusCode;
      this.name = "ClioApiError";
    }
  }
  return {
    home, previousHome,
    mockClioGet: vi.fn(), mockClioPost: vi.fn(), mockClioPatch: vi.fn(), mockClioPut: vi.fn(),
    MockClioApiError,
  };
});

vi.mock("../clioClient.js", () => ({
  clioGet: mockClioGet,
  clioPost: mockClioPost,
  clioPatch: mockClioPatch,
  clioPut: mockClioPut,
  ClioApiError: MockClioApiError,
  extractNextPageToken: () => null,
  getClioBaseUrl: () => "https://app.clio.com/api/v4",
}));

import { FREE_TEXT_KEYS, OMITTED, appendAuditLog } from "../auditLog.js";
import { registerMatterTools } from "../../tools/matters.js";
import { registerContactTools } from "../../tools/contacts.js";
import { registerDocumentTools } from "../../tools/documents.js";
import { registerTaskTools } from "../../tools/tasks.js";
import { registerCalendarTools } from "../../tools/calendar.js";
import { registerActivityTools } from "../../tools/activities.js";
import { registerBillingTools } from "../../tools/billing.js";
import { registerNoteTools } from "../../tools/notes.js";
import { registerCommunicationTools } from "../../tools/communications.js";
import { registerUserTools } from "../../tools/users.js";
import { registerAuditExportTool } from "../../tools/auditExport.js";

const REGISTRARS = [
  registerMatterTools, registerContactTools, registerDocumentTools, registerTaskTools,
  registerCalendarTools, registerActivityTools, registerBillingTools, registerNoteTools,
  registerCommunicationTools, registerUserTools, registerAuditExportTool,
];

const SENTINEL = "ZZ-PRIVATE-SENTINEL";
const AUDIT_FILE = path.join(home, ".clio-mcp", "audit.log");

/**
 * Inputs that accept arbitrary strings but carry no client content: cursors,
 * timestamps passed straight to Clio, and a MIME type. Anything added here must
 * be something that can never hold a name or client text.
 */
const SAFE_STRING_KEYS = new Set([
  "page_token", "created_since", "updated_since", "received_since", "received_before", "content_type",
]);

const schemas: Record<string, Record<string, any>> = {};
const handlers: Record<string, Function> = {};
let uploadFile: string;

beforeAll(async () => {
  const captureServer = {
    registerTool: (name: string, config: any, handler: Function) => {
      schemas[name] = config?.inputSchema ?? {};
      handlers[name] = handler;
    },
    registerResource: () => {},
  };
  for (const r of REGISTRARS) r(captureServer as any);

  // The upload path itself carries the sentinel, as a client folder name would.
  const dir = path.join(home, SENTINEL);
  await fs.mkdir(dir, { recursive: true });
  uploadFile = path.join(dir, `${SENTINEL}.txt`);
  await fs.writeFile(uploadFile, "hello");
});

afterAll(async () => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  await fs.rm(home, { recursive: true, force: true });
});

beforeEach(async () => {
  vi.clearAllMocks();
  await fs.rm(AUDIT_FILE, { force: true });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 200 })));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function acceptsArbitraryText(schema: any): boolean {
  try { return schema?.safeParse?.(SENTINEL)?.success === true; } catch { return false; }
}

/** First value this schema accepts, as in writeFieldsSelection.test.ts. */
function sampleFor(schema: any): unknown {
  const candidates: unknown[] = [1, true, "2026-01-01", "2026-01-01T00:00:00Z", "2026-01-01T09:00", "x"];
  for (const option of schema?.options ?? schema?._def?.values ?? []) candidates.unshift(option);
  for (const candidate of candidates) {
    try { if (schema?.safeParse?.(candidate)?.success) return candidate; } catch { /* not sampleable */ }
  }
  return undefined;
}

/** Explicit arguments where sampling can't reach the tool's write or read. */
const BASE_ARGS: Record<string, () => Record<string, unknown>> = {
  create_matter: () => ({ client_id: 7, status: "open", billable: true }),
  upload_document: () => ({ file_path: uploadFile, matter_id: 9 }),
  create_task: () => ({ matter_id: 9, priority: "Normal" }),
  update_task: () => ({ task_id: 42, status: "Pending" }),
  create_calendar_entry: () => ({ start_at: "2026-01-01T09:00", end_at: "2026-01-01T10:00", calendar_owner_id: 5 }),
  log_time_entry: () => ({ matter_id: 9, date: "2026-01-01", quantity_in_hours: 1 }),
  create_activity: () => ({ type: "ExpenseEntry", date: "2026-01-01", matter_id: 9, price: 1 }),
  list_notes: () => ({ matter_id: 9, limit: 25 }),
};

/** Sampled arguments, with every non-safe text input set to the sentinel. */
function argsWithSentinel(tool: string): { args: Record<string, unknown>; seeded: string[] } {
  const args: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(schemas[tool])) {
    const value = sampleFor(schema);
    if (value !== undefined) args[key] = value;
  }
  Object.assign(args, BASE_ARGS[tool]?.() ?? {});
  const seeded: string[] = [];
  for (const [key, schema] of Object.entries(schemas[tool])) {
    if (key === "file_path") { seeded.push(key); continue; }   // already a path containing the sentinel
    // Independent of FREE_TEXT_KEYS on purpose: a key that drops off that list
    // must still be caught here, not just by the classification test.
    if (!SAFE_STRING_KEYS.has(key) && acceptsArbitraryText(schema)) {
      args[key] = SENTINEL;
      seeded.push(key);
    }
  }
  return { args, seeded };
}

function primeSuccess() {
  mockClioGet.mockResolvedValue({ data: [], meta: { records: 0 } });
  mockClioPost.mockImplementation(async (p: string) =>
    p.startsWith("/documents.json")
      ? { data: { id: 1, latest_document_version: {
          uuid: "u", put_headers: [], multiparts: [{ part_number: 1, put_url: "https://s3.test/1", put_headers: [] }],
        } } }
      : { data: { id: 1 } },
  );
  mockClioPatch.mockResolvedValue({ data: { id: 42 } });
  mockClioPut.mockResolvedValue({ data: { multiparts: [] } });
}

function primeFailure() {
  const fail = async () => { throw new MockClioApiError(422, "Clio API error 422 on https://app.clio.com/api/v4/x.json: rejected"); };
  mockClioGet.mockImplementation(fail);
  mockClioPost.mockImplementation(fail);
  mockClioPatch.mockImplementation(fail);
  mockClioPut.mockImplementation(fail);
}

async function readLog(): Promise<string> {
  try { return await fs.readFile(AUDIT_FILE, "utf8"); } catch { return ""; }
}

describe("every text input is classified", () => {
  it("each tool input that accepts arbitrary text is free text or known-safe", () => {
    const unclassified: string[] = [];
    for (const [tool, shape] of Object.entries(schemas)) {
      for (const [key, schema] of Object.entries(shape)) {
        if (!acceptsArbitraryText(schema)) continue;
        if (FREE_TEXT_KEYS.has(key) || SAFE_STRING_KEYS.has(key)) continue;
        unclassified.push(`${tool}.${key}`);
      }
    }
    expect(
      unclassified,
      `classify these inputs in FREE_TEXT_KEYS (auditLog.ts) or SAFE_STRING_KEYS (this test):\n  ${unclassified.join("\n  ")}`,
    ).toEqual([]);
  });

  it("the sweep reaches the tools that take client text", () => {
    const seededTools = Object.keys(schemas).filter((t) => argsWithSentinel(t).seeded.length > 0).sort();
    expect(seededTools).toEqual(expect.arrayContaining([
      "create_activity", "create_calendar_entry", "create_matter", "create_note", "create_task",
      "list_documents", "log_time_entry", "search_contacts", "update_task", "upload_document",
    ]));
  });
});

describe("free text never reaches audit.log", () => {
  for (const [label, prime] of [["success path", primeSuccess], ["error path", primeFailure]] as const) {
    it(`on the ${label}`, async () => {
      const expectedTools: string[] = [];
      for (const tool of Object.keys(handlers)) {
        const { args, seeded } = argsWithSentinel(tool);
        if (seeded.length === 0) continue;
        expectedTools.push(tool);
        prime();
        try { await handlers[tool](args); } catch { /* the log is what is under test */ }
      }

      const log = await readLog();
      const loggedTools = new Set(log.split("\n").filter(Boolean).map((l) => JSON.parse(l).tool));
      // Guards the sweep: a tool that never wrote an entry proves nothing.
      expect([...loggedTools].sort()).toEqual(expect.arrayContaining(expectedTools.sort()));
      expect(log).not.toContain(SENTINEL);
    });
  }
});

describe("redaction rules", () => {
  it("marks supplied free text as omitted and passes empty values through", async () => {
    await appendAuditLog({
      tool: "t",
      args: { subject: "Call complainant", note: "", description: undefined, matter_id: 9, nested: { query: "Smith" } },
      outcome: "success",
    });
    const entry = JSON.parse((await readLog()).trim());
    expect(entry.args).toEqual({ subject: OMITTED, note: "", matter_id: 9, nested: { query: OMITTED } });
  });

  it("keeps secrets marked [REDACTED], distinct from omitted text", async () => {
    await appendAuditLog({ tool: "t", args: { access_token: "abc", name: "Smith" }, outcome: "success" });
    const entry = JSON.parse((await readLog()).trim());
    expect(entry.args).toEqual({ access_token: "[REDACTED]", name: OMITTED });
  });

  it("upload_document logs the Clio document id, not the local path or file name", async () => {
    primeSuccess();
    await handlers["upload_document"]({ file_path: uploadFile, matter_id: 9, name: SENTINEL });
    const entry = JSON.parse((await readLog()).trim());
    expect(entry.tool).toBe("upload_document");
    expect(entry.args).toEqual({ matter_id: 9, document_id: 1 });
  });
});
