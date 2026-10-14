// When the board offers a newer Claude SDK, as pure functions (the web has no
// test runner of its own; server/test/upgrade-offer.test.mjs imports this).
import { strings } from './i18n/index.js';

// A job in these states is still going; mirrors UNFINISHED in UpgradeDialog.jsx.
const RUNNING = new Set(['waiting', 'running', 'laptop']);

/**
 * The automatic offer's gates on the detection itself: nothing newer, nothing
 * installable from here, a version already skipped or seen, a live snooze, a
 * job in flight, or a failure for this very version on screen. The callers
 * keep the gates that are about the page (offered once, another dialog open).
 */
export function autoOfferBlocked(upgrade, now = Date.now()) {
  if (!upgrade) return true;
  const { sdk, job } = upgrade;
  const prefs = upgrade.settings ?? {};
  if (!upgrade.checkedAt || !sdk?.behind || !sdk.installable || sdk.manual || !sdk.latest) return true;
  if (sdk.latest === prefs.skipped || sdk.latest === prefs.seen) return true;
  if (prefs.snoozedUntil && now <= Date.parse(prefs.snoozedUntil)) return true;
  if (job && RUNNING.has(job.state)) return true;
  if (job?.state === 'failed' && !job.acknowledged && job.target?.sdk === sdk.latest) return true;
  return false;
}

const machinesOf = (machines) => Object.entries(machines ?? {})
  .map(([name, m]) => ({ name, claude: m?.claude ?? null, ok: m?.ok !== false }));

/**
 * What a click on «Buscar actualizaciones» found. `prev` is the state held when
 * the click happened, `next` what the fresh check returned. A click means «now»:
 * `skipped`, `seen` and `snoozedUntil` are not looked at.
 *
 * The server swallows a failed fresh check and answers with the old state, and
 * an unreachable registry is a «successful» check with no `latest`; both are
 * errors here.
 *
 * Returns `{ kind: 'error', message }`, `{ kind: 'job' }` (an upgrade is already
 * running), `{ kind: 'offer', sdk }`, `{ kind: 'manual', current, latest }`
 * (newer, but not installable from the board) or `{ kind: 'uptodate', versions }`.
 */
export function manualCheckOutcome(prev, next) {
  if (!next?.checkedAt) return { kind: 'error', message: strings().app.upgradeCheck.noCheck };
  if (prev?.checkedAt && Date.parse(next.checkedAt) <= Date.parse(prev.checkedAt)) {
    return { kind: 'error', message: strings().app.upgradeCheck.incomplete };
  }
  const sdk = next.sdk;
  if (!sdk?.latest) return { kind: 'error', message: strings().app.upgradeCheck.noLatest };
  if (next.job && RUNNING.has(next.job.state)) return { kind: 'job' };
  if (sdk.behind && sdk.installable && !sdk.manual) return { kind: 'offer', sdk };
  if (sdk.behind) return { kind: 'manual', current: sdk.current, latest: sdk.latest };
  return {
    kind: 'uptodate',
    versions: { sdk: sdk.current ?? null, latest: sdk.latest, cli: sdk.cli ?? null, machines: machinesOf(next.machines) },
  };
}
