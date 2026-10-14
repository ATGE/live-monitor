import React from 'react';
import Icon from '../Icon.jsx';
import CardSection from './CardSection.jsx';
import { laneSummary } from '../PlanReview.jsx';
import { moveStepLabel } from '../../status.js';
import { useStrings } from '../../i18n/useStrings.js';
import { fill, plural } from '../../i18n/index.js';

// What waits on you goes first: a question from a session, a plan to approve.
// Not while the task is parked: the session that asked is gone with the
// window, so answering would go nowhere — and a question-mark icon here would
// be the very thing the pill above promises is not there.
//
// `variant="expanded"` is the amber (or red, after a failure) block of the
// stretched card; `variant="footer"` is only the main action of the closed one.
export default function DecisionGroup({ task, m, h, compact = false, variant = 'expanded' }) {
  const t = useStrings();
  const { pending, park, machine, mode, moving, readyPlan, failedAt, rerunning, prPark, priorWork, canStart, chats } = m;
  const { onRetry, onStart, onSetMode, onAcceptFix, onPublishPr, onAnswer, onReviewPlan, onRetryMove, onDiscardMove } = h;

  const askedQuestion = pending?.kind === 'question' && !park;
  const failed = task.state === 'error' && !rerunning;
  const canDiscardMove = Boolean(moving?.error) && machine === moving.from;

  const retryTitle = failedAt ? fill(t.card.decision.retryTitleAt, { phase: failedAt }) : t.card.decision.retryTitle;
  const publishTitle = t.card.decision.publishTitle;
  const acceptFixTitle = t.card.decision.acceptFixTitle;
  const startTitle = t.card.decision.startTitle;
  const autoTitle = t.card.decision.autoTitle;
  const manualTitle = t.card.decision.manualTitle;

  if (variant === 'footer') {
    // One main action per state; a task that runs, or sleeps on the quota, shows none.
    return (
      <>
        {askedQuestion && (
          <button type="button" className="btn btn-warn btn-sm" onClick={() => onAnswer(task.issue)} title={t.card.decision.answerTitle}>
            <Icon name="help-circle" /> {t.card.decision.answer}
          </button>
        )}
        {readyPlan && (
          <button type="button" className="btn btn-warn btn-sm" onClick={() => onReviewPlan(task.issue)} title={t.card.decision.reviewPlanTitle}>
            <Icon name="note" /> {t.card.decision.reviewPlan}
          </button>
        )}
        {prPark && (
          <button type="button" className="btn btn-warn btn-sm" onClick={() => onPublishPr(task.issue)} title={publishTitle}>
            <Icon name="note" /> {t.card.decision.publishPr}
          </button>
        )}
        {task.state === 'error' && !rerunning && (
          <button type="button" className="btn btn-sm" onClick={() => onRetry(task.issue)} title={retryTitle}>
            <Icon name="repeat" /> {t.card.decision.retry}
          </button>
        )}
        {canStart && (
          <button type="button" className="btn btn-warn btn-sm" onClick={() => onStart(task.issue)} title={startTitle}>
            <Icon name="rocket" /> {t.card.decision.startTask}
          </button>
        )}
        {mode === 'unconfirmed' && (
          <>
            <button type="button" className="btn btn-warn btn-sm" onClick={() => onSetMode(task.issue, 'auto')} title={autoTitle}>
              <Icon name="bot" /> {t.card.decision.auto}
            </button>
            <button type="button" className="btn btn-sm" onClick={() => onSetMode(task.issue, 'manual')} title={manualTitle}>
              <Icon name="hand" /> {t.card.decision.manual}
            </button>
          </>
        )}
        {moving?.error && (
          <button type="button" className="btn btn-warn btn-sm" onClick={() => onRetryMove(task.issue)}
            title={t.card.decision.retryMoveTitle}>
            {t.card.decision.retryMove}
          </button>
        )}
      </>
    );
  }

  // A failure is its own red block: the error text is the shell's, the way out is here.
  if (failed) {
    return (
      <CardSection title={failedAt ? fill(t.card.decision.failedAt, { phase: failedAt }) : t.card.decision.failed} tone="danger">
        <div className="tcd-stack">
          {prPark && (
            <button type="button" className="btn btn-warn btn-block tcd-main" onClick={() => onPublishPr(task.issue)} title={publishTitle}>
              <Icon name="note" /> {t.card.decision.publishPr}
            </button>
          )}
          <div className="tcd-pair">
            <button type="button" className="btn tcd-half" onClick={() => onRetry(task.issue)} title={retryTitle}>
              <Icon name="repeat" /> {t.card.decision.retry}
            </button>
            {task.state === 'error' && !rerunning && task.hasWorktree && (
              <button type="button" className="btn tcd-half tcd-outline" onClick={() => onAcceptFix(task.issue)} title={acceptFixTitle}>
                <Icon name="play" /> {t.card.decision.continueFromTests}
              </button>
            )}
          </div>
        </div>
        {moving?.error && (
          <MoveFailed task={task} moving={moving} canDiscard={canDiscardMove} onRetryMove={onRetryMove} onDiscardMove={onDiscardMove} />
        )}
      </CardSection>
    );
  }

  const asked = askedQuestion ? (chats ?? []).find((c) => c.id === pending.chatId) : null;
  const questionText = pending?.questions?.[0]?.question ?? null;
  const count = [askedQuestion, Boolean(readyPlan), mode === 'unconfirmed', Boolean(canStart), Boolean(moving?.error)]
    .filter(Boolean).length;
  if (count === 0) return null;

  const waves = readyPlan?.waves ?? [];
  const nTasks = readyPlan?.tasks?.length ?? 0;

  return (
    <CardSection title={t.card.decision.title} tone="warn" count={count}>
      {askedQuestion && (
        <div className="tcd-block">
          <p className="tcd-label">
            <Icon name="help-circle" /> {asked ? fill(t.card.decision.askedIn, { chat: asked.title }) : t.card.decision.asked}
          </p>
          {questionText && <p className="tcd-text">{questionText}</p>}
          <button type="button" className="btn btn-amber btn-block tcd-main" onClick={() => onAnswer(task.issue)}
            title={t.card.decision.answerTitle}>
            <Icon name="help-circle" /> {t.card.decision.answer}
          </button>
        </div>
      )}
      {askedQuestion && readyPlan && <div className="tcd-sep" aria-hidden="true" />}
      {readyPlan && (
        <div className="tcd-block">
          <p className="tcd-text tcd-plan">
            <Icon name="clipboard" />
            <span>
              {fill(waves.length > 0 ? t.card.decision.planWaves : t.card.decision.plan, {
                version: readyPlan.version ?? 1,
                tasks: plural(nTasks, t.common.task),
                waves: plural(waves.length, t.card.decision.waves),
              })}
            </span>
          </p>
          <div className="tcd-plan-row">
            {waves.length > 0 && (
              <span className="tcd-lanes" title={t.card.decision.lanesTitle}>{laneSummary(waves)}</span>
            )}
            <span className="tcd-fill" />
            <button type="button" className="btn btn-warn-outline btn-sm" onClick={() => onReviewPlan(task.issue)}
              title={t.card.decision.reviewPlanTitle}>
              <Icon name="note" /> {t.card.decision.reviewPlan}
            </button>
          </div>
        </div>
      )}

      {canStart && (
        <button type="button" className={`btn btn-block tcd-main ${priorWork ? 'btn-warn' : 'btn-amber'}`}
          onClick={() => onStart(task.issue)} title={startTitle}>
          <Icon name="rocket" /> {t.card.decision.startTask}
        </button>
      )}

      {/* A suspicion is a question, so it gets an answer, not a switch:
          the two buttons stand where the «Manual» switch would be, until you
          have decided. */}
      {mode === 'unconfirmed' && (
        <div className="tcd-block">
          {task.suspect && (
            <p className="tcd-text">
              {task.suspect.where === 'etiqueta' ? t.card.decision.suspectLabel : fill(t.card.decision.suspectIn, { where: task.suspect.where })}
              {' '}<q className="tcd-quote">{task.suspect.quote}</q>
            </p>
          )}
          <div className="tcd-pair">
            <button type="button" className="btn btn-amber tcd-half" onClick={() => onSetMode(task.issue, 'auto')} title={autoTitle}>
              <Icon name="bot" /> {t.card.decision.auto}
            </button>
            <button type="button" className="btn btn-warn tcd-half" onClick={() => onSetMode(task.issue, 'manual')} title={manualTitle}>
              <Icon name="hand" /> {t.card.decision.manual}
            </button>
          </div>
        </div>
      )}

      {moving?.error && (
        <MoveFailed task={task} moving={moving} canDiscard={canDiscardMove} onRetryMove={onRetryMove} onDiscardMove={onDiscardMove} />
      )}
    </CardSection>
  );
}

// A failed move: what failed and where, then the way to retry or to forget it.
function MoveFailed({ task, moving, canDiscard, onRetryMove, onDiscardMove }) {
  const t = useStrings();
  return (
    <div className="tcd-block tcd-move">
      <span className="tcd-move-chip" title={moving.error}>
        <Icon name="alert-triangle" /> {fill(t.card.decision.moveFailed, { to: moving.to, step: moveStepLabel(moving) })}
      </span>
      <div className="tcd-pair">
        <button type="button" className="btn btn-warn btn-sm" onClick={() => onRetryMove(task.issue)}
          title={t.card.decision.retryMoveTitle}>
          {t.card.decision.retryMove}
        </button>
        {canDiscard && (
          <button type="button" className="btn btn-sm" onClick={() => onDiscardMove(task.issue)}
            title={fill(t.card.decision.discardTitle, { from: moving.from })}>
            {t.card.decision.discard}
          </button>
        )}
      </div>
    </div>
  );
}
