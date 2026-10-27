// Fail-closed isolation policy for Codex App Server.
// Guarantees that external MCP servers configured in global operator settings
// (~/.codex/config.toml) or repository-local settings (<worktree>/.codex/config.toml)
// cannot be loaded by default, preventing unmonitored external tool execution.
// Preserves legitimate user authentication by symlinking auth.json without copying
// secret bytes to repositories or logs.

import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, lstatSync, realpathSync, writeFileSync, chmodSync, readlinkSync, renameSync, readdirSync, cpSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR } from '../config.js';

function normalizePath(p) {
  return p.replace(/\\/g, '/');
}

/**
 * Serializes a string into a TOML basic string literal (enclosed in double quotes),
 * with all quotes, backslashes, control characters, and DEL properly escaped.
 */
export function serializeTomlString(str) {
  if (typeof str !== 'string') {
    str = String(str);
  }
  return JSON.stringify(str).replace(/\u007f/g, '\\u007f');
}

/**
 * Serializes a TOML key: returns bare key if composed solely of [A-Za-z0-9_-],
 * otherwise returns a safely quoted and escaped TOML basic string.
 */
export function serializeTomlKey(key) {
  if (typeof key !== 'string') {
    throw new TypeError(`TOML key must be a string, received ${typeof key}`);
  }
  if (!key) {
    throw new Error('TOML key cannot be empty');
  }
  if (/^[A-Za-z0-9_-]+$/.test(key)) {
    return key;
  }
  return serializeTomlString(key);
}

/**
 * Serializes a dictionary of environment variables into a TOML inline table:
 * e.g. { DEBUG = "true", PORT = "9999" }
 *
 * Validates environment variable keys and values:
 * - Key must be a non-empty string adhering to POSIX identifier rules
 *   (letters, digits, underscores, not starting with a digit) without '=', '\0', or newlines.
 * - Value must be a scalar (string, number, boolean) without null bytes.
 * - Throws explicit, descriptive errors on any invalid key or value.
 */
export function serializeTomlInlineTable(obj) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new TypeError('Environment variables must be a plain object');
  }
  const entries = Object.entries(obj);
  if (entries.length === 0) {
    return '{}';
  }
  const pairs = [];
  for (const [rawKey, rawVal] of entries) {
    if (typeof rawKey !== 'string' || rawKey.length === 0) {
      throw new Error('Environment variable key must be a non-empty string');
    }
    if (rawKey.includes('\0') || /[\r\n]/.test(rawKey)) {
      throw new Error(`Invalid environment variable key ${JSON.stringify(rawKey)}: cannot contain newlines or null characters`);
    }
    if (rawKey.includes('=')) {
      throw new Error(`Invalid environment variable key ${JSON.stringify(rawKey)}: cannot contain "="`);
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(rawKey)) {
      throw new Error(`Invalid environment variable key ${JSON.stringify(rawKey)}: must start with a letter or underscore and contain only alphanumeric characters and underscores`);
    }

    if (rawVal === null || rawVal === undefined) {
      throw new TypeError(`Environment variable value for "${rawKey}" cannot be null or undefined`);
    }
    if (typeof rawVal === 'object' || typeof rawVal === 'function' || typeof rawVal === 'symbol') {
      throw new TypeError(`Environment variable value for "${rawKey}" must be a scalar, received ${typeof rawVal}`);
    }
    const strVal = String(rawVal);
    if (strVal.includes('\0')) {
      throw new Error(`Environment variable value for "${rawKey}" cannot contain null characters`);
    }

    const tomlKey = serializeTomlKey(rawKey);
    const tomlVal = serializeTomlString(strVal);
    pairs.push(`${tomlKey} = ${tomlVal}`);
  }
  return `{ ${pairs.join(', ')} }`;
}

// Active reference tracking per isolated home to ensure cleanup of one session
// NEVER deletes auth.json or invalidates credentials of another concurrently active session.
const activeIsolatedHomes = new Map();

export function retainCodexIsolatedHome(codexHome) {
  if (!codexHome) return;
  const count = activeIsolatedHomes.get(codexHome) ?? 0;
  activeIsolatedHomes.set(codexHome, count + 1);
}

