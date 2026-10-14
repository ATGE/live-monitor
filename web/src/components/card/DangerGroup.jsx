import React from 'react';
import Icon from '../Icon.jsx';
import CardSection from './CardSection.jsx';
import { useStrings } from '../../i18n/useStrings.js';
import { fill } from '../../i18n/index.js';

// «Zona de peligro»: the only place the card keeps destructive or
// hard-to-undo actions. Nothing here while the task works: the worktree is in
// use, and the note says when the button comes back.
export default function DangerGroup({ task, m, h, compact = false, variant = 'expanded' }) {
  const t = useStrings();
  const { busy, machine, canCloseIssue, closePublishing, closeBlocked, closeWhy } = m;
  const { onDeleteWorktree, onCloseIssue } = h;
  const canDelete = task.hasWorktree && !busy;
  const lockedWorktree = task.hasWorktree && busy;
  if (!canDelete && !lockedWorktree && !canCloseIssue) return null;
  return (
    <CardSection title={t.card.danger.title}>
      <div className="tcx-danger">
        {canDelete && (
          <div className="tcx-danger-item">
            <button type="button" className="btn btn-danger btn-sm" onClick={() => onDeleteWorktree(task.issue)}
              title={t.card.danger.worktreeTitle}>
              <Icon name="trash" /> Worktree{/* i18n-ok: git term, the same in every language */}
            </button>
            <p className="tcx-danger-help">{fill(t.card.danger.worktreeHelp, { machine })}</p>
          </div>
        )}
        {lockedWorktree && (
          <p className="tcx-danger-lock"><Icon name="lock" /> <span>{t.card.danger.worktreeLocked}</span></p>
        )}
        {canCloseIssue && (
          <div className="tcx-danger-item">
            {/* Amber only when a chat turn already suggested it: on this board
                amber means «press me». Never `danger` — red is for irreversible
                local destruction (the Worktree button above), and a closed issue
                reopens with one click. */}
            <button type="button" className={`btn btn-sm ${task.closable ? 'btn-warn' : 'btn-secondary'}`} disabled={closeBlocked}
              onClick={() => onCloseIssue(task.issue)}
              title={closePublishing ? t.card.danger.closePublishing
                : !task.hasWorktree ? t.card.danger.closeNeedsWorktree
                  : [task.closable
                    ? (closeWhy ? fill(t.card.danger.closeSuggestedWhy, { why: closeWhy }) : t.card.danger.closeSuggested)
                    : t.card.danger.closeManual,
                  task.hasClosingDraft && t.card.danger.closeDraftExists].filter(Boolean).join(' · ')}>
              <Icon name="lock" /> {t.card.danger.closeIssue}
            </button>
            <p className="tcx-danger-help">{t.card.danger.closeHelp}</p>
          </div>
        )}
      </div>
    </CardSection>
  );
}
