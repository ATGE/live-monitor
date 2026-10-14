import React from 'react';
import Dialog from './Dialog.jsx';
import Icon from './Icon.jsx';
import Kbd from './ui/Kbd.jsx';
import { PUBLISH_YES, PUBLISH_NO, PUBLISH_COPY, publishTarget } from '../publishQuestion.js';
import { useStrings } from '../i18n/useStrings.js';

/**
 * The confirmation the artifact gate asks before an unattended session may
 * publish a canvas to the person's own account. It is a risk dialog on
 * purpose: two answers only, «No» focused first, and no way to hand the
 * decision back to Claude (no skip button exists here). Esc and the close
 * button only dismiss the window — the question stays pending on the server,
 * and if nobody answers in time nothing is published.
 */
export default function PublishConfirm({ questions, source = 'board', who = '', submitting = false, onSubmit, onDismiss = null }) {
  const t = useStrings();
  const q = questions[0];
  const target = publishTarget(questions);
  const title = !target || target.action === 'publish' ? PUBLISH_COPY.title : PUBLISH_COPY.otherTitle(target.tool, target.action);
  const asker = source === 'board' ? t.chat.asker.board : t.chat.asker.claude;
  const answer = (label) => { if (!submitting) onSubmit({ [q.question]: label }); };

  const header = (
    <div className="pub-head">
      <span className="pub-slab" aria-hidden="true"><Icon name="alert-triangle" /></span>
      <div className="pub-head-text">
        <div className="pub-meta">
          <span className="pub-chip">{q.header}</span>
          <span className="pub-asker">{asker}{who ? ` · ${who}` : ''}</span>
        </div>
        <h2 id="pub-title" className="pub-title">{title}</h2>
      </div>
    </div>
  );

  return (
    <Dialog title={title} tone="danger" role="alertdialog" header={header} onDismiss={onDismiss}
      dismissLabel={t.chat.publish.dismiss} className="pub-dialog"
      hint={<span className="pub-hint"><Kbd>Esc</Kbd>{/* i18n-ok: the key's name */} <span>{PUBLISH_COPY.escHint}</span></span>}>
      <div className="pub-body">
        <p id="pub-question" className="pub-question">{q.question}</p>
        <div id="pub-dest" className="pub-dest">
          <span className="pub-dest-label">{PUBLISH_COPY.destination}</span>
          <div className="pub-dest-row">
            <span className="pub-dest-icon" aria-hidden="true"><Icon name="palette" /></span>
            <strong className="pub-dest-title">{target?.title || t.chat.publish.untitled}</strong>
          </div>
        </div>
        <div className="pub-answers" role="group" aria-label={t.chat.publish.answers}>
          <button type="button" className="pub-answer pub-no" autoFocus disabled={submitting}
            onClick={() => answer(PUBLISH_NO)}>
            <span className="pub-answer-label"><Icon name="x" />{t.common.no}</span>
            <span className="pub-answer-desc">{PUBLISH_COPY.noDesc}</span>
          </button>
          <button type="button" className="pub-answer pub-yes btn btn-danger-solid" disabled={submitting}
            onClick={() => answer(PUBLISH_YES)}>
            <span className="pub-answer-label"><Icon name="arrow-up" />{t.chat.publish.yes}</span>
            <span className="pub-answer-desc">{PUBLISH_COPY.yesDesc}</span>
          </button>
        </div>
      </div>
    </Dialog>
  );
}
