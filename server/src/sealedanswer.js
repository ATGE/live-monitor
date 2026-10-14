/**
 * Which text of a finished session a validator should read.
 *
 * `runClaude` adopts a later turn's result over the sealed one when the seal
 * left subagents owing a report (`sealnet.js`). A background subagent that
 * reported inside the sealed turn can also earn a CLI turn of its own whose
 * result is a one-line acknowledgement (measured, `tools/subagent-probe`
 * scenario `inturn`). Then the adopted text is not the answer and the sealed
 * one, returned as `sealedText`, is. A good answer adopted after the seal can
 * be replaced the same way by a later acknowledgement: `replacedTexts` keeps
 * those, newest first. The parallelism nudge has the same shape: its reply can
 * be one sentence, and the first answer travels in `fallbackTexts`.
 * So: the adopted text unless it fails the caller's own check and one of the
 * others passes it (replaced first, then sealed, then the fallbacks in order).
 *
 * `usable(text)` is the caller's validator, true when the text is an answer.
 * `onSealed(origin)` is called when another text is the one returned
 * (`'sealed'`, which also covers a replaced text, or `'fallback'`), so the
 * caller can leave a line in the task log: that is how the guard is counted.
 */
export function answerOf(result, usable, onSealed = null) {
  const text = String(result?.resultText ?? '');
  const others = [];
  for (const t of result?.replacedTexts ?? []) if (t) others.push(['sealed', t]);
  if (result?.sealedText) others.push(['sealed', result.sealedText]);
  for (const t of result?.fallbackTexts ?? []) if (t) others.push(['fallback', t]);
  if (!others.length || usable(text)) return text;
  const hit = others.find(([, t]) => usable(t));
  if (!hit) return text;
  onSealed?.(hit[0]);
  return hit[1];
}

/** A text this short and on one line is a CLI acknowledgement, not an answer. */
export const ACK_MAX_CHARS = 200;

export function looksLikeAcknowledgement(text) {
  const t = String(text ?? '').trim();
  return t.length < ACK_MAX_CHARS && !t.includes('\n');
}

/**
 * `answerOf` for the consumers with no validator of their own (a plan task's
 * summary, a delegate's reply): a text is an answer when it does not look like
 * an acknowledgement. When nothing else qualifies the adopted text stays.
 */
export function substantialAnswerOf(result, onSealed = null) {
  return answerOf(result, (t) => !looksLikeAcknowledgement(t), onSealed);
}
