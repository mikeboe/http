import * as http from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryTokenStore } from '../../src/core/auth';
import { CookieJar } from '../../src/core/http';
import { HistoryStore } from '../../src/core/history';
import { runRequest } from '../../src/core/runner';
import type { RunContext } from '../../src/core/runner';

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

async function setup(files: Record<string, string>, now?: () => number) {
  const base = await mkdtemp(join(tmpdir(), 'run-'));
  const root = join(base, '.http');
  for (const [name, text] of Object.entries(files)) {
    const f = join(root, name);
    await mkdir(join(f, '..'), { recursive: true });
    await writeFile(f, text);
  }
  const ctx: RunContext = {
    root, envName: 'dev', env: { name: 'dev', variables: {}, secrets: {} }, history: new HistoryStore(join(base, 'hist')),
    jar: new CookieJar(), tokens: new MemoryTokenStore(), openBrowser: async () => {}, now,
  };
  return ctx;
}
const req = (name: string, url: string, extra = '') => `name: ${name}\nmethod: GET\nurl: ${url}\n${extra}`;
const counter = async (respond: (n: number) => [number, string]) => {
  let n = 0;
  const url = await serve((_q, res) => {
    n++;
    const [status, body] = respond(n);
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(body);
  });
  return { url, hits: () => n };
};

describe('runRequest', () => {
  it('runs simple request and records', async () => {
    const s = await counter(() => [200, '{"a":1}']);
    const ctx = await setup({ 'a.req.yaml': req('a', s.url) });
    const { entry } = await runRequest('a', ctx);
    expect(entry.ok).toBe(true);
    expect(entry.response?.status).toBe(200);
    expect((await ctx.history.list('a', 'dev'))[0].id).toBe(entry.id);
  });

  it('records non-2xx as not ok', async () => {
    const s = await counter(() => [500, '{}']);
    const ctx = await setup({ 'a.req.yaml': req('a', s.url) });
    const { entry } = await runRequest('a', ctx);
    expect(entry.ok).toBe(false);
    expect(entry.error).toBeUndefined();
  });

  const chainFiles = (login: string, api: string, extra = '') => ({
    'auth/login.req.yaml': req('login', login),
    'api.req.yaml': req('api', api, `headers:\n  - name: X-Token\n    value: '{{response("auth/login", "body.token"${extra})}}'\n`),
  });

  it('chain runs dependency when no history', async () => {
    const login = await counter(() => [200, '{"token":"tok1"}']);
    const api = await counter(() => [200, '{}']);
    const ctx = await setup(chainFiles(login.url, api.url));
    const { entry } = await runRequest('api', ctx);
    expect(entry.ok).toBe(true);
    expect(login.hits()).toBe(1);
    expect(entry.timeline.find((t) => t.kind === 'dependency')?.text).toMatch(/^Ran auth\/login → 200 \(\d+ ms\)$/);
    expect(JSON.stringify(entry.timeline)).not.toContain('tok1');
  });

  it('chain uses cached response', async () => {
    const login = await counter(() => [200, '{"token":"tok1"}']);
    const api = await counter(() => [200, '{}']);
    const ctx = await setup(chainFiles(login.url, api.url));
    await runRequest('api', ctx);
    const { entry } = await runRequest('api', ctx);
    expect(entry.ok).toBe(true);
    expect(login.hits()).toBe(1);
    expect(api.hits()).toBe(2);
  });

  it('chain reruns when older than maxAge', async () => {
    const login = await counter(() => [200, '{"token":"tok1"}']);
    const api = await counter(() => [200, '{}']);
    let t = 1_000_000;
    const ctx = await setup(chainFiles(login.url, api.url, ', "10m"'), () => t);
    await runRequest('api', ctx);
    t += 5 * 60_000;
    await runRequest('api', ctx);
    expect(login.hits()).toBe(1);
    t += 6 * 60_000;
    await runRequest('api', ctx);
    expect(login.hits()).toBe(2);
  });

  it('circular dependency error', async () => {
    const ctx = await setup({
      'a.req.yaml': req('a', 'http://x/{{response("b", "body.x")}}'),
      'b.req.yaml': req('b', 'http://x/{{response("a", "body.x")}}'),
    });
    const { entry } = await runRequest('a', ctx);
    expect(entry.ok).toBe(false);
    expect(entry.error).toContain('Circular dependency: a → b → a');
    expect(entry.timeline[entry.timeline.length - 1].kind).toBe('error');
  });

  it('failed dependency blocks parent', async () => {
    const login = await counter(() => [401, '{}']);
    const api = await counter(() => [200, '{}']);
    const ctx = await setup(chainFiles(login.url, api.url));
    const { entry } = await runRequest('api', ctx);
    expect(entry.ok).toBe(false);
    expect(entry.error).toBe('Dependency auth/login failed: 401 Unauthorized');
    expect(api.hits()).toBe(0);
    expect(entry.response).toBeUndefined();
  });

  it('missing value error', async () => {
    const login = await counter(() => [200, '{"other":1}']);
    const api = await counter(() => [200, '{}']);
    const ctx = await setup(chainFiles(login.url, api.url));
    const { entry } = await runRequest('api', ctx);
    expect(entry.ok).toBe(false);
    expect(entry.error).toBe('Dependency auth/login has no value at body.token');
    expect(api.hits()).toBe(0);
  });

  it('missing variable message names env file', async () => {
    const ctx = await setup({ 'a.req.yaml': req('a', 'http://{{host}}/') });
    const { entry } = await runRequest('a', ctx);
    expect(entry.ok).toBe(false);
    expect(entry.error).toBe('Variable "host" is not set. Add it to .http/env/dev.env (or dev.yaml).');
  });

  it('masks secrets in recorded errors', async () => {
    const ctx = await setup({ 'a.req.yaml': req('a', 'http://127.0.0.1:1/{{key}}') });
    ctx.env.secrets.key = 'S3CRET';
    const { entry } = await runRequest('a', ctx);
    expect(entry.ok).toBe(false);
    expect(JSON.stringify(entry)).not.toContain('S3CRET');
  });
});
