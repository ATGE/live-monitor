import React, { useEffect, useRef, useState } from 'react';
import Dialog from './Dialog.jsx';
import Icon from './Icon.jsx';
import { api } from '../api.js';
import { useDialog } from '../useDialog.jsx';
import { upgradeStepLabel } from '../status.js';
import { useStrings } from '../i18n/useStrings.js';
import { fill, plural, splitAround, strings } from '../i18n/index.js';

/**
 * Upgrading the Claude SDK, the CLI on every machine and the runners' code,
 * from one window: what is installed against what would be, what the upgrade
 * will do and in which order, what stands in the way, and — once a job
 * exists — its steps, its log and its result.
 *
 * Everything shown comes from the live `UpgradeState` the App keeps (snapshot
 * plus `upgrade` broadcasts); this dialog only writes through `onState`, which
 * merges, what an answer already told it, so it never waits for the broadcast.
 *
 * No button here takes the focus on open: the automatic offer opens this
 * window from a key press, and a repeat of that key must not start anything.
 */

export const UNFINISHED = new Set(['waiting', 'running', 'laptop']);
const FINISHED = new Set(['done', 'failed']);

const short = (sha) => (sha ? String(sha).slice(0, 7) : '—');
const runnersOf = (upgrade) => Object.entries(upgrade?.machines ?? {})
  .filter(([, m]) => m?.kind === 'runner')
  .map(([name, m]) => ({ name, ...m }));

/** «#937 hay un turno de chat en marcha», or just the text for a board-wide reason. */
export const formatIssue = (r) => `${r?.issue != null ? `#${r.issue} ` : ''}${r?.text ?? ''}`;

