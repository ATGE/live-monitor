import React from 'react';
import Icon from './Icon.jsx';
import { useStrings } from '../i18n/useStrings.js';
import { fill } from '../i18n/index.js';

/**
 * Which project the board is looking at.
 *
 * The board watches several projects but paints **one at a time**. This is
 * where the old fixed `owner/repo · @assignee` label was, and it follows the
 * «Nuevas en» selector in the Settings menu: with a single project there is
 * nothing to choose, so it stays the plain label it always was. Importing
 * another checkout is no longer here: it lives in the «···» menu.
 *
 * The selection itself is this device's (`activeProject.js`), not the
 * server's: the board is open on a laptop and on a phone at once.
 *
 * `onImported` stays in the signature but is unused (the import dialog moved to
 * `MoreMenu`); callers may still pass it.
 */
// eslint-disable-next-line no-unused-vars
export default function ProjectPicker({ projects = [], active, onSelect, onImported, fallback = null }) {
  const t = useStrings();
  const current = projects.find((p) => p.id === active) ?? null;
  // A board whose server does not send the registry yet keeps the old label.
  const label = current
    ? `${current.repo}${current.assignee ? ` · @${current.assignee}` : ''}`
    : fallback;

  if (projects.length <= 1) {
    return label ? <span className="tb-repo" title={label}>{label}</span> : null;
  }
  return (
    <label className="tb-picker"
      title={fill(t.topbar.picker.switchTitle, { label: label ?? '' })}>
      <Icon name="folder-git"/>
      {/* The native select stays: it is the accessible, phone-friendly list.
          Its name is painted in the button and the select is stretched
          transparent across the whole control. */}
      <span className="tb-picker-name">{current?.name || current?.id || t.topbar.picker.project}</span>
      <Icon name="chevron-down"/>
      <select
        className="tb-picker-select"
        aria-label={t.topbar.picker.project}
        value={active ?? ''}
        onChange={(e) => onSelect(e.target.value)}
      >
        {projects.map((p) => (
          <option key={p.id} value={p.id}>{p.name || p.id}</option>
        ))}
      </select>
    </label>
  );
}
