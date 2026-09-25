import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

const { mockClioGet, mockAppendAuditLog } = vi.hoisted(() => ({
  mockClioGet: vi.fn(),
  mockAppendAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../utils/clioClient.js", () => ({
  clioGet: mockClioGet,
  clioPost: vi.fn(),
  clioPatch: vi.fn(),
  clioPut: vi.fn(),
  getClioBaseUrl: vi.fn(() => "https://app.clio.com/api/v4"),
  ClioApiError: class extends Error {},
  extractNextPageToken: (meta: any) => {
    const nextUrl = meta?.paging?.next;
    if (!nextUrl) return null;
    try { return new URL(nextUrl).searchParams.get("page_token"); }
    catch { return null; }
  },
}));

vi.mock("../../utils/auditLog.js", () => ({
  appendAuditLog: mockAppendAuditLog,
}));
import { registerActivityTools } from "../activities.js";
import { registerCalendarTools } from "../calendar.js";
import { registerTaskTools } from "../tasks.js";
import { registerDocumentTools } from "../documents.js";

const handlers: Record<string, (args: Record<string, unknown>) => Promise<any>> = {};

beforeAll(() => {
  const fakeServer = {
    registerTool: (name: string, _schema: unknown, handler: any) => { handlers[name] = handler; },
  } as any;
  registerActivityTools(fakeServer);
  registerCalendarTools(fakeServer);
  registerTaskTools(fakeServer);
  registerDocumentTools(fakeServer);
});

beforeEach(() => {
  vi.clearAllMocks();
  mockAppendAuditLog.mockResolvedValue(undefined);
});

const NEXT = (path: string) => ({ records: 9, paging: { next: `https://app.clio.com/api/v4/${path}?page_token=nxt` } });
const parse = (r: any) => JSON.parse(r.content[0].text);

// ─── list_activities ─────────────────────────────────────────────────────────

describe("list_activities", () => {
  const EXPENSE = {
    id: 5, type: "ExpenseEntry", date: "2026-09-02", quantity: 1, price: 25, total: 25, note: "Transcript",
    billed: true, non_billable: false, no_charge: false, bill: { id: 700, number: "INV-7" },
    expense_category: { id: 4, name: "Transcripts" }, activity_description: null,
    user: { id: 3, name: "Tye" }, matter: { id: 42, display_number: "00042-001" },
    created_at: "2026-09-02T10:00:00Z", updated_at: "2026-09-02T10:00:00Z",
  };

  it("sends matter_id and no type filter by default, so time and expense entries both come back", async () => {
    mockClioGet.mockResolvedValue({ data: [EXPENSE], meta: { records: 1 } });
    await handlers["list_activities"]({ matter_id: 42, limit: 50 });
    const [path, params] = mockClioGet.mock.calls[0];
    expect(path).toBe("/activities.json");
    expect(params.matter_id).toBe("42");
    expect(params.limit).toBe("50");
    expect(params).not.toHaveProperty("type");
    expect(params.fields).toContain("expense_category{id,name}");
    expect(params.fields).toContain("bill{id,number}");
  });

  it("passes type, date range, status, updated_since and page_token through", async () => {
    mockClioGet.mockResolvedValue({ data: [EXPENSE], meta: { records: 1 } });
    await handlers["list_activities"]({
      matter_id: 42, limit: 50, type: "ExpenseEntry", start_date: "2026-08-01", end_date: "2026-08-31",
      status: "unbilled", updated_since: "2026-08-15T00:00:00Z", page_token: "abc",
    });
    const params = mockClioGet.mock.calls[0][1];
    expect(params).toMatchObject({
      type: "ExpenseEntry", start_date: "2026-08-01", end_date: "2026-08-31",
      status: "unbilled", updated_since: "2026-08-15T00:00:00Z", page_token: "abc",
    });
  });

  it("maps billing and expense detail", async () => {
    mockClioGet.mockResolvedValue({ data: [EXPENSE], meta: { records: 1 } });
    const a = parse(await handlers["list_activities"]({ matter_id: 42, limit: 50 })).activities[0];
    expect(a.type).toBe("ExpenseEntry");
    expect(a.billed).toBe(true);
    expect(a.bill).toEqual({ id: 700, number: "INV-7" });
    expect(a.expense_category).toEqual({ id: 4, name: "Transcripts" });
    expect(a.activity_description).toBeNull();
  });

  it("pages when the page is full", async () => {
    mockClioGet.mockResolvedValue({ data: [EXPENSE], meta: NEXT("activities.json") });
    const r = parse(await handlers["list_activities"]({ matter_id: 42, limit: 1 }));
    expect(r.next_page_token).toBe("nxt");
    expect(r.has_more).toBe(true);
  });

  it("leaves list_time_entries on its legacy contract (type=TimeEntry, bare array)", async () => {
    mockClioGet.mockResolvedValue({ data: [{ ...EXPENSE, type: "TimeEntry" }], meta: NEXT("activities.json") });
    const r = parse(await handlers["list_time_entries"]({ matter_id: 42, limit: 25 }));
    expect(mockClioGet.mock.calls[0][1].type).toBe("TimeEntry");
    expect(Array.isArray(r)).toBe(true);
  });
});

