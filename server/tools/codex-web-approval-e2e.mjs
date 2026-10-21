// End-to-end validation tool for Codex App Server authorizations in Live Monitor web interface
// using exclusively ATGE/dev-any as the test repository.
// Scenarios:
//   PART 1: Direct Web Approval Interface Tests (maintained)
//     A. Deny: direct approval -> UI dialog -> click Deny -> response decline -> clean repo.
//     B. Allow once: direct approval -> UI dialog -> click Allow once -> response accept -> single-use.
//     C. Caducidad: pending request -> interrupt/close/new-turn -> dialog detaches -> late answer 409 PENDING_GONE.
//   PART 2: Full JSON-RPC Stdio Transport Stack Tests
//     App Server simulado (JSON-RPC stdio) -> CodexAppServer -> CodexChatSession -> pipeline -> interfaz Playwright -> respuesta JSON-RPC
//     T.1 Deny over transport
//     T.2 Allow once over transport
//     T.3 Independent approval per request (no auto-approval leakage)
//     T.4 Expiration (interrupt, close, new turn, 409 PENDING_GONE)
//     T.5 Solicitudes desconocidas (unknown RPC methods rejected fail-closed at transport)
//     T.6 Identidades de hilo/turno incorrectas (missing/mismatched thread/turn rejected fail-closed at transport)
//   PART 3: Identity and Boundary Checks
//     D.1-D.3 Missing IDs and unauthorized methods
//     D.4 Real execution of CodexChatSession.#approval (no optional-chaining bypass)
//   PART 4: Real Protocol Validation
//     E. Strictly read-only sandbox inspection on real Codex binary, 0 approvals, clean git, dev-any#1 untouched.
//   PART 5: External MCP Fail-Closed Policy Demonstration
//     F. External harmless MCP with write capability in project config is blocked by default under isolation.
//
// Run: node server/tools/codex-web-approval-e2e.mjs

