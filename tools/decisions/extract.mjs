#!/usr/bin/env node
// Rebuild the corpus of Edson's decisions from the Claude Code transcripts.
//
// Two streams are extracted from every transcript listed in
// `tools/decisions/sessions.json`:
//
//   * `AskUserQuestion` -- the question, every option (including the rejected
//     ones, with their descriptions and ASCII previews) and the answer;
//   * `ExitPlanMode`    -- the full plan markdown, approved or rejected, plus
//     the prompt Edson typed right after a rejection.
//
// Everything is regenerated from scratch on every run and compared to what is
// on disk, so the command is idempotent and `--check` can fail a dirty tree.
// Code and comments are English; every word this writes for a human is Spanish.
//
// Imports nothing from `server/src`: this is a tool, not part of the server.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  LOCAL_TIME_ZONE,
  fenceFor,
  hashText,
  localParts,
  normalizeText,
  readSessions,
  structuralLines,
  textOf,
  withLock,
} from './core.mjs';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..');

export const DEFAULT_CONFIG_PATH = path.join(HERE, 'config.json');
export const DEFAULT_ADR_MAP_PATH = path.join(HERE, 'adr-map.json');

/**
 * The one line that carries state between runs.
 *
 * Only the question body is guarded by the hash: everything else (the answer,
 * the options, the ADR back-links) is rebuilt from the transcript on every
 * pass, so a change there is a diff, never an abort.
 */
export const DECISION_MARKER_RE =
  /^<!-- decision id="([^"]*)" q="(\d+)\/(\d+)" hash="([0-9a-f]+)" at="([^"]+)" kind="([^"]*)" -->$/;

/** A free-text answer that asks for the question to be put again. */
export const RE_ASK_RE =
  /no (entiendo|comprendo)|vuelv\w* a preguntar|volver a preguntar|m[aá]s detalle|reformul/i;

/** A free-text answer that withdraws the request instead of answering it. */
export const GIVE_UP_RE = /ya no quiero/i;

/** Above this many characters a free-text answer is a paste, not a sentence. */
export const DATA_ANSWER_CHARS = 500;

const GENERATED_BY = 'Generado por `tools/decisions/extract.mjs` — no se edita a mano.';
const HASH_NOTE =
  'Solo el **cuerpo de la pregunta** está protegido por un resumen (`hash`): si ' +
  'alguien lo edita a mano, la siguiente pasada aborta sin escribir nada. El ' +
  'resto del texto se vuelve a generar en cada pasada.';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Resolve a configured path against the repo root unless it is absolute. */
export function resolveOutput(value, fallback) {
  const raw = typeof value === 'string' && value ? value : fallback;
  return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(REPO_ROOT, raw);
}

export function parseConfig(raw, { configPath = DEFAULT_CONFIG_PATH } = {}) {
  const obj = raw && typeof raw === 'object' ? raw : {};
  const cutoff = typeof obj.cutoff === 'string' ? obj.cutoff : '';
  const cutoffMs = Date.parse(cutoff);
  if (!Number.isFinite(cutoffMs)) {
    throw new Error(
      `${configPath}: "cutoff" no es un instante ISO válido (${JSON.stringify(obj.cutoff)})`,
    );
  }
  const out = obj.output && typeof obj.output === 'object' ? obj.output : {};
  return {
    configPath,
    cutoff,
    cutoffMs,
    indexPath: resolveOutput(out.index, 'decisions.md'),
    daysDir: resolveOutput(out.days, 'docs/decisions'),
    historyDir: resolveOutput(out.history, 'docs/history'),
    adrIndexPath: resolveOutput(out.adrIndex, 'adr.md'),
    adrDir: resolveOutput(out.adrDir, 'docs/adr'),
    adrMapPath: resolveOutput(out.adrMap ?? obj.adrMap, DEFAULT_ADR_MAP_PATH),
  };
}

export function loadConfig({ configPath, config } = {}) {
  if (config) return parseConfig(config, { configPath: configPath ?? '<memoria>' });
  const file =
    configPath ?? process.env.HFSMON_DECISIONS_CONFIG ?? DEFAULT_CONFIG_PATH;
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return parseConfig(raw, { configPath: file });
}

export function loadAdrMap(adrMapPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(adrMapPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`adr-map.json ilegible, se ignora: ${err.message}`);
    }
    return {};
  }
}

// ---------------------------------------------------------------------------
// Transcript reading
// ---------------------------------------------------------------------------

/** The plain text of a `tool_result` block, whatever shape it arrived in. */
export function resultText(block) {
  if (!block) return '';
  const content = block.content;
  if (typeof content === 'string') return normalizeText(content);
  return textOf(content);
}

/**
 * Stream one transcript and pull out the three streams we care about.
 *
 * The file is tens of megabytes, so it is read line by line and every line is
 * parsed inside a try/catch: a half-written last line must never cost a run.
 */
export async function readTranscriptStreams(transcriptPath, sessionId) {
  const asks = [];
  const plans = [];
  const humans = [];
  const results = new Map();

  const stream = fs.createReadStream(transcriptPath, 'utf8');
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let lineNo = 0;
  for await (const line of rl) {
    lineNo += 1;
    if (!line || line.charCodeAt(0) !== 123 /* { */) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const at = record.timestamp;
    const where = { sessionId, lineNo, at };

    if (record.type === 'user' && record.origin?.kind === 'human' && record.promptId) {
      humans.push({ ...where, id: record.promptId, text: textOf(record.message?.content) });
    }

    const content = record.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'tool_use' && block.name === 'AskUserQuestion') {
        asks.push({ ...where, id: block.id, input: block.input ?? {} });
      } else if (block.type === 'tool_use' && block.name === 'ExitPlanMode') {
        plans.push({ ...where, id: block.id, input: block.input ?? {} });
      } else if (block.type === 'tool_result' && block.tool_use_id) {
        results.set(block.tool_use_id, {
          ...where,
          text: resultText(block),
          isError: block.is_error === true,
          toolUseResult: record.toolUseResult,
        });
      }
    }
  }
  return { asks, plans, humans, results };
}

