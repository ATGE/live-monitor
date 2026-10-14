import { fill, strings } from './i18n/index.js';

/**
 * The question the server asks before an unattended session may use the Artifact
 * tool (`server/src/artifactgate.js#artifactQuestion`), recognised on the client so
 * the chat can show it as a publish dialog. Plain JS: node imports it in tests.
 * The buttons must return exactly these two labels: the gate matches on them.
 * They are wire values, not screen text: the visible label is `PUBLISH_COPY.yesLabel`
 * (and the catalog's `common.no`) in the language in use. The gate asks in English;
 * the Spanish pair is still read, because a question stored before the switch keeps it.
 */
export const PUBLISH_YES = 'Yes, publish'; // i18n-ok: wire value, see artifactgate.js#CONFIRM_LABEL
export const PUBLISH_NO = 'No'; // i18n-ok: wire value
const PUBLISH_YES_LEGACY = 'Sí, publicar'; // i18n-ok: wire value of questions stored in Spanish

/**
 * True for exactly the question the artifact gate builds: one question, header
 * `Artifact`, single choice, options `Yes, publish` (or the Spanish `Sí, publicar`) and `No`, and nothing else.
 * @param {Array<object>|null|undefined} questions
 */
export function isPublishQuestion(questions) {
  if (!Array.isArray(questions) || questions.length !== 1) return false;
  const q = questions[0];
  if (!q || q.header !== 'Artifact' || q.multiSelect === true) return false; // i18n-ok: wire value
  const labels = Array.isArray(q.options) ? q.options.map((o) => o?.label) : [];
  return labels.length === 2 && (labels.includes(PUBLISH_YES) || labels.includes(PUBLISH_YES_LEGACY))
    && labels.includes(PUBLISH_NO);
}

// «Allow Claude to run <tool> <action>[ («<title>»)]?», or the Spanish wording of a question stored earlier.
const QUESTION_RE = /^(?:Allow Claude to run|¿Permites que Claude ejecute) (\S+) (\S+?)(?: \(«([\s\S]*)»\))?\?$/;

/**
 * Parses the question text into what is being asked.
 * @returns {{ tool: string, action: string, title: string|null }|null} null when the text is not the gate's
 */
export function publishTarget(questions) {
  const text = Array.isArray(questions) ? questions[0]?.question : null;
  if (typeof text !== 'string') return null;
  const m = QUESTION_RE.exec(text);
  return m ? { tool: m[1], action: m[2], title: m[3] ?? null } : null;
}

// Screen text of the publish dialog and its chat bubble, as getters over the catalog.
export const PUBLISH_COPY = {
  get title() { return strings().shared.publish.title; },
  otherTitle: (tool, action) => fill(strings().shared.publish.otherTitle, { tool, action }),
  get destination() { return strings().shared.publish.destination; },
  get yesLabel() { return strings().shared.publish.yesLabel; },
  get noLabel() { return strings().common.no; },
  get yesDesc() { return strings().shared.publish.yesDesc; },
  get noDesc() { return strings().shared.publish.noDesc; },
  get escHint() { return strings().shared.publish.escHint; },
  get pending() { return strings().shared.publish.pending; },
  get answered() { return strings().shared.publish.answered; },
  get unanswered() { return strings().shared.publish.unanswered; },
  canvasAria: (title) => fill(strings().shared.publish.canvasAria, { title }),
};
