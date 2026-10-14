#!/usr/bin/env node
// Prints a window of a transcript around a timestamp: prompts, turn ends,
// tool calls, tool results and denials, on the main thread and in sidechains.
// Read-only. Usage: node timeline.mjs <jsonl path> <iso ts> [windowSeconds]
import { readFileSync } from 'node:fs';

const [, , file, at, winArg] = process.argv;
const win = Number(winArg || 120) * 1000;
const center = Date.parse(at);
const rows = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

for (const r of rows) {
  const t = Date.parse(r.timestamp);
  if (Number.isNaN(t) || Math.abs(t - center) > win) continue;
  const side = r.isSidechain ? 'SUB ' : 'MAIN';
  const d = ((t - center) / 1000).toFixed(1).padStart(7);
  if (r.type === 'assistant') {
    const c = r.message?.content || [];
    const tools = c.filter((b) => b.type === 'tool_use').map((b) => `${b.name}(${JSON.stringify(b.input).slice(0, 60)})`);
    const text = c.filter((b) => b.type === 'text').map((b) => b.text.replace(/\s+/g, ' ').slice(0, 90)).join(' | ');
    console.log(`${d} ${side} assistant stop=${r.message?.stop_reason} ${tools.length ? '-> ' + tools.join(' ; ') : ''}${text ? ' TEXT: ' + text : ''}`);
  } else if (r.type === 'user') {
    const c = r.message?.content;
    if (typeof c === 'string') console.log(`${d} ${side} PROMPT mode=${r.permissionMode} src=${r.promptSource} :: ${c.replace(/\s+/g, ' ').slice(0, 110)}`);
    else for (const b of c || []) {
      if (b.type === 'tool_result') {
        const txt = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
        console.log(`${d} ${side} result${r.toolDenialKind ? ' DENIAL=' + r.toolDenialKind : ''} err=${!!b.is_error} :: ${txt.replace(/\s+/g, ' ').slice(0, 110)}`);
      } else if (b.type === 'text') {
        console.log(`${d} ${side} PROMPT(text) mode=${r.permissionMode} :: ${b.text.replace(/\s+/g, ' ').slice(0, 110)}`);
      }
    }
  } else {
    console.log(`${d} ${side} ${r.type}${r.subtype ? '/' + r.subtype : ''} ${JSON.stringify(r).slice(0, 160)}`);
  }
}
