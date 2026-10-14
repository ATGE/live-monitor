import { createContext, useContext } from 'react';
import { lookupRef } from './refMachines.js';
import { resolveWithFallback } from './chatPaths.js';

/** Filled by FileViewerProvider: `{ openFile, openPath, scope, setScope }`. */
export const FileViewerContext = createContext(null);

/**
 * `(ref) => void`, or null when there is no viewer (then callers render plain text).
 * `override` (e.g. an activity tree's own `{ project, issue, chatId }`) wins over the
 * provider's scope, so a relative ref resolves against the chat it came from.
 */
export function useOpenFile(override) {
  const ctx = useContext(FileViewerContext);
  const fallbackFor = useChatFallback();
  if (!ctx) return null;
  return (ref) => {
    const scope = { ...ctx.scope, ...override };
    const fallback = fallbackFor?.(ref);
    if (!fallback) return ctx.openFile({ ...scope, ref });
    // The bare name wins whenever the server finds it; the chat's own full path only when it does not.
    const lookup = (r) => lookupRef({ project: scope.project, issue: scope.issue, machine: scope.machine, ref: r });
    return resolveWithFallback(lookup, ref, fallback)
      .then((r) => ctx.openFile({ ...scope, ref: r.ref }))
      .catch(() => ctx.openFile({ ...scope, ref }));
  };
}

/**
 * Filled by ChatPanel: `{ fallbackFor(ref) }`, the chat's own full path for a
 * bare name (see `chatPaths.js`). Without a provider nothing changes.
 */
export const ChatPathsContext = createContext(null);

/** `(ref) => fullRef | null`, or null outside a chat. */
export function useChatFallback() {
  return useContext(ChatPathsContext)?.fallbackFor ?? null;
}

/** `({ machine, path, line }) => void` opening that machine's copy, or null without a viewer. */
export function useOpenPath() {
  const ctx = useContext(FileViewerContext);
  return ctx ? ({ machine, path, line }) => ctx.openPath({ machine, path, line }) : null;
}

/**
 * `() => scope`, or null without a viewer. The provider's scope is a
 * non-reactive getter, so it is read when the returned function is CALLED
 * (inside an effect or a click), never while rendering.
 */
export function useRefScope(override) {
  const ctx = useContext(FileViewerContext);
  return ctx ? () => ({ ...ctx.scope, ...override }) : null;
}