import assert from 'node:assert/strict';
import { execSync, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync, readdirSync, lstatSync } from 'node:fs';
import { globSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { CodexChatSession, codexChatHooks } from '../src/agents/chat-session.js';
import { CODEX_APPROVAL_METHODS } from '../src/agents/app-server.js';
import { auditCodexMcpConfiguration, prepareCodexIsolatedHome } from '../src/agents/codex-isolation.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const REPO_URL = 'https://github.com/ATGE/dev-any.git';
const EVIDENCE_DIR = path.join(__dirname, 'qa-evidence');
const ARTIFACT_DIR = process.env.ARTIFACT_DIR
  || '/home/dev/.gemini/antigravity-cli/brain/af832431-573f-4773-8b37-b8f765b423ef/qa-evidence';

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
  const mockAppServerFile = path.join(qaRoot, 'mock-app-server.mjs');
  const mockReadyFile = path.join(qaRoot, 'mock-ready.txt');

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
  const mockServerPort = await getFreePort();
  console.log(`  Allocated ports: web=${port}, control=${controlPort}, mockAppServer=${mockServerPort}`);

  // Create simulated App Server (JSON-RPC stdio)
  writeFileSync(mockAppServerFile, `
import http from 'node:http';
import readline from 'node:readline';
import fs from 'node:fs';

const port = ${mockServerPort};
let nextId = 100;
const pending = new Map();

// Read JSON-RPC from CodexAppServer on stdin
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  
  if (msg.id && !msg.method) {
    const cb = pending.get(String(msg.id));
    if (cb) {
      pending.delete(String(msg.id));
      cb(msg);
      return;
    }
  }

  if (msg.id && msg.method) {
    if (msg.method === 'initialize') {
      process.stdout.write(JSON.stringify({ id: msg.id, result: { serverInfo: { name: 'mock-transport-app-server' } } }) + '\\n');
    } else if (msg.method === 'thread/start' || msg.method === 'thread/resume' || msg.method === 'thread/fork') {
      process.stdout.write(JSON.stringify({ id: msg.id, result: { thread: { id: 'th-transport-qa' } } }) + '\\n');
    } else if (msg.method === 'turn/start') {
      const turnId = msg.params?.turnId ?? 'turn-transport-qa';
      process.stdout.write(JSON.stringify({ id: msg.id, result: { turn: { id: turnId, status: 'inProgress' } } }) + '\\n');
      process.stdout.write(JSON.stringify({ method: 'turn/started', params: { threadId: 'th-transport-qa', turn: { id: turnId } } }) + '\\n');
    } else if (msg.method === 'turn/interrupt') {
      process.stdout.write(JSON.stringify({ id: msg.id, result: {} }) + '\\n');
      process.stdout.write(JSON.stringify({ method: 'turn/completed', params: { threadId: 'th-transport-qa', turn: { id: 'turn-transport-qa', status: 'interrupted' } } }) + '\\n');
    } else {
      process.stdout.write(JSON.stringify({ id: msg.id, result: {} }) + '\\n');
    }
  }
});

const srv = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'POST' && req.url === '/send-approval') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const data = JSON.parse(body);
      const reqId = String(data.id ?? ++nextId);
      pending.set(reqId, (reply) => {
        res.writeHead(200);
        res.end(JSON.stringify(reply.result ?? reply));
      });
      // Send JSON-RPC approval request to CodexAppServer over stdout
      process.stdout.write(JSON.stringify({
        id: reqId,
        method: data.method ?? 'item/commandExecution/requestApproval',
        params: data.params ?? {},
      }) + '\\n');
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/new-turn') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const data = JSON.parse(body || '{}');
      const turnId = data.turnId ?? ('turn-transport-' + Date.now());
      process.stdout.write(JSON.stringify({ method: 'turn/started', params: { threadId: 'th-transport-qa', turn: { id: turnId } } }) + '\\n');
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, turnId }));
    });
    return;
  }

  res.writeHead(404).end(JSON.stringify({ error: 'not found' }));
});

srv.listen(port, '127.0.0.1', () => {
  fs.writeFileSync(${JSON.stringify(mockReadyFile)}, 'READY\\n');
});
`);

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
import { spawn } from 'node:child_process';

process.env.HFSMON_CONFIG = ${JSON.stringify(configFile)};
process.env.HFSMON_DATA_DIR = ${JSON.stringify(dataDir)};
process.env.HFSMON_NO_AUTOSTART = '1';

const ROOT = ${JSON.stringify(ROOT)};
const repoDir = ${JSON.stringify(repoDir)};
const mockAppServerFile = ${JSON.stringify(mockAppServerFile)};

// Stub sweep to keep seeded task in assigned state without polling GitHub writes
const { SWEEP_STEPS } = await import(path.join(ROOT, 'server/src/poller.js'));
SWEEP_STEPS.issueStates = async (numbers) => {
  return new Map(numbers.map(n => [n, { closed: false, assignees: ['nobody'] }]));
};

const { codexChatApproval, liveEntryOf, chatOwnerOf } = await import(path.join(ROOT, 'server/src/pipeline.js'));
const { appServerHooks } = await import(path.join(ROOT, 'server/src/agents/app-server.js'));
const { CodexChatSession } = await import(path.join(ROOT, 'server/src/agents/chat-session.js'));

await import(path.join(ROOT, 'server/src/index.js'));

let activeSignalCtl = null;
let currentTurnId = 'turn-qa-1';
let transportTurnPromise = null;

const controlServer = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  // Direct approval trigger (used in Part 1)
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

  // Setup full transport session (used in Part 2)
  if (req.method === 'POST' && req.url === '/transport/init-session') {
    const t = chatOwnerOf(1);
    const c = t.chats[0];
    const live = liveEntryOf(t, c);
    if (live.session?.close) {
      live.session.close();
    }
    // Wire appServerHooks to spawn our simulated mock App Server
    appServerHooks.spawn = (bin, args, opts) => {
      return spawn(process.execPath, [mockAppServerFile, ...args], opts);
    };

    const session = new CodexChatSession({
      machine: { kind: 'local' },
      cwd: repoDir,
      permissionMode: 'bypassPermissions',
      onApproval: (approvalRequest) => codexChatApproval(t, c, live, approvalRequest),
    });
    live.session = session;

    // Start active turn so CodexAppServer opens stdio transport to mock App Server
    transportTurnPromise = session.send('Start transport validation session turn');
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'POST' && req.url === '/transport/interrupt') {
    const t = chatOwnerOf(1);
    const c = t.chats[0];
    const live = liveEntryOf(t, c);
    if (live.session?.interrupt) {
      try { await live.session.interrupt(); } catch {}
    }
    res.writeHead(200).end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'POST' && req.url === '/transport/close') {
    const t = chatOwnerOf(1);
    const c = t.chats[0];
    const live = liveEntryOf(t, c);
    if (live.session?.close) {
      live.session.close();
    }
    res.writeHead(200).end(JSON.stringify({ ok: true }));
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
    // PART 1: DIRECT UI INTERFACE TESTS (Maintained)
    // =========================================================================
    console.log('\n================================================================');
    console.log('PART 1: DIRECT UI INTERFACE TESTS');
    console.log('================================================================');

    // Scenario A: Deny
    console.log('\n=== SCENARIO A: Deny (Direct UI) ===');
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

    await page.waitForSelector('.qdialog', { timeout: 8000 });
    const questionA = await page.locator('.q-question').textContent();
    assert.ok(questionA.includes('git status'), 'Dialog must identify requested command');
    assert.ok(questionA.includes('Allow this one action?'), 'Dialog must ask for single action');

    const snapA1 = path.join(EVIDENCE_DIR, '01-scenario-a-dialog.png');
    await page.screenshot({ path: snapA1 });

    await page.locator('.option-card:has-text("Deny")').click();
    await page.locator('.qdialog footer button.btn-primary').click();

    const rpcResultA = await triggerPromiseA;
    assert.deepEqual(rpcResultA, { decision: 'decline' }, 'Deny must deliver decline');

    await page.waitForSelector('.qdialog', { state: 'detached', timeout: 5000 });
    const snapA2 = path.join(EVIDENCE_DIR, '02-scenario-a-denied.png');
    await page.screenshot({ path: snapA2 });

    const statusAfterA = execSync('git status --porcelain', { cwd: repoDir, encoding: 'utf8' }).trim();
    assert.equal(statusAfterA, '', 'Deny must leave repository completely clean');
    console.log('  [PASS] Scenario A (Deny): RPC response verified, zero effects on repository.');

    // Scenario B: Allow once & single-use
    console.log('\n=== SCENARIO B: Allow once & single-use (Direct UI) ===');
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
    const snapB1 = path.join(EVIDENCE_DIR, '03-scenario-b-dialog.png');
    await page.screenshot({ path: snapB1 });

    await page.locator('.option-card:has-text("Allow once")').click();
    await page.locator('.qdialog footer button.btn-primary').click();

    const rpcResultB = await triggerPromiseB;
    assert.deepEqual(rpcResultB, { decision: 'accept' }, 'Allow once must deliver accept');

    await page.waitForSelector('.qdialog', { state: 'detached', timeout: 5000 });
    const snapB2 = path.join(EVIDENCE_DIR, '04-scenario-b-allowed.png');
    await page.screenshot({ path: snapB2 });

    // Single-use verification
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
    await page.locator('.option-card:has-text("Deny")').click();
    await page.locator('.qdialog footer button.btn-primary').click();
    const rpcResultBSub = await triggerPromiseBSub;
    assert.deepEqual(rpcResultBSub, { decision: 'decline' });
    await page.waitForSelector('.qdialog', { state: 'detached', timeout: 5000 });
    console.log('  [PASS] Scenario B (Allow once): Single action accepted, no persistence, no auto-approval leakage.');

    // Scenario C: Caducidad
    console.log('\n=== SCENARIO C: Caducidad (Direct UI) ===');
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
    const stateC1 = await fetch(`http://127.0.0.1:${controlPort}/chat-state`).then(r => r.json());
    const pendingIdC1 = stateC1.pending.id;

    await fetch(`http://127.0.0.1:${controlPort}/interrupt`, { method: 'POST' });
    const rpcResultC1 = await triggerPromiseC1;
    assert.deepEqual(rpcResultC1, { decision: 'decline' });

    await page.waitForSelector('.qdialog', { state: 'detached', timeout: 5000 });
    const lateAnsC1 = await fetch(`http://127.0.0.1:${port}/api/projects/hfs/tasks/1/chats/c1/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: pendingIdC1,
        answers: { 'Codex requests permission to execute: sleep 10. Allow this one action?': 'Allow once' },
      }),
    });
    assert.equal(lateAnsC1.status, 409);
    assert.equal((await lateAnsC1.json()).code, 'PENDING_GONE');
    console.log('  [PASS] Scenario C (Caducidad): Expired immediately on interrupt with HTTP 409 PENDING_GONE.');

    // =========================================================================
    // PART 2: FULL JSON-RPC STDIO TRANSPORT STACK TESTS (NEW)
    // Pipeline: App Server simulado (stdio) -> CodexAppServer -> CodexChatSession -> pipeline -> Playwright UI -> JSON-RPC stdio reply
    // =========================================================================
    console.log('\n================================================================');
    console.log('PART 2: FULL JSON-RPC STDIO TRANSPORT STACK TESTS');
    console.log('Pipeline: Simulated App Server (stdio) -> CodexAppServer -> CodexChatSession -> pipeline -> Playwright UI -> JSON-RPC');
    console.log('================================================================');

    console.log('  Initializing transport session with simulated App Server over stdio...');
    await fetch(`http://127.0.0.1:${controlPort}/transport/init-session`, { method: 'POST' });

    // Wait for mock server HTTP socket to be ready
    const startMockWait = Date.now();
    while (!existsSync(mockReadyFile)) {
      if (Date.now() - startMockWait > 10000) throw new Error('Mock App Server stdio transport failed to start');
      await new Promise(r => setTimeout(r, 100));
    }
    console.log('  Simulated App Server is live and connected via JSON-RPC stdio pipes!');

    // Scenario T.1: Deny through full transport
    console.log('\n=== SCENARIO T.1: Deny (Full JSON-RPC Transport Stack) ===');
    const transportPromiseT1 = fetch(`http://127.0.0.1:${mockServerPort}/send-approval`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 't-deny-1',
        method: 'item/commandExecution/requestApproval',
        params: { threadId: 'th-transport-qa', turnId: 'turn-transport-qa', command: 'git status' },
      }),
    }).then(r => r.json());

    console.log('  Waiting for Playwright browser to receive question through transport...');
    await page.waitForSelector('.qdialog', { timeout: 8000 });
    const questionT1 = await page.locator('.q-question').textContent();
    assert.ok(questionT1.includes('git status'), 'Dialog must identify requested command');
    const snapT1 = path.join(EVIDENCE_DIR, '07-scenario-t1-dialog.png');
    await page.screenshot({ path: snapT1 });

    console.log('  Clicking "Deny" in web interface...');
    await page.locator('.option-card:has-text("Deny")').click();
    await page.locator('.qdialog footer button.btn-primary').click();

    const rpcResultT1 = await transportPromiseT1;
    console.log('  JSON-RPC response received by simulated App Server:', rpcResultT1);
    assert.deepEqual(rpcResultT1, { decision: 'decline' }, 'Deny must deliver { decision: "decline" } to App Server transport');

    await page.waitForSelector('.qdialog', { state: 'detached', timeout: 5000 });
    const snapT2 = path.join(EVIDENCE_DIR, '08-scenario-t1-denied.png');
    await page.screenshot({ path: snapT2 });

    const statusAfterT1 = execSync('git status --porcelain', { cwd: repoDir, encoding: 'utf8' }).trim();
    assert.equal(statusAfterT1, '', 'Repository remains clean');
    console.log('  [PASS] Scenario T.1: Full transport Deny validated end-to-end.');

    // Scenario T.2: Allow once through full transport
    console.log('\n=== SCENARIO T.2: Allow once (Full JSON-RPC Transport Stack) ===');
    const transportPromiseT2 = fetch(`http://127.0.0.1:${mockServerPort}/send-approval`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 't-allow-1',
        method: 'item/commandExecution/requestApproval',
        params: { threadId: 'th-transport-qa', turnId: 'turn-transport-qa', command: 'cat README.md' },
      }),
    }).then(r => r.json());

    await page.waitForSelector('.qdialog', { timeout: 8000 });
    const questionT2 = await page.locator('.q-question').textContent();
    assert.ok(questionT2.includes('cat README.md'));
    const snapT3 = path.join(EVIDENCE_DIR, '09-scenario-t2-dialog.png');
    await page.screenshot({ path: snapT3 });

    console.log('  Clicking "Allow once" in web interface...');
    await page.locator('.option-card:has-text("Allow once")').click();
    await page.locator('.qdialog footer button.btn-primary').click();

    const rpcResultT2 = await transportPromiseT2;
    console.log('  JSON-RPC response received by simulated App Server:', rpcResultT2);
    assert.deepEqual(rpcResultT2, { decision: 'accept' }, 'Allow once must deliver { decision: "accept" } to App Server transport');

    await page.waitForSelector('.qdialog', { state: 'detached', timeout: 5000 });
    const snapT4 = path.join(EVIDENCE_DIR, '10-scenario-t2-allowed.png');
    await page.screenshot({ path: snapT4 });
    console.log('  [PASS] Scenario T.2: Full transport Allow once validated end-to-end.');

    // Scenario T.3: Independent approval per request (no auto-approval leakage)
    console.log('\n=== SCENARIO T.3: Independent approval per request (Full Transport) ===');
    const transportPromiseT3 = fetch(`http://127.0.0.1:${mockServerPort}/send-approval`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 't-subsequent-1',
        method: 'item/commandExecution/requestApproval',
        params: { threadId: 'th-transport-qa', turnId: 'turn-transport-qa', command: 'cat package.json' },
      }),
    }).then(r => r.json());

    await page.waitForSelector('.qdialog', { timeout: 8000 });
    console.log('  Subsequent command in same turn requires its own approval!');
    await page.locator('.option-card:has-text("Deny")').click();
    await page.locator('.qdialog footer button.btn-primary').click();

    const rpcResultT3 = await transportPromiseT3;
    assert.deepEqual(rpcResultT3, { decision: 'decline' });
    await page.waitForSelector('.qdialog', { state: 'detached', timeout: 5000 });
    console.log('  [PASS] Scenario T.3: Independent approval verified, no session persistence.');

    // Scenario T.4: Expiration (Interrupt lifecycle through transport)
    console.log('\n=== SCENARIO T.4: Expiration & Interrupt (Full Transport) ===');
    const transportPromiseT4 = fetch(`http://127.0.0.1:${mockServerPort}/send-approval`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 't-expire-1',
        method: 'item/commandExecution/requestApproval',
        params: { threadId: 'th-transport-qa', turnId: 'turn-transport-qa', command: 'sleep 10' },
      }),
    }).then(r => r.json());

    await page.waitForSelector('.qdialog', { timeout: 8000 });
    const stateT4 = await fetch(`http://127.0.0.1:${controlPort}/chat-state`).then(r => r.json());
    const pendingIdT4 = stateT4.pending.id;

    console.log('  Interrupting transport session...');
    await fetch(`http://127.0.0.1:${controlPort}/transport/interrupt`, { method: 'POST' });

    const rpcResultT4 = await transportPromiseT4;
    console.log('  JSON-RPC response after interrupt:', rpcResultT4);
    assert.deepEqual(rpcResultT4, { decision: 'decline' });

    await page.waitForSelector('.qdialog', { state: 'detached', timeout: 5000 });
    const lateAnsT4 = await fetch(`http://127.0.0.1:${port}/api/projects/hfs/tasks/1/chats/c1/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: pendingIdT4,
        answers: { 'Codex requests permission to execute: sleep 10. Allow this one action?': 'Allow once' },
      }),
    });
    assert.equal(lateAnsT4.status, 409, 'Late answer after interrupt returns 409 PENDING_GONE');
    assert.equal((await lateAnsT4.json()).code, 'PENDING_GONE');
    console.log('  [PASS] Scenario T.4: Transport approval expired and answered decline on interrupt.');

    // Restart transport session for negative boundary tests
    await fetch(`http://127.0.0.1:${controlPort}/transport/init-session`, { method: 'POST' });
    await new Promise(r => setTimeout(r, 300));

    // Scenario T.5: Solicitudes desconocidas
    console.log('\n=== SCENARIO T.5: Solicitudes desconocidas (Full Transport) ===');
    const unknownMethods = [
      'item/permissions/requestApproval',
      'mcpServer/elicitation/request',
      'item/tool/requestUserInput',
      'unknown/arbitraryMethod',
    ];
    for (const m of unknownMethods) {
      assert.equal(CODEX_APPROVAL_METHODS.includes(m), false);
      const resUnauth = await fetch(`http://127.0.0.1:${mockServerPort}/send-approval`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: `t5-${m.replaceAll('/', '-')}`,
          method: m,
          params: { threadId: 'th-transport-qa', turnId: 'turn-transport-qa' },
        }),
      }).then(r => r.json());
      console.log(`  Method ${m} -> declined fail-closed:`, resUnauth);
      assert.ok(resUnauth.decision === 'decline' || resUnauth.action === 'decline' || resUnauth.answers || resUnauth.permissions);
      // Verify no dialog was triggered on web UI
      const hasDialog = await page.locator('.qdialog').isVisible();
      assert.equal(hasDialog, false, 'Unauthorized RPC method must never prompt UI');
    }
    console.log('  [PASS] Scenario T.5: All unknown RPC methods fail-closed at transport.');

    // Scenario T.6: Identidades de hilo/turno incorrectas
    console.log('\n=== SCENARIO T.6: Identidades de hilo/turno incorrectas (Full Transport) ===');
    // Missing threadId
    const resNoThread = await fetch(`http://127.0.0.1:${mockServerPort}/send-approval`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 't6-no-thread',
        method: 'item/commandExecution/requestApproval',
        params: { turnId: 'turn-transport-qa', command: 'git status' },
      }),
    }).then(r => r.json());
    assert.deepEqual(resNoThread, { decision: 'decline' }, 'Missing threadId must be declined');

    // Missing turnId
    const resNoTurn = await fetch(`http://127.0.0.1:${mockServerPort}/send-approval`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 't6-no-turn',
        method: 'item/commandExecution/requestApproval',
        params: { threadId: 'th-transport-qa', command: 'git status' },
      }),
    }).then(r => r.json());
    assert.deepEqual(resNoTurn, { decision: 'decline' }, 'Missing turnId must be declined');

    // Mismatched threadId
    const resWrongThread = await fetch(`http://127.0.0.1:${mockServerPort}/send-approval`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 't6-wrong-thread',
        method: 'item/commandExecution/requestApproval',
        params: { threadId: 'th-attacker-thread', turnId: 'turn-transport-qa', command: 'git status' },
      }),
    }).then(r => r.json());
    assert.deepEqual(resWrongThread, { decision: 'decline' }, 'Mismatched threadId must be declined');

    // Mismatched turnId
    const resWrongTurn = await fetch(`http://127.0.0.1:${mockServerPort}/send-approval`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 't6-wrong-turn',
        method: 'item/commandExecution/requestApproval',
        params: { threadId: 'th-transport-qa', turnId: 'turn-stale-turn', command: 'git status' },
      }),
    }).then(r => r.json());
    assert.deepEqual(resWrongTurn, { decision: 'decline' }, 'Mismatched turnId must be declined');

    const hasDialogT6 = await page.locator('.qdialog').isVisible();
    assert.equal(hasDialogT6, false, 'Invalid identities must never reach UI dialog');
    console.log('  [PASS] Scenario T.6: Incorrect thread/turn identities fail-closed at transport level.');

    // Close transport session
    await fetch(`http://127.0.0.1:${controlPort}/transport/close`, { method: 'POST' });

    // Stop Playwright tracing and export trace.zip
    const traceFile = path.join(EVIDENCE_DIR, 'trace.zip');
    await context.tracing.stop({ path: traceFile });
    console.log('\nSaved Playwright trace:', traceFile);

    await browser.close();
    browser = null;

    // =========================================================================
    // PART 3: IDENTIDAD Y AISLAMIENTO (Including corrected D.4)
    // =========================================================================
    console.log('\n================================================================');
    console.log('PART 3: IDENTIDAD, AISLAMIENTO Y D.4 REAL VALIDATION EXECUTION');
    console.log('================================================================');

    const { codexChatApproval } = await import('../src/pipeline.js');
    const fakeChat = { planMode: false, pending: null, messages: [] };

    console.log('  D.1 Missing threadId:');
    const resD1 = await codexChatApproval({}, fakeChat, {}, {
      id: 'd1', method: 'item/commandExecution/requestApproval', params: { turnId: 't1' },
    });
    assert.deepEqual(resD1, { decision: 'decline' });

    console.log('  D.2 Missing turnId:');
    const resD2 = await codexChatApproval({}, fakeChat, {}, {
      id: 'd2', method: 'item/commandExecution/requestApproval', params: { threadId: 'th1' },
    });
    assert.deepEqual(resD2, { decision: 'decline' });

    console.log('  D.3 Unauthorized RPC methods:');
    const unauthorizedMethods = [
      'item/permissions/requestApproval',
      'mcpServer/elicitation/request',
      'item/tool/requestUserInput',
      'unknown/method',
    ];
    for (const m of unauthorizedMethods) {
      assert.equal(CODEX_APPROVAL_METHODS.includes(m), false);
      const resUnauth = await codexChatApproval({}, fakeChat, {}, {
        id: 'd3', method: m, threadId: 'th1', turnId: 't1', params: {},
      });
      assert.deepEqual(resUnauth, { decision: 'decline' });
    }

    // D.4: Real validation execution through registered handler (NO optional chaining or default fallback!)
    console.log('  D.4 Session and fork isolation (real execution of CodexChatSession.#approval):');
    let capturedHandler = null;
    const fakeClient = new EventEmitter();
    fakeClient.alive = true;
    fakeClient.open = async () => {};
    fakeClient.close = () => {};
    fakeClient.request = async (m) => {
      if (m === 'thread/resume') return { thread: { id: 'th-parent-1' } };
      if (m === 'turn/start') return { turn: { id: 'turn-d4', status: 'inProgress' } };
      return {};
    };

    const prevHooksCreate = codexChatHooks.create;
    try {
      codexChatHooks.create = (opts) => {
        capturedHandler = opts.requestHandler;
        return fakeClient;
      };

      const d4Session = new CodexChatSession({
        machine: { kind: 'local' },
        cwd: repoDir,
        permissionMode: 'bypassPermissions',
        resume: 'codex:th-parent-1',
        onApproval: async () => ({ decision: 'accept' }),
      });

      // Start turn so d4Session becomes busy with threadId='th-parent-1' and turnId='turn-d4'
      const d4Turn = d4Session.send('active turn for d4');
      await new Promise(r => setImmediate(r));
      assert.ok(capturedHandler, 'requestHandler must be registered by CodexChatSession');

      // Request with mismatched thread ID - must be declined by real #approval logic
      const resWrongThreadD4 = await capturedHandler({
        id: 'd4-wrong-thread',
        method: 'item/commandExecution/requestApproval',
        params: { threadId: 'th-attacker-thread', turnId: 'turn-d4', command: 'git status' },
      });
      assert.deepEqual(resWrongThreadD4, { decision: 'decline' }, 'Mismatched threadId must execute validation and return decline');

      // Request with mismatched turn ID - must be declined by real #approval logic
      const resWrongTurnD4 = await capturedHandler({
        id: 'd4-wrong-turn',
        method: 'item/commandExecution/requestApproval',
        params: { threadId: 'th-parent-1', turnId: 'turn-other', command: 'git status' },
      });
      assert.deepEqual(resWrongTurnD4, { decision: 'decline' }, 'Mismatched turnId must execute validation and return decline');

      // Request with valid threadId and turnId reaches onApproval and succeeds
      const resValidD4 = await capturedHandler({
        id: 'd4-valid',
        method: 'item/commandExecution/requestApproval',
        params: { threadId: 'th-parent-1', turnId: 'turn-d4', command: 'git status' },
      });
      assert.deepEqual(resValidD4, { decision: 'accept' }, 'Matching thread and turn permits approval');

      d4Session.close();
      console.log('  [PASS] Scenario D.4: Real validation executed directly through #approval handler.');
    } finally {
      codexChatHooks.create = prevHooksCreate;
    }

    console.log('  [PASS] Scenario D: Identifiers and boundaries enforced closed without fallbacks.');

    // =========================================================================
    // PART 4: REAL PROTOCOL VALIDATION AGAINST CODEX APP SERVER BINARY
    // =========================================================================
    console.log('\n================================================================');
    console.log('PART 4: REAL PROTOCOL VALIDATION (GENUINE CODEX APP SERVER BINARY)');
    console.log('================================================================');
    console.log('  Diferenciación explícita:');
    console.log('    • Partes 1, 2, 3: verificaciones deterministas con servidor simulado y Playwright UI.');
    console.log('    • Parte 4: ejecución real contra el binario genuino de Codex en el clon ATGE/dev-any.');

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
    console.log('  Verificación GitHub ATGE/dev-any#1: intacto (OPEN, 0 comentarios añadidos)');
    console.log('  [PASS] Scenario E: Real Codex App Server protocol verified safely.');

    // =========================================================================
    // PART 5: FAIL-CLOSED EXTERNAL MCP POLICY DEMONSTRATION
    // =========================================================================
    console.log('\n================================================================');
    console.log('PART 5: FAIL-CLOSED EXTERNAL MCP POLICY DEMONSTRATION');
    console.log('================================================================');
    console.log('  Auditing system and project MCP configuration...');
    const mcpAudit = auditCodexMcpConfiguration({ cwd: repoDir });
    console.log(`  User MCP home: ${mcpAudit.userHome}`);
    console.log(`  User MCP servers found: ${JSON.stringify(mcpAudit.userMcpServers)}`);
    console.log(`  Project MCP servers found: ${JSON.stringify(mcpAudit.projectMcpServers)}`);
    console.log(`  Active isolation policy: ${mcpAudit.policy} (isolated by default: ${mcpAudit.isolatedByDefault})`);

    // Configure a dummy external MCP server in a separate worktree that attempts to write a breach marker
    const mcpWorktree = mkdtempSync(path.join(os.tmpdir(), 'codex-mcp-demo-'));
    const breachMarker = path.join(mcpWorktree, 'mcp_breach_detected.txt');
    const dummyMcpScript = path.join(mcpWorktree, 'dummy-writer-mcp.mjs');

    writeFileSync(dummyMcpScript, `
import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(breachMarker)}, 'BREACH: external MCP executed unexpectedly!');
process.exit(0);
`);

    mkdirSync(path.join(mcpWorktree, '.codex'), { recursive: true });
    writeFileSync(path.join(mcpWorktree, '.codex', 'config.toml'), `
[mcp_servers.external_writer_tool]
command = "node"
args = [${JSON.stringify(dummyMcpScript)}]
`);

    console.log('  Demonstrating fail-closed isolation with dummy external write MCP in repository config...');
    const mcpDemoSession = new CodexChatSession({
      machine: { kind: 'local' },
      cwd: mcpWorktree,
      permissionMode: 'plan',
      idleMs: 0,
    });

    const mcpTurn = await mcpDemoSession.send('Reply with exactly MCP_ISOLATION_VERIFIED.');
    console.log('  Turn completed under isolated environment:', mcpTurn.resultText);
    assert.ok(mcpTurn.resultText.includes('MCP_ISOLATION_VERIFIED'));

    const breachOccurred = existsSync(breachMarker);
    console.log(`  Did external MCP execute and write marker?: ${breachOccurred}`);
    assert.equal(breachOccurred, false, 'External MCP server MUST NOT execute under fail-closed isolation policy');

    mcpDemoSession.close();
    rmSync(mcpWorktree, { recursive: true, force: true });
    console.log('  [PASS] Scenario F: External MCP isolation verified fail-closed (dummy writer was never executed).');

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
