import * as http from 'node:http';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { applyAuth, clearTokens, MemoryTokenStore, tokenKey } from '../../src/core/auth';
import type { AuthDeps } from '../../src/core/auth';
import type { Auth } from '../../src/core/model';
import type { ResolvedRequest } from '../../src/core/resolve';
import type { TimelineEntry } from '../../src/core/http';

const servers: http.Server[] = [];
async function serve(h: http.RequestListener, port = 0): Promise<string> {
  const s = http.createServer(h);
  servers.push(s);
  await new Promise<void>((r) => s.listen(port, '127.0.0.1', r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => { s.closeAllConnections(); s.close(r); })));
});

const rq = (auth: Auth, o: Partial<ResolvedRequest> = {}): ResolvedRequest => ({
  method: 'GET', url: 'http://example.test/x', headers: [], body: { kind: 'none' }, timeoutMs: 5000, followRedirects: true,
  verifyTls: true, secrets: new Set(), auth, ...o,
});
const mkDeps = (o: Partial<AuthDeps> = {}): AuthDeps & { timeline: TimelineEntry[] } => ({
  tokens: new MemoryTokenStore(), openBrowser: async () => {}, envName: 'dev', timeline: [], ...o,
});
const hdr = (r: ResolvedRequest, n: string) => r.headers.filter(([k]) => k.toLowerCase() === n.toLowerCase()).map(([, v]) => v);

describe('static auth', () => {
  it('basic', async () => {
    const r = rq({ type: 'basic', username: 'u', password: 'p' }, { headers: [['authorization', 'old']] });
    await applyAuth(r, mkDeps());
    expect(hdr(r, 'Authorization')).toEqual(['Basic ' + Buffer.from('u:p').toString('base64')]);
  });
  it('bearer', async () => {
    const r = rq({ type: 'bearer', token: 't' });
    await applyAuth(r, mkDeps());
    expect(hdr(r, 'Authorization')).toEqual(['Bearer t']);
  });
  it('apiKey header', async () => {
    const r = rq({ type: 'apiKey', in: 'header', name: 'X-Key', value: 'k' });
    await applyAuth(r, mkDeps());
    expect(hdr(r, 'x-key')).toEqual(['k']);
  });
  it('apiKey header replaces a same-name header', async () => {
    const r = rq({ type: 'apiKey', in: 'header', name: 'X-Key', value: 'k' }, { headers: [['x-key', 'old'], ['Other', '1']] });
    await applyAuth(r, mkDeps());
    expect(hdr(r, 'x-key')).toEqual(['k']);
    expect(hdr(r, 'other')).toEqual(['1']);
  });
  it('apiKey query', async () => {
    const r = rq({ type: 'apiKey', in: 'query', name: 'key', value: 'a b' }, { url: 'http://h/x?q=1#frag' });
    await applyAuth(r, mkDeps());
    expect(r.url).toBe('http://h/x?q=1&key=a+b#frag');
  });
  it('credentials added to secrets', async () => {
    const r = rq({ type: 'basic', username: 'u', password: 'pw' });
    await applyAuth(r, mkDeps());
    expect(r.secrets.has('pw')).toBe(true);
    const r2 = rq({ type: 'bearer', token: 'tok' });
    await applyAuth(r2, mkDeps());
    expect(r2.secrets.has('tok')).toBe(true);
    const r3 = rq({ type: 'apiKey', in: 'query', name: 'k', value: 'kv' });
    await applyAuth(r3, mkDeps());
    expect(r3.secrets.has('kv')).toBe(true);
  });
  it('none and inherit do nothing', async () => {
    const r = rq({ type: 'none' });
    await applyAuth(r, mkDeps());
    expect(r.headers).toEqual([]);
  });
});