/** Stable order across sessions: instant, then session, then position. */
export function byStreamOrder(a, b) {
  return (
    Date.parse(a.at) - Date.parse(b.at) ||
    String(a.sessionId).localeCompare(String(b.sessionId)) ||
    a.lineNo - b.lineNo
  );
}

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

/**
 * Split an answer string back into the labels it was built from.
 *
 * The harness joins a multi-select answer with ", " -- and roughly a sixth of
 * the labels contain ", " themselves, so splitting on the separator shreds
 * them. Matching the labels greedily, longest first, is the only safe read;
 * whatever is left over was typed by hand.
 */
export function matchAnswer(answer, labels) {
  const text = normalizeText(answer);
  const sorted = [...new Set(labels.filter((l) => typeof l === 'string' && l !== ''))].sort(
    (a, b) => b.length - a.length || a.localeCompare(b),
  );
  const chosen = [];
  let rest = text;
  let progress = true;
  while (rest !== '' && progress) {
    progress = false;
    for (const label of sorted) {
      if (rest === label) {
        chosen.push(label);
        rest = '';
        progress = true;
        break;
      }
      if (rest.startsWith(`${label}, `)) {
        chosen.push(label);
        rest = rest.slice(label.length + 2);
        progress = true;
        break;
      }
    }
  }
  return { chosen, leftover: rest };
}

/** What kind of answer this is, before re-ask pairing has a say. */
export function classifyAnswer({ answered, answer, leftover }) {
  if (!answered || normalizeText(answer ?? '') === '') return 'sin respuesta';
  if (leftover === '') return 'elegida';
  if (GIVE_UP_RE.test(answer)) return 'abandonada';
  if (normalizeText(answer).length > DATA_ANSWER_CHARS) return 'dato';
  return 'libre';
}

export function decisionNumber(n) {
  return `D-${String(n).padStart(4, '0')}`;
}

export function planNumber(n) {
  return String(n).padStart(3, '0');
}

// ---------------------------------------------------------------------------
// Small text helpers
// ---------------------------------------------------------------------------

export function collapse(text) {
  return normalizeText(text).replace(/\s+/g, ' ').trim();
}

/**
 * A prefix of `text`, never cut inside an astral character.
 *
 * `slice` counts UTF-16 code units, so cutting between the two halves of an
 * emoji leaves a lone surrogate that becomes U+FFFD once it reaches disk.
 * `toWellFormed` is the detector; the half is dropped rather than replaced.
 */
export function safeSlice(text, n) {
  const out = String(text).slice(0, n);
  return out.toWellFormed() === out ? out : out.slice(0, -1);
}

/** One line, at most `max` characters, with an ellipsis when it was cut. */
export function excerpt(text, max = 80) {
  const flat = collapse(text);
  if (flat.length <= max) return flat;
  return `${safeSlice(flat, max - 1).trimEnd()}…`;
}

/** Markdown table cells cannot hold fences, newlines or bare pipes. */
export function tableCell(text, max = 300) {
  const flat = collapse(text).replace(/\|/g, '\\|');
  if (flat.length <= max) return flat;
  return `${safeSlice(flat, max - 1).trimEnd()}…`;
}

/**
 * Text that is about to be rendered as Markdown rather than fenced.
 *
 * Descriptions quote placeholders like `<remota>` at us and GitHub swallows
 * them as HTML tags. Escaping the three HTML characters renders the text
 * exactly as it was typed and leaves the source readable.
 */
