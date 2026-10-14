/**
 * A subagent's own transcript, read back.
 *
 * The CLI writes every subagent's thread to its own file, next to the
 * session's: `~/.claude/projects/<cwd as a slug>/<session>/subagents/
 * agent-<agentId>.jsonl`, with a `.meta.json` naming the tool call that
 * launched it. That file is complete even when the stream to the board was
 * not, so it is how the panel recovers calls it never received and loads the
 * ones that scrolled out of the history.
 *
 * Pure here: text in, calls out, and candidate paths. The machine's file
 * system is the caller's.
 */
import { summarizeToolInput } from './claude.js';
import { tail, MAX_OUTPUT } from './activity.js';

// Same list as `activity.js`: a call read back from a transcript must be drawn
// the way the live stream drew it, delegate included.
const AGENT_TOOLS = new Set(['Agent', 'Task', 'mcp__opencode__delegate']);
const kindOf = (name) => (name === 'Bash' ? 'bash' : AGENT_TOOLS.has(name) ? 'agent' : 'tool');

/** How the CLI names a project's directory: every non-alphanumeric becomes `-`. */
export const projectSlug = (cwd) => String(cwd ?? '').replace(/[^A-Za-z0-9]/g, '-');

/**
 * Where the transcript may be. The slug keeps the case of the path as the
 * CLI was given it, and a Windows drive letter comes either way; both are
 * tried. `join` is the machine's path join (win32 locally, posix on a box).
 */
export function transcriptCandidates({ home, cwd, sessionIds, agentId, join }) {
  const slug = projectSlug(cwd);
  const slugs = [...new Set([slug, slug.charAt(0).toLowerCase() + slug.slice(1), slug.charAt(0).toUpperCase() + slug.slice(1)])];
  const out = [];
  for (const s of slugs) {
    for (const session of sessionIds.filter(Boolean)) {
      out.push(join(home, '.claude', 'projects', s, session, 'subagents', `agent-${agentId}.jsonl`));
    }
  }
  return out;
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (b?.type === 'text' ? b.text : '')).filter(Boolean).join('\n');
}

/**
 * The calls in a subagent's transcript, in the shape the activity tree uses.
 * A call with no result yet is `running` while its agent runs, `stopped` once
 * it does not.
 */
export function parseAgentTranscript(text, { agentRunning = false } = {}) {
  const calls = new Map();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    const content = Array.isArray(j.message?.content) ? j.message.content : [];
    for (const b of content) {
      if (b?.type === 'tool_use' && b.id) {
        const kind = kindOf(b.name);
        const call = {
          id: b.id, kind, name: b.name,
          summary: summarizeToolInput({ name: b.name, input: b.input ?? {} }) ?? '',
          status: agentRunning ? 'running' : 'stopped',
          startedAt: j.timestamp ?? null,
          fromTranscript: true,
        };
        if (kind === 'bash') {
          call.command = String(b.input?.command ?? '');
          if (b.input?.run_in_background === true) call.background = true;
        }
        calls.set(b.id, call);
      } else if (b?.type === 'tool_result' && b.tool_use_id) {
        const call = calls.get(b.tool_use_id);
        if (!call) continue;
        const std = j.toolUseResult && typeof j.toolUseResult === 'object' && ('stdout' in j.toolUseResult || 'stderr' in j.toolUseResult)
          ? `${j.toolUseResult.stdout ?? ''}${j.toolUseResult.stderr ? `\n[stderr]\n${j.toolUseResult.stderr}` : ''}`
          : null;
        call.output = tail(std ?? resultText(b.content), MAX_OUTPUT);
        call.status = b.is_error ? 'error' : 'done';
        call.endedAt = j.timestamp ?? null;
      }
    }
  }
  return [...calls.values()];
}
