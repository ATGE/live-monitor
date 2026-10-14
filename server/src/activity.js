/**
 * What a chat turn did, as a tree the panel can draw: every tool call, what it
 * answered, each subagent with the calls it made inside its own thread, and
 * the commands sent to the background with their output as it lands.
 *
 * Nothing here was visible before — not because it was hidden, but because it
 * was not collected: the board read a turn's text and its tool *names*, threw
 * away every tool result, and showed one transient line that each new call
 * overwrote. So "what is that subagent doing?" had to be asked in the chat.
 *
 * One activity message per turn, updated in place: a turn with two hundred
 * tool calls stays one entry in the history instead of eating a third of the
 * chat's 600-message cap. Outputs keep their tail, bounded, because a test
 * suite's log is the end that matters and 8 KB of it is plenty to read.
 *
 * Pure: events in, items out. The SDK, the store and the socket live elsewhere.
 */

export const MAX_OUTPUT = 8 * 1024;
export const MAX_AGENT_TEXT = 4 * 1024;
/** Past this a turn's tree stops growing; the header says how many were dropped. */
export const MAX_ITEMS = 300;
/**
 * A subagent's calls are bounded per agent instead: one agent made 142 calls
 * on #937, and a shared cap would have silenced everything after it. The
 * oldest scroll out and are counted; the panel loads them from the
 * subagent's own transcript on demand.
 */
export const MAX_AGENT_CHILDREN = 100;

/**
 * A background command that has written nothing for this long is treated as a
 * server even if its text says nothing about ports: ten minutes of silence is
 * what a listening process looks like from the outside, and what no build,
 * test run or migration looks like.
 */
export const SERVER_QUIET_MS = 10 * 60 * 1000;

/** Nothing ever estimates less than a minute left: a spinner at 0 is a lie. */
const MIN_REMAINING_MS = 60 * 1000;

// The delegate is an agent too: it runs a whole Claude Code session of its
// own, and its events arrive under the tool call that launched it.
const AGENT_TOOLS = new Set(['Agent', 'Task', 'mcp__opencode__delegate']);

/** For an agent, the end of the road — however it got there. */
const FINISHED = new Set(['done', 'error', 'stopped']);

const PORT_MIN = 1024;
const PORT_MAX = 65535;

/** Serves something: reason enough to read a bare number as its port. */
const SERVES_RE = /\bserve\b|server|listen|http\.server/i;
/** The same, plus the two shapes that only ever appear on something long-lived. */
const SERVER_CMD_RE = /\bserve\b|server|listen|http\.server|--port|while\s+true/i;
/**
 * Commands that talk *to* a port instead of opening one. They carry the same
 * `:18002` a server would, so the port alone cannot tell them apart — the verb
 * can. `curl http://127.0.0.1:18002/health` is a request that ends; only going
 * quiet for `SERVER_QUIET_MS` makes it look like a server, and that is the
 * honest answer for a `curl` that never came back.
 */
const CLIENT_RE = /^(?:[A-Za-z_]\w*=\S+\s+)*(?:sudo\s+)?(?:curl|wget|xh|httpie|http|Invoke-WebRequest|iwr|nc|telnet)\b/i;

const inRange = (n) => (Number.isInteger(n) && n >= PORT_MIN && n <= PORT_MAX ? n : null);

/**
 * The port a command appears to open, or null. Purely lexical: it reads the
 * number, it does not judge who is on which end of it — `isServerLike` does
 * that. A number outside the unprivileged range is not a port we track.
 */
export function listeningPort(command) {
  const s = String(command ?? '');
  const take = (re) => { const m = re.exec(s); return m ? inRange(Number(m[1])) : null; };
  return take(/--port[= ]\s*(\d{2,5})\b/)
    ?? take(/(?:^|\s)-p[= ]?\s*(\d{2,5})\b/)
    ?? take(/\bhttps?:\/\/(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\]):(\d{2,5})/i)
    ?? take(/(?:^|\s):(\d{2,5})\b/)
    // `node serve.js dist 18003`: the port is just the last word, and only a
    // command that already says it serves earns that reading.
    ?? (SERVES_RE.test(s) ? take(/(?:^|\s)(\d{4,5})(?=\s|$)/) : null);
}

