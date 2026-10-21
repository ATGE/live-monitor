import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { tempDir } from './teardown.mjs';
import { auditCodexMcpConfiguration, prepareCodexIsolatedHome } from '../src/agents/codex-isolation.js';
import { appServerHooks, CodexAppServer } from '../src/agents/app-server.js';
import { codexChatHooks, CodexChatSession } from '../src/agents/chat-session.js';

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
