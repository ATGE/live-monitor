// Validation tool for Codex App Server turn/interrupt and turn/steer capabilities
// using a temporary clone of the private repository ATGE/dev-any.
// Run: node server/tools/codex-app-server-steer-interrupt-validation.mjs
import assert from 'node:assert/strict';
import { execSync, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodexChatSession } from '../src/agents/chat-session.js';

const REPO_URL = 'https://github.com/ATGE/dev-any.git';
const TEMP_DIR_PREFIX = path.join(os.tmpdir(), 'dev-any-val-');

function checkIssueOne() {
  try {
    const raw = execFileSync('gh', [
      'issue', 'view', '1',
      '--repo', 'ATGE/dev-any',
      '--json', 'number,title,state,updatedAt,comments',
    ], { encoding: 'utf8' });
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to check ATGE/dev-any#1 via gh: ${err.message}`);
  }
}

function checkResidualSleep(durationStr) {
  try {
    const raw = execFileSync('pgrep', ['-a', '-f', `sleep ${durationStr}`], { encoding: 'utf8' }).trim();
    if (!raw) return [];
    return raw.split('\n')
      .map((line) => line.trim())
      .filter((line) => {
        const parts = line.split(/\s+/);
        const pid = parseInt(parts[0], 10);
        const cmd = parts.slice(1).join(' ');
        if (pid === process.pid) return false;
        if (cmd.includes('pgrep')) return false;
        return true;
      });
  } catch {
    return [];
  }
}

