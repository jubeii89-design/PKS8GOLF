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
