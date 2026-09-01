import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import fsSync from "fs";
import os from "os";
import path from "path";

const { mockClioGet, mockExtractNextPageToken, mockAppendAuditLog, MockClioApiError } = vi.hoisted(() => {
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
    mockExtractNextPageToken: vi.fn(),
    mockAppendAuditLog: vi.fn(),
    MockClioApiError,
  };
});

vi.mock("../../utils/clioClient.js", () => ({
  clioGet: mockClioGet,
  extractNextPageToken: mockExtractNextPageToken,
  ClioApiError: MockClioApiError,
}));

vi.mock("../../utils/auditLog.js", () => ({
  appendAuditLog: mockAppendAuditLog,
}));

import { runClioExport } from "../export.js";

function makeRawMatter(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    display_number: "00001-001",
    description: "Test matter",
    status: "open",
    client: { id: 10, name: "Acme Corp", date_of_birth: "1990-05-04" },
    practice_area: { id: 20, name: "Litigation" },
    open_date: "2026-01-01",
    close_date: null,
    billable: true,
    responsible_attorney: { id: 30, name: "Jane Attorney" },
    custom_field_values: [
      { id: 1, value: "ABC-123", field_type: "text_line", field_name: "Docket Number" },
    ],
    ...overrides,
  };
}

let tmpDir: string;
let outDir: string;
let stderrSpy: ReturnType<typeof vi.spyOn>;
let stdoutSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "clio-export-test-"));
  outDir = path.join(tmpDir, "out");
  stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  stdoutSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  stderrSpy.mockRestore();
  stdoutSpy.mockRestore();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("runClioExport", () => {
  // ─── (a) pagination + mapping ──────────────────────────────────────────

  it("writes page_01/page_02 with correct shape and mapped keys across two pages", async () => {
    const matterPage1 = makeRawMatter({ id: 1 });
    const matterPage2Null = makeRawMatter({
      id: 2,
      client: null,
      practice_area: null,
      responsible_attorney: null,
      custom_field_values: [],
    });

    mockClioGet
      .mockResolvedValueOnce({ data: [matterPage1], meta: { paging: { next: "x" } } })
      .mockResolvedValueOnce({ data: [matterPage2Null], meta: {} });
    mockExtractNextPageToken
      .mockReturnValueOnce("token-2")
      .mockReturnValueOnce(null);

    const code = await runClioExport(["--out-dir", outDir]);

    expect(code).toBe(0);

    const page1 = JSON.parse(await fs.readFile(path.join(outDir, "page_01.json"), "utf8"));
    expect(page1.next_page_token).toBe("token-2");
    expect(page1.matters).toEqual([
      {
        id: 1,
        display_number: "00001-001",
        description: "Test matter",
        status: "open",
        client: { id: 10, name: "Acme Corp", date_of_birth: "1990-05-04" },
        practice_area: { id: 20, name: "Litigation" },
        open_date: "2026-01-01",
        close_date: null,
        billable: true,
        responsible_attorney: { id: 30, name: "Jane Attorney" },
        custom_fields: { "Docket Number": "ABC-123" },
      },
    ]);

    const page2 = JSON.parse(await fs.readFile(path.join(outDir, "page_02.json"), "utf8"));
    expect(page2.next_page_token).toBeNull();
    expect(page2.matters).toEqual([
      {
        id: 2,
        display_number: "00001-001",
        description: "Test matter",
        status: "open",
        client: null,
        practice_area: null,
        open_date: "2026-01-01",
        close_date: null,
        billable: true,
        responsible_attorney: null,
        custom_fields: {},
      },
    ]);

    // second call carries the page_token forward
    expect(mockClioGet.mock.calls[1][1]).toMatchObject({ page_token: "token-2" });

    expect(mockAppendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "clio_export_cli", outcome: "success", result_count: 2 }),
    );
  });

  it("maps a client without a date_of_birth key (company client) to date_of_birth: null", async () => {
    const matterCompanyClient = makeRawMatter({ client: { id: 11, name: "Acme Inc." } });

    mockClioGet.mockResolvedValueOnce({ data: [matterCompanyClient], meta: {} });
    mockExtractNextPageToken.mockReturnValueOnce(null);

    const code = await runClioExport(["--out-dir", outDir]);

    expect(code).toBe(0);

    const page1 = JSON.parse(await fs.readFile(path.join(outDir, "page_01.json"), "utf8"));
    expect(page1.matters[0].client).toEqual({ id: 11, name: "Acme Inc.", date_of_birth: null });
  });

  // ─── (b) stale page cleanup ─────────────────────────────────────────────

  it("deletes a stale page_03.json in out-dir before a 1-page export", async () => {
    await fs.mkdir(outDir, { recursive: true });
    await fs.writeFile(path.join(outDir, "page_03.json"), JSON.stringify({ matters: [], next_page_token: null }));

    mockClioGet.mockResolvedValueOnce({ data: [makeRawMatter()], meta: {} });
    mockExtractNextPageToken.mockReturnValueOnce(null);

    const code = await runClioExport(["--out-dir", outDir]);

    expect(code).toBe(0);
    await expect(fs.access(path.join(outDir, "page_03.json"))).rejects.toThrow();
    await expect(fs.access(path.join(outDir, "page_01.json"))).resolves.toBeUndefined();
  });

  // ─── (c) missing --out-dir ──────────────────────────────────────────────

  it("returns exit 1 when --out-dir is missing", async () => {
    const code = await runClioExport([]);
    expect(code).toBe(1);
    expect(mockClioGet).not.toHaveBeenCalled();
  });

  // ─── (d) clioGet rejecting ───────────────────────────────────────────────

  it("returns exit 1 and prints EXPORT: FAIL on stderr when clioGet rejects with a Clio API error", async () => {
    mockClioGet.mockRejectedValueOnce(new MockClioApiError(500, "Clio API error 500 on /matters.json: boom"));

    const code = await runClioExport(["--out-dir", outDir]);

    expect(code).toBe(1);
    const printed = stderrSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(printed).toMatch(/^EXPORT: FAIL —/m);
    expect(mockAppendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "error" }),
    );
  });

  it("returns exit 2 and prints the re-authenticate message when token resolution fails", async () => {
    mockClioGet.mockRejectedValueOnce(new Error("Token refresh failed, please re-authenticate."));

    const code = await runClioExport(["--out-dir", outDir]);

    expect(code).toBe(2);
    const printed = stderrSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(printed).toContain("EXPORT: FAIL — no valid Clio token; re-authenticate via the Clio MCP in Claude, then re-run");
  });

  // ─── (e) final stdout line format ───────────────────────────────────────

  it("prints the final stdout line in the exact EXPORT: OK format", async () => {
    mockClioGet.mockResolvedValueOnce({ data: [makeRawMatter(), makeRawMatter({ id: 2 })], meta: {} });
    mockExtractNextPageToken.mockReturnValueOnce(null);

    const code = await runClioExport(["--out-dir", outDir]);

    expect(code).toBe(0);
    expect(stdoutSpy).toHaveBeenCalledWith("EXPORT: OK — 2 matters / 1 pages");
  });
});
