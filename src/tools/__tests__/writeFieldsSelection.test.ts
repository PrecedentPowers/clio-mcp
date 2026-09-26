/**
 * Every write must ask Clio for the fields its own handler reads back.
 *
 * Clio's write responses carry only a minimal record unless `fields` is
 * requested, so a write that omits it reports a successful write with every
 * field but the id missing. Ported from upstream oktopeak/clio-mcp 2.3.0
 * (writeFieldsSelection.test.ts), adapted to this fork's tool modules: the fork
 * has no REGISTRARS list, so the register functions are imported directly.
 */
import { vi, describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

const { mockClioGet, mockClioPost, mockClioPatch, mockClioPut, MockClioApiError } = vi.hoisted(() => {
  class MockClioApiError extends Error {
    statusCode: number;
    constructor(statusCode: number, message: string) {
      super(message);
      this.statusCode = statusCode;
      this.name = "ClioApiError";
    }
  }
  return {
    mockClioGet: vi.fn(),
    mockClioPost: vi.fn(),
    mockClioPatch: vi.fn(),
    mockClioPut: vi.fn(),
    MockClioApiError,
  };
});

vi.mock("../../utils/clioClient.js", () => ({
  clioGet: mockClioGet,
  clioPost: mockClioPost,
  clioPatch: mockClioPatch,
  clioPut: mockClioPut,
  ClioApiError: MockClioApiError,
  extractNextPageToken: () => null,
  getClioBaseUrl: () => "https://app.clio.com/api/v4",
}));

vi.mock("../../utils/auditLog.js", () => ({
  appendAuditLog: vi.fn().mockResolvedValue(undefined),
  readAuditLog: vi.fn().mockResolvedValue([]),
}));

// Only reached by the plumbing tests, which import the real clioClient.
vi.mock("../../auth/oauth.js", () => ({
  getValidAccessToken: vi.fn().mockResolvedValue("test-token"),
}));

import { registerMatterTools } from "../matters.js";
import { registerContactTools } from "../contacts.js";
import { registerDocumentTools } from "../documents.js";
import { registerTaskTools } from "../tasks.js";
import { registerCalendarTools } from "../calendar.js";
import { registerActivityTools } from "../activities.js";
import { registerBillingTools } from "../billing.js";
import { registerNoteTools } from "../notes.js";
import { registerCommunicationTools } from "../communications.js";
import { registerUserTools } from "../users.js";
import { registerAuditExportTool } from "../auditExport.js";

const REGISTRARS = [
  registerMatterTools, registerContactTools, registerDocumentTools, registerTaskTools,
  registerCalendarTools, registerActivityTools, registerBillingTools, registerNoteTools,
  registerCommunicationTools, registerUserTools, registerAuditExportTool,
];

/** Every tool in this fork that writes to Clio. A new write tool must be added here. */
const WRITE_TOOLS = [
  "create_matter", "upload_document", "create_task", "update_task", "complete_task",
  "create_calendar_entry", "log_time_entry", "create_activity", "create_note",
];

const schemas: Record<string, Record<string, any>> = {};
const handlers: Record<string, Function> = {};
let tmpDir: string;
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

  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clio-write-fields-"));
  uploadFile = path.join(tmpDir, "upload.txt");
  await fs.writeFile(uploadFile, "hello");
});

/** Explicit, valid arguments for the write tools so each one reaches its write. */
const WRITE_ARGS: Record<string, () => Record<string, unknown>> = {
  create_matter: () => ({ client_id: 7, description: "x", status: "open", billable: true }),
  upload_document: () => ({ file_path: uploadFile, matter_id: 9 }),
  create_task: () => ({ matter_id: 9, name: "x", description: "xx", priority: "Normal" }),
  update_task: () => ({ task_id: 42, status: "Pending" }),
  complete_task: () => ({ task_id: 42 }),
  create_calendar_entry: () => ({
    summary: "x", start_at: "2026-01-01T09:00:00Z", end_at: "2026-01-01T10:00:00Z", calendar_owner_id: 5,
  }),
  log_time_entry: () => ({ matter_id: 9, date: "2026-01-01", quantity_in_hours: 1 }),
  create_activity: () => ({ type: "TimeEntry", date: "2026-01-01", matter_id: 9, quantity_in_hours: 1 }),
  create_note: () => ({ matter_id: 9, subject: "x", body: "x" }),
};

/** First value this schema accepts. Mirrors upstream's sampler. */
function sampleFor(schema: any): unknown {
  const candidates: unknown[] = [1, true, "2026-01-01", "2026-01-01T00:00:00Z", "x"];
  for (const option of schema?.options ?? schema?._def?.values ?? []) candidates.unshift(option);
  for (const candidate of candidates) {
    try {
      if (schema?.safeParse?.(candidate)?.success) return candidate;
    } catch { /* not a zod schema we can sample */ }
  }
  return undefined;
}

function argsFor(tool: string): Record<string, unknown> {
  if (WRITE_ARGS[tool]) return WRITE_ARGS[tool]();
  const args: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(schemas[tool] ?? {})) {
    const value = sampleFor(schema);
    if (value !== undefined) args[key] = value;
  }
  return args;
}

