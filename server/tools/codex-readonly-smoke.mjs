// Run from the repository checkout: node server/tools/codex-readonly-smoke.mjs
// Does not enable polling, start Live Monitor or change a Git repository.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCodex } from '../src/agents/codex.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const r = await runCodex({
  machine: { kind: 'local' },
  cwd: root,
  prompt: 'Read the root package.json and identify the project name and the npm build command. Do not modify any file. Reply in two short sentences.',
  timeoutMs: 3 * 60_000,
  onEvent: (e) => {
    if (e.kind === 'init') console.log(`Codex SDK session: ${e.sessionId}`);
    if (e.kind === 'tool') console.log(`tool: ${e.name} ${e.input}`);
    if (e.kind === 'error') console.error(`Codex error: ${e.error}`);
  },
});
if (!r.ok) {
  console.error(`CODEX_SMOKE=FAIL ${r.error ?? 'empty response'}`);
  process.exitCode = 1;
} else {
  console.log(`CODEX_SMOKE=PASS\n${r.resultText}`);
}
