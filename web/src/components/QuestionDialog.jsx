import React, { useEffect, useMemo, useState } from 'react';
import Dialog from './Dialog.jsx';
import Markdown from './Markdown.jsx';
import MicButton from './MicButton.jsx';
import { useDictation, dictationSupport, useStopDictationOnEscape } from '../useDictation.js';
import { useAutoGrow } from '../useAutoGrow.js';
import Icon from './Icon.jsx';
import PublishConfirm from './PublishConfirm.jsx';
import { isPublishQuestion } from '../publishQuestion.js';
import { useStrings } from '../i18n/useStrings.js';
import { fill } from '../i18n/index.js';

/** The label the model marks as its pick, in either language. */
const RECOMMENDED = /\s*\((recommended|recomendad[oa])\)\s*$/i;
const isRecommended = (label) => RECOMMENDED.test(label);
const bareLabel = (label) => label.replace(RECOMMENDED, '').trim();
const OTHER = '__other__';

/**
 * The gate's «publish this canvas?» question gets its own risk dialog; every
 * other question gets the choice dialog. Two components so the hooks of the
 * choice dialog never run conditionally.
 */
export default function QuestionDialog(props) {
  if (isPublishQuestion(props.questions)) return <PublishConfirm {...props} />;
  return <ChoiceDialog {...props} />;
}

/**
 * Questions with options, as the Claude Code extension shows them: one tab
 * per question, cards for the options with the recommended one first, a
 * free-text «Otro», Anterior/Siguiente and Enviar once every question has an
 * answer. `source` says who asks — Claude, or the board when a plan task
 * ran out of retries. `onSkip` hands the decision back to Claude.
 */
