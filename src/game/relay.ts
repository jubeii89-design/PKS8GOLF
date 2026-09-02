/**
 * Where the game sends things, when a relay server is available.
 *
 * Configured at build time with VITE_RELAY_URL. When it is unset the game
 * behaves exactly as it did before — scores go straight to the AS400 as a
 * blind cross-origin GET and moves have nowhere to land — so a plain static
 * deployment still works. When it is set, everything routes through the relay,
 * which can confirm delivery and serve standings back.
 */

const configured = import.meta.env.VITE_RELAY_URL;

/** Base URL of the relay, or null when the game is running standalone. */
export const RELAY_URL: string | null =
  typeof configured === "string" && configured.trim() !== "" ? configured.replace(/\/$/, "") : null;

/** True when a relay is configured; decides which reporting path is used. */
export function hasRelay(): boolean {
  return RELAY_URL !== null;
}

export function relayEndpoint(path: string): string {
  return `${RELAY_URL}${path}`;
}

// --- session ---------------------------------------------------------------

/**
 * The token handed out at join. Every write to the relay carries it, which is
 * what stops one player reporting as another.
 *
 * It is kept in localStorage as well as in memory on purpose: moves buffered
 * by a tab that died are flushed on the next load, and without the token that
 * retry would be refused. The audit trail exists precisely for the round that
 * went wrong, so it has to survive the tab going away.
 */
const TOKEN_KEY = "pokerst8ts.session.v1";

function readStoredToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null; // private mode — memory-only session
  }
}

let sessionToken: string | null = readStoredToken();

export function setSessionToken(token: string | null): void {
  sessionToken = token;
  try {
    if (token === null) localStorage.removeItem(TOKEN_KEY);
    else localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* private mode — the in-memory copy still serves this round */
  }
}

export function hasSession(): boolean {
  return sessionToken !== null;
}

/** Authorization header for a relay write, or nothing when not joined. */
export function authHeaders(): Record<string, string> {
  return sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {};
}
