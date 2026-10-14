#!/usr/bin/env node
// Exp 5 - the chat-shaped denial: does it still happen?
//
// The chat form's signature is a pair of user prompts delivered a few tens of
// milliseconds apart with a turn already running, and the turn's first tool
// calls denied with kind `cancelled`. This streams every CLI transcript on the
// machine and measures three things the earlier census could not:
//
//   1. how many BOARD CHAT turns ran, per day and per CLI version (the
//      denominator the regression hypothesis needs);
//   2. how many close prompt PAIRS happened -- the exposure -- and what the
//      two prompts were (a CLI `<task-notification>` ahead of the board's
//      message, or two real messages);
//   3. for each pair, whether a `cancelled` denial followed it before the
//      next end of turn (the outcome).
//
// Read-only. Streams line by line: nothing imported from server/src, nothing
// held in memory beyond one file's compact records.
import { fileURLToPath } from 'node:url';
import { createReadStream, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, basename, dirname } from 'node:path';
import { homedir } from 'node:os';

const PROJECTS = join(homedir(), '.claude', 'projects');
const OUT = join(fileURLToPath(new URL('.', import.meta.url)), 'out');
mkdirSync(OUT, { recursive: true });

// Every board chat prompt carries server/prompts/chat-rules.md. Match the part
// of it that has not changed since the file was created.
const CHAT_MARK = 'Si lo que te pido se descompone en partes independientes';
const PAIR_MS = Number(process.env.PAIR_MS || 500);

function* walk(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith('.jsonl')) yield p;
  }
}

function textOf(msg) {
  const c = msg?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((b) => b.type === 'text').map((b) => b.text || '').join('\n');
  return '';
}

function kindOf(p) {
  if (p.notif) return 'notif';
  if (p.chat) return 'chat';
  return 'other';
}

async function scan(file) {
  const rec = {
    file: file.replace(PROJECTS, '~').replace(/\\/g, '/'),
    project: basename(/subagents/.test(file) ? dirname(dirname(dirname(file))) : dirname(file)),
    sub: /subagents/.test(file),
    session: basename(file, '.jsonl'),
    cwd: null, entrypoint: null, versions: new Set(),
    firstTs: null, lastTs: null,
    prompts: [],   // {ts, notif, chat, head}
    ends: [],      // ts of main-thread assistant messages that ask for no tool
    calls: [],     // {ts, tool, id, side}
    denials: [],   // {ts, tool, kind, side}
  };
  const idTool = new Map();
  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    const ts = Date.parse(r.timestamp);
    if (!Number.isNaN(ts)) {
      if (rec.firstTs == null || ts < rec.firstTs) rec.firstTs = ts;
      if (rec.lastTs == null || ts > rec.lastTs) rec.lastTs = ts;
    }
    if (r.version) rec.versions.add(r.version);
    if (r.cwd && !rec.cwd) rec.cwd = r.cwd;
    if (r.entrypoint && !rec.entrypoint) rec.entrypoint = r.entrypoint;
    const side = r.isSidechain ? 'SUB' : 'MAIN';
    if (r.type === 'assistant') {
      const c = r.message?.content;
      const tools = Array.isArray(c) ? c.filter((b) => b.type === 'tool_use') : [];
      for (const t of tools) { idTool.set(t.id, t.name); rec.calls.push({ ts, tool: t.name, id: t.id, side }); }
      if (!tools.length && side === 'MAIN' && r.message?.stop_reason !== 'tool_use') rec.ends.push(ts);
      continue;
    }
    if (r.type !== 'user') continue;
    const c = r.message?.content;
    const isResult = Array.isArray(c) && c.some((b) => b.type === 'tool_result');
    if (isResult) {
      if (!r.toolDenialKind) continue;
      const block = c.find((b) => b.type === 'tool_result');
      rec.denials.push({
        ts, kind: r.toolDenialKind, side, version: r.version || null,
        tool: idTool.get(block?.tool_use_id) || '(unresolved)',
      });
      continue;
    }
    const txt = textOf(r.message);
    if (!txt) continue;
    if (side !== 'MAIN') continue;
    rec.prompts.push({
      ts,
      notif: txt.trimStart().startsWith('<task-notification>'),
      chat: txt.includes(CHAT_MARK),
      mode: r.permissionMode || null,
      version: r.version || null,
      head: txt.replace(/\s+/g, ' ').slice(0, 60),
    });
  }
  rec.versions = [...rec.versions];
  return rec;
}

const files = [...walk(PROJECTS)];
const day = (ms) => new Date(ms).toISOString().slice(0, 10);

const chatTurns = [];   // {day, version, session, project, ts}
const pairs = [];       // one row per close prompt pair, with its outcome
const cancelled = [];   // every cancelled denial, with its shape
let scanned = 0;