// ─── list_calendar_entries ───────────────────────────────────────────────────

describe("list_calendar_entries", () => {
  const ENTRY = {
    id: 1, summary: "Trial", description: null, start_at: "2026-10-01T09:30:00-06:00", end_at: "2026-10-01T16:00:00-06:00",
    location: "Edmonton Law Courts", all_day: false, updated_at: "2026-09-20T00:00:00Z",
    matter: { id: 42, display_number: "00042-001" }, attendees: [{ id: 3, name: "Tye" }],
  };

  it("keeps the existing call unchanged when no new params are given (no limit, no matter filter)", async () => {
    mockClioGet.mockResolvedValue({ data: [ENTRY], meta: { records: 1 } });
    await handlers["list_calendar_entries"]({ from: "2026-10-01", to: "2026-10-31" });
    const params = mockClioGet.mock.calls[0][1];
    expect(params.from).toBe("2026-10-01T00:00:00Z");
    expect(params.to).toBe("2026-10-31T23:59:59Z");
    for (const k of ["limit", "matter_id", "calendar_id", "updated_since", "page_token"]) {
      expect(params).not.toHaveProperty(k);
    }
    expect(params.fields).toContain("location");
    expect(params.fields).toContain("all_day");
  });

  it("passes matter_id, calendar_id, updated_since, limit and page_token through", async () => {
    mockClioGet.mockResolvedValue({ data: [ENTRY], meta: { records: 1 } });
    await handlers["list_calendar_entries"]({
      from: "2026-10-01", to: "2026-10-31", matter_id: 42, calendar_id: 9,
      updated_since: "2026-09-01T00:00:00Z", limit: 10, page_token: "t",
    });
    expect(mockClioGet.mock.calls[0][1]).toMatchObject({
      matter_id: "42", calendar_id: "9", updated_since: "2026-09-01T00:00:00Z", limit: "10", page_token: "t",
    });
  });

  it("returns an envelope with location, all_day and the Clio paging token", async () => {
    mockClioGet.mockResolvedValue({ data: [ENTRY], meta: NEXT("calendar_entries.json") });
    const r = parse(await handlers["list_calendar_entries"]({ from: "2026-10-01", to: "2026-10-31" }));
    expect(r.entries[0].location).toBe("Edmonton Law Courts");
    expect(r.entries[0].all_day).toBe(false);
    expect(r.next_page_token).toBe("nxt");
  });

  it("returns no token on a short page when a limit was given", async () => {
    mockClioGet.mockResolvedValue({ data: [ENTRY], meta: NEXT("calendar_entries.json") });
    const r = parse(await handlers["list_calendar_entries"]({ from: "2026-10-01", to: "2026-10-31", limit: 5 }));
    expect(r.next_page_token).toBeNull();
  });

  it("still returns 'No calendar entries found.' on an empty result", async () => {
    mockClioGet.mockResolvedValue({ data: [], meta: { records: 0 } });
    const r = await handlers["list_calendar_entries"]({ from: "2026-10-01", to: "2026-10-31" });
    expect(r.content[0].text).toBe("No calendar entries found.");
  });
});

// ─── list_tasks ──────────────────────────────────────────────────────────────

