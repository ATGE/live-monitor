/**
 * The board may be open from another device (LAN or tailnet), where
 * "localhost" would mean that device. Build service links from the host the
 * browser actually reached, keeping only the port the server assigned.
 *
 * A service on another machine — a task running on the dev box — carries that
 * machine's host, which is the one the browser has to reach, whatever it used
 * to open the board.
 */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

export const serviceUrl = (service) => {
  const host = service.host && !LOOPBACK.has(service.host) ? service.host : location.hostname;
  return `${location.protocol}//${host}:${service.port}`;
};