/** A write asked for a field selection if it is in the params or already in the path. */
function selectsFields(call: unknown[]): boolean {
  const [p, , params] = call as [string, unknown, Record<string, string> | undefined];
  if (typeof p === "string" && /[?&]fields=/.test(p)) return true;
  const fields = params?.["fields"];
  return typeof fields === "string" && fields.length > 0;
}

function describeCall(call: unknown[]): string {
  const [p, , params] = call as [string, unknown, Record<string, string> | undefined];
  return `${p} (params: ${JSON.stringify(params ?? null)})`;
}

function fieldsOf(call: unknown[] | undefined): string {
  return ((call?.[2] as Record<string, string> | undefined)?.["fields"]) ?? "";
}

const FULL_TASK = {
  id: 42, name: "Draft contract", priority: "Normal", status: "complete",
  due_at: "2026-01-15T00:00:00Z", completed_at: "2026-05-22T10:00:00Z", matter: { id: 99 },
};

/** Behaves like Clio: the minimal record unless a fields selection was sent. */
function clioLike(full: Record<string, unknown>) {
  return async (_path: string, _body: unknown, params?: Record<string, string>) =>
    params?.["fields"] ? { data: full } : { data: { id: full.id } };
}

function primeDefaults() {
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

beforeEach(() => {
  vi.clearAllMocks();
  primeDefaults();
  // upload_document PUTs parts straight to S3 via global fetch.
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 200 })));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("clioClient passes a params fields selection into the query string", () => {
  for (const method of ["clioPost", "clioPatch", "clioPut"] as const) {
    it(`${method} sets params on the request URL`, async () => {
      const real = await vi.importActual<typeof import("../../utils/clioClient.js")>("../../utils/clioClient.js");
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { id: 1 } }), { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);

      await real[method]("/tasks.json", { data: {} }, { fields: "id,status" });

      const url = new URL(fetchMock.mock.calls[0][0] as string);
      expect(url.pathname).toMatch(/\/tasks\.json$/);
      expect(url.searchParams.get("fields")).toBe("id,status");
    });
  }
});