function ChoiceDialog({ questions, source = 'claude', who = '', preview = null, onSubmit, onSkip = null, onDismiss = null, submitting = false }) {
  const t = useStrings();
  const [tab, setTab] = useState(0);
  const [draft, setDraft] = useState(() => Object.fromEntries(questions.map((q) => [q.question, { picked: [], other: '', useOther: false }])));
  const [hover, setHover] = useState(null);

  const q = questions[tab];
  const options = useMemo(() => {
    const yes = q.options.filter((o) => isRecommended(o.label));
    const no = q.options.filter((o) => !isRecommended(o.label));
    return [...yes, ...no];
  }, [q]);
  const d = draft[q.question];

  const answerOf = (question) => {
    const x = draft[question.question];
    const picks = [...x.picked];
    if (x.useOther && x.other.trim()) picks.push(x.other.trim());
    if (question.multiSelect) return picks.length ? picks : null;
    return picks[0] ?? null;
  };
  const answered = (question) => answerOf(question) !== null;
  const allAnswered = questions.every(answered);

  const pick = (label) => setDraft((prev) => {
    const cur = prev[q.question];
    if (label === OTHER) return { ...prev, [q.question]: { ...cur, useOther: !cur.useOther, picked: q.multiSelect ? cur.picked : [] } };
    if (q.multiSelect) {
      const picked = cur.picked.includes(label) ? cur.picked.filter((l) => l !== label) : [...cur.picked, label];
      return { ...prev, [q.question]: { ...cur, picked } };
    }
    return { ...prev, [q.question]: { ...cur, picked: [label], useOther: false } };
  });
  const setOther = (text) => setDraft((prev) => ({ ...prev, [q.question]: { ...prev[q.question], other: text, useOther: true } }));

  const dictation = useDictation({ onText: setOther });
  const micSupport = dictationSupport();
  const otherRef = useAutoGrow({ value: d.other });
  // Dictating, the first Escape stops the microphone and keeps the draft; the
  // second one closes the dialog.
  useStopDictationOnEscape(dictation);
  // `setOther` closes over the question this render is showing: a dictation
  // that outlived the tab — or the «Otro» box being put away — would write
  // its words into the previous question's answer.
  useEffect(() => { dictation.abort(); }, [tab]);
  useEffect(() => { if (!d.useOther) dictation.abort(); }, [d.useOther]);

  const submit = () => {
    if (!allAnswered || submitting) return;
    onSubmit(Object.fromEntries(questions.map((question) => [question.question, answerOf(question)])));
  };

  const focused = hover ? options.find((o) => o.label === hover) : (options.find((o) => d.picked.includes(o.label)) ?? options[0]);
  const showPreview = options.some((o) => o.preview) || preview;
  const last = tab === questions.length - 1;
  const title = [source === 'board' ? t.chat.asker.board : t.chat.asker.claude, who].filter(Boolean).join(' · ');

  return (
    <Dialog title={title} icon="help-circle" onDismiss={onDismiss} wide className="qdialog"
      footer={(
        <>
          {onSkip && source !== 'board' && (
            <button className="btn btn-ghost btn-md" onClick={onSkip} disabled={submitting} title={t.chat.question.skipTitle}>{t.chat.question.skip}</button>
          )}
          <span className="modal-spacer" />
          {questions.length > 1 && <button className="btn btn-ghost btn-md" onClick={() => setTab((t) => Math.max(0, t - 1))} disabled={tab === 0}>{t.chat.question.previous}</button>}
          {!last && <button className="btn btn-primary btn-md" onClick={() => setTab((t) => t + 1)} disabled={!answered(q)}>{t.chat.question.next} <Icon name="chevron-right" /></button>}
          {last && <button className="btn btn-primary btn-md" onClick={submit} disabled={!allAnswered || submitting}>{submitting ? t.chat.question.submitting : t.chat.question.submit}</button>}
        </>
      )}>
      {questions.length > 1 && (
        <div className="q-tabs" role="tablist">
          {questions.map((question, i) => (
            <button key={question.question} role="tab" aria-selected={i === tab}
              className={`q-tab ${i === tab ? 'is-active' : ''} ${answered(question) ? 'is-answered' : ''}`}
              onClick={() => setTab(i)}>
              <span className="q-dot" aria-hidden="true" />{question.header}
            </button>
          ))}
          <span className="q-count">{fill(t.chat.question.count, { n: tab + 1, total: questions.length })}</span>
        </div>
      )}

      <p className="q-question">{q.question}</p>
      {q.multiSelect && <p className="q-hint">{t.chat.question.multiHint}</p>}

      <div className={`q-body ${showPreview ? 'with-preview' : ''}`}>
        <div className="q-options" role={q.multiSelect ? 'group' : 'radiogroup'}>
          {options.map((o) => {
            const on = d.picked.includes(o.label);
            return (
              <button key={o.label} type="button"
                className={`option-card ${on ? 'is-on' : ''} ${isRecommended(o.label) ? 'is-recommended' : ''}`}
                role={q.multiSelect ? 'checkbox' : 'radio'} aria-checked={on}
                onClick={() => pick(o.label)} onMouseEnter={() => setHover(o.label)} onMouseLeave={() => setHover(null)}>
                <span className={`option-mark ${q.multiSelect ? 'is-box' : ''}`} aria-hidden="true">{on ? (q.multiSelect ? <Icon name="check" /> : <Icon name="dot" />) : ''}</span>
                <span className="option-text">
                  <span className="option-label">{bareLabel(o.label)}{isRecommended(o.label) && <span className="option-reco">{t.chat.question.recommended}</span>}</span>
                  {o.description && <span className="option-desc">{o.description}</span>}
                </span>
              </button>
            );
          })}
          <div className={`option-card option-other ${d.useOther ? 'is-on' : ''}`} onClick={() => { if (!d.useOther) pick(OTHER); }}>
            <span className={`option-mark ${q.multiSelect ? 'is-box' : ''}`} aria-hidden="true">{d.useOther ? (q.multiSelect ? <Icon name="check" /> : <Icon name="dot" />) : ''}</span>
            <span className="option-text">
              <span className="option-label">{t.chat.question.otherLabel}</span>
              {/* The mic goes outside `.option-label`, which is bold. */}
              {d.useOther ? (
                <span className="option-other-row">
                  <textarea
                    className="option-input" ref={otherRef} autoFocus rows={2}
                    placeholder={dictation.listening ? t.chat.listening : t.chat.question.otherPlaceholder}
                    value={d.other} onChange={(e) => setOther(e.target.value)} onClick={(e) => e.stopPropagation()}
                  />
                  <MicButton
                    className="mic-inline" listening={dictation.listening} support={micSupport}
                    stopPropagation onToggle={() => dictation.toggle(d.other)}
                  />
                </span>
              ) : <span className="option-desc">{t.chat.question.otherHint}</span>}
              {/* A phone has no tooltips, so an unusable mic has to say why on screen. */}
              {d.useOther && !micSupport.ok && <span className="dictation-error"><Icon name="mic" /> {micSupport.reason}</span>}
              {d.useOther && dictation.error && <span className="dictation-error">{dictation.error}</span>}
            </span>
          </div>
        </div>
        {showPreview && (
          <div className="preview-box">
            {focused?.preview ? <Markdown text={focused.preview} /> : preview ? <Markdown text={preview} /> : <span className="muted">{t.chat.question.previewHint}</span>}
          </div>
        )}
      </div>
    </Dialog>
  );
}
