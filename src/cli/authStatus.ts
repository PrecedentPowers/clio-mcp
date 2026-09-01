import { loadTokens, saveTokens } from "../auth/tokenStorage.js";
import { refreshTokensPure } from "../auth/oauth.js";

// Refresh window mirrors getValidAccessToken() (oauth.ts): treat the access
// token as "needs refresh" inside the last 5 minutes of its life.
const REFRESH_WINDOW_MS = 5 * 60 * 1000;

interface AuthStatusReport {
  ok: boolean | null;
  access_expires_at: number | null;
  refreshed: boolean;
  error: string | null;
}

/**
 * `clio-mcp auth-status` — non-interactive auth health probe.
 *
 * Answers one question: would an export started right now authenticate?
 * Loads the stored tokens and, when the access token is inside (or past)
 * the refresh window, attempts the standard refresh and persists the result.
 *
 * Deliberately NEVER calls getValidAccessToken()/resolveAccessToken(): with
 * no stored tokens those fall through to runOAuthFlow(), which opens a
 * browser — fatal in an unattended scheduled run. No Clio API data call is
 * made; token refresh is the entire probe.
 *
 * Fail-open contract for the conductor: always prints exactly one JSON line
 * to stdout and exits 0 — the JSON carries the bad news ("ok": false plus
 * "error"). A non-zero exit or non-JSON stdout means the probe itself broke,
 * which the conductor-side wrapper records as ok=null / unknown.
 */
export async function runAuthStatus(_argv: string[]): Promise<number> {
  const report: AuthStatusReport = {
    ok: null,
    access_expires_at: null,
    refreshed: false,
    error: null,
  };

  try {
    const tokens = await loadTokens();
    if (!tokens || !tokens.refresh_token) {
      report.ok = false;
      report.error = "no tokens stored — authenticate via the Clio MCP in Claude";
    } else {
      report.access_expires_at = tokens.expires_at ?? null;
      const needsRefresh =
        typeof tokens.expires_at !== "number" ||
        Date.now() > tokens.expires_at - REFRESH_WINDOW_MS;

      if (!needsRefresh) {
        report.ok = true;
      } else {
        try {
          const fresh = await refreshTokensPure(tokens.refresh_token);
          // refreshTokensPure is save-free and drops clio_user_id; carry the
          // identity fields forward exactly as oauth.ts refreshAccessToken does.
          fresh.clio_user_id = tokens.clio_user_id;
          if (tokens.user_id_unavailable) fresh.user_id_unavailable = true;
          await saveTokens(fresh);
          report.ok = true;
          report.refreshed = true;
          report.access_expires_at = fresh.expires_at;
        } catch (err: any) {
          report.ok = false;
          report.error = `token refresh failed: ${err?.message ?? String(err)}`;
        }
      }
    }
  } catch (err: any) {
    report.ok = false;
    report.error = `auth-status probe error: ${err?.message ?? String(err)}`;
  }

  console.log(JSON.stringify(report));
  return 0;
}
