// What a session may do with the `Artifact` tools (Claude Design canvases).
//
// Pure on purpose, like installgate.js: it reads no store and no config, because
// a gate that can throw on a lookup is a gate with a hole in it. The wiring
// (a `PreToolUse` hook in pipeline.js) decides `design` — whether this session
// is a design session — and parks the confirmation; this module only judges.
//
// It fails closed, the opposite of the `gh` gate: an action it does not know,
// or one that is missing (the tool publishes when `action` is omitted), asks a
// person first. The only thing that passes without asking is a known read.

export const ARTIFACT_TOOLS = ['Artifact', 'ArtifactComments', 'ArtifactData'];

// Actions that only read, as the three tools really name them (measured, ADR-0082):
// `Artifact` list/read/quickstart, `ArtifactData` get/list/query. `publish` (also with
// `asset: true`), `delete`, `open`, `pin`, `unpin`, `set`, `update`, `str_replace`,
// `batch`, `reply`, `resolve` and `watch` are not here, so they ask (`Artifact` `delete`
// asks only in plan mode and is denied outside it). Compared exactly: `LIST` or ` list` is not on the
// list, so it asks.
export const READ_ACTIONS = ['list', 'read', 'quickstart', 'get', 'query'];

// The one answer that lets a held call through. Anything else — "Other",
// another label, free text — is a no.
export const CONFIRM_LABEL = 'Yes, publish';
// Pending questions stored before the switch to English carry the Spanish label.
const LEGACY_CONFIRM_LABEL = 'Sí, publicar';
export const isConfirmLabel = (label) => label === CONFIRM_LABEL || label === LEGACY_CONFIRM_LABEL;
export const REFUSE_LABEL = 'No';

const DELETE_UNAVAILABLE = 'Borrar un lienzo no está disponible en esta sesión: el CLI solo lo permite con el chat en modo plan. Bórralo desde claude.ai (menú del lienzo) o con `/artifacts` en la terminal de Claude Code (tecla d). No lo reintentes aquí.';

export const isArtifactTool = (tool) => ARTIFACT_TOOLS.includes(tool);

function actionOf(input) {
  const a = input?.action;
  return typeof a === 'string' ? a : null;
}

/**
 * @param {{ tool: string, input?: object, design: boolean, subagent?: boolean, planMode?: boolean }} args
 *   `design` is true only when the session was launched as a design session;
 *   it must never be derived from issue or plan text. `planMode` is true only
 *   when the session really runs under the CLI's plan permission mode: that is
 *   the one place where `Artifact` `delete` can be confirmed (measured, ADR-0082);
 *   anywhere else the CLI refuses it whatever the person answers, so it is denied
 *   up front instead of asking a question that cannot matter.
 * @returns {{ decision: 'allow'|'ask'|'deny', reason: string }}
 */
export function artifactVerdict({ tool, input, design, subagent = false, planMode = false } = {}) {
  if (!isArtifactTool(tool)) return { decision: 'allow', reason: 'not an Artifact tool' };
  if (design !== true) {
    return { decision: 'deny', reason: 'Esta sesión no es una sesión de diseño: las herramientas Artifact no están disponibles aquí.' };
  }
  const action = actionOf(input);
  if (action !== null && READ_ACTIONS.includes(action)) {
    return { decision: 'allow', reason: `${tool} ${action} solo lee` };
  }
  const what = action === null ? 'sin acción (publica por omisión)' : action;
  if (subagent) {
    return { decision: 'deny', reason: `Un subagente solo puede leer lienzos; ${tool} ${what} lo hace el hilo principal, con confirmación.` };
  }
  if (tool === 'Artifact' && action === 'delete' && planMode !== true) {
    return { decision: 'deny', reason: DELETE_UNAVAILABLE };
  }
  return { decision: 'ask', reason: `${tool} ${what} publica, cambia o borra: hace falta que una persona lo confirme.` };
}

const clip = (v, n = 120) => {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

/**
 * One question, two options, in the shape `normalizeQuestions` accepts
 * (header of 12 characters or fewer).
 */
export function artifactQuestion(tool, input) {
  const action = actionOf(input) ?? 'publish';
  // The title, else the artifact's link, else just the file's name: a scratchpad path is noise.
  const file = String(input?.file_path ?? '').split(/[\\/]/).filter(Boolean).pop();
  const target = clip(input?.title ?? input?.url ?? file ?? input?.asset_id ?? input?.label ?? '');
  const text = `Allow Claude to run ${tool} ${action}${target ? ` («${target}»)` : ''}?`;
  return {
    questions: [{
      question: text,
      header: 'Artifact',
      multiSelect: false,
      options: [
        { label: CONFIRM_LABEL, description: 'Runs the action now; it may publish, pin, upload or delete in your Claude Design account.' },
        { label: REFUSE_LABEL, description: 'Does not run it; Claude goes on without it.' },
      ],
    }],
  };
}
