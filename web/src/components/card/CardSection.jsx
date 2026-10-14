import React, { useId } from 'react';

/**
 * One titled section of the card's controls. `tone` colours the head only
 * (`warn` and `danger` also tint the block); `count` and `aside` sit at its
 * right, `note` is the line under the title. The section is labelled by its own
 * title so a screen reader announces the group, not just a heading.
 */
export default function CardSection({ title, note, aside, tone = 'default', count, children }) {
  const titleId = useId();
  return (
    <section className={`tc-section tc-section-${tone}`} aria-labelledby={titleId}>
      <header className="tc-section-head">
        <h3 className="tc-section-title" id={titleId}>{title}</h3>
        {count != null && <span className="tc-section-count">{count}</span>}
        {aside != null && <span className="tc-section-aside">{aside}</span>}
      </header>
      {note && <p className="tc-section-note">{note}</p>}
      {children}
    </section>
  );
}
