// «Reiniciar tablero»: stop, start and wait for the board, through restart.ps1.
// The sibling of the upgrade handover in upgrade.js, minus the laptop and the
// runners: the same sessions are closed, the store is flushed by hand (stop.ps1
// kills with taskkill /F, which skips the SIGTERM flush), and then the script
// is spawned (not detached, see spawnRestart). The board is stopped by that
// script, not by this process.
import { spawn } from 'node:child_process';
import path from 'node:path';
import express from 'express';
import { ROOT } from './config.js';
import { beginBoardSpan, endBoardSpan, closeOpenBoardSpans } from './boardtimings.js';
import { store } from './store.js';
import { keyOf } from './keys.js';
import { allHolders } from './projectchats.js';
import { closeTaskSessions } from './pipeline.js';
import { idleReasons, upgradeRunning } from './upgrade.js';

export const WAIT_POLL_MS = 5_000;

const LOGIN_BUSY_MESSAGE = 'Se está renovando el login de Claude en una máquina';

export const restartHooks = {
  // How long the old board may stay up after the spawn before the restart counts as failed.
  stillAliveMs: 60_000,
  platform: () => process.platform,
  root: ROOT,
  upgrading: () => upgradeRunning(),
  // True while a «Renovar login» job runs: a restart would kill the login in
  // progress. Wired by index.js (the login module imports this file, not the reverse).
  loginBusy: () => false,
  busy: () => busyList(idleReasons().reasons),
  async closeSessions() {
    for (const task of store.all()) {
      try { await closeTaskSessions(task); } catch { /* a session that will not close dies with the board */ }
    }
    for (const holder of allHolders()) {
      try { await closeTaskSessions(holder); } catch { /* same: it dies with the board */ }
    }
  },
  flush: () => store.flush(),
  // Not detached: on this Windows a detached PowerShell exits 0 in about 100 ms
  // without running its script (FSD-ZN02; the same trap as spawnUpgradeScript,
  // measured again 2026-10-05: the button answered `restarting`, restart.ps1
  // never wrote a line and the board stayed up). Detaching is not needed:
  // restart.ps1's front only hands the work to a worker through ShellExecute,
  // which leaves this process tree, so taskkill /T on the board cannot reach it.
  spawnRestart(root) {
    const child = spawn(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'restart.ps1')],
      { detached: false, stdio: 'ignore', windowsHide: true },
    );
    // Without a listener a failed spawn (no powershell on PATH) is an unhandled 'error'.
    child.on('error', (e) => console.error(`[restart] no se pudo lanzar restart.ps1: ${e.message}`));
    child.unref();
  },
};

/** The shape the board shows: a task's own reasons carry its issue, a project chat's do not. */
export function busyList(reasons) {
  return reasons.map((r) => (r.issue == null
    ? { id: `project:${r.project}`, title: r.text, kind: 'project-chat' }
    : { id: keyOf(r), title: r.text, kind: 'task' }));
}

/** Pure: what a restart request does right now. */
export function restartDecision({ force, busy, upgrading, renewing = false }) {
  if (upgrading || renewing) return 'refuse';
  return force || busy.length === 0 ? 'now' : 'wait';
}

// This process's start: the web compares it before and after a restart, because
// «the board still answers» is not «the board came back» (it is the same process).
const startedAt = new Date().toISOString();
let state = 'idle';
// What the last restart attempt of THIS process got wrong, or null. In memory
// only: a real restart is a new process, so it is gone by itself.
let lastFailure = null;
let timer = null;
let restarting = false;
let aliveTimer = null;

/** True while a restart waits for busy work or is under way: a login renewal must not start then. */
export function restartPending() {
  return state === 'waiting' || state === 'restarting';
}

function stopWaiting() {
  if (timer) clearInterval(timer);
  timer = null;
  state = 'idle';
}

