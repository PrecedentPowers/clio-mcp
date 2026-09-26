/**
 * clio-export must never open a browser. The default token-resolution path
 * (clioClient.ts's resolveAccessToken → getValidAccessToken → runOAuthFlow) opens
 * a browser when no tokens are stored — fatal for the Practice Conductor's
 * unattended weekly run. export.ts instead installs a SessionContext whose
 * getAccessToken is getAccessTokenNonInteractive(), which never calls
 * getValidAccessToken() or runOAuthFlow().
 *
 * Unlike export.test.ts, this file does NOT mock ../../utils/clioClient.js — it
 * exercises the real client so the auth wiring (SessionContext → clioGet →
 * resolveAccessToken → getAccessTokenNonInteractive) is actually under test.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import fsSync from "fs";
import os from "os";
import path from "path";

const {
  mockLoadTokens,
  mockSaveTokens,
  mockRefreshTokensPure,
  mockRunOAuthFlow,
  mockGetValidAccessToken,
  mockAppendAuditLog,
} = vi.hoisted(() => ({
  mockLoadTokens: vi.fn(),
  mockSaveTokens: vi.fn().mockResolvedValue(undefined),
  mockRefreshTokensPure: vi.fn(),
  mockRunOAuthFlow: vi.fn(() => {
    throw new Error("runOAuthFlow must never be called from clio-export");
  }),
  mockGetValidAccessToken: vi.fn(() => {
    throw new Error("getValidAccessToken must never be called from clio-export");
  }),
  mockAppendAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../auth/tokenStorage.js", () => ({
  loadTokens: mockLoadTokens,
  saveTokens: mockSaveTokens,
}));

vi.mock("../../auth/oauth.js", () => ({
  refreshTokensPure: mockRefreshTokensPure,
  runOAuthFlow: mockRunOAuthFlow,
  getValidAccessToken: mockGetValidAccessToken,
}));

vi.mock("../../utils/auditLog.js", () => ({
  appendAuditLog: mockAppendAuditLog,
}));

import { runClioExport } from "../export.js";
import { getAccessTokenNonInteractive } from "../../auth/nonInteractiveToken.js";
import { getSessionContext } from "../../utils/sessionContext.js";

// Minimal single-page /matters.json response — enough to satisfy mapMatter and
// extractNextPageToken (no meta.paging.next means the loop stops after page 1).
function mattersResponse() {
  return {
    data: [
      {
        id: 1,
        display_number: "00001-001",
        description: "Test matter",
        status: "open",
        client: null,
        practice_area: null,
        open_date: "2026-01-01",
        close_date: null,
        billable: true,
        responsible_attorney: null,
        custom_field_values: [],
      },
    ],
    meta: {},
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

let tmpDir: string;
let outDir: string;
let stderrSpy: ReturnType<typeof vi.spyOn>;
let stdoutSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockSaveTokens.mockResolvedValue(undefined);
  tmpDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "clio-export-auth-test-"));
  outDir = path.join(tmpDir, "out");
  stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  stdoutSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  stderrSpy.mockRestore();
  stdoutSpy.mockRestore();
  vi.unstubAllGlobals();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("runClioExport auth wiring (real clioClient, no browser)", () => {
  it("no stored tokens: exits 2, never opens a browser, never calls the network", async () => {
    mockLoadTokens.mockResolvedValue(null);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const code = await runClioExport(["--out-dir", outDir]);

    expect(code).toBe(2);
    expect(mockRunOAuthFlow).not.toHaveBeenCalled();
    expect(mockGetValidAccessToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    const printed = stderrSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(printed).toContain("EXPORT: FAIL — no valid Clio token; re-authenticate via the Clio MCP in Claude, then re-run");
  });

  it("expired token: refreshes, saves with the carried clio_user_id, and requests with the fresh Bearer token", async () => {
    mockLoadTokens.mockResolvedValue({
      access_token: "old-token",
      refresh_token: "refresh-abc",
      expires_at: Date.now() - 1000,
      clio_user_id: "u-1",
    });
    mockRefreshTokensPure.mockResolvedValue({
      access_token: "fresh-token",
      refresh_token: "refresh-abc",
      expires_at: Date.now() + 3600_000,
    });

    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(mattersResponse()));
    vi.stubGlobal("fetch", fetchMock);

    const code = await runClioExport(["--out-dir", outDir]);

    expect(code).toBe(0);
    expect(mockRefreshTokensPure).toHaveBeenCalledWith("refresh-abc");
    expect(mockSaveTokens).toHaveBeenCalledWith(
      expect.objectContaining({ access_token: "fresh-token", clio_user_id: "u-1" }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer fresh-token");
  });

  it("valid token: does not refresh and requests with the stored Bearer token", async () => {
    mockLoadTokens.mockResolvedValue({
      access_token: "valid-token",
      refresh_token: "refresh-abc",
      expires_at: Date.now() + 3600_000,
      clio_user_id: "u-1",
    });

    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(mattersResponse()));
    vi.stubGlobal("fetch", fetchMock);

    const code = await runClioExport(["--out-dir", outDir]);

    expect(code).toBe(0);
    expect(mockRefreshTokensPure).not.toHaveBeenCalled();
    expect(mockSaveTokens).not.toHaveBeenCalled();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer valid-token");
  });

  it("audit entries still resolve clio_user_id from the installed SessionContext", async () => {
    // appendAuditLog reads identity from ctx.getTokens() whenever a context is
    // installed, so the export's context must expose the stored identity.
    mockLoadTokens.mockResolvedValue({
      access_token: "valid-token",
      refresh_token: "refresh-abc",
      expires_at: Date.now() + 3600_000,
      clio_user_id: "u-1",
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(mattersResponse())));
    const seen: Array<string | undefined> = [];
    mockAppendAuditLog.mockImplementation(async () => {
      seen.push(getSessionContext()?.getTokens()?.clio_user_id);
    });

    expect(await runClioExport(["--out-dir", outDir])).toBe(0);
    expect(seen).toEqual(["u-1"]);
  });
});

describe("getAccessTokenNonInteractive", () => {
  it("throws when no tokens are stored", async () => {
    mockLoadTokens.mockResolvedValue(null);
    await expect(getAccessTokenNonInteractive()).rejects.toThrow(
      "not authenticated — no tokens stored; authenticate via the Clio MCP in Claude",
    );
  });

  it("throws when there are tokens but no refresh_token", async () => {
    mockLoadTokens.mockResolvedValue({ access_token: "a", refresh_token: "", expires_at: Date.now() + 3600_000 });
    await expect(getAccessTokenNonInteractive()).rejects.toThrow(/not authenticated/);
  });

  it("throws with a 'token refresh failed: ' prefix when refresh fails", async () => {
    mockLoadTokens.mockResolvedValue({
      access_token: "old",
      refresh_token: "refresh-abc",
      expires_at: Date.now() - 1000,
    });
    mockRefreshTokensPure.mockRejectedValue(new Error("boom"));

    await expect(getAccessTokenNonInteractive()).rejects.toThrow("token refresh failed: boom");
  });
});
