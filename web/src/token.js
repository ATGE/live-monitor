/**
 * Access token for reaching the board from another device. Arrives once as
 * ?token=… (a link you open on the phone), is kept in localStorage, and is then
 * stripped from the URL so it does not linger in history or get shared by
 * copying the address.
 */
const KEY = 'hfsmon-token';

function capture() {
  try {
    const url = new URL(location.href);
    const fromUrl = url.searchParams.get('token');
    if (fromUrl) {
      localStorage.setItem(KEY, fromUrl);
      url.searchParams.delete('token');
      history.replaceState(null, '', url.pathname + url.search + url.hash);
      return fromUrl;
    }
    return localStorage.getItem(KEY) ?? '';
  } catch {
    return '';
  }
}

export const token = capture();
export const authHeaders = () => (token ? { 'x-hfsmon-token': token } : {});
export const withToken = (url) => (token ? `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}` : url);
