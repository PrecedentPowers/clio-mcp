/**
 * tokens.enc and ~/.clio-mcp are owner-only, on a real filesystem: new files are
 * created 0600/0700, and files from earlier versions are tightened on first read.
 * The file format is unchanged, so existing installs need no re-auth.
 */
import { vi, describe, it, expect, beforeEach, afterAll } from "vitest";
import fs from "fs/promises";
import path from "path";

const { home, previousHome, KEY_HEX } = vi.hoisted(() => {
  // tokenStorage.ts fixes its directory from os.homedir() at import.
  const previousHome = process.env.HOME;
  const home = `${process.env.TMPDIR ?? "/tmp"}/clio-token-perms-${process.pid}-${Date.now()}`;
  process.env.HOME = home;
  return { home, previousHome, KEY_HEX: "ab".repeat(32) };
});

// Never touch the real OS keychain from a test: report the env key as already stored.
vi.mock("@napi-rs/keyring", () => ({
  Entry: vi.fn().mockImplementation(function () {
    return { getPassword: () => KEY_HEX, setPassword: vi.fn() };
  }),
}));

const TOKEN_DIR = path.join(home, ".clio-mcp");
const TOKEN_FILE = path.join(TOKEN_DIR, "tokens.enc");
const TOKENS = { access_token: "a", refresh_token: "r", expires_at: 1_900_000_000_000, clio_user_id: "7" } as any;
const posixOnly = process.platform === "win32" ? it.skip : it;

async function mode(p: string): Promise<number> {
  return (await fs.stat(p)).mode & 0o777;
}

/** Fresh module each time, so the once-per-process permission check runs again. */
async function freshStorage() {
  vi.resetModules();
  return import("../tokenStorage.js");
}

beforeEach(async () => {
  process.env.ENCRYPTION_KEY = KEY_HEX;
  await fs.rm(TOKEN_DIR, { recursive: true, force: true });
});

afterAll(async () => {
  delete process.env.ENCRYPTION_KEY;
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  await fs.rm(home, { recursive: true, force: true });
});

describe("token file permissions", () => {
  posixOnly("saveTokens creates tokens.enc at 0600 inside a 0700 directory", async () => {
    const { saveTokens } = await freshStorage();
    await saveTokens(TOKENS);
    expect(await mode(TOKEN_FILE)).toBe(0o600);
    expect(await mode(TOKEN_DIR)).toBe(0o700);
  });

  posixOnly("saveTokens tightens an existing world-readable directory and file", async () => {
    await fs.mkdir(TOKEN_DIR, { recursive: true, mode: 0o755 });
    await fs.chmod(TOKEN_DIR, 0o755);
    await fs.writeFile(TOKEN_FILE, "old", { mode: 0o644 });
    await fs.chmod(TOKEN_FILE, 0o644);
    const { saveTokens } = await freshStorage();
    await saveTokens(TOKENS);
    expect(await mode(TOKEN_FILE)).toBe(0o600);
    expect(await mode(TOKEN_DIR)).toBe(0o700);
  });

  posixOnly("loadTokens tightens a token file written by an earlier version", async () => {
    const first = await freshStorage();
    await first.saveTokens(TOKENS);
    await fs.chmod(TOKEN_FILE, 0o644);
    await fs.chmod(TOKEN_DIR, 0o755);

    const { loadTokens } = await freshStorage();
    expect(await loadTokens()).toEqual(TOKENS);
    expect(await mode(TOKEN_FILE)).toBe(0o600);
    expect(await mode(TOKEN_DIR)).toBe(0o700);
  });

  it("round-trips tokens with the unchanged file format and leaves no temp file behind", async () => {
    const { saveTokens, loadTokens } = await freshStorage();
    await saveTokens(TOKENS);
    expect(await loadTokens()).toEqual(TOKENS);
    // 16-byte IV + 16-byte tag + ciphertext: the pre-2.1.1 layout, so no re-auth.
    const raw = await fs.readFile(TOKEN_FILE);
    expect(raw.length).toBeGreaterThan(32);
    expect(await fs.readdir(TOKEN_DIR)).toEqual(["tokens.enc"]);
  });

  it("concurrent saves both succeed and leave one readable token file", async () => {
    const { saveTokens, loadTokens } = await freshStorage();
    const other = { ...TOKENS, access_token: "b" };
    await Promise.all([saveTokens(TOKENS), saveTokens(other)]);
    expect([TOKENS, other]).toContainEqual(await loadTokens());
    expect(await fs.readdir(TOKEN_DIR)).toEqual(["tokens.enc"]);
  });

  it("loadTokens still returns null when no token file exists", async () => {
    const { loadTokens } = await freshStorage();
    expect(await loadTokens()).toBeNull();
  });
});