/**
 * True for a background command that will not end on its own — a server. The
 * board draws those differently: no estimate, and a stop button instead of a
 * spinner that would turn forever.
 */
export function isServerLike(item, now = Date.now()) {
  if (!item || item.kind !== 'bash' || !item.background) return false;
  if (item.status !== 'running' && item.status !== 'stopping') return false;
  const since = Date.parse(item.outputChangedAt ?? item.startedAt ?? '');
  if (Number.isFinite(since) && now - since >= SERVER_QUIET_MS) return true;
  const command = String(item.command ?? '');
  if (CLIENT_RE.test(command.trimStart())) return false;
  return SERVER_CMD_RE.test(command) || item.port != null;
}

/**
 * Says a stop was asked for, so the card can stop offering the button without
 * pretending the command is already gone. The task's own end event closes it
 * for real, exactly as it closes a running one.
 */
export function markStopping(activity, itemId, now = Date.now()) {
  const item = byId(activity?.items ?? [], itemId);
  if (!item) return null;
  item.status = 'stopping';
  item.stopRequestedAt = new Date(now).toISOString();
  return item;
}

/**
 * How a wave of subagents is doing, and how long the wave still has.
 *
 * They run at once, so what is left is the laggard's remainder, not the sum:
 * five agents with four minutes each to go finish in four minutes, not twenty.
 * Until one has finished there is no mean to guess from, and saying nothing
 * beats saying a number nobody measured.
 */
export function groupProgress(activity, now = Date.now()) {
  const agents = (activity?.items ?? []).filter((i) => i.kind === 'agent');
  const finished = agents.filter((i) => FINISHED.has(i.status));
  const running = agents.filter((i) => i.status === 'running');

  const spans = finished
    .map((i) => Date.parse(i.endedAt) - Date.parse(i.startedAt))
    .filter((ms) => Number.isFinite(ms) && ms >= 0);
  const meanMs = spans.length ? Math.round(spans.reduce((a, b) => a + b, 0) / spans.length) : null;

  let remainingMs = null;
  if (meanMs != null && running.length) {
    remainingMs = Math.max(...running.map((i) => {
      const elapsed = now - Date.parse(i.startedAt);
      return Math.max(MIN_REMAINING_MS, meanMs - (Number.isFinite(elapsed) ? elapsed : 0));
    }));
  }
  return { total: agents.length, done: finished.length, running: running.length, meanMs, remainingMs };
}

export function newActivity(id, now = Date.now()) {
  return { role: 'activity', id, ts: new Date(now).toISOString(), items: [], dropped: 0 };
}

/** The end of a text, when only the end fits. */
export function tail(text, max = MAX_OUTPUT) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  return `…${s.slice(s.length - max + 1)}`;
}

/**
 * The published links in an `Artifact` result: https URLs on claude.ai or its
 * subdomains, once each, capped. Taken from the full output, because `tail`
 * keeps only the end of it.
 */
