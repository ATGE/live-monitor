import React, { useEffect, useRef, useState } from 'react';
import Icon from './Icon.jsx';
import { api } from '../api.js';
import { sameTask } from '../taskKey.js';
import { useStrings } from '../i18n/useStrings.js';

export default function LogPanel({ task, onClose }) {
  const t = useStrings();
  const [log, setLog] = useState([]);
  const scrollRef = useRef(null);

  useEffect(() => {
    api.log(task.project, task.issue).then((r) => setLog(r.log));
    // By task, not by issue: two projects can both have a #12.
    const onLog = (ev) => {
      if (sameTask(ev.detail, task)) setLog((prev) => [...prev, ev.detail.entry]);
    };
    window.addEventListener('task-log', onLog);
    return () => window.removeEventListener('task-log', onLog);
  }, [task.project, task.issue]);

  useEffect(() => {
    scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight);
  }, [log]);

  return (
    <section className="subpanel subpanel-log">
      <header>
        <h3><Icon name="scroll"/> #{task.issue} · {task.state}</h3>
        <button type="button" className="btn btn-close" onClick={onClose} aria-label={t.common.close} title={t.common.close}><Icon name="x"/></button>
      </header>
      <div className="log sp-log" ref={scrollRef}>
        {log.map((e, i) => (
          <div key={i} className="log-line">
            <span className="ts">{e.ts.slice(11, 19)}</span>
            <span className={`phase phase-${e.phase}`}>{e.phase}</span>
            <span className="text">{e.line}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
