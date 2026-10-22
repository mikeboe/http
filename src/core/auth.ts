import * as http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { fetch } from 'undici';
import type { Auth } from './model';
import type { ResolvedRequest } from './resolve';
import { mask } from './http';
import type { TimelineEntry } from './http';

export interface TokenStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
}

export class MemoryTokenStore implements TokenStore {
  private m = new Map<string, string>();
  async get(key: string) { return this.m.get(key); }
  async set(key: string, value: string) { this.m.set(key, value); }
  async delete(key: string) { this.m.delete(key); }
  async clear() { this.m.clear(); }
}

export interface AuthDeps {
  tokens: TokenStore;
  openBrowser(url: string): Promise<void>;
  envName: string;
  timeline: TimelineEntry[];
  callbackTimeoutMs?: number;
}

type OAuth = Extract<Auth, { type: 'oauth2' }>;
interface Cached { access_token: string; refresh_token?: string; expires_at?: number }

const EXPIRY_SKEW_MS = 30_000;
const DEFAULT_CALLBACK_TIMEOUT_MS = 300_000;

export function tokenKey(envName: string, auth: Auth): string {
  if (auth.type !== 'oauth2') throw new Error('tokenKey requires oauth2 auth');
  const h = createHash('sha256').update([auth.tokenUrl, auth.clientId, auth.scope ?? '', auth.grant].join('|')).digest('hex');
  return `oauth:${envName}:${h}`;
}

export async function clearTokens(store: TokenStore): Promise<void> {
  await store.clear();
}

const lower = (s: string) => s.toLowerCase();
function setHeader(req: ResolvedRequest, name: string, value: string): void {
  req.headers = req.headers.filter(([k]) => lower(k) !== lower(name));
  req.headers.push([name, value]);
}

export async function applyAuth(req: ResolvedRequest, deps: AuthDeps): Promise<void> {
  const a = req.auth;
  switch (a.type) {
    case 'none': case 'inherit': return;
    case 'basic':
      req.secrets.add(a.password);
      setHeader(req, 'Authorization', 'Basic ' + Buffer.from(`${a.username}:${a.password}`).toString('base64'));
      return;
    case 'bearer':
      req.secrets.add(a.token);
      setHeader(req, 'Authorization', `Bearer ${a.token}`);
      return;
    case 'apiKey':
      req.secrets.add(a.value);
      if (a.in === 'header') {
        req.headers.push([a.name, a.value]);
      } else {
        const q = new URLSearchParams();
        q.append(a.name, a.value);
        const enc = q.toString();
        const hash = req.url.indexOf('#');
        const base = hash >= 0 ? req.url.slice(0, hash) : req.url;
        const frag = hash >= 0 ? req.url.slice(hash) : '';
        req.url = base + (base.includes('?') ? (/[?&]$/.test(base) ? '' : '&') : '?') + enc + frag;
        req.secrets.add(encodeURIComponent(a.value));
        req.secrets.add(enc.slice(enc.indexOf('=') + 1));
      }
      return;
    case 'oauth2': {
      if (a.clientSecret) req.secrets.add(a.clientSecret);
      const token = await oauthToken(a, req, deps);
      req.secrets.add(token);
      setHeader(req, 'Authorization', `Bearer ${token}`);
    }
  }
}

function parseCached(raw: string | undefined): Cached | undefined {
  if (!raw) return undefined;
  try {
    const c = JSON.parse(raw) as Cached;
    return typeof c.access_token === 'string' ? c : undefined;
  } catch { return undefined; }
}

async function oauthToken(a: OAuth, req: ResolvedRequest, deps: AuthDeps): Promise<string> {
  const key = tokenKey(deps.envName, a);
  const cached = parseCached(await deps.tokens.get(key));
  if (cached) {
    if (cached.expires_at === undefined || Date.now() < cached.expires_at - EXPIRY_SKEW_MS) return cached.access_token;
    if (cached.refresh_token) {
      try {
        const t = await tokenRequest(a, req, new URLSearchParams({ grant_type: 'refresh_token', refresh_token: cached.refresh_token }), cached.refresh_token);
        await deps.tokens.set(key, JSON.stringify(t));
        deps.timeline.push({ kind: 'info', text: 'OAuth token refreshed' });
        return t.access_token;
      } catch { /* fall through to a full fetch */ }
    }
    await deps.tokens.delete(key);
  }
  let t: Cached;
  if (a.grant === 'clientCredentials') {
    t = await tokenRequest(a, req, new URLSearchParams({ grant_type: 'client_credentials' }));
    deps.timeline.push({ kind: 'info', text: 'OAuth token fetched (client credentials)' });
  } else {
    t = await authorizationCode(a, req, deps);
    deps.timeline.push({ kind: 'info', text: 'OAuth token fetched (authorization code)' });
  }
  await deps.tokens.set(key, JSON.stringify(t));
  return t.access_token;
}

