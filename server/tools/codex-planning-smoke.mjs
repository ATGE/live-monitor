// Real read-only E4 plan smoke (not a mock).
// Requires "codex login status" already authenticated in the Ubuntu VM.
// No GitHub writes, no automatic approvals, and refuses an unclean checkout.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTaskAgent } from '../src/agents/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const status = () => execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], {
  cwd: root, encoding: 'utf8', timeout: 10_000,
}).trim();
const before = status();
if (before) {
  console.error('CODEX_PLAN_SMOKE=FAIL Refusing to test on a checkout with uncommitted files');
  process.exitCode = 1;
} else {
  const events = [];
  const cfg = {
    agents: {
      phases: { plan: 'codex' },
      codex: { reasoningEffort: 'medium', timeoutMinutes: 5 },
    },
  };
  const result = await runTaskAgent({
    machine: { kind: 'local' },
    cwd: root,
    prompt: [
      'Read-only planning exercise. Run a shell command to read web/package.json.',
      'Create a concise implementation plan to verify the existing Vite web build without editing files.',
      'The final answer MUST include the exact line BUILD_SCRIPT=<value from scripts.build>',
      'and a separate exact line CODEX_PLAN_SMOKE_OK. If your shell command was denied,',
      'report CODEX_PLAN_SMOKE_FAILED instead. Do not modify any file or contact GitHub.',
    ].join(' '),
    onEvent: (event) => {
      events.push(event);
      if (event.kind === 'init') console.log(`CODEX_PLAN_SESSION=${event.sessionId}`);
      if (event.kind === 'tool') console.log(`CODEX_PLAN_TOOL=${event.name}`);
    },
  }, { stage: 'plan', cfg });
  const after = status();
  const stdout = String(result.resultText ?? '');
  const ok = Boolean(
    result.ok && result.sessionId?.startsWith('codex:') &&
    stdout.split(/\r?\n/).some((line) => line.trim() === 'BUILD_SCRIPT=vite build') &&
    stdout.split(/\r?\n/).some((line) => line.trim() === 'CODEX_PLAN_SMOKE_OK') &&
    events.some((ev) => ev.kind === 'tool_end' && ev.name === 'Bash' && ev.ok &&
      String(ev.output ?? '').includes('vite build')) &&
    before === after
  );
  if (ok) {
    console.log('CODEX_PLAN_SMOKE=PASS');
  } else {
    console.error(`CODEX_PLAN_SMOKE=FAIL provider_ok=${Boolean(result.ok)} file_evidence=${events.some((e) => e.kind === 'tool_end' && e.name === 'Bash' && e.ok && String(e.output ?? '').includes('vite build'))} worktree_unchanged=${before === after}`);
    if (result.error) console.error('CODEX_PLAN_ERROR=' + result.error);
    process.exitCode = 1;
  }
}
