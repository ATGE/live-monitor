// Run from the repository checkout: node server/tools/codex-readonly-smoke.mjs
// Does not enable polling, start Live Monitor or change a Git repository.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCodex } from '../src/agents/codex.js';
import { verifyCodexSdkRead } from './codex-sdk-smoke-verifier.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const expected = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const events = [];
const r = await runCodex({
  machine: { kind: 'local' },
  cwd: root,
  prompt: 'This is a read-only workspace. Execute the shell command `cat package.json`. ' +
    'Only from its actual output, reply with exactly two lines, no Markdown: ' +
    'PROJECT_NAME=<the name field> and BUILD_SCRIPT=<the scripts.build field>. ' +
    'If shell execution fails, reply READ_UNAVAILABLE. Do not modify files.',
  timeoutMs: 3 * 60_000,
  onEvent: (e) => {
    events.push(e);
    if (e.kind === 'init') console.log(`Codex SDK session: ${e.sessionId}`);
    if (e.kind === 'tool') console.log(`tool: ${e.name} ${e.input}`);
    if (e.kind === 'error') console.error(`Codex error: ${e.error}`);
  },
});
try {
  verifyCodexSdkRead({ result: r, events, expected });
  console.log(`CODEX_SMOKE=PASS\n${r.resultText}`);
} catch (error) {
  console.error(`CODEX_SMOKE=FAIL ${error.message}`);
  process.exitCode = 1;
}
