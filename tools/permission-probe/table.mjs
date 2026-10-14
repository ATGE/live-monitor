#!/usr/bin/env node
// The deliverable table: arms x {denials, reason, tool, before/after the first
// result}. Reads what `harness.mjs` wrote; runs nothing.
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = join(fileURLToPath(new URL('.', import.meta.url)), 'out');
const rows = [];
for (const f of ['results.log', 'results-run2.log']) {
  try { rows.push(...JSON.parse(readFileSync(join(OUT, f), 'utf8'))); } catch { /* not every run exists */ }
}
const seen = new Set();
const uniq = rows.filter((r) => !seen.has(r.arm) && seen.add(r.arm));
uniq.sort((a, b) => a.arm.localeCompare(b.arm));

// A run overwrites `results.log`, so an arm measured in an earlier run keeps
// only its frames. Rebuild its row from those — same data, same session.
export function fromFrames(arm) {
  const L = readFileSync(join(OUT, `${arm}.frames.log`), 'utf8').split(/\n/).filter(Boolean).map((l) => JSON.parse(l));
  let firstResultAt = null; let init = null; let denials = 0; let after = 0; let pd = 0;
  for (const { at, m } of L) {
    if (m.type === 'system' && m.subtype === 'init') init ??= m.permissionMode ?? null;
    if (m.type === 'system' && m.subtype === 'permission_denied') pd++;
    const c = m.message?.content;
    if (Array.isArray(c)) for (const b of c) {
      if (b.type === 'tool_result' && typeof b.content === 'string' && /doesn't want to take this action/.test(b.content)) {
        denials++; if (firstResultAt != null) after++;
      }
    }
    if (m.type === 'result' && firstResultAt == null) firstResultAt = at;
  }
  return { arm, initPermissionMode: init, toolDenials: denials, toolDenialsAfterFirstResult: after, permissionDeniedFrames: pd };
}

// The CLI's own words for the refusal live in the debug log, not in any frame.
function debugReason(arm) {
  try {
    const t = readFileSync(join(OUT, `${arm}.debug.log`), 'utf8');
    const m = t.match(/PreToolUse[^\n]*cancelled[^\n]*/);
    const e = t.match(/hooks? (?:chain )?failed: [^\n]*/);
    return [m?.[0]?.replace(/^\s+/, ''), e?.[0]].filter(Boolean).join(' || ') || '(ninguna)';
  } catch { return '(sin log)'; }
}
function deniedTools(arm) {
  try {
    const L = readFileSync(join(OUT, `${arm}.frames.log`), 'utf8').split(/\n/).filter(Boolean).map((l) => JSON.parse(l));
    const names = new Map();
    for (const { m } of L) {
      const c = m.message?.content;
      if (!Array.isArray(c)) continue;
      for (const b of c) if (b.type === 'tool_use') names.set(b.id, b.name);
    }
    const out = [];
    for (const { m } of L) {
      const c = m.message?.content;
      if (!Array.isArray(c)) continue;
      for (const b of c) {
        if (b.type === 'tool_result' && typeof b.content === 'string' && /doesn't want to take this action/.test(b.content)) {
          out.push(`${names.get(b.tool_use_id) ?? '?'}${m.parent_tool_use_id ? '(sub)' : ''}`);
        }
      }
    }
    return out.join(',') || '—';
  } catch { return '?'; }
}

const cols = [
  ['arm', 'brazo'], ['recipe', 'receta'], ['hook', 'hook'], ['prompt', 'prompt'],
  ['canUseTool', 'canUseTool'], ['settingSources', 'settingSources'],
  ['initPermissionMode', 'init.permissionMode'],
  ['toolDenials', 'denegaciones'], ['toolDenialsAfterFirstResult', 'tras 1er result'],
  ['permissionDeniedFrames', 'frames permission_denied'], ['hookFired', 'hook ejecutado'],
  ['closeReason', 'cierre'], ['seconds', 's'],
];
console.log([...cols.map((c) => c[1]), 'herramienta denegada', 'razón (debug del CLI)'].join('\t'));
for (const r of uniq) {
  console.log([...cols.map((c) => String(r[c[0]] ?? '')), deniedTools(r.arm), debugReason(r.arm).slice(0, 120)].join('\t'));
}
