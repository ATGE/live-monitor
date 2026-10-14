#!/usr/bin/env node
// For every `cancelled` denial on a MAIN thread: how many user prompts were
// delivered in the 60 s before it, and how far apart the last two were.
// Tests the chat hypothesis — a second prompt arriving while a turn is already
// in flight — against the phase hypothesis (stdin closed at the first result).
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = join(fileURLToPath(new URL('.', import.meta.url)), 'out');
const census = JSON.parse(readFileSync(join(OUT, 'census.log'), 'utf8'));
const PROJECTS = join(homedir(), '.claude', 'projects');

const rows = census.filter((r) => r.kind === 'cancelled');
const byFile = new Map();
for (const r of rows) {
  const f = r.file.replace('~', PROJECTS);
  if (!byFile.has(f)) byFile.set(f, []);
  byFile.get(f).push(r);
}

console.log(['ts', 'session', 'side', 'tool', 'promptsIn60s', 'gapLastTwoMs', 'sincePrevPromptS', 'inFlightAtPrompt2'].join('\t'));
for (const [file, hits] of byFile) {
  const mainFile = /subagents/.test(file) ? file.replace(/[\\/]subagents[\\/].*$/, '.jsonl') : file;
  let main;
  try { main = readFileSync(mainFile, 'utf8'); } catch { continue; }
  const entries = main.split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  // Every user prompt delivered to the CLI (board news, user text, task
  // notifications) — anything that is not a tool_result.
  const prompts = entries.filter((e) => e.type === 'user' && !e.isSidechain
    && (typeof e.message?.content === 'string'
      || (Array.isArray(e.message?.content) && e.message.content.some((b) => b.type === 'text'))))
    .map((e) => Date.parse(e.timestamp)).sort((a, b) => a - b);
  // Assistant tool calls, to tell whether a turn was in flight at prompt 2.
  const toolCalls = entries.filter((e) => e.type === 'assistant' && !e.isSidechain
    && Array.isArray(e.message?.content) && e.message.content.some((b) => b.type === 'tool_use'))
    .map((e) => Date.parse(e.timestamp));

  for (const r of hits) {
    const ts = Date.parse(r.ts);
    const near = prompts.filter((p) => p <= ts && ts - p <= 60_000);
    const gap = near.length >= 2 ? near[near.length - 1] - near[near.length - 2] : '';
    const since = near.length ? Math.round((ts - near[near.length - 1]) / 1000) : '';
    // was an assistant tool call already issued when the last prompt landed?
    const p2 = near[near.length - 1];
    const inFlight = p2 != null && toolCalls.some((t) => t < p2 && p2 - t < 120_000 && t > (near[0] ?? 0));
    console.log([r.ts, r.session.slice(0, 8), r.sidechain ? 'SUB' : 'MAIN', r.tool, near.length, gap, since, inFlight].join('\t'));
  }
}
