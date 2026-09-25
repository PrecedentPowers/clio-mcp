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
import { registerCommunicationTools } from "../communications.js";

const handlers: Record<string, (args: Record<string, unknown>) => Promise<any>> = {};

beforeAll(() => {
  registerCommunicationTools({
    registerTool: (name: string, _schema: unknown, handler: any) => { handlers[name] = handler; },
  } as any);
});

beforeEach(() => {
  vi.clearAllMocks();
  mockAppendAuditLog.mockResolvedValue(undefined);
});

const EMAIL = {
  id: 11,
  type: "EmailCommunication",
  subject: "Disclosure follow-up",
  body: "<p>Crown says the <b>video</b> is coming &amp; soon.</p>",
  date: "2026-09-01",
  received_at: "2026-09-01T15:04:00Z",
  senders: [{ id: 3, name: "Tye", type: "User" }],
  receivers: [{ id: 80, name: "Crown Office", type: "Contact" }],
  user: { id: 3, name: "Tye" },
  matter: { id: 42, display_number: "00042-001" },
  created_at: "2026-09-01T15:05:00Z",
  updated_at: "2026-09-01T15:05:00Z",
};

const DEFAULTS = { matter_id: 42, include_body: false, body_max_chars: 2000, limit: 50 };

describe("list_communications", () => {
  describe("request params", () => {
    beforeEach(() => mockClioGet.mockResolvedValue({ data: [EMAIL], meta: { records: 1 } }));

    it("calls the communications endpoint filtered by matter", async () => {
      await handlers["list_communications"](DEFAULTS);
      expect(mockClioGet.mock.calls[0][0]).toBe("/communications.json");
      const params = mockClioGet.mock.calls[0][1];
      expect(params.matter_id).toBe("42");
      expect(params.limit).toBe("50");
      expect(params).not.toHaveProperty("type");
      expect(params).not.toHaveProperty("page_token");
    });

    it("requests senders, receivers and body fields", async () => {
      await handlers["list_communications"](DEFAULTS);
      const fields = mockClioGet.mock.calls[0][1].fields as string;
      for (const f of ["senders{id,name,type}", "receivers{id,name,type}", "body", "received_at", "matter{id,display_number}"]) {
        expect(fields).toContain(f);
      }
    });

    it("passes type, date window and page_token through to Clio", async () => {
      await handlers["list_communications"]({
        ...DEFAULTS,
        type: "PhoneCommunication",
        received_since: "2026-08-01",
        received_before: "2026-08-31",
        page_token: "tok",
      });
      const params = mockClioGet.mock.calls[0][1];
      expect(params.type).toBe("PhoneCommunication");
      expect(params.received_since).toBe("2026-08-01");
      expect(params.received_before).toBe("2026-08-31");
      expect(params.page_token).toBe("tok");
    });
  });

  describe("response mapping", () => {
    it("flattens senders and receivers to {id, name, kind} and omits body by default", async () => {
      mockClioGet.mockResolvedValue({ data: [EMAIL], meta: { records: 1 } });
      const result = await handlers["list_communications"](DEFAULTS);
      const c = JSON.parse(result.content[0].text).communications[0];
      expect(c.senders).toEqual([{ id: 3, name: "Tye", kind: "User" }]);
      expect(c.receivers).toEqual([{ id: 80, name: "Crown Office", kind: "Contact" }]);
      expect(c).not.toHaveProperty("body");
      expect(c).not.toHaveProperty("body_truncated");
      expect(c.subject).toBe("Disclosure follow-up");
      expect(c.matter).toEqual({ id: 42, display_number: "00042-001" });
    });

    it("includes the body as plain text when include_body is true", async () => {
      mockClioGet.mockResolvedValue({ data: [EMAIL], meta: { records: 1 } });
      const result = await handlers["list_communications"]({ ...DEFAULTS, include_body: true });
      const c = JSON.parse(result.content[0].text).communications[0];
      expect(c.body).toBe("Crown says the video is coming & soon.");
      expect(c.body_truncated).toBe(false);
    });

    it("truncates the body to body_max_chars and flags it", async () => {
      mockClioGet.mockResolvedValue({ data: [{ ...EMAIL, body: "abcdefghij" }], meta: { records: 1 } });
      const result = await handlers["list_communications"]({ ...DEFAULTS, include_body: true, body_max_chars: 4 });
      const c = JSON.parse(result.content[0].text).communications[0];
      expect(c.body).toBe("abcd");
      expect(c.body_truncated).toBe(true);
    });

    it("returns null body when Clio has none", async () => {
      mockClioGet.mockResolvedValue({ data: [{ ...EMAIL, body: null }], meta: { records: 1 } });
      const result = await handlers["list_communications"]({ ...DEFAULTS, include_body: true });
      expect(JSON.parse(result.content[0].text).communications[0].body).toBeNull();
    });

    it("returns 'No communications found.' on an empty page", async () => {
      mockClioGet.mockResolvedValue({ data: [], meta: { records: 0 } });
      const result = await handlers["list_communications"](DEFAULTS);
      expect(result.content[0].text).toBe("No communications found.");
    });
  });

  describe("pagination", () => {
    it("returns next_page_token when the page is full and Clio has more", async () => {
      mockClioGet.mockResolvedValue({
        data: [EMAIL],
        meta: { records: 3, paging: { next: "https://app.clio.com/api/v4/communications.json?page_token=p2" } },
      });
      const parsed = JSON.parse((await handlers["list_communications"]({ ...DEFAULTS, limit: 1 })).content[0].text);
      expect(parsed.has_more).toBe(true);
      expect(parsed.next_page_token).toBe("p2");
    });

    it("returns a null token on a short page", async () => {
      mockClioGet.mockResolvedValue({ data: [EMAIL], meta: { records: 1 } });
      const parsed = JSON.parse((await handlers["list_communications"](DEFAULTS)).content[0].text);
      expect(parsed.has_more).toBe(false);
      expect(parsed.next_page_token).toBeNull();
    });
  });

  describe("audit log and errors", () => {
    it("logs success with matter_id and result_count", async () => {
      mockClioGet.mockResolvedValue({ data: [EMAIL], meta: { records: 1 } });
      await handlers["list_communications"](DEFAULTS);
      expect(mockAppendAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({ tool: "list_communications", outcome: "success", result_count: 1, matter_id: 42 }),
      );
    });

    it("logs the error and returns isError when Clio fails", async () => {
      mockClioGet.mockRejectedValue(new Error("boom"));
      const result = await handlers["list_communications"](DEFAULTS);
      expect(result.isError).toBe(true);
      expect(mockAppendAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({ tool: "list_communications", outcome: "error", error_message: "boom" }),
      );
    });
  });
});
