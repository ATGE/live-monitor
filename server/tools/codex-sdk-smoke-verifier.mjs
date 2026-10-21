// Real SDK smoke evidence must be checked independently of the model's answer.
// Pure helper: tests can prove that a plausible text-only answer never passes.
export function verifyCodexSdkRead({ result, events, expected }) {
  if (!result?.ok) throw new Error(`Codex SDK turn failed: ${result?.error ?? 'unknown'}`);
  if (!/^codex:[a-zA-Z0-9-]{8,128}$/.test(result.sessionId ?? '')) {
    throw new Error('Codex SDK did not return a namespaced session ID');
  }
  if (!expected || typeof expected.name !== 'string' || typeof expected.scripts?.build !== 'string') {
    throw new Error('Local package.json lacks a project name or build script');
  }
  if (!Array.isArray(events)) throw new Error('SDK smoke lacks tool event evidence');
  if (events.some((e) => e.kind === 'tool' && e.name !== 'Bash')) {
    throw new Error('SDK smoke invoked a tool outside the permitted read-only shell');
  }

  const reads = events.filter((e) => e.kind === 'tool' && e.name === 'Bash'
    && e.id != null && /\bcat\s+(?:\.\/)?package\.json\b/.test(String(e.args?.command ?? e.input ?? '')));
  let verifiedRead = false;
  for (const read of reads) {
    for (const end of events.filter((e) => e.kind === 'tool_end' && e.id === read.id && e.name === 'Bash' && e.ok === true)) {
      let observed;
      try { observed = JSON.parse(String(end.output ?? '').trim()); } catch { continue; }
      if (observed?.name === expected.name && observed?.scripts?.build === expected.scripts.build) {
        verifiedRead = true;
        break;
      }
    }
    if (verifiedRead) break;
  }
  if (!verifiedRead) throw new Error('No successful cat package.json tool result matching the local file');

  const answer = String(result.resultText ?? '').trim().replace(/\r\n/g, '\n');
  const wanted = `PROJECT_NAME=${expected.name}\nBUILD_SCRIPT=${expected.scripts.build}`;
  if (answer !== wanted) throw new Error('Codex answer did not exactly match the verified package.json fields');
  return true;
}
