import React, { useEffect, useRef, useState } from 'react';
import { useChatFallback, useOpenPath, useRefScope } from './context.js';
import { groupMachines, lookupRef } from './refMachines.js';
import { resolveWithFallback } from './chatPaths.js';
import { fill } from '../i18n/index.js';
import { useStrings } from '../i18n/useStrings.js';

/**
 * One chip per machine that holds `refText`, next to a file reference. The
 * wrapper always renders (the observer needs something to watch) and stays
 * empty while loading, on error or when nothing resolves. The effect depends on
 * the scope's values and the ref only: `override` is a new object every render.
 */
export default function MachineChips({ refText, override }) {
  const v = useStrings().viewer;
  const openPath = useOpenPath();
  const getScope = useRefScope(override);
  const wrap = useRef(null);
  const [chips, setChips] = useState([]);
  // Read at render only to key the effect; the effect re-reads the scope when it fires.
  const { project, issue, machine } = getScope ? getScope() : {};
  const getScopeRef = useRef(getScope);
  getScopeRef.current = getScope;
  const enabled = Boolean(openPath);
  // A string, not the function: it keys the effect and only changes with the chat's own paths.
  const fallbackRef = useChatFallback()?.(refText) ?? null;

  useEffect(() => {
    if (!enabled) return undefined;
    let dead = false;
    // A new ref must not show the previous one's machines while it resolves.
    setChips([]);
    const go = () => {
      const s = getScopeRef.current?.() ?? {};
      const lookup = (ref) => lookupRef({ project: s.project, issue: s.issue, machine: s.machine, ref });
      // The bare name as always; the chat's own full path only when it finds nothing.
      resolveWithFallback(lookup, refText, fallbackRef)
        .then(({ result: r }) => { if (!dead) setChips(r ? groupMachines(r.candidates, r.line) : []); })
        .catch(() => { if (!dead) setChips([]); });
    };
    const el = wrap.current;
    let io = null;
    if (el && typeof IntersectionObserver === 'function') {
      io = new IntersectionObserver((entries) => {
        if (entries.some((e) => e.isIntersecting)) { io.disconnect(); go(); }
      });
      io.observe(el);
    } else {
      go();
    }
    return () => { dead = true; io?.disconnect(); };
  }, [enabled, project, issue, machine, refText, fallbackRef]);

  if (!openPath) return null;
  return (
    <span className="file-ref-machines" ref={wrap}>
      {chips.map((c) => (
        <button
          key={c.machine}
          type="button"
          className="chip chip-machine file-ref-machine"
          title={fill(v.openCopyOn, { machine: c.machine })}
          onClick={() => openPath(c)}
        >📍 {c.machine}</button>
      ))}
    </span>
  );
}