describe("every write asks Clio for the fields it reads back", () => {
  it("no registered tool issues a write that takes Clio's default response", async () => {
    const offenders: string[] = [];
    const wrote = new Set<string>();

    for (const [tool, handler] of Object.entries(handlers)) {
      vi.clearAllMocks();
      primeDefaults();

      // A tool that rejects the sampled arguments may still have issued a write
      // before failing, and that write is as much under test as a clean one.
      try { await handler(argsFor(tool)); } catch { /* the call shape is what is under test */ }

      const calls = [...mockClioPost.mock.calls, ...mockClioPatch.mock.calls, ...mockClioPut.mock.calls];
      if (calls.length) wrote.add(tool);
      for (const call of calls) {
        if (!selectsFields(call)) offenders.push(`${tool} -> ${describeCall(call)}`);
      }
    }

    // Guards the sweep itself: a write tool that never reached its write proves nothing.
    expect([...wrote].sort()).toEqual([...WRITE_TOOLS].sort());
    expect(
      offenders,
      `these writes read back fields Clio was never asked for:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });

  it("write tools request the extra fields their responses report", async () => {
    await handlers["complete_task"](WRITE_ARGS.complete_task());
    expect(fieldsOf(mockClioPatch.mock.calls.at(-1))).toContain("completed_at");

    await handlers["log_time_entry"](WRITE_ARGS.log_time_entry());
    await handlers["create_activity"](WRITE_ARGS.create_activity());
    for (const call of mockClioPost.mock.calls) {
      expect(fieldsOf(call)).toContain("type");
      expect(fieldsOf(call)).toContain("non_billable");
    }

    mockClioPost.mockClear();
    await handlers["create_matter"](WRITE_ARGS.create_matter());
    const matterFields = fieldsOf(mockClioPost.mock.calls.at(-1));
    expect(matterFields).toContain("originating_attorney{id,name}");
    expect(matterFields).toContain("client_reference");
    expect(matterFields).toContain("client{id,name,date_of_birth}");
  });
});

// conductor-task stamps the returned id back into the vault and trusts the
// returned status, so these shapes are load-bearing.
describe("task write tools return real ids and status (conductor-task contract)", () => {
  it("create_task returns id, name, priority and due date", async () => {
    mockClioPost.mockImplementation(clioLike({ ...FULL_TASK, status: "pending", completed_at: null }));
    const result = await handlers["create_task"]({ ...WRITE_ARGS.create_task(), due_date: "2026-01-15" }) as any;
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text)).toEqual({
      success: true,
      task: { id: 42, name: "Draft contract", priority: "Normal", due_at: "2026-01-15", matter_id: 9 },
    });
  });

  it("update_task returns id, status and matter_id", async () => {
    mockClioPatch.mockImplementation(clioLike({ ...FULL_TASK, status: "pending" }));
    const result = await handlers["update_task"](WRITE_ARGS.update_task()) as any;
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text)).toEqual({
      success: true,
      task: {
        id: 42, name: "Draft contract", priority: "Normal", status: "pending",
        due_date: "2026-01-15", matter_id: 99,
      },
    });
  });

  it("complete_task returns id, status and completed_at", async () => {
    mockClioPatch.mockImplementation(clioLike(FULL_TASK));
    const result = await handlers["complete_task"](WRITE_ARGS.complete_task()) as any;
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text)).toEqual({
      success: true,
      task: { id: 42, name: "Draft contract", status: "complete", completed_at: "2026-05-22T10:00:00Z" },
    });
  });
});

// A write can request a field selection (the sweep above) and still under-request
// it — asking for less than the handler actually reads back off the response. A
// tool that reads a property Clio was never asked for silently gets `undefined`
// for it. This guard catches that by recording every top-level property each
// handler reads off the written record and checking it against what was requested.
describe("every write tool only reads properties it requested", () => {
  /** Split a Clio fields string into its top-level names, e.g. "id,matter{id},x" -> [id, matter, x]. */
  function parseTopLevelFields(fields: string): Set<string> {
    const names = new Set<string>();
    let depth = 0;
    let current = "";
    for (const ch of fields) {
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (ch === "," && depth === 0) {
        if (current) names.add(current.replace(/\{.*\}$/s, ""));
        current = "";
        continue;
      }
      current += ch;
    }
    if (current) names.add(current.replace(/\{.*\}$/s, ""));
    return names;
  }

  /** Wraps a plausible record in a Proxy that records every top-level property read. */
  function recordingProxy(base: Record<string, unknown>, reads: Set<string>): Record<string, unknown> {
    return new Proxy(base, {
      get(target, prop, receiver) {
        if (typeof prop === "symbol" || prop === "then" || prop === "toJSON" || prop === "id") {
          return Reflect.get(target, prop, receiver);
        }
        reads.add(prop);
        return Reflect.get(target, prop, receiver);
      },
    });
  }

  // Plausible values for whatever each handler reads back off its write response,
  // so handlers don't throw reaching into a nested id/name.
  const BASE_RECORDS: Record<string, Record<string, unknown>> = {
    create_matter: {
      id: 1, display_number: "00001-001", description: "x", status: "open", billable: true,
      client: { id: 1, name: "Client" },
      practice_area: { id: 1, name: "Litigation" },
      responsible_attorney: { id: 1, name: "Attorney" },
      originating_attorney: { id: 1, name: "Attorney" },
      client_reference: "ref-1",
      open_date: "2026-01-01",
    },
    create_task: {
      id: 1, name: "Task", priority: "Normal", due_at: "2026-01-15T00:00:00Z", matter: { id: 9 },
    },
    update_task: {
      id: 1, name: "Task", priority: "Normal", status: "pending", due_at: "2026-01-15T00:00:00Z", matter: { id: 9 },
    },
    complete_task: {
      id: 1, name: "Task", status: "complete", completed_at: "2026-05-22T10:00:00Z", matter: { id: 9 },
    },
    create_calendar_entry: {
      id: 1, summary: "Meeting", description: "x", start_at: "2026-01-01T09:00:00Z", end_at: "2026-01-01T10:00:00Z",
      matter: { id: 9, display_number: "00001-001" },
      attendees: [{ id: 5, name: "User" }],
    },
    log_time_entry: {
      id: 1, date: "2026-01-01", quantity_in_hours: 1, price: 100, total: 100, note: "x", non_billable: false,
      matter: { id: 9, display_number: "00001-001" },
      user: { id: 5, name: "User" },
    },
    create_activity: {
      id: 1, type: "TimeEntry", date: "2026-01-01", quantity_in_hours: 1, price: 100, total: 100, note: "x", non_billable: false,
      matter: { id: 9, display_number: "00001-001" },
      user: { id: 5, name: "User" },
    },
    create_note: { id: 1, subject: "x" },
  };

  it("no write tool reads a property Clio was never asked for", async () => {
    const offenders: string[] = [];

    for (const tool of WRITE_TOOLS) {
      if (tool === "upload_document") continue;

      const base = BASE_RECORDS[tool];
      if (!base) throw new Error(`no BASE_RECORDS entry for write tool "${tool}" — add one`);

      vi.clearAllMocks();
      primeDefaults();

      const reads = new Set<string>();
      const proxy = recordingProxy(base, reads);
      mockClioPost.mockResolvedValue({ data: proxy });
      mockClioPatch.mockResolvedValue({ data: proxy });

      await handlers[tool](WRITE_ARGS[tool]());

      const calls = [...mockClioPost.mock.calls, ...mockClioPatch.mock.calls];
      const lastCall = calls.at(-1);
      expect(lastCall, `${tool} never issued a write`).toBeDefined();
      const requested = parseTopLevelFields(fieldsOf(lastCall));

      for (const prop of reads) {
        if (!requested.has(prop)) {
          offenders.push(`${tool} reads ${prop} but does not request it`);
        }
      }
    }

    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});
