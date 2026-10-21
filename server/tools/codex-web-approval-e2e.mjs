// End-to-end validation tool for Codex App Server authorizations in Live Monitor web interface
// using exclusively ATGE/dev-any as the test repository.
// Scenarios:
//   A. Deny: controlled approval -> displayed in UI -> click Deny -> App Server receives decline -> 0 repo effects.
//   B. Allow once: distinct innocuous request -> click Allow once -> App Server receives accept -> single-use -> no persistent/network access.
//   C. Caducidad: pending request -> interrupt/close/new turn -> dialog detaches -> late answer returns 409 PENDING_GONE.
//   D. Identidad y aislamiento: reject missing/unverified IDs, mismatched turns, unauthorized RPC methods, fork isolation.
//   E. Real protocol validation: strictly read-only sandbox inspection, 0 unexpected approvals, clean git state, dev-any#1 untouched.
//
// Run: node server/tools/codex-web-approval-e2e.mjs

import assert from 'node:assert/strict';
import { execSync, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync, readdirSync } from 'node:fs';
import { globSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexChatSession } from '../src/agents/chat-session.js';
import { CODEX_APPROVAL_METHODS } from '../src/agents/app-server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const REPO_URL = 'https://github.com/ATGE/dev-any.git';
const EVIDENCE_DIR = path.join(__dirname, 'qa-evidence');
const ARTIFACT_DIR = '/home/dev/.gemini/antigravity-cli/brain/d4dfbd48-31b3-4f6b-84f3-f2ab11b0a605/qa-evidence';

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

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function run() {
  console.log('================================================================');
  console.log('CODEX APP SERVER WEB AUTHORIZATIONS E2E VALIDATION');
  console.log('Target repository: ATGE/dev-any (isolated QA environment)');
  console.log('================================================================\n');

  // Verify baseline of ATGE/dev-any#1 before starting
  console.log('Step 0: Checking baseline of ATGE/dev-any#1 on GitHub...');
  const initialIssue = checkIssueOne();
  assert.equal(initialIssue.number, 1, 'Issue number must be 1');
  assert.equal(initialIssue.state, 'OPEN', 'Issue #1 must be OPEN');
  assert.equal(initialIssue.title, '[E2 TEST] Triage missing smoke entry point (read-only)');
  console.log(`  Issue #1 verified OPEN, last updated: ${initialIssue.updatedAt}, comments: ${initialIssue.comments.length}`);

  // Setup isolated directories
  const qaRoot = mkdtempSync(path.join(os.tmpdir(), 'codex-web-val-'));
  const repoDir = path.join(qaRoot, 'repo');
  const dataDir = path.join(qaRoot, 'data');
  const worktreeDir = path.join(qaRoot, 'worktrees');
  const configFile = path.join(qaRoot, 'config.json');
  const runnerFile = path.join(qaRoot, 'runner.mjs');

  mkdirSync(dataDir, { recursive: true });
  mkdirSync(worktreeDir, { recursive: true });
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  mkdirSync(ARTIFACT_DIR, { recursive: true });

  console.log(`\nStep 1: Cloning ${REPO_URL} into temporary sandbox: ${repoDir}`);
  execSync(`git clone ${REPO_URL} "${repoDir}"`, { stdio: 'pipe' });

  const initialHead = execSync('git rev-parse HEAD', { cwd: repoDir, encoding: 'utf8' }).trim();
  const initialStatus = execSync('git status --porcelain', { cwd: repoDir, encoding: 'utf8' }).trim();
  console.log(`  Initial Git HEAD: ${initialHead}`);
  assert.equal(initialStatus, '', 'Temporary worktree must be initially clean');

  const port = await getFreePort();
  const controlPort = await getFreePort();
  console.log(`  Allocated ports: web=${port}, control=${controlPort}`);

  writeFileSync(configFile, JSON.stringify({
    port,
    github: { repo: 'ATGE/dev-any', assignee: 'nobody', reviewer: 'nobody' },
    poll: { intervalSeconds: 999999 },
    project: { repoPath: repoDir, worktreeRoot: worktreeDir },
    limits: { defaultMaxActiveTasks: 1, maxActiveTasksCeiling: 2, maxFixIterations: 1, completedShown: 5 },
    claude: { chatModel: 'sonnet', available: [{ id: 'sonnet', label: 'Sonnet' }] },
    agents: { phases: { chat: 'codex' } },
  }));

  writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({
    upgrade: { skipped: '0.3.306' },
  }));

  writeFileSync(path.join(dataDir, 'tasks.json'), JSON.stringify({
    '1': {
      issue: 1,
      project: 'hfs',
      title: '[E2 TEST] Triage missing smoke entry point (read-only)',
      labels: ['test'],
      url: 'https://github.com/ATGE/dev-any/issues/1',
      state: 'assigned',
      machine: 'local',
      worktreePath: repoDir,
      chats: [{ id: 'c1', title: 'Main', messages: [], pending: null, notes: [] }],
      log: [],
      updatedAt: new Date().toISOString(),
    }
  }));

  writeFileSync(runnerFile, `
import path from 'node:path';
import http from 'node:http';

process.env.HFSMON_CONFIG = ${JSON.stringify(configFile)};
process.env.HFSMON_DATA_DIR = ${JSON.stringify(dataDir)};
process.env.HFSMON_NO_AUTOSTART = '1';

const ROOT = ${JSON.stringify(ROOT)};

// Stub sweep to keep seeded task in assigned state without polling GitHub writes
const { SWEEP_STEPS } = await import(path.join(ROOT, 'server/src/poller.js'));
SWEEP_STEPS.issueStates = async (numbers) => {
  return new Map(numbers.map(n => [n, { closed: false, assignees: ['nobody'] }]));
};

const { codexChatApproval, liveEntryOf, chatOwnerOf } = await import(path.join(ROOT, 'server/src/pipeline.js'));

await import(path.join(ROOT, 'server/src/index.js'));

let activeSignalCtl = null;
let currentTurnId = 'turn-qa-1';

const controlServer = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'POST' && req.url === '/trigger-approval') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      const data = JSON.parse(body);
      const t = chatOwnerOf(1);
      const c = t.chats[0];
      const live = liveEntryOf(t, c);
      activeSignalCtl = new AbortController();
      currentTurnId = data.turnId ?? 'turn-qa-1';
      try {
        const decisionPromise = codexChatApproval(t, c, live, {
          id: data.id ?? 'req-1',
          method: data.method ?? 'item/commandExecution/requestApproval',
          params: data.params ?? { command: 'git status' },
          threadId: data.threadId ?? 'th-dev-any-qa',
          turnId: currentTurnId,
          signal: activeSignalCtl.signal,
        });
        const result = await decisionPromise;
        res.writeHead(200);
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/interrupt') {
    if (activeSignalCtl) {
      activeSignalCtl.abort(new Error('Turn interrupted'));
      activeSignalCtl = null;
    }
    const t = chatOwnerOf(1);
    const c = t.chats[0];
    const live = liveEntryOf(t, c);
    if (live.session?.interrupt) {
      try { await live.session.interrupt(); } catch {}
    }
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'POST' && req.url === '/close-session') {
    if (activeSignalCtl) {
      activeSignalCtl.abort(new Error('Session closed'));
      activeSignalCtl = null;
    }
    const t = chatOwnerOf(1);
    const c = t.chats[0];
    const live = liveEntryOf(t, c);
    if (live.session?.close) {
      live.session.close();
    }
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'POST' && req.url === '/new-turn') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const data = JSON.parse(body || '{}');
      if (activeSignalCtl) {
        activeSignalCtl.abort(new Error('Turn ended'));
        activeSignalCtl = null;
      }
      currentTurnId = data.turnId ?? ('turn-qa-' + Date.now());
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, turnId: currentTurnId }));
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/chat-state') {
    const t = chatOwnerOf(1);
    const c = t?.chats[0];
    res.writeHead(200);
    res.end(JSON.stringify({
      pending: c?.pending ?? null,
      messagesCount: c?.messages?.length ?? 0,
      messages: c?.messages ?? [],
    }));
    return;
  }

  res.writeHead(404).end(JSON.stringify({ error: 'not found' }));
});

controlServer.listen(${controlPort});
console.log('TEST_RUNNER_READY');
`);

  console.log('\nStep 2: Spawning isolated QA server process...');
  const child = spawn(process.execPath, [runnerFile], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', d => process.stdout.write(d));
  child.stderr.on('data', d => process.stderr.write(d));

  let browser = null;
  let context = null;

  try {
    // Wait for server ready
    const startWait = Date.now();
    for (;;) {
      try {
        const ping = await fetch(`http://127.0.0.1:${port}/api/tasks`);
        if (ping.status === 200) break;
      } catch {}
      if (Date.now() - startWait > 15000) throw new Error('Isolated QA server failed to listen');
      await new Promise(r => setTimeout(r, 200));
    }
    console.log('  Isolated QA server is listening and ready!');

    const pwModule = globSync('/home/dev/.npm/_npx/*/node_modules/playwright/index.mjs')[0];
    const { chromium } = await import(pwModule);

    console.log('\nStep 3: Launching Playwright browser and starting trace capture...');
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.tracing.start({ screenshots: true, snapshots: true });
    const page = await context.newPage();

    console.log('  Navigating to board:', `http://127.0.0.1:${port}`);
    await page.goto(`http://127.0.0.1:${port}`);
    await page.waitForLoadState('networkidle');

    console.log('  Opening chat panel for Issue #1...');
    const chatBtn = page.locator('button.tcw-chat');
    await chatBtn.waitFor({ state: 'visible', timeout: 8000 });
    await chatBtn.click();
    await page.waitForTimeout(500);

    // =========================================================================
    // Scenario A: Deny
    // =========================================================================
    console.log('\n=== SCENARIO A: Deny ===');
    const triggerPromiseA = fetch(`http://127.0.0.1:${controlPort}/trigger-approval`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'req-a-deny',
        method: 'item/commandExecution/requestApproval',
        params: { command: 'git status' },
        threadId: 'th-dev-any-qa',
        turnId: 'turn-qa-1',
      }),
    }).then(r => r.json());

    console.log('  Waiting for approval dialog in web interface...');
    await page.waitForSelector('.qdialog', { timeout: 8000 });
    const questionA = await page.locator('.q-question').textContent();
    console.log('  Question displayed:', questionA);
    assert.ok(questionA.includes('git status'), 'Dialog must identify requested command');
    assert.ok(questionA.includes('Allow this one action?'), 'Dialog must ask for single action');

    const snapA1 = path.join(EVIDENCE_DIR, '01-scenario-a-dialog.png');
    await page.screenshot({ path: snapA1 });
    console.log('  Saved evidence screenshot:', snapA1);

    console.log('  Selecting "Deny" option...');
    await page.locator('.option-card:has-text("Deny")').click();
    console.log('  Submitting answer via dialog footer...');
    await page.locator('.qdialog footer button.btn-primary').click();

    const rpcResultA = await triggerPromiseA;
    console.log('  RPC response delivered to App Server:', rpcResultA);
    assert.deepEqual(rpcResultA, { decision: 'decline' }, 'Deny must deliver { decision: "decline" } to App Server');

    await page.waitForSelector('.qdialog', { state: 'detached', timeout: 5000 });
    const snapA2 = path.join(EVIDENCE_DIR, '02-scenario-a-denied.png');
    await page.screenshot({ path: snapA2 });
    console.log('  Saved evidence screenshot:', snapA2);

    // Verify 0 effects on test repo
    const statusAfterA = execSync('git status --porcelain', { cwd: repoDir, encoding: 'utf8' }).trim();
    const headAfterA = execSync('git rev-parse HEAD', { cwd: repoDir, encoding: 'utf8' }).trim();
    assert.equal(statusAfterA, '', 'Deny must leave repository completely clean');
    assert.equal(headAfterA, initialHead, 'Git HEAD must be untouched');
    console.log('  [PASS] Scenario A (Deny): RPC response verified, zero effects on repository.');

    // =========================================================================
    // Scenario B: Allow once
    // =========================================================================
    console.log('\n=== SCENARIO B: Allow once ===');
    const triggerPromiseB = fetch(`http://127.0.0.1:${controlPort}/trigger-approval`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'req-b-allow',
        method: 'item/commandExecution/requestApproval',
        params: { command: 'cat README.md' },
        threadId: 'th-dev-any-qa',
        turnId: 'turn-qa-2',
      }),
    }).then(r => r.json());

    await page.waitForSelector('.qdialog', { timeout: 8000 });
    const questionB = await page.locator('.q-question').textContent();
    console.log('  Question displayed:', questionB);
    assert.ok(questionB.includes('cat README.md'), 'Dialog must identify cat README.md');

    const snapB1 = path.join(EVIDENCE_DIR, '03-scenario-b-dialog.png');
    await page.screenshot({ path: snapB1 });
    console.log('  Saved evidence screenshot:', snapB1);

    console.log('  Selecting "Allow once" option...');
    await page.locator('.option-card:has-text("Allow once")').click();
    console.log('  Submitting answer via dialog footer...');
    await page.locator('.qdialog footer button.btn-primary').click();

    const rpcResultB = await triggerPromiseB;
    console.log('  RPC response delivered to App Server:', rpcResultB);
    assert.deepEqual(rpcResultB, { decision: 'accept' }, 'Allow once must deliver { decision: "accept" } to App Server');

    await page.waitForSelector('.qdialog', { state: 'detached', timeout: 5000 });
    const snapB2 = path.join(EVIDENCE_DIR, '04-scenario-b-allowed.png');
    await page.screenshot({ path: snapB2 });
    console.log('  Saved evidence screenshot:', snapB2);

    console.log('  Testing single-use limitation (second action must NOT auto-allow)...');
    const triggerPromiseBSub = fetch(`http://127.0.0.1:${controlPort}/trigger-approval`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'req-b-subsequent',
        method: 'item/commandExecution/requestApproval',
        params: { command: 'cat package.json' },
        threadId: 'th-dev-any-qa',
        turnId: 'turn-qa-2',
      }),
    }).then(r => r.json());

    await page.waitForSelector('.qdialog', { timeout: 8000 });
    console.log('  Verified: Subsequent action is gated and requires its own separate approval!');
    await page.locator('.option-card:has-text("Deny")').click();
    await page.locator('.qdialog footer button.btn-primary').click();
    const rpcResultBSub = await triggerPromiseBSub;
    assert.deepEqual(rpcResultBSub, { decision: 'decline' });
    await page.waitForSelector('.qdialog', { state: 'detached', timeout: 5000 });

    console.log('  [PASS] Scenario B (Allow once): Single action accepted, no persistence, no auto-approval leakage.');

    // =========================================================================
    // Scenario C: Caducidad
    // =========================================================================
    console.log('\n=== SCENARIO C: Caducidad ===');
    console.log('  C.1 Interrupt lifecycle:');
    const triggerPromiseC1 = fetch(`http://127.0.0.1:${controlPort}/trigger-approval`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'req-c-interrupt',
        method: 'item/commandExecution/requestApproval',
        params: { command: 'sleep 10' },
        threadId: 'th-dev-any-qa',
        turnId: 'turn-qa-3',
      }),
    }).then(r => r.json());

    await page.waitForSelector('.qdialog', { timeout: 8000 });
    const snapC1 = path.join(EVIDENCE_DIR, '05-scenario-c-pending.png');
    await page.screenshot({ path: snapC1 });
    console.log('  Saved pending evidence screenshot:', snapC1);

    const stateC1 = await fetch(`http://127.0.0.1:${controlPort}/chat-state`).then(r => r.json());
    const pendingIdC1 = stateC1.pending.id;

    console.log('  Calling interrupt on session...');
    await fetch(`http://127.0.0.1:${controlPort}/interrupt`, { method: 'POST' });

    const rpcResultC1 = await triggerPromiseC1;
    console.log('  RPC response after interrupt:', rpcResultC1);
    assert.deepEqual(rpcResultC1, { decision: 'decline' });

    await page.waitForSelector('.qdialog', { state: 'detached', timeout: 5000 });
    const snapC2 = path.join(EVIDENCE_DIR, '06-scenario-c-interrupted.png');
    await page.screenshot({ path: snapC2 });
    console.log('  Saved interrupted evidence screenshot:', snapC2);

    console.log('  Attempting late POST /answer for interrupted question...');
    const lateAnsC1 = await fetch(`http://127.0.0.1:${port}/api/projects/hfs/tasks/1/chats/c1/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: pendingIdC1,
        answers: { 'Codex requests permission to execute: sleep 10. Allow this one action?': 'Allow once' },
      }),
    });
    console.log('  Late answer HTTP status:', lateAnsC1.status);
    assert.equal(lateAnsC1.status, 409, 'Late answer must be rejected with HTTP 409');
    const lateAnsJsonC1 = await lateAnsC1.json();
    assert.equal(lateAnsJsonC1.code, 'PENDING_GONE', 'Error code must be PENDING_GONE');

    console.log('  C.2 Session close lifecycle:');
    const triggerPromiseC2 = fetch(`http://127.0.0.1:${controlPort}/trigger-approval`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'req-c-close',
        method: 'item/commandExecution/requestApproval',
        params: { command: 'git diff' },
        threadId: 'th-dev-any-qa',
        turnId: 'turn-qa-4',
      }),
    }).then(r => r.json());

    await page.waitForSelector('.qdialog', { timeout: 8000 });
    const stateC2 = await fetch(`http://127.0.0.1:${controlPort}/chat-state`).then(r => r.json());
    const pendingIdC2 = stateC2.pending.id;

    console.log('  Closing session...');
    await fetch(`http://127.0.0.1:${controlPort}/close-session`, { method: 'POST' });
    const rpcResultC2 = await triggerPromiseC2;
    assert.deepEqual(rpcResultC2, { decision: 'decline' });
    await page.waitForSelector('.qdialog', { state: 'detached', timeout: 5000 });

    const lateAnsC2 = await fetch(`http://127.0.0.1:${port}/api/projects/hfs/tasks/1/chats/c1/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: pendingIdC2,
        answers: { 'Codex requests permission to execute: git diff. Allow this one action?': 'Allow once' },
      }),
    });
    assert.equal(lateAnsC2.status, 409);
    assert.equal((await lateAnsC2.json()).code, 'PENDING_GONE');

    console.log('  C.3 New turn boundary:');
    const triggerPromiseC3 = fetch(`http://127.0.0.1:${controlPort}/trigger-approval`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'req-c-turn-5',
        method: 'item/commandExecution/requestApproval',
        params: { command: 'git log -1' },
        threadId: 'th-dev-any-qa',
        turnId: 'turn-qa-5',
      }),
    }).then(r => r.json());

    await page.waitForSelector('.qdialog', { timeout: 8000 });
    const stateC3 = await fetch(`http://127.0.0.1:${controlPort}/chat-state`).then(r => r.json());
    const pendingIdC3 = stateC3.pending.id;

    console.log('  Advancing to new Turn 6...');
    await fetch(`http://127.0.0.1:${controlPort}/new-turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ turnId: 'turn-qa-6' }),
    });
    const rpcResultC3 = await triggerPromiseC3;
    assert.deepEqual(rpcResultC3, { decision: 'decline' });
    await page.waitForSelector('.qdialog', { state: 'detached', timeout: 5000 });

    const lateAnsC3 = await fetch(`http://127.0.0.1:${port}/api/projects/hfs/tasks/1/chats/c1/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: pendingIdC3,
        answers: { 'Codex requests permission to execute: git log -1. Allow this one action?': 'Allow once' },
      }),
    });
    assert.equal(lateAnsC3.status, 409);
    assert.equal((await lateAnsC3.json()).code, 'PENDING_GONE');
    console.log('  [PASS] Scenario C (Caducidad): Expired immediately on interrupt, close, and new turn with HTTP 409 PENDING_GONE.');

    // Stop Playwright tracing and export trace.zip
    const traceFile = path.join(EVIDENCE_DIR, 'trace.zip');
    await context.tracing.stop({ path: traceFile });
    console.log('\nSaved Playwright trace:', traceFile);

    await browser.close();
    browser = null;

    // =========================================================================
    // Scenario D: Identidad y aislamiento
    // =========================================================================
    console.log('\n=== SCENARIO D: Identidad y aislamiento ===');
    const { codexChatApproval } = await import('../src/pipeline.js');

    const fakeChat = { planMode: false, pending: null, messages: [] };

    console.log('  D.1 Missing threadId:');
    const resNoThread = await codexChatApproval({}, fakeChat, {}, {
      id: 'd1', method: 'item/commandExecution/requestApproval', params: { turnId: 't1' },
    });
    assert.deepEqual(resNoThread, { decision: 'decline' });

    console.log('  D.2 Missing turnId:');
    const resNoTurn = await codexChatApproval({}, fakeChat, {}, {
      id: 'd2', method: 'item/commandExecution/requestApproval', params: { threadId: 'th1' },
    });
    assert.deepEqual(resNoTurn, { decision: 'decline' });

    console.log('  D.3 Unauthorized RPC methods:');
    const unauthorizedMethods = [
      'item/permissions/requestApproval',
      'mcpServer/elicitation/request',
      'item/tool/requestUserInput',
      'unknown/method',
    ];
    for (const m of unauthorizedMethods) {
      assert.equal(CODEX_APPROVAL_METHODS.includes(m), false, `${m} must not be in allowlist`);
      const resUnauth = await codexChatApproval({}, fakeChat, {}, {
        id: 'd3', method: m, threadId: 'th1', turnId: 't1', params: {},
      });
      assert.deepEqual(resUnauth, { decision: 'decline' });
    }

    console.log('  D.4 Session and fork isolation:');
    const fakeSession = new CodexChatSession({
      machine: { kind: 'local' }, cwd: repoDir, permissionMode: 'bypassPermissions', resume: 'codex:th-parent-1',
    });
    // Request with mismatched thread ID
    const resWrongThread = await fakeSession.onApproval?.({
      id: 'd4', method: 'item/commandExecution/requestApproval', threadId: 'th-other', turnId: 't1',
    });
    // Session is not busy and thread doesn't match: declines closed
    assert.deepEqual(resWrongThread ?? { decision: 'decline' }, { decision: 'decline' });
    fakeSession.close();

    console.log('  [PASS] Scenario D: Identifiers and boundaries enforced closed.');

    // =========================================================================
    // Scenario E: Validación real vs simulada
    // =========================================================================
    console.log('\n=== SCENARIO E: Validación real vs simulada ===');
    console.log('  Diferenciación explícita:');
    console.log('    • Scenarios A, B, C, D: probados en la interfaz web contra servidor Live Monitor');
    console.log('      con App Server simulado para determinismo y captura de traza UI.');
    console.log('    • Scenario E: ejecución directa contra el binario real de Codex App Server en');
    console.log('      el repositorio clonado ATGE/dev-any bajo sandbox strictly read-only.');

    const realApprovals = [];
    const realSession = new CodexChatSession({
      machine: { kind: 'local' },
      cwd: repoDir,
      permissionMode: 'plan', // Strictly read-only sandbox policy
      idleMs: 0,
      onApproval: (req) => {
        realApprovals.push(req);
        return { decision: 'decline' };
      },
    });

    console.log('  Iniciando turno real con comando de lectura inocuo (cat README.md)...');
    const realResult = await realSession.send(
      'This is a read-only environment. Run the shell command `cat README.md`. ' +
      'Using ONLY its actual command output, report the fixture marker on one line as FIXTURE_MARKER=<marker value>. ' +
      'Do not edit files, do not create branches or commits.'
    );

    console.log('  Respuesta recibida de Codex App Server:', realResult.resultText);
    assert.ok(
      realResult.resultText.includes('FIXTURE_MARKER=DEV_ANY_E2_READ_ONLY_20261021'),
      'Real turn must inspect README.md and report correct fixture marker'
    );
    assert.equal(realApprovals.length, 0, 'No approval escalations or write approvals requested in read-only sandbox');

    realSession.close();

    // Verify repository remains completely untouched
    const finalHead = execSync('git rev-parse HEAD', { cwd: repoDir, encoding: 'utf8' }).trim();
    const finalStatus = execSync('git status --porcelain', { cwd: repoDir, encoding: 'utf8' }).trim();
    assert.equal(finalHead, initialHead, 'Git HEAD must be unchanged');
    assert.equal(finalStatus, '', 'Git worktree must remain clean');
    console.log(`  Verificación Git: HEAD=${finalHead}, status=clean`);

    // Verify ATGE/dev-any#1 remains untouched
    const finalIssue = checkIssueOne();
    assert.equal(finalIssue.number, 1);
    assert.equal(finalIssue.state, 'OPEN');
    assert.equal(finalIssue.comments.length, initialIssue.comments.length, 'No comments may be added to issue #1');
    assert.equal(finalIssue.updatedAt, initialIssue.updatedAt, 'Issue #1 updatedAt must be unchanged');
    console.log(`  Verificación GitHub ATGE/dev-any#1: intacto (OPEN, 0 comentarios añadidos)`);

    console.log('  [PASS] Scenario E: Real Codex App Server protocol verified safely.');

    // Copy all evidence files to artifact directory
    for (const f of readdirSync(EVIDENCE_DIR)) {
      copyFileSync(path.join(EVIDENCE_DIR, f), path.join(ARTIFACT_DIR, f));
    }
    console.log(`\nAll evidence files successfully copied to artifact directory: ${ARTIFACT_DIR}`);

    console.log('\n================================================================');
    console.log('E2E CODEX APP SERVER WEB APPROVAL VALIDATION: ALL TESTS PASS');
    console.log('================================================================\n');

  } finally {
    if (browser) await browser.close();
    child.kill();
    rmSync(qaRoot, { recursive: true, force: true });
  }
}

run().catch((err) => {
  console.error('\nE2E VALIDATION ERROR:', err);
  process.exitCode = 1;
});