describe("list_tasks", () => {
  const TASK = {
    id: 8, name: "Order transcript", description: "From the prelim", priority: "Normal", due_at: "2026-09-10T00:00:00Z",
    status: "complete", completed_at: "2026-09-09T18:00:00Z", created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-09T18:00:00Z",
    assignee: { id: 3, name: "Tye" }, matter: { id: 42, display_number: "00042-001" }, reminders: [],
  };

  it("passes complete, created_since, updated_since and page_token through", async () => {
    mockClioGet.mockResolvedValue({ data: [TASK], meta: { records: 1 } });
    await handlers["list_tasks"]({
      matter_id: 42, limit: 25, complete: true, created_since: "2026-08-01T00:00:00Z",
      updated_since: "2026-09-01T00:00:00Z", page_token: "p",
    });
    expect(mockClioGet.mock.calls[0][1]).toMatchObject({
      matter_id: "42", complete: "true", created_since: "2026-08-01T00:00:00Z", updated_since: "2026-09-01T00:00:00Z", page_token: "p",
    });
  });

  it("sends complete=false for open tasks and omits it when unset", async () => {
    mockClioGet.mockResolvedValue({ data: [TASK], meta: { records: 1 } });
    await handlers["list_tasks"]({ matter_id: 42, limit: 25, complete: false });
    await handlers["list_tasks"]({ matter_id: 42, limit: 25 });
    expect(mockClioGet.mock.calls[0][1].complete).toBe("false");
    expect(mockClioGet.mock.calls[1][1]).not.toHaveProperty("complete");
  });

  it("returns description, completed_at and timestamps", async () => {
    mockClioGet.mockResolvedValue({ data: [TASK], meta: { records: 1 } });
    const t = parse(await handlers["list_tasks"]({ matter_id: 42, limit: 25 })).tasks[0];
    expect(t).toMatchObject({
      description: "From the prelim", completed_at: "2026-09-09T18:00:00Z",
      created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-09T18:00:00Z", due_date: "2026-09-10",
    });
  });

  it("pages when the page is full", async () => {
    mockClioGet.mockResolvedValue({ data: [TASK], meta: NEXT("tasks.json") });
    expect(parse(await handlers["list_tasks"]({ matter_id: 42, limit: 1 })).next_page_token).toBe("nxt");
  });
});

// ─── list_documents ──────────────────────────────────────────────────────────

describe("list_documents", () => {
  const DOC = {
    id: 2, name: "Disclosure letter.pdf", content_type: "application/pdf", size: 1000,
    created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-03T00:00:00Z", received_at: "2026-08-31T00:00:00Z",
    matter: { id: 42, display_number: "00042-001" },
  };

  it("passes created_since and updated_since through and requests the new timestamps", async () => {
    mockClioGet.mockResolvedValue({ data: [DOC], meta: { records: 1 } });
    await handlers["list_documents"]({
      matter_id: 42, limit: 25, created_since: "2026-08-01T00:00:00Z", updated_since: "2026-09-01T00:00:00Z",
    });
    const params = mockClioGet.mock.calls[0][1];
    expect(params.created_since).toBe("2026-08-01T00:00:00Z");
    expect(params.updated_since).toBe("2026-09-01T00:00:00Z");
    expect(params.fields).toContain("updated_at");
    expect(params.fields).toContain("received_at");
  });

  it("returns updated_at and received_at", async () => {
    mockClioGet.mockResolvedValue({ data: [DOC], meta: { records: 1 } });
    const d = parse(await handlers["list_documents"]({ matter_id: 42, limit: 25 })).documents[0];
    expect(d.updated_at).toBe("2026-09-03T00:00:00Z");
    expect(d.received_at).toBe("2026-08-31T00:00:00Z");
  });

  it("paginates past 50 documents", async () => {
    mockClioGet.mockResolvedValue({ data: Array.from({ length: 50 }, (_, i) => ({ ...DOC, id: i })), meta: NEXT("documents.json") });
    const r = parse(await handlers["list_documents"]({ matter_id: 42, limit: 50 }));
    expect(r.documents).toHaveLength(50);
    expect(r.next_page_token).toBe("nxt");
  });
});
