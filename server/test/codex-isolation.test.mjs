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
import { execFileSync } from 'node:child_process';

function parseToml(tomlContent) {
  const stdout = execFileSync('python3', ['-c', 'import tomllib, json, sys; print(json.dumps(tomllib.loads(sys.stdin.read())))'], {
    input: tomlContent,
    encoding: 'utf8',
  });
  return JSON.parse(stdout);
}

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
    const parsed = parseToml(configContent);
    assert.equal(parsed.mcp_servers.explicit_safe_tool.command, 'node');
    assert.deepEqual(parsed.mcp_servers.explicit_safe_tool.args, ['/path/to/safe.js']);
    assert.deepEqual(parsed.mcp_servers.explicit_safe_tool.env, { SAFE_MODE: '1' });
    assert.ok(configContent.includes('[mcp_servers.explicit_safe_tool]'));
    assert.ok(configContent.includes('command = "node"'));
    assert.ok(configContent.includes('args = ["/path/to/safe.js"]'));
    assert.ok(configContent.includes('env = { SAFE_MODE = "1" }'));
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

    // Parse the entire generated configuration with an authentic TOML parser (tomllib)
    const parsed = parseToml(content);

    // Validate structure
    assert.ok(content.startsWith('# Generated by Live Monitor Codex fail-closed isolation policy.'));
    assert.equal(parsed.allow_symlinked_codex_home, true);
    assert.equal(parsed.projects[cwdRepo.replace(/\\/g, '/')].trust_level, 'untrusted');

    // Validate server_one
    assert.equal(parsed.mcp_servers.server_one.command, '/usr/local/bin/mcp-tool');
    assert.deepEqual(parsed.mcp_servers.server_one.args, ['--param', 'value with spaces', '--flag']);
    assert.deepEqual(parsed.mcp_servers.server_one.env, { DEBUG: 'true', PORT: '9999' });

    // Validate exact inline TOML representation matches expected format
    assert.ok(content.includes('env = { DEBUG = "true", PORT = "9999" }'));

    // Validate server_two
    assert.equal(parsed.mcp_servers.server_two.command, 'node');
    assert.deepEqual(parsed.mcp_servers.server_two.args, ['server.js']);
    assert.equal(parsed.mcp_servers.server_two.env, undefined);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('TOML validation: Configuración predeterminada sin MCP', () => {
  const tmp = tempDir('codex-toml-default-');
  try {
    const cwdRepo = path.join(tmp, 'repo');
    mkdirSync(cwdRepo, { recursive: true });
    const prepared = prepareCodexIsolatedHome({ cwd: cwdRepo, dataDir: tmp, sessionId: 'default-mcp-test' });
    const content = readFileSync(prepared.configPath, 'utf8');
    const parsed = parseToml(content);

    assert.equal(parsed.allow_symlinked_codex_home, true);
    assert.equal(parsed.projects[cwdRepo.replace(/\\/g, '/')].trust_level, 'untrusted');
    assert.equal(parsed.mcp_servers, undefined, 'Must not define any mcp_servers table by default');
    assert.ok(!content.includes('[mcp_servers'), 'Config text must not contain mcp_servers');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('TOML validation: MCP explícito con variables de entorno diversas y vacías', () => {
  const tmp = tempDir('codex-toml-env-');
  try {
    const prepared = prepareCodexIsolatedHome({
      dataDir: tmp,
      sessionId: 'env-test',
      mcpPolicy: {
        allowedMcpServers: {
          tool_empty_env: {
            command: 'echo',
            env: {},
          },
          tool_with_env: {
            command: '/bin/tool',
            args: ['--run'],
            env: {
              VAR_A: 'value_a',
              VAR_NUM: 123,
              VAR_BOOL: true,
              LOWER_CASE: 'allowed',
            },
          },
        },
      },
    });

    const content = readFileSync(prepared.configPath, 'utf8');
    const parsed = parseToml(content);

    assert.deepEqual(parsed.mcp_servers.tool_empty_env.env, {});
    assert.ok(content.includes('env = {}'));

    assert.equal(parsed.mcp_servers.tool_with_env.command, '/bin/tool');
    assert.deepEqual(parsed.mcp_servers.tool_with_env.env, {
      VAR_A: 'value_a',
      VAR_NUM: '123',
      VAR_BOOL: 'true',
      LOWER_CASE: 'allowed',
    });
    assert.ok(content.includes('env = { VAR_A = "value_a", VAR_NUM = "123", VAR_BOOL = "true", LOWER_CASE = "allowed" }'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('TOML validation: Argumentos con espacios, comillas y caracteres especiales', () => {
  const tmp = tempDir('codex-toml-args-');
  try {
    const testArgs = [
      '--flag',
      'value with spaces',
      '--message="quoted string"',
      'path/with\\backslash',
      'special chars: @#$%^&*()_+{}[]|:;<>?,./',
      'unicode: ñ, ü, 日本語, 🚀',
      'arg with \t tab',
    ];

    const prepared = prepareCodexIsolatedHome({
      dataDir: tmp,
      sessionId: 'args-test',
      mcpPolicy: {
        allowedMcpServers: {
          complex_tool: {
            command: 'node',
            args: testArgs,
          },
        },
      },
    });

    const content = readFileSync(prepared.configPath, 'utf8');
    const parsed = parseToml(content);

    assert.deepEqual(parsed.mcp_servers.complex_tool.args, testArgs);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('TOML validation: Identificadores de MCP que requieren comillado y auditoría', () => {
  const tmp = tempDir('codex-toml-quoted-mcp-');
  try {
    const prepared = prepareCodexIsolatedHome({
      dataDir: tmp,
      sessionId: 'mcp-quoted-test',
      mcpPolicy: {
        allowedMcpServers: {
          'server.with.dots': { command: 'node', args: ['a.js'] },
          'server with spaces': { command: 'python3', args: ['b.py'] },
          'tool-with-dashes': { command: 'sh' },
          'tool@special#1': { command: 'tool' },
          'tool"with"quotes': { command: 'bin' },
        },
      },
    });

    const content = readFileSync(prepared.configPath, 'utf8');
    const parsed = parseToml(content);

    assert.ok(parsed.mcp_servers['server.with.dots']);
    assert.ok(parsed.mcp_servers['server with spaces']);
    assert.ok(parsed.mcp_servers['tool-with-dashes']);
    assert.ok(parsed.mcp_servers['tool@special#1']);
    assert.ok(parsed.mcp_servers['tool"with"quotes']);

    assert.ok(content.includes('[mcp_servers.tool-with-dashes]'));
    assert.ok(content.includes('[mcp_servers."server.with.dots"]'));
    assert.ok(content.includes('[mcp_servers."server with spaces"]'));
    assert.ok(content.includes('[mcp_servers."tool@special#1"]'));
    assert.ok(content.includes('[mcp_servers."tool\\"with\\"quotes"]'));

    // Test auditCodexMcpConfiguration parsing quoted MCP names
    const auditHome = path.join(tmp, 'audit-home');
    mkdirSync(auditHome, { recursive: true });
    writeFileSync(path.join(auditHome, 'config.toml'), content);
    const audit = auditCodexMcpConfiguration({ userCodexHome: auditHome });
    assert.ok(audit.userMcpServers.includes('server.with.dots'));
    assert.ok(audit.userMcpServers.includes('server with spaces'));
    assert.ok(audit.userMcpServers.includes('tool-with-dashes'));
    assert.ok(audit.userMcpServers.includes('tool@special#1'));
    assert.ok(audit.userMcpServers.includes('tool"with"quotes'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('TOML validation: Claves y valores de entorno inválidos son rechazados de forma segura', () => {
  const tmp = tempDir('codex-toml-invalid-');
  try {
    const invalidKeyCases = [
      '',
      ' ',
      'INVALID KEY',
      'KEY=WITH_EQUALS',
      'KEY\nINJECT',
      'KEY\rINJECT',
      'KEY\0NULL',
      '1START_WITH_NUMBER',
      '-START_WITH_DASH',
      'KEY.WITH.DOTS',
    ];

    for (const badKey of invalidKeyCases) {
      assert.throws(
        () => {
          prepareCodexIsolatedHome({
            dataDir: tmp,
            sessionId: 'inv-key',
            mcpPolicy: {
              allowedMcpServers: {
                bad_tool: { command: 'node', env: { [badKey]: 'value' } },
              },
            },
          });
        },
        /(Invalid environment variable key|Environment variable key)/,
        `Must throw for invalid env key: ${JSON.stringify(badKey)}`
      );
    }

    const invalidValueCases = [
      null,
      undefined,
      { nested: 'object' },
      ['nested', 'array'],
      () => {},
      'value\0with_null',
    ];

    for (const badVal of invalidValueCases) {
      assert.throws(
        () => {
          prepareCodexIsolatedHome({
            dataDir: tmp,
            sessionId: 'inv-val',
            mcpPolicy: {
              allowedMcpServers: {
                bad_tool: { command: 'node', env: { VALID_KEY: badVal } },
              },
            },
          });
        },
        /(Environment variable value|cannot contain null bytes)/,
        `Must throw for invalid env value: ${typeof badVal}`
      );
    }

    // Invalid env container type
    assert.throws(() => {
      prepareCodexIsolatedHome({
        dataDir: tmp,
        sessionId: 'inv-env-type',
        mcpPolicy: {
          allowedMcpServers: {
            bad_tool: { command: 'node', env: 'not_an_object' },
          },
        },
      });
    }, /Environment variables must be a plain object/);

    // Invalid MCP server name injection
    assert.throws(() => {
      prepareCodexIsolatedHome({
        dataDir: tmp,
        sessionId: 'inv-mcp-name',
        mcpPolicy: {
          allowedMcpServers: {
            'injected\n[section]': { command: 'node' },
          },
        },
      });
    }, /cannot contain newlines/);

    // Invalid command
    assert.throws(() => {
      prepareCodexIsolatedHome({
        dataDir: tmp,
        sessionId: 'inv-cmd',
        mcpPolicy: {
          allowedMcpServers: {
            tool: { command: '' },
          },
        },
      });
    }, /must specify a non-empty string command/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('TOML validation: Rutas de proyecto con caracteres especiales', () => {
  const tmp = tempDir('codex-toml-proj-');
  try {
    const specialRepo = path.join(tmp, 'repo with spaces, [brackets], and "quotes"');
    mkdirSync(specialRepo, { recursive: true });

    const prepared = prepareCodexIsolatedHome({
      cwd: specialRepo,
      dataDir: tmp,
      sessionId: 'special-proj-test',
    });

    const content = readFileSync(prepared.configPath, 'utf8');
    const parsed = parseToml(content);

    const normSpecial = specialRepo.replace(/\\/g, '/');
    assert.ok(parsed.projects[normSpecial]);
    assert.equal(parsed.projects[normSpecial].trust_level, 'untrusted');

    // Verify re-reading preserves the project path without corruption
    const prepared2 = prepareCodexIsolatedHome({
      cwd: specialRepo,
      dataDir: tmp,
      sessionId: 'special-proj-test',
    });
    const content2 = readFileSync(prepared2.configPath, 'utf8');
    const parsed2 = parseToml(content2);
    assert.ok(parsed2.projects[normSpecial]);
    assert.equal(parsed2.projects[normSpecial].trust_level, 'untrusted');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

function hasCodexCli() {
  try {
    execFileSync('codex', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test('Prueba con el Codex CLI real y un MCP ficticio local: solamente carga los MCP explícitamente autorizados', (t) => {
  if (!hasCodexCli()) {
    t.skip('Codex CLI is not installed in this environment');
    return;
  }
  const tmp = tempDir('codex-real-cli-mcp-');
  try {
    const repoDir = path.join(tmp, 'repo');
    mkdirSync(path.join(repoDir, '.codex'), { recursive: true });

    // 1. Untrusted MCP in project configuration (should be isolated and NOT loaded)
    writeFileSync(path.join(repoDir, '.codex', 'config.toml'), `
[mcp_servers.unauthorized_repo_tool]
command = "node"
args = ["unauthorized.js"]
`);

    // 2. Benign dummy MCP script
    const dummyScript = path.join(tmp, 'dummy-mcp.js');
    writeFileSync(dummyScript, `
console.log(JSON.stringify({ status: 'ok', mcp: 'dummy', env: process.env.AUTHORIZED_VAR }));
`);

    // 3. Prepare isolated home with authorized dummy MCP
    const prepared = prepareCodexIsolatedHome({
      cwd: repoDir,
      dataDir: tmp,
      sessionId: 'cli-mcp-test',
      mcpPolicy: {
        allowedMcpServers: {
          authorized_dummy_tool: {
            command: 'node',
            args: [dummyScript],
            env: { AUTHORIZED_VAR: 'pass_cert_123', PORT: '8080' },
          },
        },
      },
    });

    // Validate generated TOML with tomllib first
    const content = readFileSync(prepared.configPath, 'utf8');
    const parsed = parseToml(content);
    assert.ok(parsed.mcp_servers.authorized_dummy_tool);
    assert.equal(parsed.mcp_servers.authorized_dummy_tool.env.AUTHORIZED_VAR, 'pass_cert_123');
    assert.equal(parsed.mcp_servers.unauthorized_repo_tool, undefined);

    // 4. Execute REAL codex CLI with CODEX_HOME pointing to the isolated runtime
    const listOutput = execFileSync('codex', ['mcp', 'list'], {
      env: { ...process.env, CODEX_HOME: prepared.codexHome },
      encoding: 'utf8',
    });

    // Verify authorized dummy tool is recognized by genuine Codex CLI
    assert.ok(
      listOutput.includes('authorized_dummy_tool'),
      `codex mcp list must include authorized_dummy_tool. Output:\n${listOutput}`
    );
    // Verify unauthorized repo MCP is NOT loaded
    assert.ok(
      !listOutput.includes('unauthorized_repo_tool'),
      `codex mcp list must NOT include unauthorized_repo_tool. Output:\n${listOutput}`
    );

    // 5. Inspect authorized tool via codex mcp get
    const getOutput = execFileSync('codex', ['mcp', 'get', 'authorized_dummy_tool'], {
      env: { ...process.env, CODEX_HOME: prepared.codexHome },
      encoding: 'utf8',
    });
    assert.ok(getOutput.includes('enabled: true'));
    assert.ok(getOutput.includes('command: node'));
    assert.ok(getOutput.includes('dummy-mcp.js'));
    assert.ok(getOutput.includes('AUTHORIZED_VAR'));

    // 6. Test default configuration without mcpPolicy: codex mcp list shows no MCP tools
    const defaultPrep = prepareCodexIsolatedHome({
      cwd: repoDir,
      dataDir: tmp,
      sessionId: 'cli-default-test',
    });
    const defaultListOutput = execFileSync('codex', ['mcp', 'list'], {
      env: { ...process.env, CODEX_HOME: defaultPrep.codexHome },
      encoding: 'utf8',
    });
    assert.ok(!defaultListOutput.includes('authorized_dummy_tool'));
    assert.ok(!defaultListOutput.includes('unauthorized_repo_tool'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
