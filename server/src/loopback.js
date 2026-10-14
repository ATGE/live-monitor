/**
 * The one place that decides whether a base URL is this machine's own proxy.
 *
 * It lives in a module of its own, with no dependencies, because both sides of
 * the guarantee need it: `claude.js` (a credential in an overlay is accepted
 * only towards loopback) and `runner-client.js` (the same decision about a
 * session whose CLI runs on a runner). Putting it in `claude.js` would drag the
 * SDK, `quota.js` and the data directory into every test that touches a
 * machine — which `data-dir.test.mjs` rejects, and rightly.
 */

/**
 * True only for an `http://` URL whose host is literally 127.0.0.1.
 *
 * Parsed rather than prefix-matched: `http://127.0.0.1:1@evil.com/x` starts
 * with `http://127.0.0.1:` and yet its host is evil.com — enough to walk a
 * credential off this machine.
 */
export function isLoopbackUrl(s) {
  try {
    const u = new URL(String(s));
    return u.protocol === 'http:' && u.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}