describe('oauth2 client credentials', () => {
  const tokenServer = async (respond: (body: URLSearchParams, auth?: string) => [number, object]) => {
    const calls: { body: URLSearchParams; auth?: string }[] = [];
    const base = await serve((req, res) => {
      let b = '';
      req.on('data', (d) => (b += d));
      req.on('end', () => {
        const body = new URLSearchParams(b);
        calls.push({ body, auth: req.headers.authorization });
        const [status, json] = respond(body, req.headers.authorization);
        res.statusCode = status;
        res.setHeader('content-type', 'application/json').end(JSON.stringify(json));
      });
    });
    return { base, calls };
  };

  it('fetches and caches', async () => {
    const { base, calls } = await tokenServer(() => [200, { access_token: 'AT', expires_in: 3600 }]);
    const auth: Auth = { type: 'oauth2', grant: 'clientCredentials', tokenUrl: base + '/t', clientId: 'cid', clientSecret: 'sec', scope: 's1' };
    const deps = mkDeps();
    const r1 = rq(auth); const r2 = rq(auth);
    await applyAuth(r1, deps); await applyAuth(r2, deps);
    expect(calls).toHaveLength(1);
    expect(calls[0].body.get('grant_type')).toBe('client_credentials');
    expect(calls[0].body.get('scope')).toBe('s1');
    expect(calls[0].auth).toBe('Basic ' + Buffer.from('cid:sec').toString('base64'));
    expect(hdr(r2, 'authorization')).toEqual(['Bearer AT']);
    expect(r1.secrets.has('AT')).toBe(true);
    expect(r1.secrets.has('sec')).toBe(true);
    expect(deps.timeline.filter((t) => t.kind === 'info')).toHaveLength(1);
  });
  it('sends client_id in body without secret', async () => {
    const { base, calls } = await tokenServer(() => [200, { access_token: 'AT' }]);
    await applyAuth(rq({ type: 'oauth2', grant: 'clientCredentials', tokenUrl: base, clientId: 'cid' }), mkDeps());
    expect(calls[0].body.get('client_id')).toBe('cid');
    expect(calls[0].auth).toBeUndefined();
  });
  it('expired token refreshes', async () => {
    const { base, calls } = await tokenServer((b) => [200, { access_token: b.get('grant_type') === 'refresh_token' ? 'NEW' : 'x' }]);
    const auth: Auth = { type: 'oauth2', grant: 'clientCredentials', tokenUrl: base, clientId: 'c' };
    const deps = mkDeps();
    await deps.tokens.set(tokenKey('dev', auth), JSON.stringify({ access_token: 'OLD', refresh_token: 'RT', expires_at: Date.now() + 10_000 }));
    const r = rq(auth);
    await applyAuth(r, deps);
    expect(calls[0].body.get('grant_type')).toBe('refresh_token');
    expect(calls[0].body.get('refresh_token')).toBe('RT');
    expect(hdr(r, 'authorization')).toEqual(['Bearer NEW']);
  });
  it('expired token without refresh token is re-fetched', async () => {
    const { base, calls } = await tokenServer(() => [200, { access_token: 'FRESH' }]);
    const auth: Auth = { type: 'oauth2', grant: 'clientCredentials', tokenUrl: base, clientId: 'c' };
    const deps = mkDeps();
    await deps.tokens.set(tokenKey('dev', auth), JSON.stringify({ access_token: 'OLD', expires_at: Date.now() - 1 }));
    const r = rq(auth);
    await applyAuth(r, deps);
    expect(calls[0].body.get('grant_type')).toBe('client_credentials');
    expect(hdr(r, 'authorization')).toEqual(['Bearer FRESH']);
  });
  it('non-2xx throws with masked secrets', async () => {
    const { base } = await tokenServer(() => [401, { error: 'bad secret hunter2' }]);
    const auth: Auth = { type: 'oauth2', grant: 'clientCredentials', tokenUrl: base, clientId: 'c', clientSecret: 'hunter2' };
    const err = (await applyAuth(rq(auth), mkDeps()).then(() => undefined, (e: unknown) => e)) as Error;
    expect(err.message).toMatch(/^OAuth token request failed: 401 /);
    expect(err.message).not.toContain('hunter2');
  });
  it('token request is cancelled by the signal', async () => {
    const base = await serve(() => { /* never respond */ });
    const auth: Auth = { type: 'oauth2', grant: 'clientCredentials', tokenUrl: base, clientId: 'c' };
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    const t0 = Date.now();
    await expect(applyAuth(rq(auth), mkDeps({ signal: ac.signal }))).rejects.toThrow(/cancel/i);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
  it('token request times out', async () => {
    const base = await serve(() => { /* never respond */ });
    const auth: Auth = { type: 'oauth2', grant: 'clientCredentials', tokenUrl: base, clientId: 'c' };
    await expect(applyAuth(rq(auth), mkDeps({ tokenTimeoutMs: 50 }))).rejects.toThrow(/timed out/i);
  });
  it('tokenKey is stable and clearTokens empties the store', async () => {
    const a: Auth = { type: 'oauth2', grant: 'clientCredentials', tokenUrl: 'u', clientId: 'c', scope: 's' };
    const h = createHash('sha256').update('u|c|s|clientCredentials').digest('hex');
    expect(tokenKey('dev', a)).toBe(`oauth:dev:${h}`);
    const st = new MemoryTokenStore();
    await st.set('a', '1');
    await clearTokens(st);
    expect(await st.get('a')).toBeUndefined();
  });
});

describe('oauth2 authorization code', () => {
  const setup = async () => {
    const calls: URLSearchParams[] = [];
    const base = await serve((req, res) => {
      let b = '';
      req.on('data', (d) => (b += d));
      req.on('end', () => { calls.push(new URLSearchParams(b)); res.setHeader('content-type', 'application/json').end(JSON.stringify({ access_token: 'AC', expires_in: 60 })); });
    });
    return { base, calls };
  };

  it('with pkce', async () => {
    const { base, calls } = await setup();
    const auth: Auth = { type: 'oauth2', grant: 'authorizationCode', authUrl: 'http://auth.test/authorize', tokenUrl: base, clientId: 'cid', scope: 'read' };
    let authUrl!: URL; let page = '';
    const deps = mkDeps({
      openBrowser: async (u) => {
        authUrl = new URL(u);
        const cb = new URL(authUrl.searchParams.get('redirect_uri')!);
        cb.searchParams.set('code', 'CODE'); cb.searchParams.set('state', authUrl.searchParams.get('state')!);
        page = await (await fetch(cb)).text();
      },
    });
    const r = rq(auth);
    await applyAuth(r, deps);
    expect(authUrl.searchParams.get('response_type')).toBe('code');
    expect(authUrl.searchParams.get('client_id')).toBe('cid');
    expect(authUrl.searchParams.get('scope')).toBe('read');
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(page).toContain('You can close this tab.');
    expect(calls[0].get('grant_type')).toBe('authorization_code');
    expect(calls[0].get('code')).toBe('CODE');
    expect(calls[0].get('redirect_uri')).toBe(authUrl.searchParams.get('redirect_uri'));
    const verifier = calls[0].get('code_verifier')!;
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(authUrl.searchParams.get('code_challenge'));
    expect(hdr(r, 'authorization')).toEqual(['Bearer AC']);
  });
  it('state mismatch answers 400 and keeps waiting for the real callback', async () => {
    const { base, calls } = await setup();
    const auth: Auth = { type: 'oauth2', grant: 'authorizationCode', authUrl: 'http://a/authorize', tokenUrl: base, clientId: 'c' };
    let redirect = '';
    let wrong = 0;
    const deps = mkDeps({
      openBrowser: async (u) => {
        const au = new URL(u);
        redirect = au.searchParams.get('redirect_uri')!;
        const bad = new URL(redirect); bad.searchParams.set('code', 'EVIL'); bad.searchParams.set('state', 'wrong');
        wrong = (await fetch(bad)).status;
        const good = new URL(redirect); good.searchParams.set('code', 'GOOD'); good.searchParams.set('state', au.searchParams.get('state')!);
        await fetch(good);
      },
    });
    const r = rq(auth);
    await applyAuth(r, deps);
    expect(wrong).toBe(400);
    expect(calls.map((c) => c.get('code'))).toEqual(['GOOD']);
    expect(hdr(r, 'authorization')).toEqual(['Bearer AC']);
    await expect(fetch(redirect)).rejects.toThrow();
  });
  it('state mismatch alone ends in the timeout', async () => {
    const { base } = await setup();
    const auth: Auth = { type: 'oauth2', grant: 'authorizationCode', authUrl: 'http://a/authorize', tokenUrl: base, clientId: 'c' };
    const deps = mkDeps({
      callbackTimeoutMs: 200,
      openBrowser: async (u) => {
        const cb = new URL(new URL(u).searchParams.get('redirect_uri')!); cb.searchParams.set('code', 'C'); cb.searchParams.set('state', 'wrong');
        await fetch(cb);
      },
    });
    await expect(applyAuth(rq(auth), deps)).rejects.toThrow(/timed out/i);
  });
  it('times out and closes server', async () => {
    const { base } = await setup();
    const auth: Auth = { type: 'oauth2', grant: 'authorizationCode', authUrl: 'http://a/authorize', tokenUrl: base, clientId: 'c' };
    let redirect = '';
    const deps = mkDeps({ callbackTimeoutMs: 50, openBrowser: async (u) => { redirect = new URL(u).searchParams.get('redirect_uri')!; } });
    await expect(applyAuth(rq(auth), deps)).rejects.toThrow(/timed out/i);
    await expect(fetch(redirect)).rejects.toThrow();
  });
  it('abort while waiting for the browser callback rejects and closes server', async () => {
    const { base } = await setup();
    const auth: Auth = { type: 'oauth2', grant: 'authorizationCode', authUrl: 'http://a/authorize', tokenUrl: base, clientId: 'c' };
    const ac = new AbortController();
    let redirect = '';
    const deps = mkDeps({ signal: ac.signal, openBrowser: async (u) => { redirect = new URL(u).searchParams.get('redirect_uri')!; setTimeout(() => ac.abort(), 20); } });
    await expect(applyAuth(rq(auth), deps)).rejects.toThrow(/cancel/i);
    await expect(fetch(redirect)).rejects.toThrow();
  });
  it('fixed redirectUri port and path used, no pkce when disabled', async () => {
    const { base } = await setup();
    const probe = http.createServer(); await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const port = (probe.address() as AddressInfo).port; await new Promise((r) => probe.close(r));
    const auth: Auth = { type: 'oauth2', grant: 'authorizationCode', authUrl: 'http://a/authorize', tokenUrl: base, clientId: 'c', pkce: false, redirectUri: `http://127.0.0.1:${port}/cb` };
    let u!: URL;
    const deps = mkDeps({
      openBrowser: async (s) => {
        u = new URL(s);
        const cb = new URL(u.searchParams.get('redirect_uri')!); cb.searchParams.set('code', 'C'); cb.searchParams.set('state', u.searchParams.get('state')!);
        await fetch(cb);
      },
    });
    await applyAuth(rq(auth), deps);
    expect(u.searchParams.get('redirect_uri')).toBe(`http://127.0.0.1:${port}/cb`);
    expect(u.searchParams.has('code_challenge')).toBe(false);
  });
});
