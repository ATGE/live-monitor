import { useEffect, useState } from 'react';
import { api } from './api.js';
import { pluginChips, readPlugins } from './pluginChip.js';

/**
 * The required-plugins state of every machine, shared by whatever paints it.
 *
 * Self-contained like LoginChips: it reads the state on mount and on every
 * reconnect, and follows the `board-plugins` window event (the WebSocket
 * `plugins` broadcast, forwarded by App). Installing is only ever a click.
 *
 * @returns {{ state: object, chips: object[], error: string|null, install: (machine: string, id: string) => void }}
 */
export function usePlugins() {
  const [state, setState] = useState({ required: [], machines: {} });
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    const load = () => api.pluginsState().then((r) => { if (alive) setState(readPlugins(r)); }).catch(() => {});
    load();
    const onState = (ev) => setState(readPlugins(ev.detail));
    window.addEventListener('board-connected', load);
    window.addEventListener('board-plugins', onState);
    return () => {
      alive = false;
      window.removeEventListener('board-connected', load);
      window.removeEventListener('board-plugins', onState);
    };
  }, []);

  const install = (machine, id) => {
    setError(null);
    api.installPlugin(machine, id).catch((e) => setError(e.message));
  };

  return { state, chips: pluginChips(state), error, install };
}

export default usePlugins;