export function releaseCodexIsolatedHome(codexHome) {
  if (!codexHome) return true;
  const current = activeIsolatedHomes.get(codexHome);
  if (current === undefined) return true;
  if (current <= 1) {
    activeIsolatedHomes.delete(codexHome);
    return true; // Last reference released; safe to remove sensitive artifacts
  }
  activeIsolatedHomes.set(codexHome, current - 1);
  return false; // Still active sessions using this runtime directory
}

export function getActiveCodexIsolatedHomesCount(codexHome) {
  return activeIsolatedHomes.get(codexHome) ?? 0;
}

function seedFromParentHome(sourceHome, targetHome) {
  try {
    const entries = readdirSync(sourceHome, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === 'auth.json' || entry.name === 'config.toml' || entry.name.startsWith('.config.toml.tmp')) {
        continue; // auth and config are generated fresh for targetHome
      }
      const srcPath = path.join(sourceHome, entry.name);
      const dstPath = path.join(targetHome, entry.name);
      if (!existsSync(dstPath)) {
        cpSync(srcPath, dstPath, { recursive: true });
      }
    }
  } catch { /* best effort seeding */ }
}

/**
 * Audit any external MCP servers defined in user or project configuration.
 */
export function auditCodexMcpConfiguration({ cwd = null, userCodexHome = null } = {}) {
  const home = userCodexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  const userConfigPath = path.join(home, 'config.toml');
  const userMcpServers = [];
  if (existsSync(userConfigPath)) {
    try {
      const content = readFileSync(userConfigPath, 'utf8');
      const matches = content.matchAll(/^\[mcp_servers\.(?:"([^"\\]*(?:\\.[^"\\]*)*)"|([A-Za-z0-9_-]+))\]/gm);
      for (const m of matches) {
        let name = m[2];
        if (m[1] !== undefined) {
          try {
            name = JSON.parse(`"${m[1]}"`);
          } catch {
            name = m[1];
          }
        }
        if (name) userMcpServers.push(name);
      }
    } catch { /* ignore read errors in audit */ }
  }

  const projectMcpServers = [];
  if (cwd) {
    const projectConfigPath = path.join(cwd, '.codex', 'config.toml');
    if (existsSync(projectConfigPath)) {
      try {
        const content = readFileSync(projectConfigPath, 'utf8');
        const matches = content.matchAll(/^\[mcp_servers\.(?:"([^"\\]*(?:\\.[^"\\]*)*)"|([A-Za-z0-9_-]+))\]/gm);
        for (const m of matches) {
          let name = m[2];
          if (m[1] !== undefined) {
            try {
              name = JSON.parse(`"${m[1]}"`);
            } catch {
              name = m[1];
            }
          }
          if (name) projectMcpServers.push(name);
        }
      } catch { /* ignore read errors in audit */ }
    }
  }

  return {
    userHome: home,
    userConfigPath,
    userMcpServers,
    projectMcpServers,
    isolatedByDefault: true,
    policy: 'fail-closed',
  };
}

/**
 * Prepares an isolated CODEX_HOME directory for Codex App Server execution.
 * - Enforces fail-closed isolation so no external MCPs are loaded by default.
 * - Symlinks auth.json so legitimate credentials remain valid without copying bytes.
 * - Validates existing symlink target to prevent pointing to stale or hijacked auth files.
 * - Explicitly marks active project/worktree paths untrusted in the isolated config
 *   so repository-level .codex/config.toml cannot inject MCPs or hooks.
 * - Preserves existing untrusted project entries across concurrent or sequential setups.
 * - Writes config.toml atomically to avoid race conditions during concurrent reads.
 * - Supports per-project and per-session runtime directory partitioning.
 * - Supports explicit opt-in policy via mcpPolicy.allowedMcpServers if configured.
 */
export function prepareCodexIsolatedHome({
  cwd = null,
  customCodexHome = null,
  mcpPolicy = null,
  dataDir = null,
  sessionId = null,
  projectId = null,
  taskId = null,
  planningId = null,
  forkFromHome = null,
} = {}) {
  let targetDir = customCodexHome;
  if (!targetDir) {
    const baseRuntime = process.env.CODEX_ISOLATION_DIR ?? path.join(dataDir ?? DATA_DIR, 'codex-runtime');
    if (planningId) {
      const safePlan = String(planningId).replace(/[^a-zA-Z0-9_.-]/g, '_');
      targetDir = path.join(baseRuntime, 'planning', safePlan);
    } else if (taskId) {
      const safeProject = String(projectId ?? 'global').replace(/[^a-zA-Z0-9_.-]/g, '_');
      const safeTask = String(taskId).replace(/[^a-zA-Z0-9_.-]/g, '_');
      const safeSession = String(sessionId ?? 'default').replace(/[^a-zA-Z0-9_.-]/g, '_');
      targetDir = path.join(baseRuntime, 'projects', safeProject, 'tasks', safeTask, 'sessions', safeSession);
    } else if (projectId && sessionId) {
      const safeProject = String(projectId).replace(/[^a-zA-Z0-9_.-]/g, '_');
      const safeSession = String(sessionId).replace(/[^a-zA-Z0-9_.-]/g, '_');
      targetDir = path.join(baseRuntime, 'projects', safeProject, 'sessions', safeSession);
    } else if (sessionId) {
      const safeSession = String(sessionId).replace(/[^a-zA-Z0-9_.-]/g, '_');
      targetDir = path.join(baseRuntime, 'sessions', safeSession);
    } else if (projectId) {
      const safeProject = String(projectId).replace(/[^a-zA-Z0-9_.-]/g, '_');
      targetDir = path.join(baseRuntime, 'projects', safeProject);
    } else {
      targetDir = baseRuntime;
    }
  }

  mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(targetDir, 0o700);
  } catch { /* ignore chmod error on platforms or filesystems that do not support it */ }

  // Seed history/state from parent home if this session was forked
  if (forkFromHome && existsSync(forkFromHome) && forkFromHome !== targetDir) {
    seedFromParentHome(forkFromHome, targetDir);
  }

  // Retain active session reference count on this directory
  retainCodexIsolatedHome(targetDir);

  // 1. Preserve legitimate authentication via symlink (zero copying of secret material)
  const sourceAuth = process.env.CODEX_AUTH_FILE
    ?? (process.env.CODEX_HOME ? path.join(process.env.CODEX_HOME, 'auth.json') : null)
    ?? path.join(os.homedir(), '.codex', 'auth.json');

  const targetAuth = path.join(targetDir, 'auth.json');
  if (existsSync(sourceAuth)) {
    let resolvedSource = sourceAuth;
    try {
      resolvedSource = realpathSync(sourceAuth);
    } catch { /* use raw sourceAuth if realpath fails */ }

    const stat = lstatSync(targetAuth, { throwIfNoEntry: false });
    let needsRelink = true;
    if (stat) {
      if (stat.isSymbolicLink()) {
        try {
          const currentDest = readlinkSync(targetAuth);
          let resolvedCurrent = currentDest;
          try {
            resolvedCurrent = realpathSync(targetAuth);
          } catch { /* broken symlink */ }
          if (currentDest === sourceAuth || resolvedCurrent === resolvedSource) {
            needsRelink = false;
          }
        } catch { /* error inspecting link */ }
      }
      if (needsRelink) {
        rmSync(targetAuth, { force: true });
      }
    }
    if (needsRelink) {
      symlinkSync(sourceAuth, targetAuth);
    }
  } else {
    // If sourceAuth does not exist, clean up any stale targetAuth
    const stat = lstatSync(targetAuth, { throwIfNoEntry: false });
    if (stat) {
      rmSync(targetAuth, { force: true });
    }
  }

  // 2. Generate isolated config.toml with fail-closed MCP policy
  const untrustedProjects = new Set();
  const targetConfig = path.join(targetDir, 'config.toml');

  // If config.toml already exists, preserve previously registered untrusted projects
  if (existsSync(targetConfig)) {
    try {
      const prevContent = readFileSync(targetConfig, 'utf8');
      const projMatches = prevContent.matchAll(/^\[projects\.(?:"([^"\\]*(?:\\.[^"\\]*)*)"|([A-Za-z0-9_-]+))\]\s*\ntrust_level\s*=\s*"untrusted"/gm);
      for (const m of projMatches) {
        let val = m[2];
        if (m[1] !== undefined) {
          try {
            val = JSON.parse(`"${m[1]}"`);
          } catch {
            val = m[1];
          }
        }
        if (val) untrustedProjects.add(val);
      }
    } catch { /* ignore read errors */ }
  }

  if (cwd) {
    if (typeof cwd === 'string' && cwd.includes('\0')) {
      throw new Error('Project path cannot contain null characters');
    }
    const normCwd = normalizePath(cwd);
    untrustedProjects.add(normCwd);
    try {
      const realCwd = normalizePath(realpathSync(cwd));
      if (realCwd) untrustedProjects.add(realCwd);
    } catch { /* if cwd does not yet exist or is virtual */ }
  }

  const configLines = [
    '# Generated by Live Monitor Codex fail-closed isolation policy.',
    '# Prevents external MCP servers from user or project configs from bypassing board controls.',
    'allow_symlinked_codex_home = true',
    '',
  ];

  for (const proj of untrustedProjects) {
    configLines.push(`[projects.${serializeTomlString(proj)}]`, 'trust_level = "untrusted"', '');
  }

  // If specific MCP servers are explicitly authorized via policy, configure only them
  if (mcpPolicy?.allowedMcpServers) {
    if (typeof mcpPolicy.allowedMcpServers !== 'object' || Array.isArray(mcpPolicy.allowedMcpServers)) {
      throw new TypeError('allowedMcpServers must be an object');
    }
    for (const [name, cfg] of Object.entries(mcpPolicy.allowedMcpServers)) {
      if (typeof name !== 'string' || !name.trim()) {
        throw new Error('MCP server name must be a non-empty string');
      }
      if (name.includes('\0') || /[\r\n]/.test(name)) {
        throw new Error(`Invalid MCP server name ${JSON.stringify(name)}: cannot contain newlines or null characters`);
      }
      if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
        throw new TypeError(`Configuration for MCP server "${name}" must be an object`);
      }
      if (typeof cfg.command !== 'string' || !cfg.command.trim()) {
        throw new Error(`MCP server "${name}" must specify a non-empty string command`);
      }
      if (cfg.command.includes('\0') || /[\r\n]/.test(cfg.command)) {
        throw new Error(`MCP server "${name}" command cannot contain newlines or null characters`);
      }

      const mcpKey = serializeTomlKey(name);
      configLines.push(`[mcp_servers.${mcpKey}]`);
      configLines.push(`command = ${serializeTomlString(cfg.command)}`);

      if (cfg.args !== undefined) {
        if (!Array.isArray(cfg.args)) {
          throw new TypeError(`MCP server "${name}" args must be an array`);
        }
        const serializedArgs = cfg.args.map((arg, idx) => {
          if (typeof arg !== 'string' && typeof arg !== 'number' && typeof arg !== 'boolean') {
            throw new TypeError(`MCP server "${name}" arg at index ${idx} must be a scalar, received ${typeof arg}`);
          }
          const str = String(arg);
          if (str.includes('\0')) {
            throw new Error(`MCP server "${name}" arg at index ${idx} cannot contain null characters`);
          }
          return serializeTomlString(str);
        });
        configLines.push(`args = [${serializedArgs.join(', ')}]`);
      }

      if (cfg.env !== undefined) {
        configLines.push(`env = ${serializeTomlInlineTable(cfg.env)}`);
      }

      configLines.push('');
    }
  }

  // Atomic file write using renameSync to prevent race conditions during concurrent reads
  const tmpConfig = path.join(targetDir, `.config.toml.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`);
  writeFileSync(tmpConfig, configLines.join('\n'), 'utf8');
  renameSync(tmpConfig, targetConfig);

  return {
    codexHome: targetDir,
    configPath: targetConfig,
    env: { ...process.env, CODEX_HOME: targetDir },
  };
}

/**
 * Safely cleans up sensitive artifacts (such as the auth.json symlink)
 * from an isolated Codex runtime directory when a session terminates.
 * Respects active session reference counts to ensure concurrent sessions
 * sharing a directory are NEVER stripped of their credentials.
 */
export function cleanupCodexIsolatedHome({ codexHome = null, removeAuth = true, force = false } = {}) {
  if (!codexHome) return;
  if (!force) {
    const canClean = releaseCodexIsolatedHome(codexHome);
    if (!canClean) {
      // Other sessions are still actively using this codexHome.
      return;
    }
  }
  if (removeAuth) {
    const targetAuth = path.join(codexHome, 'auth.json');
    try {
      const stat = lstatSync(targetAuth, { throwIfNoEntry: false });
      if (stat) {
        rmSync(targetAuth, { force: true });
      }
    } catch { /* best effort cleanup */ }
  }
}