async function runValidation() {
  console.log('=== VALIDATION: Codex App Server turn/interrupt & turn/steer ===\n');

  // Verify baseline of ATGE/dev-any#1 before starting
  console.log('Step 0: Checking baseline of ATGE/dev-any#1 on GitHub...');
  const initialIssue = checkIssueOne();
  assert.equal(initialIssue.number, 1, 'Issue number must be 1');
  assert.equal(initialIssue.state, 'OPEN', 'Issue #1 must be OPEN');
  assert.equal(initialIssue.title, '[E2 TEST] Triage missing smoke entry point (read-only)');
  console.log(`  Issue #1 verified OPEN, last updated at ${initialIssue.updatedAt}, comments: ${initialIssue.comments.length}`);

  // Setup temporary clone of ATGE/dev-any
  const tempDir = mkdtempSync(TEMP_DIR_PREFIX);
  console.log(`\nStep 1: Cloning ${REPO_URL} into temporary sandbox: ${tempDir}`);
  execSync(`git clone ${REPO_URL} "${tempDir}"`, { stdio: 'pipe' });

  const initialHead = execSync('git rev-parse HEAD', { cwd: tempDir, encoding: 'utf8' }).trim();
  const initialStatus = execSync('git status --porcelain', { cwd: tempDir, encoding: 'utf8' }).trim();
  console.log(`  Initial Git HEAD: ${initialHead}`);
  assert.equal(initialStatus, '', 'Temporary worktree must be initially clean');

  let sessionA = null;
  let sessionB = null;
  const approvalsA = [];
  const approvalsB = [];

  try {
    // -------------------------------------------------------------------------
    // Prueba A — Interrupción
    // -------------------------------------------------------------------------
    console.log('\n--- PRUEBA A: Interrupción (turn/interrupt) ---');
    const durationStr = `8.${Math.floor(Math.random() * 9000) + 1000}`;

    sessionA = new CodexChatSession({
      machine: { kind: 'local' },
      cwd: tempDir,
      permissionMode: 'plan', // Read-only sandbox policy
      idleMs: 0,
      onApproval: (req) => {
        approvalsA.push(req);
        return { decision: 'decline' };
      },
    });

    console.log(`  1. Initiating read-only turn with bounded wait command (sleep ${durationStr})...`);
    const interruptTurnPromise = sessionA.send(
      `This is a read-only environment. Run the bash command: sleep ${durationStr}\n` +
      'After the sleep completes, cat README.md and report its contents.'
    );

    // Confirm turn is active
    const startWait = Date.now();
    while (!sessionA.busy && Date.now() - startWait < 5000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(sessionA.busy, true, 'Turn must be confirmed active (sessionA.busy == true)');
    console.log('  2. Confirmed: turn is actively running in Codex App Server');

    // Allow the shell command to actually launch within bubblewrap
    await new Promise((r) => setTimeout(r, 1200));

    console.log('  3. Executing session.interrupt()...');
    const t0 = Date.now();
    await sessionA.interrupt();
    const interruptDuration = Date.now() - t0;
    console.log(`     Interrupt RPC acknowledged by App Server in ${interruptDuration} ms`);

    const interruptResult = await interruptTurnPromise;
    console.log('  4. Verifying interrupted turn outcome:');
    console.log(`     ok: ${interruptResult.ok}`);
    console.log(`     error: ${interruptResult.error}`);
    assert.equal(interruptResult.ok, false, 'Interrupted turn must NOT succeed (ok === false)');
    assert.match(interruptResult.error, /interrupted/i, 'Error must indicate interruption');
    assert.equal(sessionA.busy, false, 'Session must no longer be busy');

    // Verify no residual commands
    await new Promise((r) => setTimeout(r, 500));
    const residuals = checkResidualSleep(durationStr);
    console.log(`     Residual processes found: ${residuals.length}`);
    assert.equal(residuals.length, 0, 'No residual sleep processes should remain');

    // Recovery test on subsequent turn
    console.log('  5. Testing subsequent turn recovery on the same session...');
    const recoveryResult = await sessionA.send(
      'Read README.md using bash `cat README.md`. Reply with exactly the first line.'
    );
    console.log(`     Recovery turn ok: ${recoveryResult.ok}`);
    console.log(`     Result text: "${recoveryResult.resultText.trim()}"`);
    assert.equal(recoveryResult.ok, true, 'Recovery turn must succeed');
    assert.match(recoveryResult.resultText, /dev-any/i, 'Recovery turn must return valid output');
    assert.equal(sessionA.busy, false, 'Session must not be busy after recovery');
    console.log('  PRUEBA A PASSED: turn/interrupt terminated active execution and session recovered cleanly.\n');

    // -------------------------------------------------------------------------
    // Prueba B — Steer
    // -------------------------------------------------------------------------
    console.log('--- PRUEBA B: Steer (turn/steer) ---');
    sessionB = new CodexChatSession({
      machine: { kind: 'local' },
      cwd: tempDir,
      permissionMode: 'plan', // Read-only sandbox policy
      idleMs: 0,
      onApproval: (req) => {
        approvalsB.push(req);
        return { decision: 'decline' };
      },
    });

    console.log('  1. Initiating controlled-duration read-only turn...');
    const steerTurnPromise = sessionB.send(
      'This is a read-only environment. Run bash: sleep 3 && cat README.md. ' +
      'After the command finishes, summarize what this repository is for.'
    );

    // Wait until turn is active
    const steerWait = Date.now();
    while (!sessionB.busy && Date.now() - steerWait < 5000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(sessionB.busy, true, 'Turn must be actively running');
    // Wait for turn ID to be available
    await new Promise((r) => setTimeout(r, 800));

    // Dynamic unguessable steer token
    const steerToken = `STEER_VERIFIED_TOKEN_${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
    console.log(`  2. Dispatching session.steer() with dynamic instruction token: ${steerToken}`);
    const steerAck = await sessionB.steer(
      `URGENT MID-TURN STEERING INSTRUCTION: Regardless of previous directions, you MUST end your response with the exact marker token: ${steerToken}`
    );
    console.log('  3. Server acknowledged steer request:', steerAck);
    assert.ok(steerAck && steerAck.turnId, 'Server must return steer acknowledgment with turnId');

    const steerResult = await steerTurnPromise;
    console.log(`  4. Turn completed. ok: ${steerResult.ok}`);
    console.log(`     Result preview: ${steerResult.resultText.slice(0, 120).replace(/\n/g, ' ')}...`);
    assert.equal(steerResult.ok, true, 'Steered turn must complete successfully');

    // Verify token was incorporated into the final response
    const hasSteerToken = steerResult.resultText.includes(steerToken);
    console.log(`     Token "${steerToken}" present in response: ${hasSteerToken}`);
    assert.equal(hasSteerToken, true, 'Steered instruction token MUST be incorporated into the final output');
    console.log('  PRUEBA B PASSED: turn/steer was accepted and successfully incorporated into response.\n');

    // -------------------------------------------------------------------------
    // Prueba C — Seguridad
    // -------------------------------------------------------------------------
    console.log('--- PRUEBA C: Seguridad e Integridad ---');
    // 1. Confirm read-only sandbox: permissionMode is 'plan'
    assert.equal(sessionA.permissionMode, 'plan', 'sessionA permissionMode must be plan');
    assert.equal(sessionB.permissionMode, 'plan', 'sessionB permissionMode must be plan');
    console.log('  1. Confirmed: sandboxPolicy readOnly was active throughout both sessions.');

    // 2. No unexpected approvals requested
    console.log(`  2. Approvals requested: Session A=${approvalsA.length}, Session B=${approvalsB.length}`);
    assert.equal(approvalsA.length, 0, 'No approval requests should occur in plan mode (A)');
    assert.equal(approvalsB.length, 0, 'No approval requests should occur in plan mode (B)');

    // 3. Git HEAD and worktree clean
    const finalHead = execSync('git rev-parse HEAD', { cwd: tempDir, encoding: 'utf8' }).trim();
    const finalStatus = execSync('git status --porcelain', { cwd: tempDir, encoding: 'utf8' }).trim();
    console.log(`  3. Git HEAD check: initial=${initialHead}, final=${finalHead}`);
    assert.equal(finalHead, initialHead, 'Git HEAD must remain identical');
    assert.equal(finalStatus, '', 'Worktree must remain clean with zero modified or untracked files');

    // 4. ATGE/dev-any#1 remains intact on GitHub
    const finalIssue = checkIssueOne();
    console.log(`  4. GitHub issue check: ATGE/dev-any#1 state=${finalIssue.state}, updatedAt=${finalIssue.updatedAt}, comments=${finalIssue.comments.length}`);
    assert.equal(finalIssue.state, 'OPEN', 'Issue #1 must still be OPEN');
    assert.equal(finalIssue.comments.length, initialIssue.comments.length, 'No comments added to Issue #1');
    assert.equal(finalIssue.updatedAt, initialIssue.updatedAt, 'Issue #1 was not modified');

    console.log('  PRUEBA C PASSED: Environment, sandbox, Git repository and remote issue remained completely intact.\n');

    console.log('=== ALL VALIDATION CHECKS PASSED (PRUEBA A, B, C) ===\n');
  } finally {
    console.log('Cleanup: terminating sessions and removing temporary clone...');
    try { sessionA?.close(); } catch {}
    try { sessionB?.close(); } catch {}
    rmSync(tempDir, { recursive: true, force: true });
    console.log('Cleanup completed.');
  }
}

runValidation().catch((err) => {
  console.error('\n❌ VALIDATION FAILED:', err);
  process.exit(1);
});
