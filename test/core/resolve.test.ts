import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveRequest } from '../../src/core/resolve';
import type { EffectiveRequest } from '../../src/core/workspace';
import type { Environment } from '../../src/core/env';
import { MissingVariableError } from '../../src/core/template';

const env: Environment = { name: 'dev', variables: { host: 'h.test', id: 'env-id' }, secrets: { key: 's3cret' } };
const noResp = async () => ({ value: '', secret: false });
const mk = (o: Partial<EffectiveRequest> = {}): EffectiveRequest => ({
  name: 'r', method: 'GET', url: 'http://{{host}}/u/{{id}}', pathParams: {}, query: [], headers: [], body: { type: 'none' },
  settings: {}, auth: { type: 'none' }, inheritedHeaders: [], file: '/tmp/x/a.req.yaml', id: 'a', ...o,
});

describe('resolveRequest', () => {
  it('applies pathParams and env', async () => {
    const r = await resolveRequest(mk({ pathParams: { id: '7' } }), env, noResp);
    expect(r.url).toBe('http://h.test/u/7');
    expect(r.timeoutMs).toBe(30000);
    expect(r.followRedirects).toBe(true);
    expect(r.verifyTls).toBe(true);
  });
  it('pathParams override env', async () => {
    const r = await resolveRequest(mk({ pathParams: { id: '{{host}}-x' } }), env, noResp);
    expect(r.url).toBe('http://h.test/u/h.test-x');
    expect((await resolveRequest(mk(), env, noResp)).url).toBe('http://h.test/u/env-id');
  });
  it('secrets tracked', async () => {
    const r = await resolveRequest(mk({
      headers: [{ name: 'X-Key', value: '{{key}}' }], auth: { type: 'bearer', token: '{{key}}' },
      pathParams: { id: '{{key}}' },
    }), env, noResp);
    expect(r.secrets.has('s3cret')).toBe(true);
    expect(r.headers).toContainEqual(['X-Key', 's3cret']);
    expect(r.auth).toEqual({ type: 'bearer', token: 's3cret' });
    expect((await resolveRequest(mk({ pathParams: { id: '1' } }), env, noResp)).secrets.size).toBe(0);
  });
  it('disabled query dropped and query encoded', async () => {
    const r = await resolveRequest(mk({
      url: 'http://h/p?a=1',
      query: [{ name: 'q', value: 'a b&c' }, { name: 'off', value: '1', enabled: false }],
      headers: [{ name: 'X-Off', value: '1', enabled: false }, { name: 'X-On', value: '1' }],
      inheritedHeaders: [{ name: 'X-Inh', value: 'i' }],
    }), env, noResp);
    expect(r.url).toBe('http://h/p?a=1&q=a+b%26c');
    expect(r.headers).toEqual([['X-Inh', 'i'], ['X-On', '1']]);
  });
  it('json content-type default', async () => {
    const r = await resolveRequest(mk({ body: { type: 'json', content: '{"h":"{{host}}"}' } }), env, noResp);
    expect(r.headers).toContainEqual(['Content-Type', 'application/json']);
    expect(r.body).toEqual({ kind: 'bytes', data: Buffer.from('{"h":"h.test"}'), contentType: 'application/json' });
    const r2 = await resolveRequest(mk({ body: { type: 'json', content: '{}' }, headers: [{ name: 'content-type', value: 'application/vnd+json' }] }), env, noResp);
    expect(r2.headers.filter(([k]) => k.toLowerCase() === 'content-type')).toEqual([['content-type', 'application/vnd+json']]);
  });
  it('form and multipart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'res-'));
    await writeFile(join(dir, 'f.txt'), 'file!');
    const file = join(dir, 'a.req.yaml');
    const f = await resolveRequest(mk({ file, body: { type: 'form', fields: [{ name: 'a', value: '{{host}}' }, { name: 'b', value: 'x', enabled: false }] } }), env, noResp);
    expect(f.body).toEqual({ kind: 'form', fields: [['a', 'h.test']] });
    const m = await resolveRequest(mk({ file, body: { type: 'multipart', parts: [{ name: 't', value: 'v' }, { name: 'f', file: 'f.txt' }, { name: 'z', value: 'n', enabled: false }] } }), env, noResp);
    expect(m.body).toEqual({ kind: 'multipart', parts: [{ name: 't', value: 'v' }, { name: 'f', file: join(dir, 'f.txt'), filename: 'f.txt' }] });
    const b = await resolveRequest(mk({ file, body: { type: 'file', path: 'f.txt' } }), env, noResp);
    expect(b.body).toEqual({ kind: 'bytes', data: Buffer.from('file!') });
  });
  it('missing variable throws', async () => {
    await expect(resolveRequest(mk({ url: 'http://{{nope}}' }), env, noResp)).rejects.toBeInstanceOf(MissingVariableError);
  });
});
