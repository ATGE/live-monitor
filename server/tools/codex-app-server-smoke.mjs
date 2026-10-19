// Native Linux smoke test: same user/login as the Live Monitor board.
// Protocol success is NOT sufficient. Codex must actually read web/package.json.
// No GitHub writes, no automatically granted sandbox escalation.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexChatSession } from '../src/agents/chat-session.js';
import { verifyCodexRead, verifyCodexContinuation } from './codex-smoke-verifier.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const webPackage = JSON.parse(readFileSync(path.join(root, 'web/package.json'), 'utf8'));
const expectedScript = webPackage.scripts?.build;
if (typeof expectedScript !== 'string' || !expectedScript) {
  throw new Error('Local web/package.json has no build script to verify');
}
const events = [];
const chat = new CodexChatSession({
  machine: { kind: 'local' },
  cwd: root,
  permissionMode: 'plan',
  idleMs: 0,
  onEvent: (ev) => {
    events.push(ev);
    if (ev.kind === 'init') console.log(`APP_SERVER_SESSION=${ev.sessionId}`);
    if (ev.kind === 'tool') console.log(`CODEX_TOOL=${ev.name}`);
    if (ev.kind === 'error') console.error(`CODEX_ERROR=${ev.error}`);
  },
});
try {
  const first = await chat.send(
    'This is a read-only environment. Run the shell command `cat web/package.json`. ' +
    'Using ONLY its actual command output, return the exact build script ' +
    'on one line as BUILD_SCRIPT=<script value>. ' +
    'If the shell tool fails or is denied, say BUILD_SCRIPT_UNAVAILABLE instead. Do not edit files.'
  );
  verifyCodexRead({ result: first, events, expectedScript });
  const second = await chat.send(
    'Based on the previous successful inspection, what folder contained package.json? ' +
    'Reply using exactly one line WEB_DIR=<relative directory>. Do not run commands or edit files.'
  );
  verifyCodexContinuation({ result: second, sessionId: first.sessionId });
  console.log(`APP_SERVER_SMOKE=PASS\nTURN_1=${first.resultText}\nTURN_2=${second.resultText}`);
} catch (e) {
  console.error(`APP_SERVER_SMOKE=FAIL ${e.message}`);
  process.exitCode = 1;
} finally {
  chat.close();
}
