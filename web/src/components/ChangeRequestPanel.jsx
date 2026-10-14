import React from 'react';
import Icon from './Icon.jsx';
import Markdown from './Markdown.jsx';
import { useStrings } from '../i18n/useStrings.js';
import { fill, splitAround } from '../i18n/index.js';
import { formatDateTime } from '../i18n/format.js';

/**
 * The review itself, read in the side panel next to the chat — which is where
 * it gets worked on. The card in the board only holds the controls.
 *
 * It is also where the drafted answers are read before they are published: the
 * agent writes them, but nothing reaches the reviewer until you have seen the
 * words that will carry your name.
 */
export default function ChangeRequestPanel({ task, reviewId, onClose, onDraft, onDiscard, onPublish, pending = false }) {
  const t = useStrings();
  const cr = (task.changeRequests ?? []).find((c) => c.reviewId === reviewId);
  if (!cr) return null;

  const fecha = cr.submittedAt ? formatDateTime(cr.submittedAt) : '';
  const drafts = cr.draftReplies ?? [];
  const drafting = cr.status === 'drafting';

  return (
    <section className="subpanel">
      <header>
        <h3><Icon name="note"/> {fill(t.card.crPanel.title, { author: cr.author })}</h3>
        <div className="sp-actions">
          <a className="btn btn-sm" href={cr.url} target="_blank" rel="noreferrer"><Icon name="external"/> {t.card.crPanel.viewOnGithub}</a>
          <button type="button" className="btn btn-close" onClick={onClose} aria-label={t.common.close} title={t.common.close}><Icon name="x"/></button>
        </div>
      </header>
      <p className="panel-sub">
        {/* `task.prNumber` is only the current cycle's PR (contract: null once
            it's merged/closed), so a change request left open across a cycle
            change would otherwise print the literal «PR #null». */}
        #{task.issue} · {task.prNumber ? `PR #${task.prNumber}` : t.card.crPanel.noPr} · {fecha}
        {cr.commitId && <> · {splitAround(t.card.crPanel.onCommit, { commit: cr.commitId.slice(0, 8) }).map((part) => (part.hole
          ? <code key={part.key}>{part.text}</code> : <React.Fragment key={part.key}>{part.text}</React.Fragment>))}</>}
      </p>

      <div className="subpanel-body">
        {(drafts.length > 0 || drafting) && (
          <div className="cr-drafts">
            <h4>
              <Icon name="pencil"/> {t.card.crPanel.drafted}
              {drafting && <span className="spinner" />}
            </h4>
            <p className="muted">{t.card.crPanel.draftsNote}</p>

            {drafts.map((d) => (
              <div className="cr-draft" key={d.threadId}>
                <span className="cr-comment-where">{d.path}{d.line ? `:${d.line}` : ''}</span>
                <Markdown text={d.body} />
              </div>
            ))}

            {cr.draftSummary && (
              <div className="cr-draft">
                <span className="cr-comment-where">
                  {drafts.length ? t.card.crPanel.summaryUnpublished : t.card.crPanel.prComment}
                </span>
                <Markdown text={cr.draftSummary} />
              </div>
            )}

            {drafts.length > 0 && (
              <div className="cr-draft-actions">
                <button type="button" className="btn btn-primary btn-md" disabled={cr.status !== 'fixed' || pending} onClick={() => onPublish(cr.reviewId)}>
                  <Icon name="check-circle"/> {fill(t.card.crPanel.publish, { author: cr.author })}
                </button>
                <button type="button" className="btn btn-md" onClick={() => onDraft(cr.reviewId)} disabled={drafting}><Icon name="refresh"/> {t.card.crPanel.redraft}</button>
                <button type="button" className="btn btn-danger btn-sm" onClick={() => onDiscard(cr.reviewId)} disabled={drafting}>
                  {t.card.crPanel.discard}
                </button>
              </div>
            )}
          </div>
        )}

        {cr.body ? <Markdown text={cr.body} /> : <p className="muted">{t.card.crPanel.noBody}</p>}

        <h4 className="cr-comments-title">{fill(t.card.crPanel.inline, { n: (cr.comments ?? []).length })}</h4>
        {(cr.comments ?? []).length === 0 && (
          <p className="muted">{t.card.crPanel.noInline}</p>
        )}
        {(cr.comments ?? []).map((c) => (
          <div className="cr-comment" key={c.id}>
            <a className="cr-comment-where" href={c.url} target="_blank" rel="noreferrer">
              {c.path}{c.line ? `:${c.line}` : ''}
            </a>
            <Markdown text={c.body} />
          </div>
        ))}
      </div>
    </section>
  );
}