async function tokenRequest(a: OAuth, req: ResolvedRequest, params: URLSearchParams, prevRefresh?: string): Promise<Cached> {
  if (a.scope && params.get('grant_type') !== 'refresh_token') params.set('scope', a.scope);
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  if (a.clientSecret) headers.authorization = 'Basic ' + Buffer.from(`${a.clientId}:${a.clientSecret}`).toString('base64');
  else params.set('client_id', a.clientId);
  const res = await fetch(a.tokenUrl, { method: 'POST', headers, body: params.toString() });
  const text = await res.text();
  if (res.status < 200 || res.status >= 300) {
    throw new Error(mask(`OAuth token request failed: ${res.status} ${text.slice(0, 200)}`, req.secrets));
  }
  let j: { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };
  try { j = JSON.parse(text); } catch { throw new Error('OAuth token response was not JSON'); }
  if (typeof j.access_token !== 'string') throw new Error('OAuth token response has no access_token');
  const out: Cached = { access_token: j.access_token };
  const rt = typeof j.refresh_token === 'string' ? j.refresh_token : prevRefresh;
  if (rt) out.refresh_token = rt;
  const exp = Number(j.expires_in);
  if (j.expires_in !== undefined && Number.isFinite(exp)) out.expires_at = Date.now() + exp * 1000;
  return out;
}

async function authorizationCode(a: Extract<OAuth, { grant: 'authorizationCode' }>, req: ResolvedRequest, deps: AuthDeps): Promise<Cached> {
  const state = randomBytes(16).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  let port = 0;
  let cbPath = '/callback';
  if (a.redirectUri) {
    const u = new URL(a.redirectUri);
    port = u.port ? Number(u.port) : 80;
    cbPath = u.pathname || '/';
  }
  let server: http.Server | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    const result = new Promise<string>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('OAuth authorization timed out waiting for the browser callback')), deps.callbackTimeoutMs ?? DEFAULT_CALLBACK_TIMEOUT_MS);
      server = http.createServer((rq, rs) => {
        const u = new URL(rq.url ?? '/', 'http://127.0.0.1');
        if (u.pathname !== cbPath) { rs.statusCode = 404; rs.end('Not found'); return; }
        const err = u.searchParams.get('error');
        const code = u.searchParams.get('code');
        const send = (status: number, msg: string) => { rs.statusCode = status; rs.setHeader('content-type', 'text/plain'); rs.end(msg); };
        if (u.searchParams.get('state') !== state) { send(400, 'State mismatch.'); reject(new Error('OAuth state mismatch')); return; }
        if (err) { send(400, `Authorization failed: ${err}`); reject(new Error(`OAuth authorization failed: ${err}`)); return; }
        if (!code) { send(400, 'Missing code.'); reject(new Error('OAuth callback had no code')); return; }
        send(200, 'You can close this tab.');
        resolve(code);
      });
      server.once('error', reject);
      server.listen(port, '127.0.0.1');
    });
    result.catch(() => {});
    await new Promise<void>((res, rej) => {
      if (server!.listening) return res();
      server!.once('listening', res);
      server!.once('error', rej);
    });
    const redirectUri = a.redirectUri ?? `http://127.0.0.1:${(server!.address() as AddressInfo).port}${cbPath}`;
    const url = new URL(a.authUrl);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', a.clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    if (a.scope) url.searchParams.set('scope', a.scope);
    url.searchParams.set('state', state);
    if (a.pkce !== false) {
      url.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'));
      url.searchParams.set('code_challenge_method', 'S256');
    }
    await deps.openBrowser(url.toString());
    const code = await result;
    const params = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
    if (a.pkce !== false) params.set('code_verifier', verifier);
    return await tokenRequest(a, req, params);
  } finally {
    if (timer) clearTimeout(timer);
    if (server) { server.closeAllConnections(); server.close(); }
  }
}
