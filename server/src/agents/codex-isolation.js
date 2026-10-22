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
      const matches = content.matchAll(/^\[mcp_servers\.([^\]\s]+)\]/gm);
      for (const m of matches) {
        userMcpServers.push(m[1]);
      }
    } catch { /* ignore read errors in audit */ }
  }

  const projectMcpServers = [];
  if (cwd) {
    const projectConfigPath = path.join(cwd, '.codex', 'config.toml');
    if (existsSync(projectConfigPath)) {
      try {
        const content = readFileSync(projectConfigPath, 'utf8');
        const matches = content.matchAll(/^\[mcp_servers\.([^\]\s]+)\]/gm);
        for (const m of matches) {
          projectMcpServers.push(m[1]);
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
      const projMatches = prevContent.matchAll(/^\[projects\."([^"]+)"\]\s*\ntrust_level\s*=\s*"untrusted"/gm);
      for (const m of projMatches) {
        untrustedProjects.add(m[1]);
      }
    } catch { /* ignore read errors */ }
  }

  if (cwd) {
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
    configLines.push(`[projects."${proj}"]`, 'trust_level = "untrusted"', '');
  }

  // If specific MCP servers are explicitly authorized via policy, configure only them
  if (mcpPolicy?.allowedMcpServers && typeof mcpPolicy.allowedMcpServers === 'object') {
    for (const [name, cfg] of Object.entries(mcpPolicy.allowedMcpServers)) {
      if (!cfg || typeof cfg !== 'object' || !cfg.command) continue;
      configLines.push(`[mcp_servers.${name}]`);
      configLines.push(`command = ${JSON.stringify(cfg.command)}`);
      if (Array.isArray(cfg.args)) {
        configLines.push(`args = ${JSON.stringify(cfg.args)}`);
      }
      if (cfg.env && typeof cfg.env === 'object') {
        configLines.push(`env = ${JSON.stringify(cfg.env)}`);
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