const MAX_LINKS = 10;
export function artifactLinks(text) {
  const out = [];
  for (const m of String(text ?? '').matchAll(/https:\/\/[^\s<>()[\]"'`|]+/g)) {
    const url = m[0].replace(/[.,;:]+$/, '');
    let host;
    try { host = new URL(url).hostname; } catch { continue; }
    if (host !== 'claude.ai' && !host.endsWith('.claude.ai')) continue;
    if (!out.includes(url)) out.push(url);
    if (out.length >= MAX_LINKS) break;
  }
  return out;
}

/** Depth-first lookup, because a subagent's calls hang under its own item. */
export function findItem(items, predicate) {
  for (const item of items) {
    if (predicate(item)) return item;
    const inner = item.children ? findItem(item.children, predicate) : null;
    if (inner) return inner;
  }
  return null;
}

const byId = (items, id) => (id ? findItem(items, (i) => i.id === id) : null);
const byTask = (items, taskId) => (taskId ? findItem(items, (i) => i.taskId === taskId) : null);

function countItems(items) {
  return items.reduce((n, i) => n + 1 + (i.children ? countItems(i.children) : 0), 0);
}

function kindOf(name) {
  if (name === 'Bash') return 'bash';
  if (AGENT_TOOLS.has(name)) return 'agent';
  return 'tool';
}

/**
 * Applies one session event and says which item changed — the caller sends
 * that item alone over the wire, not the whole tree. Returns null when the
 * event touched nothing the panel shows.
 */
export function applyEvent(activity, ev, now = Date.now()) {
  const { items } = activity;
  switch (ev.kind) {
    case 'tool': {
      const parent = byId(items, ev.parentId);
      const underAgent = parent?.kind === 'agent';
      if (!underAgent && countItems(items) >= MAX_ITEMS) { activity.dropped += 1; return null; }
      const kind = kindOf(ev.name);
      const item = {
        id: ev.id,
        kind,
        name: ev.name,
        summary: ev.input ?? '',
        status: 'running',
        startedAt: new Date(now).toISOString(),
      };
      if (kind === 'bash') {
        item.command = String(ev.args?.command ?? '');
        if (ev.args?.run_in_background === true) goesBackground(item);
      }
      if (kind === 'agent') {
        // The delegate names no subagent type; what it delegates to is the name.
        item.subagentType = ev.args?.subagent_type ?? (ev.name === 'mcp__opencode__delegate' ? 'opencode' : null);
        item.children = [];
        item.text = '';
      }
      // A subagent's call hangs under it; anything else — including a call
      // whose parent we never saw — sits at the top so it is never lost.
      const list = parent?.children ?? items;
      list.push(item);
      if (underAgent && parent.children.length > MAX_AGENT_CHILDREN) {
        const out = parent.children.length - MAX_AGENT_CHILDREN;
        parent.children.splice(0, out);
        parent.hiddenChildren = (parent.hiddenChildren ?? 0) + out;
        // The whole agent goes over the wire, so the panel drops the oldest too.
        return { item: parent, parentId: parentOf(items, parent) };
      }
      return { item, parentId: parent?.id ?? null };
    }

    case 'tool_end': {
      const item = byId(items, ev.id);
      if (!item) return null;
      // The CLI refused the call — `claude.js` flags it, and says so in the log
      // besides. Nothing ran, so none of the shapes below apply: a denied
      // launch has no background life and no report to wait for, and left
      // `running` it would spin in the panel for ever.
      if (ev.denied) {
        item.denied = true;
        item.output = tail(ev.output ?? '');
        finish(item, 'error', now);
        return { item, parentId: parentOf(items, item) };
      }
      const structured = ev.structured && typeof ev.structured === 'object' && !Array.isArray(ev.structured)
        ? ev.structured : null;

      if (item.kind === 'agent' && structured?.isAsync) {
        // The call only *launched* the agent; it lives on as a task and its
        // report arrives with `task_done`. The launch text is noise.
        if (structured.outputFile) item.outputFile = structured.outputFile;
        return { item, parentId: parentOf(items, item) };
      }
      if (item.kind === 'bash' && structured && ('stdout' in structured || 'stderr' in structured)) {
        item.output = tail(joinStd(structured.stdout, structured.stderr));
        if (structured.backgroundTaskId) {
          goesBackground(item);
          item.taskId = structured.backgroundTaskId;
        }
      } else if (item.kind === 'agent' && Array.isArray(structured?.content)) {
        item.output = tail(structured.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n'));
      } else {
        item.output = tail(ev.output ?? '');
      }
      if (/^Artifact(Comments|Data)?$/.test(item.name)) {
        const links = artifactLinks(`${ev.output ?? ''}\n${structured?.url ?? ''}`);
        if (links.length) item.links = links;
      }
      if (item.background) {
        // "Command running in background… Output is being written to: <file>"
        const m = /written to:\s*(.+?)\s*$/m.exec(ev.output ?? '');
        if (m) item.outputFile = m[1];
        // Still running: the task's own notification closes it.
        return { item, parentId: parentOf(items, item) };
      }
      finish(item, ev.ok ? 'done' : 'error', now);
      return { item, parentId: parentOf(items, item) };
    }

    case 'progress': {
      const item = byId(items, ev.id);
      if (!item) return null;
      item.elapsed = ev.elapsed;
      return { item, parentId: parentOf(items, item) };
    }

    case 'text': {
      // Only a subagent's narrative lands here; the main thread's text is a
      // chat message of its own.
      const item = byId(items, ev.parentId);
      if (!item || item.kind !== 'agent') return null;
      item.text = tail(`${item.text ?? ''}${item.text ? '\n' : ''}${ev.text}`, MAX_AGENT_TEXT);
      return { item, parentId: parentOf(items, item) };
    }

    case 'task_started': {
      const item = byId(items, ev.toolUseId);
      if (item) {
        item.taskId = ev.taskId;
        if (ev.background) goesBackground(item);
        return { item, parentId: parentOf(items, item) };
      }
      if (countItems(items) >= MAX_ITEMS) { activity.dropped += 1; return null; }
      const fresh = {
        id: `task:${ev.taskId}`,
        kind: 'background',
        name: ev.taskType ?? 'task',
        summary: ev.description ?? '',
        status: 'running',
        taskId: ev.taskId,
        background: true,
        startedAt: new Date(now).toISOString(),
      };
      items.push(fresh);
      return { item: fresh, parentId: null };
    }

    case 'task_progress': {
      const item = byTask(items, ev.taskId) ?? byId(items, ev.toolUseId);
      if (!item) return null;
      item.progress = ev.summary || ev.description || ev.lastTool || null;
      return { item, parentId: parentOf(items, item) };
    }

    case 'task_done': {
      const item = byTask(items, ev.taskId) ?? byId(items, ev.toolUseId);
      if (!item) return null;
      if (item.kind === 'agent') {
        // The subagent's final report, which is the thing worth reading.
        item.output = tail(ev.summary ?? '');
      } else if (ev.summary && !item.output) {
        item.output = tail(ev.summary);
      }
      if (ev.outputFile) item.outputFile = ev.outputFile;
      item.progress = null;
      finish(item, { completed: 'done', failed: 'error', stopped: 'stopped' }[ev.status] ?? 'done', now);
      return { item, parentId: parentOf(items, item) };
    }

    default:
      return null;
  }
}

/**
 * Replaces a background item's output with what its file holds now, and stamps
 * *when* it last actually changed. Re-reading the same tail is not a change:
 * that stamp is the only evidence the board has that a command still has
 * something to say, and it is what tells a slow build from a server.
 */
export function setOutput(activity, id, output, now = Date.now()) {
  const item = byId(activity.items, id);
  if (!item) return null;
  const text = tail(output);
  if (text !== item.output) {
    item.output = text;
    item.outputChangedAt = new Date(now).toISOString();
  }
  return { item, parentId: parentOf(activity.items, item) };
}

/**
 * A command that turned out to run in the background. Its port is read here
 * and only here: the command line never changes afterwards, and a value on
 * the item saves every later caller from parsing it again.
 */
function goesBackground(item) {
  item.background = true;
  if (item.kind === 'bash' && item.port === undefined) item.port = listeningPort(item.command);
}

/** Everything still running when the session dies is marked so, not left spinning. */
export function closeAll(activity, status = 'stopped', now = Date.now()) {
  const changed = [];
  const walk = (list) => {
    for (const item of list) {
      // A stop that was asked for and never arrived ends here too.
      if (item.status === 'running' || item.status === 'stopping') { finish(item, status, now); changed.push(item); }
      if (item.children) walk(item.children);
    }
  };
  walk(activity.items);
  return changed;
}

function finish(item, status, now) {
  item.status = status;
  item.endedAt = new Date(now).toISOString();
  item.elapsed = undefined;
}

function parentOf(items, item) {
  const parent = findItem(items, (i) => i.children?.includes(item));
  return parent?.id ?? null;
}

function joinStd(stdout, stderr) {
  const out = String(stdout ?? '');
  const err = String(stderr ?? '').trim();
  if (!err) return out;
  return out.trim() ? `${out.trimEnd()}\n[stderr]\n${err}` : `[stderr]\n${err}`;
}

/** Counts for the collapsed header, and the running item worth naming. */
export function summarize(activity) {
  const all = [];
  const walk = (list) => { for (const i of list) { all.push(i); if (i.children) walk(i.children); } };
  walk(activity.items);

  const agents = all.filter((i) => i.kind === 'agent');
  const background = all.filter((i) => i.background && i.kind !== 'agent');
  const running = all.filter((i) => i.status === 'running');
  return {
    tools: all.length,
    agents: {
      total: agents.length,
      running: agents.filter((i) => i.status === 'running').length,
      done: agents.filter((i) => i.status !== 'running').length,
    },
    background: background.length,
    running: running.length,
    // Innermost first: "Read x.rs" inside an agent says more than "Agent".
    current: running.length ? running[running.length - 1] : null,
    dropped: activity.dropped,
  };
}

/**
 * The tree an event belongs to. A subagent or a background command outlives
 * the turn that launched it, so its later events must land on the tree that
 * holds it — not on whatever turn is open now, and not nowhere when none is.
 *
 * A subagent's own calls are new items: their id matches nothing yet. What
 * ties them to their tree is `parentId`, the agent's call. Matching only by
 * the event's own id is how #937 kept 7 of an agent's 142 calls: the rest
 * arrived after the launching turn ended and were dropped, or landed in a
 * later turn's tree as if the main thread had made them.
 */
export function treeFor(liveTree, trees, ev) {
  const keys = [
    ev.taskId && ((i) => i.taskId === ev.taskId),
    ev.toolUseId && ((i) => i.id === ev.toolUseId),
    ev.id && ((i) => i.id === ev.id),
    ev.parentId && ((i) => i.id === ev.parentId),
  ].filter(Boolean);
  const hit = (tree) => Boolean(tree && keys.length && findItem(tree.items ?? [], (i) => keys.some((k) => k(i))));
  if (hit(liveTree)) return liveTree;
  for (let n = trees.length - 1; n >= 0; n -= 1) {
    if (hit(trees[n])) return trees[n];
  }
  return liveTree;
}

/**
 * Folds calls read from a subagent's transcript into its item: the ones the
 * stream never delivered are added, running ones the transcript shows
 * finished are closed, and only the last `keep` stay in the history — the
 * rest are counted, and loadable again from the transcript.
 */
export function mergeAgentCalls(agent, calls, { keep = MAX_AGENT_CHILDREN } = {}) {
  const byCallId = new Map((agent.children ?? []).map((c) => [c.id, c]));
  // What the agent already accounted for: the calls in view and the ones that
  // scrolled out. Only past that is anything new — otherwise every reopening
  // would report the hidden ones as recovered again.
  const knownBefore = byCallId.size + (agent.hiddenChildren ?? 0);
  for (const call of calls) {
    const known = byCallId.get(call.id);
    if (!known) { byCallId.set(call.id, call); continue; }
    // The transcript stamps the moment of the call; the stream only when the
    // board received it. Order follows the transcript.
    if (call.startedAt) known.startedAt = call.startedAt;
    if (known.status === 'running' && call.status !== 'running') {
      known.status = call.status;
      known.endedAt = call.endedAt;
      if (!known.output && call.output) known.output = call.output;
    }
  }
  const all = [...byCallId.values()].sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
  const kept = all.slice(-keep);
  agent.children = kept;
  agent.hiddenChildren = all.length - kept.length;
  return { added: Math.max(0, all.length - knownBefore), total: all.length, hidden: agent.hiddenChildren };
}

/** The one-line label for the tab and the card while a turn runs. */
export function activityLabel(activity) {
  const s = summarize(activity);
  const parts = [];
  if (s.agents.total) parts.push(`🤖 ${s.agents.total} subagente${s.agents.total === 1 ? '' : 's'}${s.agents.running ? ` (${s.agents.running} en curso)` : ''}`);
  if (s.current) parts.push(`${s.current.name}: ${s.current.summary}`.slice(0, 100));
  return parts.join(' · ');
}
