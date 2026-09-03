const TOKEN_KEY = 'ci_access_token';
const LEGACY_KEY = 'ci_api_key';

export const auth = {
  token: () => sessionStorage.getItem(TOKEN_KEY),
  legacyKey: () => localStorage.getItem(LEGACY_KEY),
  saveToken: (token: string) => sessionStorage.setItem(TOKEN_KEY, token),
  saveLegacyKey: (key: string) => localStorage.setItem(LEGACY_KEY, key),
  clear: () => { sessionStorage.removeItem(TOKEN_KEY); localStorage.removeItem(LEGACY_KEY); },
};

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = auth.token();
  const apiKey = auth.legacyKey();
  const headers = new Headers(options.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  else if (apiKey) headers.set('X-API-Key', apiKey);
  if (options.body) headers.set('Content-Type', 'application/json');
  const response = await fetch(path, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? body.message ?? `HTTP ${response.status}`);
  return body as T;
}
