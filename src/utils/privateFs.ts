import fs from "fs/promises";

/**
 * Owner-only permissions for ~/.clio-mcp and the files in it (tokens.enc,
 * audit.log). `mkdir`/`writeFile` modes only apply when the path is created, so
 * existing installs are tightened with an explicit chmod as well.
 *
 * A chmod failure (e.g. a filesystem without POSIX modes) is a warning, never an
 * error: it must not block a token save or an audit write. Windows has no POSIX
 * modes, so this is a no-op there.
 */
export async function restrictMode(target: string, mode: number): Promise<void> {
  if (process.platform === "win32") return;
  try {
    await fs.chmod(target, mode);
  } catch (err: any) {
    if (err?.code === "ENOENT") return;
    console.error(`[privateFs] WARNING: could not set mode ${mode.toString(8)} on ${target}: ${err?.message ?? err}`);
  }
}

/** Creates `dir` if needed and makes it owner-only (0700). */
export async function ensurePrivateDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await restrictMode(dir, 0o700);
}
