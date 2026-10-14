import React from 'react';
import { pageUrl } from './fileApi.js';
import { fill } from '../i18n/index.js';
import { useStrings } from '../i18n/useStrings.js';

/**
 * An `.html` file as a page. Only `.html`, like the server's `/api/files/page`
 * (which rejects anything else); `FILE_KINDS` does not open `.htm`.
 */
export const isHtmlPath = (path) => /\.html$/i.test(String(path ?? ''));

/** «Page | Code», in the viewer's header. */
export function PageToggle({ mode, onChange }) {
  const v = useStrings().viewer;
  return (
    <div className="viewer-switch viewer-page-toggle" role="group" aria-label={v.pageViewAria}>
      {[['page', v.pageTab], ['code', v.codeTab]].map(([id, label]) => (
        <button key={id} className={mode === id ? 'on' : ''} aria-pressed={mode === id} onClick={() => onChange(id)}>{label}</button>
      ))}
    </div>
  );
}

/**
 * The page in an iframe with an empty `sandbox`: no scripts, no same-origin
 * access, no forms, no top navigation; the server's CSP says the same. It
 * cannot report its height, so the frame fills the viewer's body (CSS) and the
 * page scrolls inside it. `version` changes the URL when the file changed, so
 * the live reload reloads the frame, as `imgVersion` does for an image.
 */
export function HtmlPage({ entry, version }) {
  const s = useStrings().viewer;
  const v = version ? `&v=${encodeURIComponent(version)}` : '';
  return <iframe className="viewer-page" sandbox="" src={`${pageUrl(entry)}${v}`} title={fill(s.pageTitle, { path: entry.path })} />;
}
