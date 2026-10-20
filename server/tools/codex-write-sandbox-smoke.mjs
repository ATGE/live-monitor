// E4b prerequisite, NOT production fix support.
// Verify Codex App Server workspace-write in a throwaway Git repository.
// Never run on Kovar, DeepTrade, or the caller's actual checkout.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodexChatSession } from '../src/agents/chat-session.js';

const worktree = mkdtempSync(path.join(os.tmpdir(), 'hfsmon-codex-qa-write-'));
const exec = (args) => execFileSync('git', args, { cwd: worktree, encoding: 'utf8', timeout: 15_000 }).trim();
let chat = null;
try {
  exec(['init', '-q']);
  writeFileSync(path.join(worktree, 'probe.txt'), 'CODEX_WRITE_INITIAL\n', { mode: 0o600 });
  writeFileSync(path.join(worktree, 'README.md'), '# Temporary sandbox smoke\n', { mode: 0o600 });
  exec(['add', '--', 'probe.txt', 'README.md']);
  exec(['-c', 'user.name=Codex QA', '-c', 'user.email=qa@example.invalid', 'commit', '-qm', 'baseline']);
  const initialHead = exec(['rev-parse', 'HEAD']);
  const events = [];
  let approvalRequests = 0;
  chat = new CodexChatSession({
    machine: { kind: 'local' }, cwd: worktree,
    permissionMode: 'bypassPermissions', // existing board label => *workspaceWrite*, never danger-full-access.
    idleMs: 0, onApproval: async () => { approvalRequests += 1; return { decision: 'decline' }; },
    onEvent: (e) => {
      events.push(e);
      if (e.kind === 'tool') console.log(`CODEX_WRITE_TOOL=${e.name}`);
    },
  });
  const result = await chat.send([
    'Only inside this temporary Git repository, change probe.txt so its entire content is',
    'exactly CODEX_WRITE_SUCCESS followed by one newline.',
    'Do not edit README.md or any other file, do not stage or commit,',
    'do not use network, MCP servers, or GitHub tools. Report what you did.',
  ].join(' '));
  const actual = readFileSync(path.join(worktree, 'probe.txt'), 'utf8');
  const changed = exec(['diff', '--name-only']);
  const status = exec(['status', '--porcelain', '--untracked-files=all']);
  const afterHead = exec(['rev-parse', 'HEAD']);
  const success = Boolean(
    result.ok &&
    result.sessionId?.startsWith('codex:') &&
    actual === 'CODEX_WRITE_SUCCESS\n' &&
    changed === 'probe.txt' &&
    status === ' M probe.txt' &&
    afterHead === initialHead &&
    events.some((e) => e.kind === 'tool_end' && e.ok && ['Edit', 'Bash'].includes(e.name)) &&
    approvalRequests === 0
  );
  if (!success) {
    console.error(`CODEX_WRITE_SMOKE=FAIL provider_ok=${Boolean(result.ok)} only_probe_changed=${changed === 'probe.txt'} commit_untouched=${afterHead === initialHead} approval_requests=${approvalRequests}`);
    if (result.error) console.error('CODEX_WRITE_ERROR=' + result.error);
    process.exitCode = 1;
  } else {
    console.log('CODEX_WRITE_SMOKE=PASS (throwaway repo, file edited, no commits, no approvals)');
  }
} catch (err) {
  console.error('CODEX_WRITE_SMOKE=FAIL ' + err.message);
  process.exitCode = 1;
} finally {
  chat?.close();
  // This exact directory was freshly created by mkdtempSync; never clean a
  // caller-provided directory. No data from the user's actual worktree is used.
  rmSync(worktree, { recursive: true, force: true });
}
