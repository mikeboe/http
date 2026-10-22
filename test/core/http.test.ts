import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { CookieJar, mask, send } from '../../src/core/http';
import type { ResolvedRequest } from '../../src/core/resolve';

const servers: http.Server[] = [];
async function serve(h: http.RequestListener): Promise<string> {
  const s = http.createServer(h);
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => { s.closeAllConnections(); s.close(r); })));
});

const rq = (o: Partial<ResolvedRequest>): ResolvedRequest => ({
  method: 'GET', url: '', headers: [], body: { kind: 'none' }, timeoutMs: 5000, followRedirects: true, verifyTls: true,
  secrets: new Set(), auth: { type: 'none' }, ...o,
});
const jar = () => ({ jar: new CookieJar() });

describe('send', () => {
  it('sends method headers body', async () => {
    const base = await serve((req, res) => {
      const c: Buffer[] = [];
      req.on('data', (d) => c.push(d));
      req.on('end', () => res.setHeader('content-type', 'application/json').end(JSON.stringify({ m: req.method, h: req.headers['x-a'], b: Buffer.concat(c).toString() })));
    });
    const { response, timeline } = await send(rq({ method: 'POST', url: base + '/p', headers: [['X-A', '1']], body: { kind: 'bytes', data: Buffer.from('hello'), contentType: 'text/plain' } }), jar());
    expect(JSON.parse(response.bodyText!)).toEqual({ m: 'POST', h: '1', b: 'hello' });
    expect(response.status).toBe(200);
    expect(timeline.map((t) => t.kind)).toEqual(['request', 'response']);
  });
  it('follows redirects and records them', async () => {
    const base = await serve((req, res) => {
      if (req.url === '/a') res.writeHead(302, { location: '/b' }).end();
      else res.end('done');
    });
    const { response, timeline } = await send(rq({ url: base + '/a' }), jar());
    expect(response.bodyBase64).toBe(Buffer.from('done').toString('base64'));
    expect(response.url).toBe(base + '/b');
    expect(timeline.map((t) => t.kind)).toEqual(['request', 'redirect', 'request', 'response']);
  });
  it('followRedirects false returns 302', async () => {
    const base = await serve((_req, res) => res.writeHead(302, { location: '/b' }).end());
    const { response } = await send(rq({ url: base + '/a', followRedirects: false }), jar());
    expect(response.status).toBe(302);
  });
  it('gives up after 10 redirects', async () => {
    const base = await serve((_req, res) => res.writeHead(302, { location: '/loop' }).end());
    await expect(send(rq({ url: base + '/loop' }), jar())).rejects.toThrow(/redirects/);
  });
  it('cross-origin redirect drops Authorization', async () => {
    const seen: Record<string, string | undefined> = {};
    const other = await serve((req, res) => { seen.other = req.headers.authorization; res.end('ok'); });
    const base = await serve((req, res) => {
      if (req.url === '/same') { seen.same = req.headers.authorization; res.end('ok'); }
      else res.writeHead(302, { location: other + '/x' }).end();
    });
    await send(rq({ url: base + '/start', headers: [['Authorization', 'Bearer t']] }), jar());
    expect(seen.other).toBeUndefined();
    const b2 = await serve((req, res) => {
      if (req.url === '/same') { seen.same = req.headers.authorization; res.end('ok'); } else res.writeHead(302, { location: '/same' }).end();
    });
    await send(rq({ url: b2 + '/start', headers: [['Authorization', 'Bearer t']] }), jar());
    expect(seen.same).toBe('Bearer t');
  });
  it('303 becomes GET', async () => {
    const seen: string[] = [];
    const base = await serve((req, res) => {
      seen.push(`${req.method} ${req.url} ${req.headers['content-type'] ?? ''}`);
      if (req.url === '/a') res.writeHead(303, { location: '/b' }).end(); else res.end('ok');
      req.resume();
    });
    await send(rq({ method: 'POST', url: base + '/a', body: { kind: 'bytes', data: Buffer.from('x'), contentType: 'text/plain' } }), jar());
    expect(seen).toEqual(['POST /a text/plain', 'GET /b ']);
  });
  it('timeout aborts with error message containing timed out', async () => {
    const base = await serve(() => { /* never respond */ });
    await expect(send(rq({ url: base, timeoutMs: 100 }), jar())).rejects.toThrow(/timed out/);
  });
  it('abort signal cancels', async () => {
    const base = await serve(() => { /* never respond */ });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    await expect(send(rq({ url: base }), { jar: new CookieJar(), signal: ac.signal })).rejects.toThrow(/cancel/i);
  });
  it('cookies stored and resent', async () => {
    const base = await serve((req, res) => {
      if (req.url === '/set') res.setHeader('set-cookie', ['a=1; Path=/', 'b=2; Max-Age=0']).end();
      else res.end(String(req.headers.cookie));
    });
    const j = new CookieJar();
    await send(rq({ url: base + '/set' }), { jar: j });
    const { response } = await send(rq({ url: base + '/get' }), { jar: j });
    expect(response.bodyText).toBeUndefined();
    expect(Buffer.from(response.bodyBase64, 'base64').toString()).toBe('a=1');
    j.clear();
    expect(j.cookieHeader(base)).toBeUndefined();
  });
  it('binary response', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 255, 128]);
    const base = await serve((_q, res) => res.setHeader('content-type', 'image/png').end(png));
    const { response } = await send(rq({ url: base }), jar());
    expect(response.bodyText).toBeUndefined();
    expect(Buffer.from(response.bodyBase64, 'base64').equals(png)).toBe(true);
    expect(response.sizeBytes).toBe(png.length);
  });
  it('truncates large body', async () => {
    const big = Buffer.alloc(11 * 1024 * 1024, 97);
    const base = await serve((_q, res) => res.setHeader('content-type', 'text/plain').end(big));
    const { response } = await send(rq({ url: base }), jar());
    expect(response.truncated).toBe(true);
    expect(response.sizeBytes).toBe(big.length);
    expect(Buffer.from(response.bodyBase64, 'base64').length).toBe(10 * 1024 * 1024);
  });
  it('timeline masks secrets', async () => {
    const base = await serve((_q, res) => res.end('ok'));
    const { timeline } = await send(rq({
      url: base + '/?k=topsecret', secrets: new Set(['topsecret']),
      headers: [['Authorization', 'Bearer other'], ['X-Api', 'topsecret'], ['Cookie', 'a=b']],
    }), jar());
    const req = timeline[0];
    expect(req.text).not.toContain('topsecret');
    expect(req.headers).toContainEqual(['Authorization', '•••••']);
    expect(req.headers).toContainEqual(['Cookie', '•••••']);
    expect(req.headers).toContainEqual(['X-Api', '•••••']);
  });
  it('mask replaces longest first', () => {
    expect(mask('abc abcd', new Set(['abc', 'abcd']))).toBe('••••• •••••');
  });
});
