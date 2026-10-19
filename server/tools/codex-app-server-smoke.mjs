// Native Linux smoke test: same user/login as the Live Monitor board.
// Run from the checkout: node server/tools/codex-app-server-smoke.mjs
// Safe plan/readOnly sandbox, no GitHub writes and no automatic approvals.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexChatSession } from '../src/agents/chat-session.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const chat = new CodexChatSession({
  machine: { kind: 'local' },
  cwd: root,
  permissionMode: 'plan',
  idleMs: 0,
  onEvent: (e) => {
    if (e.kind === 'init') console.log(`APP_SERVER_SESSION=${e.sessionId}`);
    if (e.kind === 'tool') console.log(`CODEX_TOOL=${e.name}`);
    if (e.kind === 'error') console.error(`CODEX_ERROR=${e.error}`);
  },
});
try {
  const first = await chat.send('Read package.json for the web package. Tell me the build command in one sentence. Do not change any file.');
  if (!first.ok) throw new Error(first.error || 'first turn failed');
  if (!first.sessionId?.startsWith('codex:')) throw new Error('missing namespaced thread id');
  const second = await chat.send('State the directory where the web package lives, based on our prior turn. Do not change any file.');
  if (!second.ok || second.sessionId !== first.sessionId) throw new Error(second.error || 'resume failed');
  console.log(`APP_SERVER_SMOKE=PASS\nTURN_1=${first.resultText}\nTURN_2=${second.resultText}`);
} catch (e) {
  console.error(`APP_SERVER_SMOKE=FAIL ${e.message}`);
  process.exitCode = 1;
} finally {
  chat.close();
}
