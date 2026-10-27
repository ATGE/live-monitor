// Acceptance gate for the *real* Codex App Server smoke. RPC success does
// not imply the model could read a file: the turn can complete after a sandbox
// failure and the model may respond with an apology.
export function verifyCodexRead({ result, events = [], expectedScript }) {
  if (!result?.ok) throw new Error(`Codex turn failed: ${result?.error ?? 'no result'}`);
  if (!result?.sessionId?.startsWith('codex:')) throw new Error('No Codex thread ID returned');
  if (typeof expectedScript !== 'string' || !expectedScript) throw new Error('Missing local build script fixture');
  const failures = events.filter((ev) => ev.kind === 'tool_end' && ev.name === 'Bash' && ev.ok === false);
  const outputs = events.filter((ev) => ev.kind === 'tool_end' && ev.name === 'Bash'
      && ev.ok === true && typeof ev.output === 'string').map((ev) => ev.output);
  if (!outputs.some((output) => output.includes(expectedScript))) {
    const hint = failures.length
      ? 'Codex commands failed inside the sandbox; check Bubblewrap/AppArmor and run codex sandbox linux /bin/true.'
      : 'No successful command returned the expected package.json build script.';
    throw new Error(`Codex did not prove it could read web/package.json. ${hint}`);
  }
  const reply = String(result.resultText ?? '').trim();
  if (!reply.split(/\r?\n/).some((line) => line.trim() === `BUILD_SCRIPT=${expectedScript}`)) {
    throw new Error('Codex did not return the exact BUILD_SCRIPT from web/package.json');
  }
  return true;
}

export function verifyCodexContinuation({ result, sessionId }) {
  if (!result?.ok) throw new Error(`Codex follow-up turn failed: ${result?.error ?? 'no result'}`);
  if (!sessionId || result.sessionId !== sessionId) throw new Error('Codex follow-up used a different thread ID');
  if (!String(result.resultText ?? '').split(/\r?\n/).some((line) => line.trim() === 'WEB_DIR=web')) {
    throw new Error('Codex did not correctly answer from the previous turn');
  }
  return true;
}
