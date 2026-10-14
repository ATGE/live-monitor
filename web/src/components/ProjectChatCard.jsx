import React from 'react';
import Icon from './Icon.jsx';
import Chip from './ui/Chip.jsx';
import LiveDot from './ui/LiveDot.jsx';
import { useStrings } from '../i18n/useStrings.js';
import { fill, plural } from '../i18n/index.js';

/**
 * The project chat card: a conversation with no issue behind it, so it has
 * no task buttons and no state. The whole card opens the chat. It is a
 * summary from the server (`kind: 'project'`), never a task.
 */
export default function ProjectChatCard({ holder, showMachine, onOpen }) {
  const t = useStrings();
  const chats = (holder.chats ?? []).filter((c) => !c.closedAt);
  const working = chats.filter((c) => c.busy).length;
  const busy = Boolean(holder.busy) || working > 0;
  const asking = chats.filter((c) => c.pending).length;
  const head = holder.head ?? null;
  const headLine = head
    ? (head.branch ? fill(t.board.branchLine, { branch: head.branch }) : `detached @ ${head.sha ?? '?'}`)
    : null;
  const open = () => onOpen?.(holder);
  return (
    <article id={`card-${holder.key}`} className="bd-project" role="button" tabIndex={0}
      title={t.board.projectHint}
      onClick={open}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } // i18n-ok: KeyboardEvent.key
      }}>
      <header className="bd-project-head">
        <span className="bd-project-badge" aria-hidden="true"><Icon name="message" /></span>
        <span className="bd-project-title">{t.board.projectTitle}</span>
        <code className="bd-project-base">{holder.baseBranch ?? 'main'}</code>
        {chats.length > 0 && <span className="bd-project-chats">{plural(chats.length, t.board.chatsCount)}</span>}
      </header>
      {(showMachine || headLine) && (
        <div className="bd-project-meta">
          {showMachine && <Chip icon="map-pin">{holder.machine}</Chip>}
          {headLine && <code className="bd-project-head-line" title={headLine}>{headLine}</code>}
        </div>
      )}
      {busy && (
        <div className="bd-project-live">
          <LiveDot />
          <span>{working > 0 ? plural(working, t.board.chatsWorking) : t.board.conversationWorking}</span>
        </div>
      )}
      {asking > 0 && (
        <div className="bd-project-ask">
          <Icon name="help-circle" />
          <span>{plural(asking, t.board.chatsAsking)}</span>
        </div>
      )}
    </article>
  );
}