for (const f of files) {
  let st;
  try { st = statSync(f); } catch { continue; }
  if (!st.size) continue;
  const rec = await scan(f);
  scanned++;
  const isChatSession = rec.prompts.some((p) => p.chat);
  for (const p of rec.prompts) {
    if (!p.chat) continue;
    chatTurns.push({
      day: day(p.ts), version: p.version || rec.versions[0] || '?',
      session: rec.session.slice(0, 8), project: rec.project, ts: new Date(p.ts).toISOString(),
    });
  }
  // close pairs of main-thread prompts
  for (let i = 1; i < rec.prompts.length; i++) {
    const a = rec.prompts[i - 1];
    const b = rec.prompts[i];
    const gap = b.ts - a.ts;
    if (gap > PAIR_MS) continue;
    // Was a turn already running when b landed? A tool call issued after the
    // last end of turn preceding a, and not later than b.
    const endsBefore = rec.ends.filter((e) => e <= a.ts);
    const lastEndBefore = endsBefore.length ? endsBefore[endsBefore.length - 1] : -Infinity;
    const inFlight = rec.calls.some((c) => c.ts > lastEndBefore && c.ts <= b.ts);
    const nextEnd = rec.ends.find((e) => e > b.ts);
    const horizon = Math.min(nextEnd == null ? Infinity : nextEnd + 2000, b.ts + 300_000);
    const after = rec.denials.filter((d) => d.ts >= b.ts && d.ts <= horizon);
    const toolsAfter = rec.calls.filter((c) => c.ts >= b.ts && c.ts <= horizon).length;
    pairs.push({
      day: day(b.ts), ts: new Date(b.ts).toISOString(), gapMs: gap,
      version: b.version || rec.versions[0] || '?',
      session: rec.session.slice(0, 8), project: rec.project,
      chatSession: isChatSession, kinds: `${kindOf(a)}+${kindOf(b)}`,
      inFlight, toolsAfter,
      cancelledAfter: after.filter((d) => d.kind === 'cancelled').length,
      denialsAfter: after.length,
      firstDenialS: after.length ? Math.round((after[0].ts - b.ts) / 1000) : null,
    });
  }
  for (const d of rec.denials) {
    if (d.kind !== 'cancelled') continue;
    // the nearest close pair preceding this denial
    let pairGap = null;
    let pairKinds = null;
    let sincePairS = null;
    for (let i = 1; i < rec.prompts.length; i++) {
      const a = rec.prompts[i - 1];
      const b = rec.prompts[i];
      if (b.ts > d.ts) break;
      if (b.ts - a.ts <= PAIR_MS) {
        pairGap = b.ts - a.ts;
        pairKinds = `${kindOf(a)}+${kindOf(b)}`;
        sincePairS = Math.round((d.ts - b.ts) / 1000);
      }
    }
    const before = rec.prompts.filter((p) => p.ts <= d.ts);
    const lastPrompt = before.length ? before[before.length - 1] : null;
    cancelled.push({
      day: day(d.ts), ts: new Date(d.ts).toISOString(), version: d.version || rec.versions[0] || '?',
      session: rec.session.slice(0, 8), project: rec.project, sub: rec.sub, side: d.side, tool: d.tool,
      chatSession: isChatSession, chatPrompt: !!lastPrompt?.chat,
      pairGapMs: pairGap, pairKinds, sincePairS,
    });
  }
}

writeFileSync(join(OUT, 'chat-shape.json'), JSON.stringify({ scanned, chatTurns, pairs, cancelled }, null, 1));

const tally = (rows, keyFn) => {
  const m = new Map();
  for (const r of rows) { const k = keyFn(r); m.set(k, (m.get(k) || 0) + 1); }
  return [...m.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
};
const show = (title, rows) => {
  console.log(`\n== ${title}`);
  for (const [k, v] of rows) console.log(`  ${k}\t${v}`);
};

console.log(`transcripts scanned: ${scanned} / ${files.length}`);
console.log(`board chat turns: ${chatTurns.length}   close prompt pairs (<=${PAIR_MS} ms): ${pairs.length}   cancelled denials: ${cancelled.length}`);
const uniq = [...new Map(chatTurns.map((r) => [r.session + r.version, r])).values()];
show('chat turns by day', tally(chatTurns, (r) => r.day));
show('chat turns by CLI version', tally(chatTurns, (r) => r.version));
show('distinct chat sessions by CLI version', tally(uniq, (r) => r.version));
show('pairs by kind (all projects)', tally(pairs, (r) => r.kinds));
show('pairs in chat sessions, by version', tally(pairs.filter((p) => p.chatSession), (r) => r.version));
show('pairs in chat sessions: outcome by version', tally(pairs.filter((p) => p.chatSession), (r) => `${r.version}\t${r.cancelledAfter > 0 ? 'DENIED' : 'clean'}`));
show('cancelled denials by version', tally(cancelled, (r) => r.version));
show('cancelled denials in chat sessions, by day', tally(cancelled.filter((c) => c.chatSession), (r) => r.day));
console.log(`\nwrote ${join(OUT, 'chat-shape.json')}`);
