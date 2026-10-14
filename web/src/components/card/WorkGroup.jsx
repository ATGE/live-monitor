import React from 'react';
import Icon from '../Icon.jsx';
import LiveDot from '../ui/LiveDot.jsx';
import CardSection from './CardSection.jsx';
import { useStrings } from '../../i18n/useStrings.js';
import { fill, plural } from '../../i18n/index.js';

/** The one that gets pressed most, so it says whether anything is alive. */
export function ChatButton({ task, m, h }) {
  const t = useStrings();
  const { chatPending, chats, chatsBusy } = m;
  const { onChat } = h;
  return (
    <button type="button" className="btn btn-sm tcw-btn tcw-chat" onClick={() => onChat(task.issue)}
      title={chatsBusy ? plural(chatsBusy, t.card.work.chatBusy)
        : chatPending ? t.card.work.chatWaiting
          : task.hasWorktree ? t.card.work.chatWorktree
            : t.card.work.chatNoWorktree}>
      <Icon name="message" /> <span>Chat{chats.length > 1 && <span className="tcw-count"> ·{chats.length}</span>}</span>{/* i18n-ok: Chat is the same word in every language */}
      {chatsBusy > 0 && <LiveDot />}
      {chatPending > 0 && (
        <span className="tcw-ask" role="img" aria-label={t.card.work.chatWaiting} title={t.card.work.chatWaiting}>
          <Icon name="help-circle" />
        </span>
      )}
    </button>
  );
}

/** The board's own plan, while one is running or stopped: done / not skipped. */
export function PlanButton({ task, m, h }) {
  const t = useStrings();
  const { onReviewPlan } = h;
  const plan = task.workPlan;
  if (!plan || task.state === 'plan_ready' || !['running', 'asking', 'stopped', 'failed'].includes(plan.status)) return null;
  const steps = plan.tasks ?? [];
  const done = steps.filter((s) => s.status === 'done').length;
  const total = steps.filter((s) => s.status !== 'skipped').length;
  return (
    <button type="button" className="btn btn-sm tcw-btn tcw-plan" onClick={() => onReviewPlan(task.issue)}
      title={t.card.work.planTitle}>
      <Icon name="clipboard" /> <span>Plan{total > 0 ? ` ${done}/${total}` : ''}</span>{/* i18n-ok: Plan is the same word in every language */}
    </button>
  );
}

const QA_VERDICT_ICON = { pass: 'check-circle', fail: 'x-circle', unverified: 'alert-triangle' };

export default function WorkGroup({ task, m, h, compact = false, variant = 'expanded' }) {
  const t = useStrings();
  const { qaChecked, qaTotal } = m;
  const { onDemo, onLog, onTimeline, onQa } = h;
  const verdictIcon = QA_VERDICT_ICON[task.qaVerdict];
  return (
    <CardSection title={t.card.work.title} aside={(
      <span className="tcw-aside">
        <button type="button" className="btn btn-ghost btn-xs tcw-aside-btn" onClick={() => onLog(task.issue)} title={t.card.work.logTitle}><Icon name="scroll" /> Log</button>{/* i18n-ok: Log is the same word in every language */}
        <button type="button" className="btn btn-ghost btn-xs tcw-aside-btn" onClick={() => onTimeline(task.issue)} title={t.card.work.timesTitle}><Icon name="timer" /> {t.card.work.times}</button>
      </span>
    )}>
      <div className="tcw-row">
        <ChatButton task={task} m={m} h={h} />
        <PlanButton task={task} m={m} h={h} />
      </div>
      <div className="tcw-row">
        <button type="button" className="btn btn-sm tcw-btn" onClick={() => onDemo(task.issue)} title={t.card.work.demoTitle}><Icon name="film" /> <span>Demo</span></button>{/* i18n-ok: Demo reads the same in every language */}
        <button type="button" className={`btn btn-sm tcw-btn tcw-qa tcw-qa-${task.qaVerdict ?? 'none'}`} onClick={() => onQa(task.issue)}
          title={task.qaVerdict === 'pass' ? t.card.work.qaPass
            : task.qaVerdict === 'fail' ? t.card.work.qaFail
              : task.qaVerdict === 'unverified' ? t.card.work.qaUnverified
                : task.qaUi === false ? t.card.work.qaNoUi : t.card.work.qaDefault}>
          <Icon name="compass" /> Browser QA{task.qaEvidenceCount > 0 && <span className="tcw-count"> ·{task.qaEvidenceCount}</span>}{/* i18n-ok: Browser QA is a product name */}
          {verdictIcon && <Icon name={verdictIcon} className="tcw-verdict" />}
          {task.qaBusy && <LiveDot />}
        </button>
      </div>
      {task.qaVerdict === 'unverified' && (
        <p className="tcw-qa-note"
          title={t.card.work.qaNote}>
          <Icon name="alert-triangle" /> {qaTotal > 0 ? fill(t.card.work.qaIncompleteCounts, { checked: qaChecked, total: qaTotal }) : t.card.work.qaIncomplete}
        </p>
      )}
    </CardSection>
  );
}
