import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { tempDir } from './teardown.mjs';
import {
  auditCodexMcpConfiguration,
  prepareCodexIsolatedHome,
  cleanupCodexIsolatedHome,
  retainCodexIsolatedHome,
  releaseCodexIsolatedHome,
  getActiveCodexIsolatedHomesCount,
} from '../src/agents/codex-isolation.js';
import { appServerHooks, CodexAppServer } from '../src/agents/app-server.js';
import { codexChatHooks, CodexChatSession } from '../src/agents/chat-session.js';
import { statSync, readlinkSync, symlinkSync } from 'node:fs';

test('auditCodexMcpConfiguration detects MCP servers from user and project config', () => {
  const tmp = tempDir('codex-audit-test-');
  try {
    const userHome = path.join(tmp, 'user-codex');
    const projectDir = path.join(tmp, 'repo');
    mkdirSync(userHome, { recursive: true });
    mkdirSync(path.join(projectDir, '.codex'), { recursive: true });

    writeFileSync(path.join(userHome, 'config.toml'), `
[mcp_servers.global_tool]
command = "node"
args = ["global.js"]

[mcp_servers.second_tool]
command = "echo"
`);

    writeFileSync(path.join(projectDir, '.codex', 'config.toml'), `
[mcp_servers.project_tool]
command = "python3"
args = ["run.py"]
`);

    const audit = auditCodexMcpConfiguration({ cwd: projectDir, userCodexHome: userHome });
    assert.deepEqual(audit.userMcpServers, ['global_tool', 'second_tool']);
    assert.deepEqual(audit.projectMcpServers, ['project_tool']);
    assert.equal(audit.isolatedByDefault, true);
    assert.equal(audit.policy, 'fail-closed');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('prepareCodexIsolatedHome creates isolated home, symlinks auth without copying, and marks project untrusted', () => {
  const tmp = tempDir('codex-iso-prep-');
  try {
    const fakeAuthDir = path.join(tmp, 'fake-home');
    mkdirSync(fakeAuthDir, { recursive: true });
    const fakeAuthFile = path.join(fakeAuthDir, 'auth.json');
    writeFileSync(fakeAuthFile, JSON.stringify({ token: 'SECRET_TOKEN_DO_NOT_COPY' }));

    const projectDir = path.join(tmp, 'project');
    mkdirSync(projectDir, { recursive: true });

    const prevAuthEnv = process.env.CODEX_AUTH_FILE;
    process.env.CODEX_AUTH_FILE = fakeAuthFile;

    const runtimeDir = path.join(tmp, 'runtime');
    const prepared = prepareCodexIsolatedHome({ cwd: projectDir, customCodexHome: runtimeDir });

    assert.equal(prepared.codexHome, runtimeDir);
    assert.equal(prepared.env.CODEX_HOME, runtimeDir);

    // Verify auth.json is a SYMLINK, not a copied file
    const targetAuth = path.join(runtimeDir, 'auth.json');
    assert.ok(existsSync(targetAuth), 'auth.json must exist in isolated runtime');
    const stat = lstatSync(targetAuth);
    assert.ok(stat.isSymbolicLink(), 'auth.json MUST be a symlink to prevent copying credentials');

    // Verify config.toml marks project untrusted and has fail-closed MCP policy
    const configContent = readFileSync(prepared.configPath, 'utf8');
    assert.ok(configContent.includes('allow_symlinked_codex_home = true'));
    assert.ok(configContent.includes('trust_level = "untrusted"'));
    assert.ok(!configContent.includes('[mcp_servers.'), 'Must have no mcp_servers by default (fail-closed)');

    if (prevAuthEnv !== undefined) process.env.CODEX_AUTH_FILE = prevAuthEnv;
    else delete process.env.CODEX_AUTH_FILE;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('prepareCodexIsolatedHome supports explicit opt-in policy for specific MCP servers', () => {
  const tmp = tempDir('codex-iso-policy-');
  try {
    const runtimeDir = path.join(tmp, 'runtime');
    const prepared = prepareCodexIsolatedHome({
      cwd: tmp,
      customCodexHome: runtimeDir,
      mcpPolicy: {
        allowedMcpServers: {
          explicit_safe_tool: {
            command: 'node',
            args: ['/path/to/safe.js'],
            env: { SAFE_MODE: '1' },
          },
        },
      },
    });

    const configContent = readFileSync(prepared.configPath, 'utf8');
    assert.ok(configContent.includes('[mcp_servers.explicit_safe_tool]'));
    assert.ok(configContent.includes('command = "node"'));
    assert.ok(configContent.includes('args = ["/path/to/safe.js"]'));
    assert.ok(configContent.includes('"SAFE_MODE": "1"') || configContent.includes('"SAFE_MODE":"1"'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('CodexAppServer passes isolated CODEX_HOME environment to child process by default', async () => {
  const previousSpawn = appServerHooks.spawn;
  const tmp = tempDir('codex-app-spawn-');
  let capturedOpts = null;
  try {
    appServerHooks.spawn = (cmd, args, opts) => {
      capturedOpts = opts;
      const fake = {
        once: () => fake,
        stdin: { write: () => {}, on: () => {} },
        stdout: { on: () => {} },
        stderr: { on: () => {} },
      };
      return fake;
    };

    const server = new CodexAppServer({ cwd: tmp, timeoutMs: 100 });
    server.open().catch(() => {});

    assert.ok(capturedOpts, 'spawn was called');
    assert.ok(capturedOpts.env, 'spawn received custom environment');
    assert.ok(capturedOpts.env.CODEX_HOME, 'spawn received CODEX_HOME in env');
    assert.notEqual(capturedOpts.env.CODEX_HOME, process.env.HOME + '/.codex', 'CODEX_HOME must not be global ~/.codex');
  } finally {
    appServerHooks.spawn = previousSpawn;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('CodexChatSession propagates cwd and mcpPolicy to CodexAppServer', async () => {
  const previousCreate = codexChatHooks.create;
  let capturedOpts = null;
  try {
    codexChatHooks.create = (opts) => {
      capturedOpts = opts;
      const emitter = new EventEmitter();
      emitter.alive = true;
      emitter.open = async () => {};
      emitter.close = () => {};
      emitter.request = async (method) => {
        if (method === 'thread/start') return { thread: { id: 'th-chat-iso-1' } };
        if (method === 'turn/start') {
          setImmediate(() => {
            emitter.emit('notification', { method: 'turn/completed', params: { turn: { id: 't1', status: 'completed' } } });
          });
          return { turn: { id: 't1', status: 'inProgress' } };
        }
        return {};
      };
      return emitter;
    };

    const session = new CodexChatSession({
      machine: { kind: 'local' },
      cwd: '/test/custom-repo',
      mcpPolicy: { allowedMcpServers: { toolA: { command: 'echo' } } },
    });

    await session.send('test');
    assert.ok(capturedOpts);
    assert.equal(capturedOpts.cwd, '/test/custom-repo');
    assert.deepEqual(capturedOpts.mcpPolicy, { allowedMcpServers: { toolA: { command: 'echo' } } });
    session.close();
  } finally {
    codexChatHooks.create = previousCreate;
  }
});

test('prepareCodexIsolatedHome preserves existing untrusted projects and writes config.toml atomically', () => {
  const tmp = tempDir('codex-race-preserv-');
  try {
    const runtimeDir = path.join(tmp, 'runtime');
    const repo1 = path.join(tmp, 'repo1');
    const repo2 = path.join(tmp, 'repo2');
    mkdirSync(repo1, { recursive: true });
    mkdirSync(repo2, { recursive: true });

    prepareCodexIsolatedHome({ cwd: repo1, customCodexHome: runtimeDir });
    let config = readFileSync(path.join(runtimeDir, 'config.toml'), 'utf8');
    assert.ok(config.includes(`[projects."${repo1.replace(/\\/g, '/')}"]`));

    // Register second project: must preserve first project as untrusted
    prepareCodexIsolatedHome({ cwd: repo2, customCodexHome: runtimeDir });
    config = readFileSync(path.join(runtimeDir, 'config.toml'), 'utf8');
    assert.ok(config.includes(`[projects."${repo1.replace(/\\/g, '/')}"]`), 'repo1 must remain marked untrusted');
    assert.ok(config.includes(`[projects."${repo2.replace(/\\/g, '/')}"]`), 'repo2 must be marked untrusted');
    assert.ok(!existsSync(path.join(runtimeDir, '.config.toml.tmp')), 'temporary config file must be cleanly renamed');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('prepareCodexIsolatedHome verifies and fixes stale auth symlinks and cleans up when source missing', () => {
  const tmp = tempDir('codex-auth-fix-');
  try {
    const fakeAuthDir = path.join(tmp, 'fake-home');
    mkdirSync(fakeAuthDir, { recursive: true });
    const fakeAuthFile = path.join(fakeAuthDir, 'auth.json');
    writeFileSync(fakeAuthFile, JSON.stringify({ token: 'VALID_AUTH' }));

    const prevAuthEnv = process.env.CODEX_AUTH_FILE;
    process.env.CODEX_AUTH_FILE = fakeAuthFile;

    const runtimeDir = path.join(tmp, 'runtime');
    mkdirSync(runtimeDir, { recursive: true });
    const targetAuth = path.join(runtimeDir, 'auth.json');

    // Create a stale symlink pointing to an arbitrary path
    symlinkSync('/path/to/stale/auth.json', targetAuth);
    assert.ok(lstatSync(targetAuth).isSymbolicLink());

    // Prepare home: should detect stale symlink and relink to fakeAuthFile
    prepareCodexIsolatedHome({ cwd: tmp, customCodexHome: runtimeDir });
    assert.equal(readlinkSync(targetAuth), fakeAuthFile, 'Must point to legitimate auth file');
    assert.equal(statSync(runtimeDir).mode & 0o777, 0o700, 'Must enforce 0700 directory mode');

    // Remove sourceAuth: prepare home must remove targetAuth
    rmSync(fakeAuthFile, { force: true });
    prepareCodexIsolatedHome({ cwd: tmp, customCodexHome: runtimeDir });
    assert.ok(!existsSync(targetAuth) && !lstatSync(targetAuth, { throwIfNoEntry: false }), 'Must remove targetAuth when sourceAuth missing');

    if (prevAuthEnv !== undefined) process.env.CODEX_AUTH_FILE = prevAuthEnv;
    else delete process.env.CODEX_AUTH_FILE;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('prepareCodexIsolatedHome supports per-session and per-project directory partitions', () => {
  const tmp = tempDir('codex-partition-');
  try {
    const sessionPrep = prepareCodexIsolatedHome({ cwd: tmp, dataDir: tmp, sessionId: 'codex:chat-1' });
    assert.ok(sessionPrep.codexHome.includes(path.join('codex-runtime', 'sessions', 'codex_chat-1')));

    const projectPrep = prepareCodexIsolatedHome({
      cwd: tmp,
      dataDir: tmp,
      projectId: 'project-alpha',
      mcpPolicy: { allowedMcpServers: { alphaTool: { command: 'echo' } } },
    });
    assert.ok(projectPrep.codexHome.includes(path.join('codex-runtime', 'projects', 'project-alpha')));

    const sessionConfig = readFileSync(sessionPrep.configPath, 'utf8');
    const projectConfig = readFileSync(projectPrep.configPath, 'utf8');
    assert.ok(!sessionConfig.includes('alphaTool'), 'Session config must not leak project MCP tools');
    assert.ok(projectConfig.includes('alphaTool'), 'Project config contains only its allowed tools');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('CodexAppServer enforces isolated CODEX_HOME and prevents bypass via CODEX_DISABLE_ISOLATION or custom env', async () => {
  const previousSpawn = appServerHooks.spawn;
  const prevDisable = process.env.CODEX_DISABLE_ISOLATION;
  process.env.CODEX_DISABLE_ISOLATION = '1';
  const tmp = tempDir('codex-bypass-test-');
  let capturedOpts = null;
  try {
    appServerHooks.spawn = (cmd, args, opts) => {
      capturedOpts = opts;
      const fake = {
        once: () => fake,
        stdin: { write: () => {}, on: () => {} },
        stdout: { on: () => {} },
        stderr: { on: () => {} },
      };
      return fake;
    };

    const server = new CodexAppServer({
      cwd: tmp,
      env: { CUSTOM_OVERRIDE: '1', CODEX_HOME: '/attempted/bypass/home' },
      timeoutMs: 100,
    });
    server.open().catch(() => {});

    assert.ok(capturedOpts);
    assert.equal(capturedOpts.env.CUSTOM_OVERRIDE, '1');
    assert.notEqual(capturedOpts.env.CODEX_HOME, '/attempted/bypass/home', 'Custom env must not override isolated CODEX_HOME');
    assert.notEqual(capturedOpts.env.CODEX_HOME, process.env.HOME + '/.codex', 'Must not fall back to unisolated ~/.codex');
    assert.ok(capturedOpts.env.CODEX_HOME.includes('codex-runtime'));
    server.close();
  } finally {
    appServerHooks.spawn = previousSpawn;
    if (prevDisable !== undefined) process.env.CODEX_DISABLE_ISOLATION = prevDisable;
    else delete process.env.CODEX_DISABLE_ISOLATION;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('cleanupCodexIsolatedHome safely removes auth.json upon cleanup', () => {
  const tmp = tempDir('codex-cleanup-test-');
  try {
    const runtimeDir = path.join(tmp, 'runtime');
    mkdirSync(runtimeDir, { recursive: true });
    const targetAuth = path.join(runtimeDir, 'auth.json');
    writeFileSync(targetAuth, 'secret');

    cleanupCodexIsolatedHome({ codexHome: runtimeDir });
    assert.ok(!existsSync(targetAuth), 'auth.json must be unlinked');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('Regression: Dos proyectos concurrentes con configuraciones MCP distintas', () => {
  const tmp = tempDir('codex-reg-mcp-');
  try {
    const projA = prepareCodexIsolatedHome({
      dataDir: tmp,
      projectId: 'project-A',
      mcpPolicy: { allowedMcpServers: { alpha_tool: { command: 'node', args: ['alpha.js'] } } },
    });
    const projB = prepareCodexIsolatedHome({
      dataDir: tmp,
      projectId: 'project-B',
      mcpPolicy: { allowedMcpServers: { beta_tool: { command: 'python3', env: { BETA_FLAG: '1' } } } },
    });

    assert.notEqual(projA.codexHome, projB.codexHome);
    const cfgA = readFileSync(projA.configPath, 'utf8');
    const cfgB = readFileSync(projB.configPath, 'utf8');

    assert.ok(cfgA.includes('[mcp_servers.alpha_tool]'));
    assert.ok(!cfgA.includes('beta_tool'), 'Project A must not have Project B MCP tools');

    assert.ok(cfgB.includes('[mcp_servers.beta_tool]'));
    assert.ok(!cfgB.includes('alpha_tool'), 'Project B must not have Project A MCP tools');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('Regression: Dos tareas con el mismo identificador local de chat mantienen runtimes separados', () => {
  const tmp = tempDir('codex-reg-tasks-');
  try {
    const task1 = prepareCodexIsolatedHome({
      dataDir: tmp,
      projectId: 'same-project',
      taskId: 'task-101',
      sessionId: 'default',
    });
    const task2 = prepareCodexIsolatedHome({
      dataDir: tmp,
      projectId: 'same-project',
      taskId: 'task-202',
      sessionId: 'default',
    });

    assert.notEqual(task1.codexHome, task2.codexHome);
    assert.ok(task1.codexHome.includes(path.join('tasks', 'task-101', 'sessions', 'default')));
    assert.ok(task2.codexHome.includes(path.join('tasks', 'task-202', 'sessions', 'default')));

    writeFileSync(path.join(task1.codexHome, 'task1-marker.txt'), 't1');
    assert.ok(!existsSync(path.join(task2.codexHome, 'task1-marker.txt')));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('Regression: Reapertura real de una sesión después de cerrar App Server mantiene la identidad del directorio', async () => {
  const tmp = tempDir('codex-reg-reopen-');
  const prevCreate = codexChatHooks.create;
  const capturedInstances = [];

  class MockAppServer extends EventEmitter {
    constructor(opts) {
      super();
      this.opts = opts;
      this.alive = false;
      this.turn = 0;
      capturedInstances.push(this);
    }
    async open() {
      this.alive = true;
      const iso = prepareCodexIsolatedHome({ ...this.opts, dataDir: tmp });
      this.isolatedHome = iso.codexHome;
      return this;
    }
    close() {
      this.alive = false;
      cleanupCodexIsolatedHome({ codexHome: this.isolatedHome });
      this.emit('disconnected', new Error('closed'));
    }
    async request(method, params) {
      if (method === 'thread/start') return { thread: { id: 'thread-reopen-1' } };
      if (method === 'thread/resume') return { thread: { id: params.threadId } };
      if (method === 'turn/start') {
        const turnId = 't-' + (++this.turn);
        setImmediate(() => {
          this.emit('notification', { method: 'turn/started', params: { threadId: params.threadId, turn: { id: turnId } } });
          this.emit('notification', { method: 'item/completed', params: { threadId: params.threadId, turnId, item: { type: 'agentMessage', id: 'm1', text: 'Turn ' + this.turn } } });
          this.emit('notification', { method: 'turn/completed', params: { threadId: params.threadId, turn: { id: turnId, status: 'completed' } } });
        });
        return { turn: { id: turnId, status: 'inProgress' } };
      }
      return {};
    }
  }

  try {
    codexChatHooks.create = (opts) => new MockAppServer(opts);

    const session = new CodexChatSession({
      machine: { kind: 'local' },
      cwd: tmp,
      sessionId: 'chat-main',
      taskId: 'task-reopen',
      projectId: 'proj-reopen',
    });

    const res1 = await session.send('turn 1');
    assert.equal(res1.ok, true);
    assert.equal(res1.sessionId, 'codex:thread-reopen-1');
    const firstHome = session.isolatedHome;
    assert.ok(firstHome);

    // Simulate idle timeout suspension: close App Server
    session.close();
    assert.equal(session.alive, false);

    // Reopen session on next turn
    const res2 = await session.send('turn 2');
    assert.equal(res2.ok, true);
    assert.equal(session.isolatedHome, firstHome, 'isolatedHome must be preserved across reopen');
    assert.equal(capturedInstances.length, 2);
    assert.equal(capturedInstances[1].opts.codexHome, firstHome, 'Reopened AppServer received exact same codexHome');

    session.close();
  } finally {
    codexChatHooks.create = prevCreate;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('Regression: resume después de reiniciar el proceso Live Monitor conserva el mismo CODEX_HOME', async () => {
  const tmp = tempDir('codex-reg-restart-');
  const prevCreate = codexChatHooks.create;
  let homeProcess1 = null;

  class MockAppServer extends EventEmitter {
    constructor(opts) {
      super();
      this.opts = opts;
      this.alive = false;
    }
    async open() {
      this.alive = true;
      const iso = prepareCodexIsolatedHome({ ...this.opts, dataDir: tmp });
      this.isolatedHome = iso.codexHome;
      return this;
    }
    close() {
      this.alive = false;
      cleanupCodexIsolatedHome({ codexHome: this.isolatedHome });
      this.emit('disconnected', new Error('closed'));
    }
    async request(method, params) {
      if (method === 'thread/start') return { thread: { id: 'thread-persistent-99' } };
      if (method === 'thread/resume') return { thread: { id: params.threadId } };
      if (method === 'turn/start') {
        setImmediate(() => {
          this.emit('notification', { method: 'turn/started', params: { threadId: params.threadId, turn: { id: 't1' } } });
          this.emit('notification', { method: 'turn/completed', params: { threadId: params.threadId, turn: { id: 't1', status: 'completed' } } });
        });
        return { turn: { id: 't1', status: 'inProgress' } };
      }
      return {};
    }
  }

  try {
    codexChatHooks.create = (opts) => new MockAppServer(opts);

    // Process 1: run turn 1
    const session1 = new CodexChatSession({
      machine: { kind: 'local' },
      cwd: tmp,
      sessionId: 'chat-persisted',
      taskId: 'task-persisted',
      projectId: 'proj-persisted',
    });
    const result1 = await session1.send('first turn');
    homeProcess1 = session1.isolatedHome;
    session1.close();

    // Process 2: Live Monitor restarted, memory reset. New CodexChatSession instantiated with resume = result1.sessionId
    const session2 = new CodexChatSession({
      machine: { kind: 'local' },
      cwd: tmp,
      resume: result1.sessionId,
      sessionId: 'chat-persisted',
      taskId: 'task-persisted',
      projectId: 'proj-persisted',
    });
    const result2 = await session2.send('second turn after restart');
    assert.equal(result2.ok, true);
    assert.equal(session2.isolatedHome, homeProcess1, 'Process 2 after restart must resolve to the identical CODEX_HOME');
    session2.close();
  } finally {
    codexChatHooks.create = prevCreate;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('Regression: fork manteniendo el historial esperado en un entorno aislado sin corromper el padre', async () => {
  const tmp = tempDir('codex-reg-fork-');
  const prevCreate = codexChatHooks.create;
  const dispatchedRequests = [];

  class MockAppServer extends EventEmitter {
    constructor(opts) {
      super();
      this.opts = opts;
      this.alive = false;
    }
    async open() {
      this.alive = true;
      const iso = prepareCodexIsolatedHome({ ...this.opts, dataDir: tmp });
      this.isolatedHome = iso.codexHome;
      return this;
    }
    close() {
      this.alive = false;
      cleanupCodexIsolatedHome({ codexHome: this.isolatedHome });
      this.emit('disconnected', new Error('closed'));
    }
    async request(method, params) {
      dispatchedRequests.push({ method, params, home: this.isolatedHome });
      if (method === 'thread/start') return { thread: { id: 'thread-parent' } };
      if (method === 'thread/fork') return { thread: { id: 'thread-forked-child' } };
      if (method === 'turn/start') {
        setImmediate(() => {
          this.emit('notification', { method: 'turn/started', params: { threadId: params.threadId, turn: { id: 't1' } } });
          this.emit('notification', { method: 'turn/completed', params: { threadId: params.threadId, turn: { id: 't1', status: 'completed' } } });
        });
        return { turn: { id: 't1', status: 'inProgress' } };
      }
      return {};
    }
  }

  try {
    codexChatHooks.create = (opts) => new MockAppServer(opts);

    // Parent session
    const parent = new CodexChatSession({
      machine: { kind: 'local' },
      cwd: tmp,
      sessionId: 'chat-parent',
      taskId: 'task-fork',
      projectId: 'proj-fork',
    });
    const parentRes = await parent.send('parent prompt');
    assert.equal(parentRes.sessionId, 'codex:thread-parent');
    const parentHome = parent.isolatedHome;

    // Forked session
    const child = new CodexChatSession({
      machine: { kind: 'local' },
      cwd: tmp,
      resume: parentRes.sessionId,
      forkSession: true,
      sessionId: 'chat-child',
      taskId: 'task-fork',
      projectId: 'proj-fork',
      forkFromHome: parentHome,
    });
    const childRes = await child.send('child prompt');
    assert.equal(childRes.sessionId, 'codex:thread-forked-child');
    assert.notEqual(child.isolatedHome, parentHome, 'Child must have its own isolated runtime directory');

    // Verify thread/fork was requested with parent's thread ID
    const forkCall = dispatchedRequests.find(r => r.method === 'thread/fork');
    assert.ok(forkCall, 'thread/fork must be called');
    assert.equal(forkCall.params.threadId, 'thread-parent');

    parent.close();
    child.close();
  } finally {
    codexChatHooks.create = prevCreate;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('Regression: Planificaciones simultáneas sin contaminación de configuración', () => {
  const tmp = tempDir('codex-reg-planning-');
  try {
    const plan1 = prepareCodexIsolatedHome({
      dataDir: tmp,
      planningId: 'plan-run-1',
      mcpPolicy: { allowedMcpServers: { toolForPlan1: { command: 'node', args: ['p1.js'] } } },
    });
    const plan2 = prepareCodexIsolatedHome({
      dataDir: tmp,
      planningId: 'plan-run-2',
      mcpPolicy: { allowedMcpServers: { toolForPlan2: { command: 'python3', args: ['p2.py'] } } },
    });

    assert.notEqual(plan1.codexHome, plan2.codexHome);
    assert.ok(plan1.codexHome.includes(path.join('planning', 'plan-run-1')));
    assert.ok(plan2.codexHome.includes(path.join('planning', 'plan-run-2')));

    const cfg1 = readFileSync(plan1.configPath, 'utf8');
    const cfg2 = readFileSync(plan2.configPath, 'utf8');

    assert.ok(cfg1.includes('toolForPlan1'));
    assert.ok(!cfg1.includes('toolForPlan2'));

    assert.ok(cfg2.includes('toolForPlan2'));
    assert.ok(!cfg2.includes('toolForPlan1'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('Regression: Cleanup sin afectar otras sesiones activas que comparten o tienen runtimes dedicados', () => {
  const tmp = tempDir('codex-reg-cleanup-');
  const prevAuthEnv = process.env.CODEX_AUTH_FILE;
  try {
    const fakeAuthDir = path.join(tmp, 'fake-auth');
    mkdirSync(fakeAuthDir, { recursive: true });
    const fakeAuth = path.join(fakeAuthDir, 'auth.json');
    writeFileSync(fakeAuth, JSON.stringify({ token: 'test-token' }));
    process.env.CODEX_AUTH_FILE = fakeAuth;

    const session1 = prepareCodexIsolatedHome({ dataDir: tmp, sessionId: 'session-alpha' });
    const session2 = prepareCodexIsolatedHome({ dataDir: tmp, sessionId: 'session-beta' });

    assert.ok(existsSync(path.join(session1.codexHome, 'auth.json')));
    assert.ok(existsSync(path.join(session2.codexHome, 'auth.json')));

    // Cleanup session 1
    cleanupCodexIsolatedHome({ codexHome: session1.codexHome });

    // Session 1 cleaned, Session 2 completely intact
    assert.ok(!existsSync(path.join(session1.codexHome, 'auth.json')));
    assert.ok(existsSync(path.join(session2.codexHome, 'auth.json')), 'Session 2 auth.json must NOT be deleted by Session 1 cleanup');

    // Test reference counted shared home:
    const shared = path.join(tmp, 'shared-home');
    mkdirSync(shared, { recursive: true });
    prepareCodexIsolatedHome({ customCodexHome: shared }); // refcount = 1
    prepareCodexIsolatedHome({ customCodexHome: shared }); // refcount = 2
    assert.equal(getActiveCodexIsolatedHomesCount(shared), 2);

    cleanupCodexIsolatedHome({ codexHome: shared }); // refcount decrements to 1
    assert.equal(getActiveCodexIsolatedHomesCount(shared), 1);
    assert.ok(existsSync(path.join(shared, 'auth.json')), 'Shared home auth.json must NOT be removed while another session is active');

    cleanupCodexIsolatedHome({ codexHome: shared }); // refcount decrements to 0
    assert.equal(getActiveCodexIsolatedHomesCount(shared), 0);
    assert.ok(!existsSync(path.join(shared, 'auth.json')), 'Shared home auth.json removed only after last reference released');
  } finally {
    if (prevAuthEnv !== undefined) process.env.CODEX_AUTH_FILE = prevAuthEnv;
    else delete process.env.CODEX_AUTH_FILE;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('Regression: Validación real del archivo TOML generado para MCP explícitos con parámetros complejos', () => {
  const tmp = tempDir('codex-reg-toml-');
  try {
    const cwdRepo = path.join(tmp, 'my-repo');
    mkdirSync(cwdRepo, { recursive: true });

    const prepared = prepareCodexIsolatedHome({
      cwd: cwdRepo,
      dataDir: tmp,
      sessionId: 'toml-test',
      mcpPolicy: {
        allowedMcpServers: {
          server_one: {
            command: '/usr/local/bin/mcp-tool',
            args: ['--param', 'value with spaces', '--flag'],
            env: { DEBUG: 'true', PORT: '9999' },
          },
          server_two: {
            command: 'node',
            args: ['server.js'],
          },
        },
      },
    });

    const content = readFileSync(prepared.configPath, 'utf8');

    // Validate structure
    assert.ok(content.startsWith('# Generated by Live Monitor Codex fail-closed isolation policy.'));
    assert.ok(content.includes('allow_symlinked_codex_home = true'));
    assert.ok(content.includes(`[projects."${cwdRepo.replace(/\\/g, '/')}"]`));
    assert.ok(content.includes('trust_level = "untrusted"'));

    // Validate server_one
    assert.ok(content.includes('[mcp_servers.server_one]'));
    assert.ok(content.includes('command = "/usr/local/bin/mcp-tool"'));
    assert.ok(content.includes('args = ["--param","value with spaces","--flag"]'));
    assert.ok(content.includes('env = {"DEBUG":"true","PORT":"9999"}'));

    // Validate server_two
    assert.ok(content.includes('[mcp_servers.server_two]'));
    assert.ok(content.includes('command = "node"'));
    assert.ok(content.includes('args = ["server.js"]'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