/** The CLI a machine has is enough when it is the wanted one or newer. */
export function cliOk(have, want) {
  if (!want) return true;
  if (!have) return false;
  const a = String(have).split('.').map(Number);
  const b = String(want).split('.').map(Number);
  if ([...a, ...b].some(Number.isNaN)) return have === want;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

/**
 * The runners a runner-only upgrade would touch, by the rule the server applies
 * in `runnersNeedingUpdate`: code behind `origin/main`, or a CLI below the one
 * the installed SDK pairs with. Only the boxes such a job really touches count
 * — one that does not answer and one whose code diverged are left out there
 * too, and counting them enabled a button whose POST comes back «nada que
 * actualizar». `wanted` is the fallback for a check that could not reach npm
 * and left `sdk.cli` null: it is what the table paints in «Objetivo», and
 * without it a runner whose CLI fell behind read as up to date.
 */
export function runnersToUpdate(upgrade) {
  const sdk = upgrade?.sdk ?? {};
  return runnersOf(upgrade).filter((r) => r.online && r.runner?.status !== 'diverged'
    && (r.runner?.status === 'behind' || !cliOk(r.claude, sdk.cli ?? r.wanted)));
}

// The runner code's state, in the language in use. Getters, so a switch reaches it.
const CODE_STATUS = {
  get current() { return strings().ops.upgrade.states.current; },
  get behind() { return strings().ops.upgrade.states.behind; },
  get diverged() { return strings().ops.upgrade.states.diverged; },
  get unknown() { return strings().ops.upgrade.states.unknown; },
};

/**
 * The header chip for an upgrade state, or null when there is nothing to say.
 * In priority order: a job in flight, a job waiting, an unacknowledged result,
 * a newer SDK, a runner behind, a runner diverged.
 */
export function upgradeChip(upgrade) {
  if (!upgrade) return null;
  const t = strings().ops.upgrade.chip;
  const { job, sdk } = upgrade;
  const runners = runnersOf(upgrade);
  const jobSdk = job?.target?.sdk ?? '?';
  if (job && (job.state === 'running' || job.state === 'laptop')) {
    return { tone: 'busy', spin: true, label: t.runningLabel, title: fill(t.runningTitle, { sdk: jobSdk, step: upgradeStepLabel(job.step) }) };
  }
  if (job?.state === 'waiting') {
    const n = upgrade.idle?.reasons?.length ?? 0;
    return { tone: 'warn', icon: 'hourglass', label: fill(t.waitingLabel, { n }), title: fill(t.waitingTitle, { sdk: jobSdk }) };
  }
  if (job && FINISHED.has(job.state) && !job.acknowledged) {
    return job.state === 'done'
      ? { tone: 'ok', icon: 'check-circle', label: t.doneLabel, title: fill(t.doneTitle, { sdk: jobSdk }) }
      : {
        tone: 'error', icon: 'alert-triangle', label: t.failedLabel,
        title: fill(job.error ? t.failedTitleError : t.failedTitle, { step: upgradeStepLabel(job.failedStep), error: job.error }),
      };
  }
  // Before the server's first check the cached state knows nothing about
  // versions or runners: only a job (always current) is worth a chip.
  if (!upgrade.checkedAt) return null;
  if (sdk?.behind && sdk.latest) {
    return {
      tone: 'warn', icon: 'arrow-up', label: `SDK ${sdk.latest}`,
      title: fill(sdk.cli ? t.sdkTitleCli : t.sdkTitle, { current: sdk.current, latest: sdk.latest, cli: sdk.cli }),
    };
  }
  const behind = runners.filter((r) => r.runner?.status === 'behind');
  if (behind.length) return { tone: 'warn', icon: 'arrow-up', label: 'runner', title: fill(t.runnerBehindTitle, { names: behind.map((r) => r.name).join(', ') }) }; // i18n-ok: technical name
  // The blind spot this closes: the chip asked whether the runner's *code* was
  // behind and never whether its CLI was, while `runnersToUpdate` — the
  // predicate the dialog itself uses — counts both. A box whose CLI fell below
  // the one the installed SDK pairs with has every remote task rejected, and
  // the header said nothing about it; since the chip is the only way to open
  // the dialog, there was no way in either. Found the hard way: both machines
  // sat at 2.1.283/2.1.281 against a wanted 2.1.284 with a silent header.
  //
  // Runners only, deliberately. The laptop's PATH CLI is the opt-in step of
  // `upgrade.ps1` (the checkbox, off by default) and nagging about a box the
  // board does not touch by default would be noise. And a machine whose
  // `claude` is unknown — an offline one reports null — is left out rather
  // than described as outdated: it already has a chip of its own saying it
  // does not answer, and this one would be claiming what it cannot know.
  const wantedCli = sdk?.cli ?? runners.find((r) => r.wanted)?.wanted ?? null;
  const cliBehind = runners.filter((r) => r.runner?.status !== 'diverged'
    && r.claude && !cliOk(r.claude, sdk?.cli ?? r.wanted));
  if (cliBehind.length) {
    return {
      tone: 'warn',
      icon: 'arrow-up', label: `CLI ${wantedCli ?? ''}`.trimEnd(),
      title: fill(wantedCli ? t.cliTitle : t.cliTitlePaired, { list: cliBehind.map((r) => `${r.name} (${r.claude})`).join(', '), wanted: wantedCli }),
    };
  }
  const diverged = runners.filter((r) => r.runner?.status === 'diverged');
  if (diverged.length) return { tone: 'error', icon: 'alert-triangle', label: t.divergedLabel, title: fill(t.divergedTitle, { names: diverged.map((r) => r.name).join(', ') }) };
  return null;
}

const blockerText = (b) => (typeof b === 'string' ? b : b?.text ?? b?.error ?? JSON.stringify(b));
/** A precheck refusal that «Solo la portátil» lifts: a runner that cannot take part. */
const onlyLaptopBlocker = (b) => b?.code === 'runner_offline' || b?.code === 'runner_diverged';

// Glyph and the key of its label in the catalog.
const STEP_ICONS = {
  ok: ['check', 'ok'],
  failed: ['x', 'failed'],
  warn: ['alert-triangle', 'warn'],
  skipped: ['ban', 'skipped'],
};

function StepIcon({ state }) {
  const t = useStrings().ops.upgrade;
  if (state === 'running') return <span className="spinner" role="img" aria-label={t.stepRunning} />;
  const [glyph, key] = STEP_ICONS[state] ?? ['dot', null];
  return <span role="img" aria-label={key ? t.stepIcons[key] : state}><Icon name={glyph}/></span>;
}

function StepList({ job }) {
  const t = useStrings().ops.upgrade;
  const steps = job.steps ?? [];
  if (!steps.length) return <p className="upgrade-muted">{t.noSteps}</p>;
  return (
    <ul className="upgrade-steps">
      {steps.map((s, i) => (
        <li key={`${s.name}-${i}`} className={`upgrade-step upgrade-step-${s.state}`} data-step={s.name}>
          <span className="upgrade-step-icon"><StepIcon state={s.state} /></span>
          <span className="upgrade-step-label">{s.state === 'skipped' ? fill(t.stepSkipped, { label: upgradeStepLabel(s.name) }) : upgradeStepLabel(s.name)}</span>
          {s.detail && <span className="upgrade-step-detail">{s.detail}</span>}
        </li>
      ))}
    </ul>
  );
}

function LogTail({ lines }) {
  const pre = useRef(null);
  const count = lines?.length ?? 0;
  useEffect(() => { if (pre.current) pre.current.scrollTop = pre.current.scrollHeight; }, [count, lines?.[count - 1]]);
  if (!count) return null;
  return <pre className="upgrade-log" ref={pre}>{lines.join('\n')}</pre>;
}

function IssueList({ items, className }) {
  return (
    <ul className={className}>
      {items.map((r, i) => <li key={`${r.issue ?? 'b'}-${i}`}>{formatIssue(r)}</li>)}
    </ul>
  );
}

/**
 * «Qué pasará», in the order the job does it. `pathCli` is the opt-in for
 * `laptop_cli`: the step is listed only when it was asked for, because the job
 * only runs it then.
 */
function planItems(upgrade, onlyLaptop, pathCli) {
  const t = strings().ops.upgrade.plan;
  const sdk = upgrade.sdk ?? {};
  const target = sdk.latest ?? sdk.current;
  // With the SDK already current the server makes a runner-only job: the
  // laptop is not touched, the board does not restart and nothing is committed.
  const runnerOnly = !sdk.behind;
  const items = [];
  for (const r of runnersOf(upgrade)) {
    // The same target the table paints and the gate counts: the pair of the
    // version that would be installed, or the machine's own `wanted` when the
    // check could not reach npm.
    const want = sdk.cli ?? r.wanted;
    const needsCli = Boolean(want) && !cliOk(r.claude, want);
    const needsCode = r.runner?.status === 'behind';
    const diverged = r.runner?.status === 'diverged';
    if (!needsCli && !needsCode && !diverged) continue;
    if (onlyLaptop) {
      items.push({ key: `runner-${r.name}`, head: fill(t.onlyLaptopSkip, { name: r.name }), warn: true });
      continue;
    }
    const steps = [upgradeStepLabel('runner_check')];
    if (needsCli) steps.push(`${upgradeStepLabel('runner_cli')}: claude ${want}`);
    if (needsCode) steps.push(`${upgradeStepLabel('runner_code')} (${short(r.runner?.commit)} → ${short(r.runner?.target)})`, upgradeStepLabel('runner_restart'));
    items.push({
      key: `runner-${r.name}`, head: `${r.name}:`, steps,
      note: diverged ? t.divergedNote : null,
    });
  }
  if (runnerOnly) {
    if (!items.length) items.push({ key: 'nothing', head: t.nothing });
    return items;
  }
  const laptopSteps = [
    upgradeStepLabel('laptop_stop'),
    `${upgradeStepLabel('laptop_install')} ${target ?? ''}`.trim(),
    `${upgradeStepLabel('laptop_verify')}${sdk.cli ? ` (${sdk.cli})` : ''}`,
  ];
  if (pathCli) laptopSteps.push(sdk.cli ? fill(t.laptopOnlyIfOlder, { step: upgradeStepLabel('laptop_cli'), cli: sdk.cli }) : upgradeStepLabel('laptop_cli'));
  laptopSteps.push(upgradeStepLabel('laptop_bootstrap'));
  items.push({ key: 'laptop', head: t.laptopHead, steps: laptopSteps });
  items.push({ key: 'restart', head: t.restartBoard });
  const unpushed = upgrade.git?.unpushed ?? 0;
  items.push({
    key: 'commit', head: t.commitHead,
    note: unpushed > 0 ? plural(unpushed, t.unpushed) : null,
  });
  return items;
}

/** What the last known git state already says the precheck will refuse. */
function localBlockers(upgrade) {
  const git = upgrade?.git ?? {};
  const t = strings().ops.upgrade.blockers;
  const list = [];
  if (git.branch && git.branch !== 'main') list.push({ code: 'branch', text: fill(t.branch, { branch: git.branch }) });
  if ((git.dirty ?? []).length) list.push({ code: 'dirty', text: fill(t.dirty, { files: git.dirty.join(', ') }) });
  return list;
}

function VersionTable({ upgrade }) {
  const t = useStrings().ops.upgrade;
  const sdk = upgrade.sdk ?? {};
  const machines = Object.entries(upgrade.machines ?? {});
  const rows = [];
  rows.push({ key: 'sdk', machine: 'local', what: 'SDK', now: sdk.current, next: sdk.latest ?? sdk.current, state: sdk.behind ? t.states.newer : t.states.current, tone: sdk.behind ? 'warn' : 'ok' });
  for (const [name, m] of machines) {
    const want = sdk.cli ?? m.wanted;
    // The tone comes from the state code, never from the label that is shown.
    const cliCode = m.online === false ? 'offline' : !m.claude ? 'unknown' : cliOk(m.claude, want) ? 'current' : 'behind';
    rows.push({ key: `cli-${name}`, machine: name, what: 'CLI', now: m.claude, next: want, state: t.states[cliCode], tone: cliCode === 'current' ? 'ok' : cliCode === 'behind' ? 'warn' : 'off' });
    if (m.kind === 'runner') {
      const st = m.runner?.status ?? 'unknown';
      rows.push({
        key: `code-${name}`, machine: name, what: 'runner', now: short(m.runner?.commit), next: short(m.runner?.target), // i18n-ok: technical name
        state: CODE_STATUS[st] ?? st, tone: st === 'current' ? 'ok' : st === 'behind' ? 'warn' : st === 'diverged' ? 'error' : 'off',
      });
    }
  }
  return (
    <div className="upgrade-table-wrap">
      <table className="upgrade-versions">
        <thead><tr><th>{t.table.machine}</th><th>{t.table.what}</th><th>{t.table.current}</th><th>{t.table.target}</th><th>{t.table.state}</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} data-row={r.key}>
              <td>{r.machine}</td><td>{r.what}</td>
              <td><code>{r.now ?? '—'}</code></td><td><code>{r.next ?? '—'}</code></td>
              <td className={`upgrade-state upgrade-state-${r.tone}`}>{r.state}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ResultSummary({ job }) {
  const t = useStrings().ops.upgrade.result;
  const prev = job.previous ?? {};
  const target = job.target ?? {};
  const laptop = job.laptop ?? {};
  const lines = [
    { key: 'sdk', text: `SDK ${prev.sdk ?? '?'} → ${target.sdk ?? '?'}` },
    { key: 'cli', text: `CLI ${prev.cli ?? '?'} → ${target.cli ?? '?'}` },
  ];
  for (const [name, r] of Object.entries(job.runners ?? {})) {
    lines.push({ key: `runner-${name}`, text: fill(t.code, { name, before: short(r.commitBefore), after: short(r.commitAfter), cliBefore: r.cliBefore ?? '?', cliAfter: r.cliAfter ?? '?' }) });
  }
  if (laptop.commit) lines.push({ key: 'commit', text: `commit ${short(laptop.commit)}` });
  if (laptop.pushed === true) lines.push({ key: 'push', text: t.pushDone });
  else if (laptop.pushed === false) lines.push({ key: 'push', text: laptop.pushError ? fill(t.pushFailedError, { error: laptop.pushError }) : t.pushFailed, tone: 'warn' });
  if (laptop.rolledBack) lines.push({ key: 'rollback', text: t.rolledBack, tone: 'warn' });
  if (job.state === 'failed') {
    lines.push({ key: 'failed', text: fill(job.error ? t.failedError : t.failed, { step: upgradeStepLabel(job.failedStep), error: job.error }), tone: 'error' });
  }
  return (
    <ul className="upgrade-result">
      {lines.map((l) => <li key={l.key} data-line={l.key} className={l.tone ? `upgrade-result-${l.tone}` : ''}>{l.text}</li>)}
    </ul>
  );
}

export default function UpgradeDialog({ upgrade, onState, onClose }) {
  const all = useStrings();
  const t = all.ops.upgrade;
  const [onlyLaptop, setOnlyLaptop] = useState(false);
  const [updatePathCli, setUpdatePathCli] = useState(false);
  const [posting, setPosting] = useState(false);
  const [refused, setRefused] = useState(null);   // blockers from a 409 precheck
  const [failure, setFailure] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const { ask } = useDialog();
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  // What the dialog shows is worth a fresh look: the cached state may be 30 s old.
  useEffect(() => {
    api.upgradeState({ fresh: true }).then((s) => { if (alive.current && s) onState(s); }).catch(() => {});
  }, []);

  const job = upgrade?.job ?? null;
  const active = job && UNFINISHED.has(job.state) ? job : null;
  const result = job && FINISHED.has(job.state) && !job.acknowledged ? job : null;
  const sdk = upgrade?.sdk ?? {};
  const target = sdk.latest ?? sdk.current ?? null;
  const reasons = upgrade?.idle?.reasons ?? [];
  const warnings = upgrade?.idle?.warnings ?? [];
  const runners = runnersOf(upgrade);
  // Whether this POST installs the SDK here. Without it the job is runner-only
  // — `git pull`, a restart, and at most a `claude install` the box runs by
  // itself — which changes what npm has to serve and what «Solo la portátil»
  // would even mean.
  const installsSdk = Boolean(sdk.behind);

  // The runners «Solo la portátil» would leave behind, and why.
  const refusedRunners = (refused ?? []).filter(onlyLaptopBlocker);
  const offlineNames = [...new Set([
    ...runners.filter((r) => r.online === false).map((r) => r.name),
    ...refusedRunners.filter((b) => b.code === 'runner_offline').map((b) => b.machine).filter(Boolean),
  ])];
  const divergedNames = [...new Set(refusedRunners.filter((b) => b.code === 'runner_diverged').map((b) => b.machine).filter(Boolean))];
  const runnerTrouble = [
    ...offlineNames.map((name) => fill(t.runnerOffline, { name })),
    ...divergedNames.map((name) => fill(t.runnerDiverged, { name })),
  ].join('; ');
  // With nothing to install here, «Solo la portátil» leaves no work at all: the
  // plan reads «se omite» for every runner and the POST answers «nada que
  // actualizar». So it is offered only for a job that does install the SDK.
  const offerOnlyLaptop = installsSdk && (offlineNames.length > 0 || refusedRunners.length > 0);
  // A box that was checked and then stopped being offered — the state changed
  // under it — is not a choice any more: acting on it would skip the runners
  // with nothing said on screen. The checkbox itself only renders while offered,
  // so this is the same value wherever the reader can see it.
  const skipRunners = onlyLaptop && offerOnlyLaptop;
  // This one's reason sends the reader to the checkbox, so it stands only while
  // the checkbox does. A runner-only job is refused over no runner it can skip
  // — an offline or diverged box stays out of it, server side too — and is not
  // offered «Solo la portátil» either, so it must not be disabled over one.
  const gatedByRunner = refusedRunners.length > 0 && offerOnlyLaptop && !skipRunners;
  // The `claude` on the laptop's PATH is Edson's own interactive CLI, not the
  // one the board's sessions use — that one comes inside the SDK. So the step
  // is an opt-in, off by default, and only a job that runs the laptop's steps
  // can offer it: a runner-only one never starts `upgrade.ps1`.
  const offerPathCli = installsSdk;
  // Same rule as `skipRunners`: a box checked before the state changed under it
  // is not a choice any more, so what travels is what the reader can still see.
  const withPathCli = updatePathCli && offerPathCli;

  const nothingToDo = !sdk.behind && !runnersToUpdate(upgrade).length;
  const disabledReason = !upgrade ? t.loading
    : !upgrade.checkedAt ? t.checking
      : nothingToDo ? t.disabled.upToDate
        : sdk.manual ? t.disabled.manual
          // Only the laptop's install depends on npm; the server gates it the
          // same way, so a runner-only job is never refused over the registry.
          : installsSdk && !sdk.installable ? t.disabled.notPublished
            : !target ? t.disabled.noVersion
              : gatedByRunner ? fill(t.disabled.runner, { trouble: runnerTrouble || t.runnerCannot, label: t.onlyLaptop })
                : null;
  const canRequest = !disabledReason && !posting;
  // Before the first POST, what git already shows; after a 409, the server's word.
  const blockers = refused ?? localBlockers(upgrade);

  const setJob = (next) => { if (next && alive.current) onState((u) => (u ? { ...u, job: next } : u)); };

  const cutList = () => {
    const parts = [];
    if (reasons.length) parts.push(`${t.cut.willCut}\n${reasons.map((r) => `• ${formatIssue(r)}`).join('\n')}`);
    if (warnings.length) parts.push(`${t.cut.also}\n${warnings.map((r) => `• ${formatIssue(r)}`).join('\n')}`);
    return parts.join('\n\n') || t.cut.nothing;
  };

  const request = async ({ now = false } = {}) => {
    if (now) {
      setConfirming(true);
      const go = await ask({
        title: t.cut.title, icon: 'alert-triangle',
        text: `${cutList()}\n\n${t.cut.restartNote}`,
        options: [{ value: true, label: t.cut.confirm, tone: 'warn' }], cancel: t.cut.wait,
      });
      if (!alive.current) return;
      setConfirming(false);
      if (!go) return;
    }
    setPosting(true);
    setFailure(null);
    try {
      if (!active) {
        const r = await api.requestUpgrade({ target, onlyLaptop: skipRunners, updatePathCli: withPathCli });
        setJob(r?.job);
      }
      if (now) {
        const r = await api.upgradeNow();
        setJob(r?.job);
      }
      if (alive.current) setRefused(null);
    } catch (e) {
      if (!alive.current) return;
      if (e.status === 409 && e.data?.job) setJob(e.data.job);
      else if (Array.isArray(e.data?.blockers) && e.data.blockers.length) setRefused(e.data.blockers);
      else setFailure(e.message);
    } finally {
      if (alive.current) setPosting(false);
    }
  };

  const cancel = async () => {
    setPosting(true);
    setFailure(null);
    try {
      await api.cancelUpgrade();
      if (alive.current) onState((u) => (u ? { ...u, job: null } : u));
    } catch (e) {
      if (alive.current) setFailure(e.message);
    } finally {
      if (alive.current) setPosting(false);
    }
  };

  // Closing a result is what acknowledges it, on every device.
  const acknowledge = () => {
    const id = result.id;
    api.ackUpgrade(id).catch((e) => console.warn('upgrade ack:', e.message)); // i18n-ok: technical name
    onState((u) => (u?.job?.id === id ? { ...u, job: { ...u.job, acknowledged: true } } : u));
    onClose();
  };

  // ---- a finished job: its result ----
  if (result) {
    return (
      <Dialog
        title={result.state === 'done' ? t.resultDone : t.resultFailed}
        icon={result.state === 'done' ? 'check-circle' : 'alert-triangle'}
        wide className="upgrade-dialog upgrade-dialog-result"
        onDismiss={acknowledge}
        footer={<><span className="modal-spacer" /><button className="btn btn-primary btn-md" onClick={acknowledge}>{all.common.close}</button></>}
      >
        <section className="upgrade-section"><ResultSummary job={result} /></section>
        <section className="upgrade-section">
          <h4>{t.steps}</h4>
          <StepList job={result} />
          <LogTail lines={result.logTail} />
        </section>
      </Dialog>
    );
  }

  // ---- a job in flight or waiting ----
  if (active) {
    const waiting = active.state === 'waiting';
    return (
      <Dialog
        title={fill(waiting ? t.jobWaitingTitle : t.jobRunningTitle, { sdk: active.target?.sdk ?? '?' })}
        icon={waiting ? 'hourglass' : 'refresh'}
        wide className="upgrade-dialog upgrade-dialog-job"
        onDismiss={confirming ? null : onClose}
        footer={(
          <>
            <button className="btn btn-ghost btn-md" onClick={onClose}>{all.common.close}</button>
            <span className="modal-spacer" />
            {waiting && <button className="btn btn-danger btn-md" disabled={posting} onClick={cancel}>{t.cancelUpgrade}</button>}
            {waiting && <button className="btn btn-warn btn-md" disabled={posting} onClick={() => request({ now: true })}>{t.updateNow}</button>}
          </>
        )}
      >
        {active.state === 'laptop' && (
          <p className="upgrade-note">{t.relaunching}</p>
        )}
        {waiting && (
          <section className="upgrade-section">
            <h4>{t.waitsFor}</h4>
            {reasons.length ? <IssueList items={reasons} className="upgrade-reasons" /> : <p className="upgrade-muted">{t.startsSoon}</p>}
            {warnings.length > 0 && <IssueList items={warnings} className="upgrade-warnings" />}
          </section>
        )}
        {failure && <p className="upgrade-error">{failure}</p>}
        <section className="upgrade-section">
          <h4>{t.steps}</h4>
          <StepList job={active} />
          <LogTail lines={active.logTail} />
        </section>
      </Dialog>
    );
  }

  // ---- no job: what an upgrade would do ----
  const hasReasons = reasons.length > 0;
  return (
    <Dialog
      title={t.planTitle} icon="arrow-up"
      wide className="upgrade-dialog upgrade-dialog-plan"
      onDismiss={confirming ? null : onClose}
      footer={(
        <>
          <button className="btn btn-ghost btn-md" onClick={onClose}>{all.common.cancel}</button>
          {disabledReason && upgrade && <span className="modal-caption upgrade-disabled-reason">{disabledReason}</span>}
          <span className="modal-spacer" />
          {hasReasons ? (
            <>
              <button className="btn btn-primary btn-md" disabled={!canRequest} onClick={() => request()}>
                {posting ? t.sending : t.schedule}
              </button>
              <button className="btn btn-warn btn-md" disabled={!canRequest} onClick={() => request({ now: true })}>{t.updateNow}</button>
            </>
          ) : (
            <button className="btn btn-primary btn-md" disabled={!canRequest} onClick={() => request()}>
              {posting ? t.sending : t.update}
            </button>
          )}
        </>
      )}
    >
      {!upgrade ? <p className="upgrade-muted"><span className="spinner" /> {t.loading}</p> : (
        <>
          <section className="upgrade-section">
            <h4>
              {t.versions}
              {sdk.notesUrl && <a className="upgrade-notes" href={sdk.notesUrl} target="_blank" rel="noreferrer">{t.releaseNotes} <Icon name="external"/></a>}
            </h4>
            <VersionTable upgrade={upgrade} />
          </section>

          {(failure || blockers.length > 0) && (
            <section className="upgrade-section">
              <h4>{t.resolveFirst}</h4>
              <ul className="upgrade-blockers">
                {failure && <li>{fill(t.requestFailed, { error: failure })}</li>}
                {blockers.map((b, i) => (
                  <li key={`${b?.code ?? 'b'}-${i}`} data-code={b?.code ?? ''} className={onlyLaptopBlocker(b) && skipRunners ? 'lifted' : ''}>{blockerText(b)}</li>
                ))}
              </ul>
            </section>
          )}

          {offerOnlyLaptop && (
            <section className="upgrade-section">
              <label className="upgrade-only-laptop">
                <input type="checkbox" checked={onlyLaptop} onChange={(e) => setOnlyLaptop(e.target.checked)} />
                {t.onlyLaptop}
              </label>
              <p className="upgrade-warn-text">
                {runnerTrouble ? fill(t.laptopWarn, { trouble: runnerTrouble }) : t.laptopWarnPlain}
              </p>
            </section>
          )}

          {offerPathCli && (
            <section className="upgrade-section">
              <label className="upgrade-only-laptop upgrade-path-cli">
                <input type="checkbox" checked={updatePathCli} onChange={(e) => setUpdatePathCli(e.target.checked)} />
                <span>{splitAround(t.pathCli, { code: '' }).map((p) => (p.hole ? <code key={p.key}>{'claude'}</code> : <React.Fragment key={p.key}>{p.text}</React.Fragment>))}</span>
              </label>
              <p className="upgrade-muted">{t.pathCliNote}</p>
            </section>
          )}

          <section className="upgrade-section">
            <h4>{t.whatWillHappen}</h4>
            <ol className="upgrade-plan">
              {planItems(upgrade, skipRunners, withPathCli).map((it) => (
                <li key={it.key} data-item={it.key} className={it.warn ? 'upgrade-warn' : ''}>
                  {it.head}
                  {it.steps && <ul>{it.steps.map((s) => <li key={s}>{s}</li>)}</ul>}
                  {it.note && <div className="upgrade-plan-note">{it.note}</div>}
                </li>
              ))}
            </ol>
          </section>

          {(hasReasons || warnings.length > 0) && (
            <section className="upgrade-section">
              {hasReasons && (
                <>
                  <h4>{t.busyNow}</h4>
                  <IssueList items={reasons} className="upgrade-reasons" />
                </>
              )}
              {warnings.length > 0 && (
                <>
                  <h4>{t.cutAnyway}</h4>
                  <IssueList items={warnings} className="upgrade-warnings" />
                </>
              )}
            </section>
          )}
        </>
      )}
    </Dialog>
  );
}