/** Closes the sessions, flushes the store and launches restart.ps1. */
async function restartNow() {
  if (restarting) return;
  restarting = true;
  clearTimeout(aliveTimer);
  stopWaiting();
  // This process cannot record its own end (restart.ps1 kills it): the start is
  // written here, and the next boot closes it in restartRouter().
  const spanId = beginBoardSpan({ name: 'restart' });
  try {
    await restartHooks.closeSessions();
    // Before the spawn: stop.ps1 kills this process without a chance to flush.
    restartHooks.flush();
    restartHooks.spawnRestart(restartHooks.root);
    // Stays 'restarting' while the old board still answers; the web shows it until the board goes.
    state = 'restarting';
    // restart.ps1 kills this process, which takes the timer with it. If the timer
    // fires the script failed and the board stayed up: close the span here instead
    // of letting the next boot book the whole uptime as an ok restart.
    aliveTimer = setTimeout(() => {
      if (state === 'restarting') state = 'idle';
      lastFailure = { at: new Date().toISOString(), reason: 'still-alive', afterMs: restartHooks.stillAliveMs };
      // The web reads lastFailure (GET /api/restart); this line is the trace for the err log.
      console.error(`[restart] restart.ps1 no detuvo el tablero en ${restartHooks.stillAliveMs} ms; ver hfs-monitor.restart.log`);
      endBoardSpan(spanId, { outcome: 'error', error: 'the board was still running after restart.ps1' });
    }, restartHooks.stillAliveMs);
    aliveTimer.unref?.();
  } catch (e) {
    state = 'idle';
    // The POST answers this as a 500, but a restart that waited for busy work has no
    // caller to answer: the web finds it here.
    lastFailure = { at: new Date().toISOString(), reason: 'error', message: String(e.message).slice(0, 200) };
    endBoardSpan(spanId, { outcome: 'error', error: String(e.message).slice(0, 200) });
    throw e;
  } finally {
    // Also after a success: if restart.ps1 fails, the board stays up and must accept another try.
    restarting = false;
  }
}

/** One poll of a waiting restart: restarts once nothing is busy, or gives up if an upgrade began. */
export async function checkWaiting() {
  if (state !== 'waiting') return null;
  const busy = restartHooks.busy();
  const decision = restartDecision({
    force: false, busy, upgrading: restartHooks.upgrading(), renewing: restartHooks.loginBusy(),
  });
  if (decision === 'refuse') { stopWaiting(); return state; }
  if (decision === 'now') await restartNow();
  return state;
}

export function restartRouter() {
  // Mounted once at boot: a restart left open by the board that died is ended by this one coming up.
  closeOpenBoardSpans(undefined, { name: 'restart', outcome: 'ok' });
  const router = express.Router();

  router.get('/api/restart', (req, res) => {
    res.json({
      state,
      busy: restartHooks.busy(),
      supported: restartHooks.platform() === 'win32',
      startedAt,
      lastFailure,
    });
  });

  router.post('/api/restart', async (req, res) => {
    const busy = restartHooks.busy();
    if (restartHooks.platform() !== 'win32') {
      return res.status(501).json({ error: 'Restarting from the board is only supported on Windows', supported: false });
    }
    // upgradeGuard already answers this 409 (without busy) when mounted first; this is the fallback.
    if (restartHooks.upgrading()) {
      return res.status(409).json({ error: 'The board is updating', busy });
    }
    if (restartHooks.loginBusy()) {
      return res.status(409).json({ error: LOGIN_BUSY_MESSAGE, busy });
    }
    // A new request starts clean, whether it waits or restarts now.
    lastFailure = null;
    const force = req.body?.force === true;
    const decision = restartDecision({ force, busy, upgrading: false, renewing: false });
    try {
      if (decision === 'wait') {
        if (state !== 'waiting') {
          state = 'waiting';
          timer = setInterval(() => {
            checkWaiting().catch((e) => console.error(`[restart] la espera murió: ${e.stack ?? e.message}`));
          }, WAIT_POLL_MS);
          timer.unref?.();
        }
        return res.status(202).json({ state });
      }
      await restartNow();
      return res.status(202).json({ state });
    } catch (e) {
      return res.status(500).json({ error: `could not restart: ${e.message}` });
    }
  });

  router.post('/api/restart/cancel', (req, res) => {
    // Same as POST: upgradeGuard answers first, so this branch is only the fallback.
    if (restartHooks.upgrading()) {
      return res.status(409).json({ error: 'The board is updating', busy: restartHooks.busy() });
    }
    stopWaiting();
    res.json({ state });
  });

  return router;
}
