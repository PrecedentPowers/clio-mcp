import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

const { mockLoadTokens, mockSaveTokens, mockRefreshTokensPure } = vi.hoisted(() => ({
  mockLoadTokens: vi.fn(),
  mockSaveTokens: vi.fn(),
  mockRefreshTokensPure: vi.fn(),
}));

vi.mock("../../auth/tokenStorage.js", () => ({
  loadTokens: mockLoadTokens,
  saveTokens: mockSaveTokens,
}));

vi.mock("../../auth/oauth.js", () => ({
  refreshTokensPure: mockRefreshTokensPure,
}));

import { runAuthStatus } from "../authStatus.js";

function lastReport(logSpy: ReturnType<typeof vi.spyOn>): any {
  const calls = logSpy.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return JSON.parse(String(calls[calls.length - 1][0]));
}

describe("runAuthStatus", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("reports ok without refresh when the access token is comfortably fresh", async () => {
    mockLoadTokens.mockResolvedValue({
      access_token: "a",
      refresh_token: "r",
      expires_at: Date.now() + 60 * 60 * 1000,
    });
    const code = await runAuthStatus([]);
    expect(code).toBe(0);
    const report = lastReport(logSpy);
    expect(report.ok).toBe(true);
    expect(report.refreshed).toBe(false);
    expect(mockRefreshTokensPure).not.toHaveBeenCalled();
    expect(mockSaveTokens).not.toHaveBeenCalled();
  });

  it("refreshes inside the window, persists, and preserves clio_user_id", async () => {
    mockLoadTokens.mockResolvedValue({
      access_token: "a",
      refresh_token: "r",
      expires_at: Date.now() - 1000, // expired
      clio_user_id: "344920268",
    });
    mockRefreshTokensPure.mockResolvedValue({
      access_token: "a2",
      refresh_token: "r2",
      expires_at: Date.now() + 55 * 60 * 1000,
    });
    const code = await runAuthStatus([]);
    expect(code).toBe(0);
    const report = lastReport(logSpy);
    expect(report.ok).toBe(true);
    expect(report.refreshed).toBe(true);
    expect(mockSaveTokens).toHaveBeenCalledTimes(1);
    expect(mockSaveTokens.mock.calls[0][0].clio_user_id).toBe("344920268");
  });

  it("reports ok=false when the refresh chain is dead — still exit 0", async () => {
    mockLoadTokens.mockResolvedValue({
      access_token: "a",
      refresh_token: "r",
      expires_at: Date.now() - 1000,
    });
    mockRefreshTokensPure.mockRejectedValue(
      new Error("Token refresh failed, please re-authenticate.")
    );
    const code = await runAuthStatus([]);
    expect(code).toBe(0);
    const report = lastReport(logSpy);
    expect(report.ok).toBe(false);
    expect(report.error).toContain("token refresh failed");
    expect(mockSaveTokens).not.toHaveBeenCalled();
  });

  it("reports ok=false when no tokens are stored — never triggers OAuth", async () => {
    mockLoadTokens.mockResolvedValue(null);
    const code = await runAuthStatus([]);
    expect(code).toBe(0);
    const report = lastReport(logSpy);
    expect(report.ok).toBe(false);
    expect(report.error).toContain("no tokens stored");
    expect(mockRefreshTokensPure).not.toHaveBeenCalled();
  });

  it("even a storage-layer throw exits 0 with ok=false", async () => {
    mockLoadTokens.mockRejectedValue(new Error("keychain unavailable"));
    const code = await runAuthStatus([]);
    expect(code).toBe(0);
    const report = lastReport(logSpy);
    expect(report.ok).toBe(false);
    expect(report.error).toContain("keychain unavailable");
  });
});