export function escapeInline(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** A link target that works from `fromFile` to `toFile`, POSIX style. */
export function relLink(fromFile, toFile) {
  const rel = path.relative(path.dirname(fromFile), toFile).split(path.sep).join('/');
  return rel === '' ? path.basename(toFile) : rel;
}

function pushBlank(lines) {
  if (lines.length && lines[lines.length - 1] !== '') lines.push('');
}

function fenced(text, tag) {
  const fence = fenceFor(text);
  return [`${fence}${tag}`, ...normalizeText(text).split('\n'), fence];
}

/**
 * One option as a bullet: label, description and (if any) its preview.
 *
 * `mark` is the checkbox state ('x' / ' ') for a day file's full option list;
 * omitted (or null) it renders a plain bullet, which is what the ADR block
 * uses for options that were never chosen -- there is no state left to mark.
 * Shared by `renderDecision` and `renderAdrBlock` so the two option lists
 * (one full, one filtered) never drift apart in how a bullet looks.
 */
export function renderOptionBullet(option, mark = null) {
  const lines = [];
  const prefix = mark === null ? '-' : `- [${mark}]`;
  const desc = escapeInline(collapse(option.description));
  lines.push(`${prefix} **${escapeInline(option.label)}**${desc ? ` — ${desc}` : ''}`);
  if (option.preview) {
    // Column 0 on purpose: the fence-aware parsers only see fences there, and
    // an indented preview inside the bullet would be invisible to them.
    lines.push('', ...fenced(option.preview, 'text'), '');
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Model building
// ---------------------------------------------------------------------------

/**
 * Turn the raw streams into numbered decisions and plans.
 *
 * Numbering runs over everything under the cutoff, in stream order, so a
 * decision keeps its identifier for good as long as the cutoff does not move.
 */
export function buildModel({ asks, plans, humans, results, cutoffMs }) {
  const sortedAsks = [...asks].sort(byStreamOrder).filter((a) => Date.parse(a.at) <= cutoffMs);
  const sortedPlans = [...plans].sort(byStreamOrder).filter((p) => Date.parse(p.at) <= cutoffMs);
  const sortedHumans = [...humans].sort(byStreamOrder);

  const decisions = [];
  const dialogs = [];
  let n = 0;

  for (const ask of sortedAsks) {
    const result = results.get(ask.id);
    const answers =
      result?.toolUseResult && typeof result.toolUseResult === 'object'
        ? (result.toolUseResult.answers ?? null)
        : null;
    const questions = Array.isArray(ask.input?.questions) ? ask.input.questions : [];
    const dialog = { ask, result, answered: Boolean(result), decisions: [] };

    questions.forEach((q, i) => {
      n += 1;
      const question = normalizeText(q?.question ?? '');
      const options = (Array.isArray(q?.options) ? q.options : []).map((o) => ({
        label: normalizeText(o?.label ?? ''),
        description: typeof o?.description === 'string' ? o.description : '',
        preview: typeof o?.preview === 'string' && o.preview !== '' ? normalizeText(o.preview) : '',
      }));
      const rawAnswer = answers && typeof answers[q?.question] === 'string' ? answers[q.question] : '';
      const answered = Boolean(result) && rawAnswer !== '';
      const { chosen, leftover } = matchAnswer(rawAnswer, options.map((o) => o.label));
      const kind = classifyAnswer({ answered, answer: rawAnswer, leftover });
      const freeText = leftover === '' ? '' : normalizeText(rawAnswer);
      const { day, time } = localParts(ask.at);

      const decision = {
        n,
        number: decisionNumber(n),
        anchor: `d-${String(n).padStart(4, '0')}`,
        toolUseId: ask.id,
        qIndex: i + 1,
        qTotal: questions.length,
        header: collapse(q?.header ?? '') || 'Sin rótulo',
        question,
        hash: hashText(question),
        at: ask.at,
        day,
        time,
        multiSelect: q?.multiSelect === true,
        options,
        chosen: freeText ? [] : chosen,
        chosenSet: new Set(freeText ? [] : chosen),
        freeText,
        kind,
        answeredAt: result?.at ?? ask.at,
        pairedWith: null,
        pairRole: null,
      };
      decisions.push(decision);
      dialog.decisions.push(decision);
    });

    dialogs.push(dialog);
  }

  pairReAsks(dialogs, sortedHumans);

  const plansOut = [];
  const planIssues = { error: 0, missing: 0 };
  let planN = 0;
  for (const plan of sortedPlans) {
    const result = results.get(plan.id);
    const tur = result?.toolUseResult;
    const text = result?.text ?? '';
    if (!result) {
      planIssues.missing += 1;
      continue;
    }
    if (/<tool_use_error>/.test(text)) {
      planIssues.error += 1;
      continue;
    }
    const approved = Boolean(tur && typeof tur === 'object' && typeof tur.plan === 'string');
    const rejected = !approved && /^The user doesn't want/.test(text);
    if (!approved && !rejected) {
      planIssues.error += 1;
      continue;
    }
    planN += 1;
    const body = normalizeText(
      approved ? tur.plan : (plan.input?.plan ?? tur?.plan ?? ''),
    );
    const reason = rejected ? nextHumanAfter(sortedHumans, result.at ?? plan.at) : null;
    const { day, time } = localParts(plan.at);
    plansOut.push({
      n: planN,
      number: planNumber(planN),
      toolUseId: plan.id,
      at: plan.at,
      day,
      time,
      state: approved ? 'aprobado' : 'rechazado',
      approved,
      plan: body,
      planFilePath: typeof plan.input?.planFilePath === 'string' ? plan.input.planFilePath : '',
      filePath: approved && typeof tur.filePath === 'string' ? tur.filePath : '',
      isAgent: approved ? tur.isAgent === true : false,
      reason: reason ? normalizeText(reason.text) : '',
      fileName: `plan-${planNumber(planN)}-${approved ? 'aprobado' : 'rechazado'}-${day}.md`,
    });
  }

  return { decisions, dialogs, plans: plansOut, planIssues, humans: sortedHumans };
}

function nextHumanAfter(humans, at) {
  const ms = Date.parse(at);
  for (const h of humans) {
    if (Date.parse(h.at) >= ms && h.text.trim() !== '') return h;
  }
  return null;
}

/**
 * Pair "I don't understand, ask me again" with the question that came back.
 *
 * Two signals, either one is enough: the answer itself asks for a re-ask, or
 * the very next dialog reuses the same header. Both are only trusted while no
 * human prompt has run in between -- once Edson typed something new, the next
 * dialog is about something else.
 */
export function pairReAsks(dialogs, humans) {
  let pairs = 0;
  for (let i = 0; i < dialogs.length - 1; i += 1) {
    const dialog = dialogs[i];
    const next = dialogs[i + 1];
    const nextAsk = Date.parse(next.ask.at);

    for (const decision of dialog.decisions) {
      if (decision.pairedWith || !decision.freeText) continue;
      const since = Date.parse(decision.answeredAt);
      const human = nextHumanAfter(humans, decision.answeredAt);
      if (human && Date.parse(human.at) < nextAsk) continue;
      if (nextAsk < since) continue;

      const sameHeader = next.decisions.find((d) => d.header === decision.header);
      if (!RE_ASK_RE.test(decision.freeText) && !sameHeader) continue;
      const target = sameHeader ?? next.decisions[0];
      if (!target || target.pairedWith) continue;

      decision.pairedWith = target;
      decision.pairRole = 'origen';
      decision.kind = 'repreguntada';
      target.pairedWith = decision;
      target.pairRole = 'destino';
      pairs += 1;
      break; // one pairing per dialog: the next dialog is a single re-ask
    }
  }
  return pairs;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function renderDecision(decision, { dayFilePath, dayPathOf, adrMap, adrIndexPath }) {
  const lines = [];
  lines.push(`<a id="${decision.anchor}"></a>`, '');
  lines.push(`### ${decision.number} · ${decision.time} — ${escapeInline(decision.header)}`, '');
  lines.push(
    `<!-- decision id="${decision.toolUseId}" q="${decision.qIndex}/${decision.qTotal}" ` +
      `hash="${decision.hash}" at="${decision.at}" kind="${decision.kind}" -->`,
    '',
  );

  lines.push('**Pregunta.**', '');
  lines.push(...fenced(decision.question, 'text'), '');

  if (decision.chosen.length) {
    lines.push(`**Respuesta.** ${decision.chosen.map(escapeInline).join(' · ')}`, '');
  } else if (decision.freeText) {
    lines.push('**Respuesta.**', '');
    lines.push(...fenced(decision.freeText, 'text'), '');
  } else {
    lines.push('**Respuesta.** — sin respuesta —', '');
  }

  lines.push(`**Opciones.**${decision.multiSelect ? ' (multiselección)' : ''}`, '');
  if (decision.options.length === 0) {
    lines.push('- — (el diálogo no ofreció ninguna) —');
  }
  for (const option of decision.options) {
    const mark = decision.chosenSet.has(option.label) ? 'x' : ' ';
    lines.push(...renderOptionBullet(option, mark));
  }
  pushBlank(lines);

  if (decision.pairedWith) {
    const other = decision.pairedWith;
    const target = dayPathOf(other.day);
    const href =
      target === dayFilePath ? `#${other.anchor}` : `${relLink(dayFilePath, target)}#${other.anchor}`;
    const label = decision.pairRole === 'origen' ? 'Reformulada en' : 'Reformula a';
    lines.push(`**${label}.** [${other.number}](${href})`, '');
  }

  // `adr.md` lives at the repo root, not next to a day file under
  // `docs/decisions/`: a literal `adr.md#adr-nnnn` here resolves to
  // `docs/decisions/adr.md`, which does not exist. `docs.test.mjs` (phase C,
  // §9.8) is watching for exactly this once `adrMap` stops being `{}`.
  const adrs = Array.isArray(adrMap?.[decision.number]) ? adrMap[decision.number] : [];
  const links = adrs
    .filter((a) => typeof a === 'string' && a)
    .map((a) => `[${a}](${relLink(dayFilePath, adrIndexPath)}#${a.toLowerCase()})`);
  lines.push(`**Recogida en.** ${links.length ? links.join(', ') : '— (sin ADR todavía)'}`, '');

  return lines;
}

export function renderDayFile(day, decisions, ctx) {
  const dayFilePath = ctx.dayPathOf(day);
  const lines = [
    `# Decisiones de Edson — ${day}`,
    '',
    GENERATED_BY,
    '',
    `- Corte: \`${ctx.cutoff}\``,
    `- Zona horaria: \`${LOCAL_TIME_ZONE}\``,
    `- Índice: [decisions.md](${relLink(dayFilePath, ctx.indexPath)})`,
    '',
    HASH_NOTE,
    '',
    `## ${day}`,
    '',
  ];
  for (const decision of decisions) {
    lines.push(...renderDecision(decision, { ...ctx, dayFilePath }));
    pushBlank(lines);
  }
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

export function renderIndex(byDay, ctx) {
  const lines = [
    '# Decisiones de Edson',
    '',
    GENERATED_BY,
    '',
    'Cada entrada es un diálogo `AskUserQuestion` de una sesión de Claude Code:',
    'la pregunta tal cual se hizo, **todas** las opciones (también las',
    'descartadas, con su descripción y su vista previa) y la respuesta.',
    '',
    `- Corte: \`${ctx.cutoff}\``,
    `- Zona horaria: \`${LOCAL_TIME_ZONE}\``,
    `- Historial de planes: [docs/history](${relLink(
      ctx.indexPath,
      path.join(ctx.historyDir, 'README.md'),
    )})`,
    '- Regenerar: `npm run decisions:build` · comprobar: `npm run decisions:check`',
    '',
    HASH_NOTE,
    '',
    '## Días',
    '',
  ];
  for (const [day, decisions] of byDay) {
    const dayPath = ctx.dayPathOf(day);
    const href = relLink(ctx.indexPath, dayPath);
    const count = decisions.length;
    lines.push(`- [${day}](${href}) — ${count} ${count === 1 ? 'decisión' : 'decisiones'}`);
    for (const decision of decisions) {
      lines.push(
        `  - [${decision.number}](${href}#${decision.anchor}) · ${escapeInline(decision.header)} · ` +
          `${escapeInline(excerpt(decision.question))}`,
      );
    }
  }
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

export function renderPlanFile(plan) {
  const lines = [
    `# Plan ${plan.number} — ${plan.state}`,
    '',
    GENERATED_BY,
    '',
    `- Instante: \`${plan.at}\` (${plan.day} ${plan.time} ${LOCAL_TIME_ZONE})`,
    `- Estado: **${plan.state}**`,
    `- \`planFilePath\`: ${plan.planFilePath ? `\`${plan.planFilePath}\`` : '— (ninguno)'}`,
    `- \`filePath\`: ${plan.filePath ? `\`${plan.filePath}\`` : '— (ninguno)'}`,
  ];
  if (plan.approved && plan.isAgent) lines.push('- Lo propuso un subagente (`isAgent`).');
  lines.push('', '---', '');
  // The plan is fenced as markdown so its own headings, anchors and decision
  // markers can never be read as structure of this file.
  lines.push(...fenced(plan.plan, 'markdown'), '');
  if (!plan.approved) {
    lines.push('**Motivo (siguiente prompt de Edson).**', '');
    if (plan.reason) lines.push(...fenced(plan.reason, 'text'), '');
    else lines.push('— (no hubo prompt después del rechazo) —', '');
  }
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

export function renderHistoryReadme(plans, ctx) {
  const lines = [
    '# Historial de planes',
    '',
    GENERATED_BY,
    '',
    'Cada plan que pasó por `ExitPlanMode`, aprobado o rechazado, con su texto',
    'completo. El motivo es el prompt que Edson escribió justo después de',
    'rechazarlo.',
    '',
    `- Corte: \`${ctx.cutoff}\``,
    `- Zona horaria: \`${LOCAL_TIME_ZONE}\``,
    `- Índice de decisiones: [decisions.md](${relLink(
      path.join(ctx.historyDir, 'README.md'),
      ctx.indexPath,
    )})`,
    '',
    '| Plan | Instante | Estado | Archivo | Motivo |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const plan of plans) {
    lines.push(
      `| ${plan.number} | ${plan.day} ${plan.time} | ${plan.state} | ` +
        `[${plan.fileName}](${plan.fileName}) | ${plan.reason ? escapeInline(tableCell(plan.reason)) : '—'} |`,
    );
  }
  if (plans.length === 0) lines.push('| — | — | — | — | — |');
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

// ---------------------------------------------------------------------------
// ADR generated block
// ---------------------------------------------------------------------------

export const ADR_FILE_RE = /^(\d{4})-[a-z0-9-]{1,40}\.md$/;
export const ADR_BLOCK_START = '<!-- adr:generated -->';
export const ADR_BLOCK_END = '<!-- /adr:generated -->';

/** `ADR-nnnn -> [D-nnnn, ...]`, the reverse of `adr-map.json`, sorted. */
export function invertAdrMap(adrMap) {
  const out = new Map();
  for (const [d, adrs] of Object.entries(adrMap ?? {})) {
    for (const adr of Array.isArray(adrs) ? adrs : []) {
      if (typeof adr !== 'string' || !adr) continue;
      if (!out.has(adr)) out.set(adr, []);
      out.get(adr).push(d);
    }
  }
  for (const list of out.values()) list.sort();
  return out;
}

/**
 * Every ADR file on disk under `cfg.adrDir`, oldest number first.
 *
 * Only names matching `NNNN-slug.md` count -- `_plantilla.md` starts with an
 * underscore and never matches, which is exactly what keeps it out of the
 * sweep without a special case.
 */
export function adrFiles(cfg) {
  let names = [];
  try {
    names = fs.readdirSync(cfg.adrDir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const m = ADR_FILE_RE.exec(name);
    if (!m) continue;
    const full = path.join(cfg.adrDir, name);
    try {
      if (!fs.statSync(full).isFile()) continue;
    } catch {
      continue; // a dangling link, or a file gone since readdirSync: not an ADR
    }
    out.push({ file: full, number: m[1] });
  }
  out.sort((a, b) => a.number.localeCompare(b.number));
  return out;
}

/**
 * The lines that belong between `adr:generated` markers for one ADR.
 *
 * Empty when the ADR has no `D-nnnn` behind it (like `ADR-0001` today) -- that
 * is not an error, it just means nothing to render. For each cited decision:
 * the question and the answer verbatim, every option that was NOT chosen with
 * its label, description and preview copied literally (`renderOptionBullet`,
 * shared with a day file's full option list), and a link back to the day file
 * as evidence.
 */
export function renderAdrBlock(adrFilePath, dNumbers, decisionsByNumber, ctx) {
  if (!dNumbers.length) return [];
  const lines = [];
  for (const d of [...dNumbers].sort()) {
    const decision = decisionsByNumber.get(d);
    if (!decision) {
      const adr = /^\d{4}/.exec(path.basename(adrFilePath))?.[0];
      throw new Error(
        `tools/decisions/adr-map.json asigna ${d} a ${adr ? `ADR-${adr}` : adrFilePath}, ` +
          'pero ese D-nnnn no existe en el corpus de decisiones.',
      );
    }
    lines.push(`### ${d} · ${escapeInline(decision.header)}`, '');
    lines.push('**Pregunta.**', '');
    lines.push(...fenced(decision.question, 'text'), '');

    if (decision.chosen.length) {
      lines.push(`**Respuesta elegida.** ${decision.chosen.map(escapeInline).join(' · ')}`, '');
    } else if (decision.freeText) {
      lines.push('**Respuesta elegida.**', '');
      lines.push(...fenced(decision.freeText, 'text'), '');
    } else {
      lines.push('**Respuesta elegida.** — sin respuesta —', '');
    }

    const discarded = decision.options.filter((o) => !decision.chosenSet.has(o.label));
    lines.push('**Alternativas descartadas.**', '');
    if (discarded.length === 0) {
      lines.push('- — (no había otra opción) —');
    } else {
      for (const option of discarded) lines.push(...renderOptionBullet(option));
    }
    pushBlank(lines);

    const href = relLink(adrFilePath, ctx.dayPathOf(decision.day));
    lines.push(`**Evidencia.** [${d}](${href}#${decision.anchor})`, '');
  }
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Where the markers of an ADR are, and only there.
 *
 * A marker counts when it is a whole line (trimmed) outside a fenced block --
 * the same walker `parseDayFile` uses, for the same reason: text quotes us. A
 * human sentence that mentions the marker string, or a fenced example of the
 * block, is not structure. Anything but exactly one opening followed by exactly
 * one closing is an error, never a guess: a duplicated pair would otherwise sit
 * green under `--check` with junk inside it, and a quoted marker would have the
 * block injected into the middle of a sentence.
 *
 * Returns the line indexes into `raw.split('\n')` (`structuralLines` keeps them).
 */
export function findAdrMarkers(raw, label) {
  const starts = [];
  const ends = [];
  for (const [i, line] of structuralLines(raw)) {
    const t = line.trim();
    if (t === ADR_BLOCK_START) starts.push(i);
    else if (t === ADR_BLOCK_END) ends.push(i);
  }
  if (starts.length === 0 && ends.length === 0) {
    throw new Error(
      `${label}: le faltan los marcadores ${ADR_BLOCK_START} / ${ADR_BLOCK_END}, cada uno en ` +
        'una línea propia y fuera de un bloque cercado; vuelve a ponerlos pegados al final del archivo.',
    );
  }
  if (starts.length !== 1 || ends.length !== 1 || starts[0] > ends[0]) {
    throw new Error(
      `${label}: los marcadores ${ADR_BLOCK_START} / ${ADR_BLOCK_END} tienen que ser exactamente ` +
        `uno de apertura y uno de cierre, en ese orden, y aquí hay ${starts.length} de apertura ` +
        `y ${ends.length} de cierre (fuera de bloques cercados${
          starts.length === 1 && ends.length === 1 ? ', y el cierre va antes que la apertura' : ''
        }). Deja un solo par pegado al final del archivo.`,
    );
  }
  return { start: starts[0], end: ends[0] };
}

/**
 * Splice a rendered block between the two markers of an ADR file already on
 * disk, leaving everything else -- title, `Estado`, `Fecha`, `Rastro`,
 * `Afecta a`, the four human sections, whatever they already say -- byte for
 * byte untouched. The markers are found by `findAdrMarkers`, so a mention of
 * them in prose or inside a fence never moves the block. Beyond that no guard:
 * `compareFiles` already diffs the whole file against disk, so an edit outside
 * the markers renders back to the same bytes ("unchanged") and an edit inside
 * them renders differently ("changed", which is exactly what `--check` should
 * catch).
 *
 * The block itself is checked too: were it to hold a line that reads as a
 * marker, the next pass would find two and stop, so it is refused here.
 */
export function spliceAdrBlock(raw, blockLines, label) {
  const stray = [...structuralLines(blockLines.join('\n'))].find(([, line]) => {
    const t = line.trim();
    return t === ADR_BLOCK_START || t === ADR_BLOCK_END;
  });
  if (stray) {
    throw new Error(
      `${label}: el bloque generado trae un marcador ${stray[1].trim()} suelto (fuera de un bloque ` +
        'cercado) y la siguiente pasada lo leería como estructura. No se escribe nada.',
    );
  }
  const { start, end } = findAdrMarkers(raw, label);
  const lines = raw.split('\n');
  return [...lines.slice(0, start + 1), ...blockLines, ...lines.slice(end)].join('\n');
}

// ---------------------------------------------------------------------------
// Round-trip guard
// ---------------------------------------------------------------------------

/**
 * Read the decisions back out of a rendered day file.
 *
 * Markers are located with the fence-aware walker -- a question body can quote
 * a marker at us -- and then the first fence after each marker is the question,
 * which is re-hashed against the marker. A mismatch means a hand edit.
 */
export function parseDayFile(text, label = 'archivo') {
  const lines = normalizeText(text).split('\n');
  const markers = [];
  for (const [i, line] of structuralLines(text)) {
    const m = DECISION_MARKER_RE.exec(line);
    if (m) {
      markers.push({
        line: i,
        id: m[1],
        qIndex: Number(m[2]),
        qTotal: Number(m[3]),
        hash: m[4],
        at: m[5],
        kind: m[6],
      });
    }
  }

  const entries = [];
  for (const marker of markers) {
    let j = marker.line + 1;
    while (j < lines.length && !/^(`{3,})/.test(lines[j])) j += 1;
    if (j >= lines.length) {
      throw new Error(
        `${label}: la decisión ${marker.hash} (línea ${marker.line + 1}) no tiene ` +
          'bloque cercado con su pregunta.',
      );
    }
    const fence = /^(`{3,})/.exec(lines[j])[1];
    const body = [];
    let k = j + 1;
    for (; k < lines.length; k += 1) {
      if (lines[k] === fence) break;
      body.push(lines[k]);
    }
    if (k >= lines.length) {
      throw new Error(
        `${label}: el bloque abierto en la línea ${j + 1} no se cierra nunca.`,
      );
    }
    const question = normalizeText(body.join('\n'));
    if (hashText(question) !== marker.hash) {
      throw new Error(
        `${label}: la pregunta de la decisión ${marker.hash} (línea ${marker.line + 1}) ` +
          'ya no coincide con su resumen; alguien la editó a mano. No se escribe nada.',
      );
    }
    entries.push({ ...marker, question });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// build()
// ---------------------------------------------------------------------------

/**
 * Everything the run will put on disk, in memory.
 *
 * Nothing here touches the output files: the caller compares, reports and only
 * then writes, which is what makes `--check` honest.
 */
export async function build(options = {}) {
  const cfg = loadConfig(options);
  const adrMap = options.adrMap ?? loadAdrMap(cfg.adrMapPath);
  const config = readSessions(options.sessionsPath);
  const includeLocal = options.includeLocal === true;

  // The corpus is committed, so it may only be built from sessions that are
  // committed too. `sessions.local.json` is gitignored and holds whatever this
  // machine listed by hand: letting it in would put decisions in the
  // numbering on one machine and nowhere else, and `--check` would then fail
  // on every other machine. `--include-local` is the deliberate exception.
  const chosen = includeLocal
    ? config.sessions
    : config.sessions.filter((s) => config.trackedIds.has(s.id));
  const skippedLocal = includeLocal
    ? []
    : config.sessions.filter((s) => !config.trackedIds.has(s.id));

  const asks = [];
  const plans = [];
  const humans = [];
  const results = new Map();
  let sessionsRead = 0;
  const missing = [];

  for (const session of chosen) {
    const transcript = session.transcript;
    if (!transcript || !fs.existsSync(transcript)) {
      console.warn(`sesión ${session.id}: no encuentro su transcripción (${transcript ?? '—'}), se salta`);
      missing.push(session.id);
      continue;
    }
    const streams = await readTranscriptStreams(transcript, session.id);
    sessionsRead += 1;
    asks.push(...streams.asks);
    plans.push(...streams.plans);
    humans.push(...streams.humans);
    for (const [id, value] of streams.results) if (!results.has(id)) results.set(id, value);
  }

  const model = buildModel({ asks, plans, humans, results, cutoffMs: cfg.cutoffMs });

  // Closing rule. Results and human prompts are deliberately NOT filtered by
  // the cutoff -- an answer that arrived after it still belongs to the dialog
  // under it -- so a cutoff at the live end of a transcript would render a
  // dialog with no answer yet, or a rejection with no reason yet, and the very
  // same cutoff would render something else tomorrow. Requiring the cutoff to
  // be at or before the last thing Edson typed closes that window: everything
  // under the cutoff has already been answered and replied to.
  const lastHuman = model.humans.length ? model.humans[model.humans.length - 1] : null;
  const closingRule = {
    name: 'corte ≤ último prompt humano',
    cutoff: cfg.cutoff,
    lastHuman: lastHuman?.at ?? null,
    held: Boolean(lastHuman) && cfg.cutoffMs <= Date.parse(lastHuman.at),
  };
  if (model.decisions.length > 0 || model.plans.length > 0) {
    if (!lastHuman) {
      throw new Error(
        `Regla de cierre «${closingRule.name}»: las transcripciones no traen ningún prompt ` +
          'humano, así que no se puede saber si el corte está cerrado. No se escribe nada.',
      );
    }
    if (!closingRule.held) {
      throw new Error(
        `Regla de cierre «${closingRule.name}»: el corte (${cfg.cutoff}) es posterior al ` +
          `último prompt de Edson (${lastHuman.at}). Con un corte en el borde vivo de la ` +
          'transcripción, una respuesta o un motivo que aún no existen cambiarían el ' +
          'contenido en la siguiente pasada con el mismo corte. Atrasa el corte o espera. ' +
          'No se escribe nada.',
      );
    }
  }

  const files = new Map();
  const dayPathOf = (day) => path.join(cfg.daysDir, `${day}.md`);
  const ctx = {
    cutoff: cfg.cutoff,
    indexPath: cfg.indexPath,
    historyDir: cfg.historyDir,
    dayPathOf,
    adrMap,
    adrIndexPath: cfg.adrIndexPath,
  };

  const byDay = new Map();
  for (const decision of model.decisions) {
    if (!byDay.has(decision.day)) byDay.set(decision.day, []);
    byDay.get(decision.day).push(decision);
  }
  const days = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  for (const [day, decisions] of days) {
    files.set(dayPathOf(day), renderDayFile(day, decisions, ctx));
  }
  if (model.decisions.length > 0 || model.plans.length > 0) {
    files.set(cfg.indexPath, renderIndex(days, ctx));
  }
  for (const plan of model.plans) {
    files.set(path.join(cfg.historyDir, plan.fileName), renderPlanFile(plan));
  }
  if (model.plans.length > 0) {
    files.set(path.join(cfg.historyDir, 'README.md'), renderHistoryReadme(model.plans, ctx));
  }

  // ADR generated blocks. Every `docs/adr/NNNN-slug.md` already on disk gets
  // its `adr:generated` fragment rebuilt from `adr-map.json`; a file with no
  // `D-nnnn` behind it (like `ADR-0001` today) renders an empty block, which
  // is not an error. Everything outside the markers is read back from disk
  // untouched, so a hand-written Contexto/Decisión/Consecuencias section
  // never shows up as a change.
  const decisionsByNumber = new Map(model.decisions.map((d) => [d.number, d]));
  const adrByNumber = invertAdrMap(adrMap);
  for (const { file, number } of adrFiles(cfg)) {
    const label = path.relative(REPO_ROOT, file).split(path.sep).join('/');
    const raw = readIfExists(file);
    if (raw === null) continue; // listed by readdirSync, gone by the time we read it
    const dNumbers = adrByNumber.get(`ADR-${number}`) ?? [];
    const blockLines = renderAdrBlock(file, dNumbers, decisionsByNumber, ctx);
    files.set(file, spliceAdrBlock(raw, blockLines, label));
  }

  // (i) Renderer sanity: what we are about to write must read back identical.
  for (const [file, content] of files) {
    if (path.dirname(file) !== cfg.daysDir) continue;
    const back = parseDayFile(content, path.basename(file));
    if (back.length !== (byDay.get(path.basename(file, '.md'))?.length ?? 0)) {
      throw new Error(
        `${path.basename(file)}: se renderizaron ${
          byDay.get(path.basename(file, '.md'))?.length ?? 0
        } decisiones pero solo se recuperan ${back.length}.`,
      );
    }
  }

  const kinds = {};
  for (const decision of model.decisions) kinds[decision.kind] = (kinds[decision.kind] ?? 0) + 1;

  const report = {
    cutoff: cfg.cutoff,
    closingRule,
    includeLocal,
    sessions: chosen.length,
    sessionsRead,
    sessionsMissing: missing,
    sessionsUsed: chosen.map((s) => ({ id: s.id, label: s.label ?? '', tracked: config.trackedIds.has(s.id) })),
    sessionsSkipped: skippedLocal.map((s) => ({ id: s.id, label: s.label ?? '' })),
    dialogs: model.dialogs.length,
    answered: model.dialogs.filter((d) => d.answered).length,
    unanswered: model.dialogs.filter((d) => !d.answered).length,
    questions: model.decisions.length,
    options: model.decisions.reduce((n, d) => n + d.options.length, 0),
    previews: model.decisions.reduce((n, d) => n + d.options.filter((o) => o.preview).length, 0),
    multiSelect: model.decisions.filter((d) => d.multiSelect).length,
    kinds,
    pairs: model.decisions.filter((d) => d.pairRole === 'origen').length,
    plansApproved: model.plans.filter((p) => p.approved).length,
    plansRejected: model.plans.filter((p) => !p.approved).length,
    plansError: model.planIssues.error,
    plansMissing: model.planIssues.missing,
    days: days.map(([day, decisions]) => ({ day, count: decisions.length })),
  };

  return { files, report, model, config: cfg };
}

// ---------------------------------------------------------------------------
// Disk
// ---------------------------------------------------------------------------

function readIfExists(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/** Markdown already on disk under the generated directories. */
export function existingFiles(cfg) {
  const out = [];
  for (const dir of [cfg.daysDir, cfg.historyDir]) {
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.md')) continue;
      const full = path.join(dir, name);
      if (fs.statSync(full).isFile()) out.push(full);
    }
  }
  return out;
}

/** (ii) Every day file already on disk must still match its own hashes. */
export function guardHandEdits(cfg) {
  let names = [];
  try {
    names = fs.readdirSync(cfg.daysDir);
  } catch {
    return 0;
  }
  let checked = 0;
  for (const name of names.filter((n) => n.endsWith('.md'))) {
    const full = path.join(cfg.daysDir, name);
    const text = readIfExists(full);
    if (text === null) continue;
    parseDayFile(text, path.relative(REPO_ROOT, full).split(path.sep).join('/'));
    checked += 1;
  }
  return checked;
}

export function compareFiles(files, cfg) {
  const changed = [];
  const unchanged = [];
  for (const [file, content] of files) {
    const current = readIfExists(file);
    if (current === content) unchanged.push(file);
    else changed.push(file);
  }
  const known = new Set(files.keys());
  const orphans = existingFiles(cfg).filter((f) => !known.has(f));
  return { changed, unchanged, orphans };
}

/** Write only what changed: temp file plus rename, LF, under one lock. */
export function writeFiles(files, changed, cfg) {
  return withLock(cfg.indexPath, () => {
    for (const file of changed) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = path.join(path.dirname(file), `.tmp-${process.pid}-${path.basename(file)}`);
      fs.writeFileSync(tmp, files.get(file), 'utf8');
      fs.renameSync(tmp, file);
    }
    return changed.length;
  });
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function rel(file) {
  const r = path.relative(REPO_ROOT, file);
  return (r.startsWith('..') ? file : r).split(path.sep).join('/');
}

export function formatReport(report, disk, files) {
  const lines = [];
  lines.push(`Corte: ${report.cutoff}`);
  lines.push(
    `Regla de cierre «${report.closingRule.name}»: se cumple ` +
      `(último prompt de Edson: ${report.closingRule.lastHuman ?? '—'})`,
  );
  lines.push(
    `Sesiones: ${report.sessionsRead} leídas de ${report.sessions}` +
      (report.sessionsMissing.length ? ` (sin transcripción: ${report.sessionsMissing.join(', ')})` : ''),
  );
  for (const session of report.sessionsUsed) {
    lines.push(`  usada ${session.tracked ? '(seguida)' : '(local)'}: ${session.id} — ${session.label}`);
  }
  if (report.sessionsSkipped.length) {
    lines.push(
      `Sesiones locales omitidas: ${report.sessionsSkipped.length} ` +
        '(no están en git; usa --include-local para incluirlas)',
    );
    for (const session of report.sessionsSkipped) {
      lines.push(`  omitida (local): ${session.id} — ${session.label}`);
    }
  }
  lines.push(
    `Diálogos: ${report.dialogs} (respondidos ${report.answered}, sin respuesta ${report.unanswered})`,
  );
  lines.push(
    `Preguntas: ${report.questions} · opciones: ${report.options} · ` +
      `vistas previas: ${report.previews} · multiselección: ${report.multiSelect}`,
  );
  const kinds = Object.entries(report.kinds).sort((a, b) => b[1] - a[1]);
  lines.push(`Tipos: ${kinds.length ? kinds.map(([k, v]) => `${k} ${v}`).join(', ') : '—'}`);
  lines.push(`Parejas pregunta/repregunta: ${report.pairs}`);
  lines.push(
    `Planes: ${report.plansApproved} aprobados, ${report.plansRejected} rechazados, ` +
      `${report.plansError} con error de herramienta, ${report.plansMissing} sin resultado`,
  );
  if (disk) {
    lines.push(
      `Archivos: ${disk.written} escritos, ${disk.unchanged} sin cambios, ` +
        `${disk.orphans.length} huérfanos`,
    );
    for (const orphan of disk.orphans) {
      lines.push(`  huérfano (no se borra): ${rel(orphan)}`);
    }
  }
  let biggest = null;
  for (const entry of report.days) {
    const file = [...files.keys()].find((f) => path.basename(f) === `${entry.day}.md`);
    if (!file) continue;
    const bytes = Buffer.byteLength(files.get(file), 'utf8');
    if (!biggest || bytes > biggest.bytes) biggest = { file, bytes, day: entry.day };
  }
  if (biggest) {
    lines.push(`Día más grande: ${rel(biggest.file)} (${biggest.bytes} bytes)`);
  }
  return lines.join('\n');
}

export async function main(argv = process.argv.slice(2)) {
  const check = argv.includes('--check');
  const includeLocal = argv.includes('--include-local');
  const at = argv.indexOf('--config');
  const configPath = at >= 0 ? argv[at + 1] : undefined;

  let built;
  try {
    built = await build({ configPath, includeLocal });
  } catch (err) {
    console.error(`No se pudo extraer: ${err.message}`);
    return 1;
  }
  const { files, report, config: cfg } = built;

  if (report.questions === 0 && report.plansApproved + report.plansRejected === 0) {
    console.log('nada que extraer en esta máquina');
    return 1;
  }

  try {
    guardHandEdits(cfg);
  } catch (err) {
    console.error(err.message);
    return 1;
  }

  const { changed, unchanged, orphans } = compareFiles(files, cfg);

  if (check) {
    console.log(formatReport(report, { written: 0, unchanged: unchanged.length, orphans }, files));
    if (changed.length === 0) {
      console.log('sin cambios');
      return 0;
    }
    console.log(`Cambiarían ${changed.length} archivo(s):`);
    for (const file of changed) console.log(`  ${rel(file)}`);
    console.log('Ejecuta `npm run decisions:build` para regenerarlos.');
    return 1;
  }

  writeFiles(files, changed, cfg);
  console.log(
    formatReport(report, { written: changed.length, unchanged: unchanged.length, orphans }, files),
  );
  for (const file of changed) console.log(`  escrito: ${rel(file)}`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(err?.stack ?? String(err));
      process.exitCode = 1;
    },
  );
}
