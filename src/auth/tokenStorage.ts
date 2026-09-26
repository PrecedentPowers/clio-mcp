import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { Entry } from "@napi-rs/keyring";
import type { ClioTokens } from "./oauth.js";
import { ensurePrivateDir, restrictMode } from "../utils/privateFs.js";

const TOKEN_DIR = path.join(os.homedir(), ".clio-mcp");
const TOKEN_FILE = path.join(TOKEN_DIR, "tokens.enc");
const KEY_FILE = path.join(TOKEN_DIR, "key.hex");

const ALGORITHM = "aes-256-gcm";
const KEYCHAIN_SERVICE = "clio-mcp";
const KEYCHAIN_ACCOUNT = "encryption-key";

// Token files written before owner-only permissions are tightened on first read.
let tokenPermissionsChecked = false;

export async function getEncryptionKey(): Promise<Buffer> {
  const envKey = process.env.ENCRYPTION_KEY;

  // 1. Env var override (CI/headless, backward compat)
  if (envKey) {
    if (envKey.length !== 64)
      throw new Error(`ENCRYPTION_KEY must be 64 hex chars (32 bytes for AES-256). Got ${envKey.length}.`);
    try {
      const entry = new Entry(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
      if (!entry.getPassword()) {
        entry.setPassword(envKey);
        console.error("[tokenStorage] Migrated ENCRYPTION_KEY from env to OS keychain. You may remove it from .env.");
      }
    } catch (keychainErr: any) {
      console.error(`[tokenStorage] Keychain write skipped (${keychainErr.message}).`);
    }
    return Buffer.from(envKey, "hex");
  }

  // 2. OS keychain (macOS / Windows Credential Manager / desktop Linux)
  try {
    const entry = new Entry(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
    let keyHex = entry.getPassword();
    if (!keyHex) {
      keyHex = crypto.randomBytes(32).toString("hex");
      entry.setPassword(keyHex);
      console.error("[tokenStorage] Generated encryption key and saved to OS keychain.");
    }
    return Buffer.from(keyHex, "hex");
  } catch (keychainErr: any) {
    console.error(`[tokenStorage] Keychain unavailable (${keychainErr.message}), using file fallback.`);
  }

  // 3. File fallback: ~/.clio-mcp/key.hex (mode 0600) — WSL2 / headless Linux
  await fs.mkdir(TOKEN_DIR, { recursive: true, mode: 0o700 });
  try {
    return Buffer.from((await fs.readFile(KEY_FILE, "utf8")).trim(), "hex");
  } catch (err: any) {
    if (err.code !== "ENOENT") throw err;
  }
  const keyHex = crypto.randomBytes(32).toString("hex");
  await fs.writeFile(KEY_FILE, keyHex, { mode: 0o600 });
  console.error("[tokenStorage] OS keychain unavailable. Generated encryption key at ~/.clio-mcp/key.hex (mode 0600).");
  return Buffer.from(keyHex, "hex");
}

export async function saveTokens(tokens: ClioTokens): Promise<void> {
  await ensurePrivateDir(TOKEN_DIR);

  const key = await getEncryptionKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const plaintext = JSON.stringify(tokens);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  const combined = Buffer.concat([iv, authTag, encrypted]);
  // Write-then-rename so a crash mid-write can't leave a torn token file. The
  // temp name is unique per write because two processes (the Desktop connector
  // and a scheduled auth-status refresh) can save at the same moment. It is
  // created owner-only; the final chmod covers a filesystem that ignores the
  // create mode.
  const tmpFile = `${TOKEN_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmpFile, combined, { mode: 0o600 });
  try {
    await fs.rename(tmpFile, TOKEN_FILE);
  } catch (err) {
    await fs.unlink(tmpFile).catch(() => {});
    throw err;
  }
  await restrictMode(TOKEN_FILE, 0o600);
  tokenPermissionsChecked = true;
}

export async function loadTokens(): Promise<ClioTokens | null> {
  let combined: Buffer;
  try {
    combined = await fs.readFile(TOKEN_FILE);
  } catch (err: any) {
    if (err.code === "ENOENT") return null;
    throw err;
  }

  if (!tokenPermissionsChecked) {
    await restrictMode(TOKEN_DIR, 0o700);
    await restrictMode(TOKEN_FILE, 0o600);
    tokenPermissionsChecked = true;
  }

  try {
    const key = await getEncryptionKey();
    const iv = combined.subarray(0, 16);
    const authTag = combined.subarray(16, 32);
    const encrypted = combined.subarray(32);

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]);

    return JSON.parse(decrypted.toString("utf8")) as ClioTokens;
  } catch (err: any) {
    console.error(
      `[tokenStorage] WARNING: Token file exists but decryption failed. ` +
      `File may be corrupt or ENCRYPTION_KEY has changed. Detail: ${err.message}`
    );
    return null;
  }
}

export async function clearTokens(): Promise<void> {
  try {
    await fs.unlink(TOKEN_FILE);
  } catch (err: any) {
    if (err.code !== "ENOENT") throw err; // ENOENT = already gone, that's fine
  }
}