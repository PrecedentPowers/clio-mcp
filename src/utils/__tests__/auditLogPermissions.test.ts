/**
 * audit.log and its directory are owner-only on a real filesystem, and a
 * failed chmod never blocks an audit write.
 */
import { vi, describe, it, expect, beforeEach, afterAll, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";

const { home, previousHome } = vi.hoisted(() => {
  const previousHome = process.env.HOME;
  const home = `${process.env.TMPDIR ?? "/tmp"}/clio-audit-perms-${process.pid}-${Date.now()}`;
  process.env.HOME = home;
  return { home, previousHome };
});

const AUDIT_DIR = path.join(home, ".clio-mcp");
const AUDIT_FILE = path.join(AUDIT_DIR, "audit.log");
const posixOnly = process.platform === "win32" ? it.skip : it;

async function mode(p: string): Promise<number> {
  return (await fs.stat(p)).mode & 0o777;
}

/** Fresh module each time, so the once-per-process permission check runs again. */
async function freshAuditLog() {
  vi.resetModules();
  return import("../auditLog.js");
}

beforeEach(async () => {
  await fs.rm(AUDIT_DIR, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  await fs.rm(home, { recursive: true, force: true });
});

describe("audit.log permissions", () => {
  posixOnly("a new audit.log is 0600 in a 0700 directory", async () => {
    const { appendAuditLog } = await freshAuditLog();
    await appendAuditLog({ tool: "t", args: {}, outcome: "success" });
    expect(await mode(AUDIT_FILE)).toBe(0o600);
    expect(await mode(AUDIT_DIR)).toBe(0o700);
  });

  posixOnly("an existing world-readable audit.log is tightened on the first append", async () => {
    await fs.mkdir(AUDIT_DIR, { recursive: true });
    await fs.chmod(AUDIT_DIR, 0o755);
    await fs.writeFile(AUDIT_FILE, '{"tool":"old"}\n');
    await fs.chmod(AUDIT_FILE, 0o644);

    const { appendAuditLog } = await freshAuditLog();
    await appendAuditLog({ tool: "t", args: {}, outcome: "success" });
    expect(await mode(AUDIT_FILE)).toBe(0o600);
    expect(await mode(AUDIT_DIR)).toBe(0o700);
    // Existing entries are kept: the log stays append-only.
    expect((await fs.readFile(AUDIT_FILE, "utf8")).split("\n").filter(Boolean)).toHaveLength(2);
  });

  it("a failing chmod warns but the entry is still written", async () => {
    const { appendAuditLog } = await freshAuditLog();
    const fsModule = (await import("fs/promises")).default;
    vi.spyOn(fsModule, "chmod").mockRejectedValue(Object.assign(new Error("EPERM"), { code: "EPERM" }));
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});

    await appendAuditLog({ tool: "t", args: {}, outcome: "success" });

    expect(JSON.parse((await fs.readFile(AUDIT_FILE, "utf8")).trim()).tool).toBe("t");
    if (process.platform !== "win32") {
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not set mode"));
    }
  });
});
