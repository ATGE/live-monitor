import React from 'react';
import Icon from './Icon.jsx';
import StateButton from './ui/StateButton.jsx';
import { useStrings } from '../i18n/useStrings.js';
import { fill, plural } from '../i18n/index.js';

// The status words live in the catalog (card.cr.status); only the tone is here.
const TONE = {
  pending: 'warn',
  triaging: 'busy',
  fixing: 'busy',
  testing: 'busy',
  drafting: 'busy',
  fixed: 'ok',
  needs_attention: 'warn',
  resolved: 'done',
  superseded: 'done',
};

const BUSY = ['triaging', 'fixing', 'testing', 'drafting'];

/**
 * A change request as a card inside the task's card: the controls only. The
 * review text itself opens in the side panel, because no real review fits
 * legibly in a 304px card.
 */
export default function ChangeRequestCard({ task, cr, onOpen, onToggleActive, onDraft, onStart }) {
  const t = useStrings();
  const active = task.activeChangeRequest === cr.reviewId;
  const info = { label: t.card.cr.status[cr.status] ?? cr.status, tone: TONE[cr.status] ?? 'idle' };
  const busy = BUSY.includes(cr.status);
  const drafts = (cr.draftReplies ?? []).length;
  const answerable = ['fixed', 'needs_attention'].includes(cr.status);

  const toggleTitle = busy ? t.card.cr.toggleBusy : (active ? t.card.cr.toggleActive : t.card.cr.toggleInactive);

  return (
    <div className={`tcc-cr tcc-cr-${info.tone} ${active ? 'is-active' : 'is-idle'}`}>
      <button type="button" className="tcc-cr-open" onClick={() => onOpen(cr.reviewId)}
        title={t.card.cr.openTitle}>
        <span className="tcc-cr-author"><Icon name="note" /> @{cr.author}</span>
        <span className={`tcc-cr-status tcc-cr-status-${info.tone}`}>
          {busy && <span className="spinner" />}{info.label}
        </span>
        <span className="tcc-cr-count">
          {plural((cr.comments ?? []).length, t.card.cr.comments)}
          {drafts > 0 && <> · {plural(drafts, t.card.cr.drafted)}</>}
        </span>
      </button>

      <div className="tcc-cr-actions">
        {/* A button, not a switch: the state is written out and the button says
            what a click does. Busy locks it, as the old switch was. */}
        <span className="tcc-cr-active" title={toggleTitle}>
          <Icon name={active ? 'check-circle' : 'circle-minus'} /> {active ? t.card.cr.active : t.card.cr.inactive}
        </span>
        <StateButton on={active} name={fill(t.card.cr.stateName, { author: cr.author })} disabled={busy} title={toggleTitle}
          onToggle={() => onToggleActive(cr.reviewId, !active)} />

        {/* Two steps on purpose: the agent writes the answers, you read them in
            the side panel, and only then do they reach the reviewer. */}
        {/* A manual task starts nothing by itself, so its change request needs
            a hand. Without this the card would sit pending for ever. */}
        {cr.status === 'pending' ? (
          <button type="button" className="btn btn-primary btn-sm" onClick={() => onStart()}
            title={t.card.cr.startTitle}>
            <Icon name="play" /> {t.card.cr.fix}
          </button>
        ) : drafts === 0 ? (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={!answerable || busy}
            title={answerable
              ? plural((cr.comments ?? []).length, t.card.cr.draftTitle)
              : t.card.cr.notPushed}
            onClick={() => onDraft(cr.reviewId)}
          >{cr.status === 'drafting' ? t.card.cr.drafting : <><Icon name="pencil" /> {t.card.cr.draft}</>}</button>
        ) : (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            title={t.card.cr.readTitle}
            onClick={() => onOpen(cr.reviewId)}
          ><Icon name="check-circle" /> {t.card.cr.ready}</button>
        )}
      </div>
    </div>
  );
}
