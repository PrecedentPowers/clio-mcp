import { loadTokens, saveTokens } from "./tokenStorage.js";
import { refreshTokensPure } from "./oauth.js";

// Refresh window mirrors getValidAccessToken() (oauth.ts) and the auth-status
// probe (authStatus.ts): treat the access token as "needs refresh" inside the
// last 5 minutes of its life.
const REFRESH_WINDOW_MS = 5 * 60 * 1000;

/**
 * Non-interactive, browser-free access-token resolution for the clio-export CLI.
 *
 * clio-export runs unattended (the Practice Conductor's weekly cron). The default
 * resolveAccessToken() path (clioClient.ts) falls through to getValidAccessToken()
 * when no SessionContext is installed, and getValidAccessToken() calls
 * runOAuthFlow() when no tokens are stored — that opens a browser, which is fatal
 * in an unattended run. This function is installed as a SessionContext's
 * getAccessToken() by the export CLI instead: missing tokens or a failed refresh
 * are hard failures, never an invitation to authenticate interactively. It never
 * imports or calls getValidAccessToken()/runOAuthFlow().
 */
export async function getAccessTokenNonInteractive(): Promise<string> {
  const tokens = await loadTokens();
  if (!tokens || !tokens.refresh_token) {
    throw new Error("not authenticated — no tokens stored; authenticate via the Clio MCP in Claude");
  }

  const needsRefresh =
    typeof tokens.expires_at !== "number" ||
    Date.now() > tokens.expires_at - REFRESH_WINDOW_MS;

  if (!needsRefresh) {
    return tokens.access_token;
  }

  let fresh;
  try {
    fresh = await refreshTokensPure(tokens.refresh_token);
  } catch (err: any) {
    throw new Error(`token refresh failed: ${err?.message ?? String(err)}`);
  }

  // refreshTokensPure is save-free and drops clio_user_id; carry the identity
  // fields forward exactly as authStatus.ts does.
  fresh.clio_user_id = tokens.clio_user_id;
  if (tokens.user_id_unavailable) fresh.user_id_unavailable = true;
  await saveTokens(fresh);

  return fresh.access_token;
}
