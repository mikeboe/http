import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  requestIdFromPath, requestPathFromId, listTree, loadFolderChain, effectiveRequest, loadEffective,
} from '../../src/core/workspace';
import { parseRequest, parseFolder } from '../../src/core/model';

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-')); });

async function put(rel: string, text: string) {
  const f = path.join(root, rel);
  await fs.mkdir(path.dirname(f), { recursive: true });
  await fs.writeFile(f, text);
  return f;
}
const req = (t: string) => parseRequest(t).request!;
const folder = (t: string) => parseFolder(t).folder!;

describe('ids', () => {
  it('id round trip', () => {
    const f = path.join(root, 'users', 'get.req.yaml');
    const id = requestIdFromPath(root, f);
    expect(id).toBe('users/get');
    expect(requestPathFromId(root, id)).toBe(f);
  });
  it('ids with spaces and unicode', () => {
    const f = path.join(root, 'my folder', 'Über list.req.yaml');
    expect(requestIdFromPath(root, f)).toBe('my folder/Über list');
    expect(requestPathFromId(root, 'my folder/Über list')).toBe(f);
  });
});

describe('id safety', () => {
  it('rejects ids outside root', () => {
    for (const id of ['../x', 'a/../../x', '/etc/passwd']) {
      expect(() => requestPathFromId(root, id)).toThrow(`Invalid request id: ${id}`);
    }
  });
});

describe('listTree', () => {
  it('lists folders then requests with methods', async () => {
    await put('b.req.yaml', 'name: B\nmethod: POST\nurl: http://x\n');
    await put('a.req.yaml', 'name: A\nurl: http://x\n');
    await put('zed/inner.req.yaml', 'url: http://x\nmethod: DELETE\n');
    await put('alpha/_folder.yaml', '');
    const tree = await listTree(root);
    expect(tree.map((n) => [n.kind, n.id])).toEqual([
      ['folder', 'alpha'], ['folder', 'zed'], ['request', 'a'], ['request', 'b'],
    ]);
    expect(tree[2]).toMatchObject({ name: 'A', method: 'GET' });
    expect(tree[3]).toMatchObject({ name: 'B', method: 'POST' });
    expect(tree[1].children![0]).toMatchObject({ id: 'zed/inner', method: 'DELETE', name: 'inner' });
  });
  it('tree skips env and .openapi', async () => {
    await put('env/dev.yaml', 'x: 1');
    await put('.openapi/s.req.yaml', 'url: x');
    await put('.schema/s.json', '{}');
    await put('a.req.yaml', 'url: http://x\n');
    expect((await listTree(root)).map((n) => n.id)).toEqual(['a']);
  });
  it('tree marks invalid and removed files', async () => {
    await put('bad.req.yaml', 'method: NOPE\nurl: x\n');
    await put('gone.req.yaml', 'url: x\nsource: { spec: s, operationId: o, removed: true }\n');
    const tree = await listTree(root);
    expect(tree.find((n) => n.id === 'bad')).toMatchObject({ invalid: true, name: 'bad' });
    expect(tree.find((n) => n.id === 'bad')!.method).toBeUndefined();
    expect(tree.find((n) => n.id === 'gone')!.removed).toBe(true);
  });
  it('marks an unreadable file invalid instead of failing the listing', async () => {
    await put('ok.req.yaml', 'url: http://x\n');
    await fs.symlink(path.join(root, 'missing-target'), path.join(root, 'dangling.req.yaml'));
    const tree = await listTree(root);
    expect(tree.find((n) => n.id === 'dangling')).toMatchObject({ invalid: true, name: 'dangling' });
    expect(tree.find((n) => n.id === 'ok')!.invalid).toBeUndefined();
  });
  it('returns empty for a missing root', async () => {
    expect(await listTree(path.join(root, 'nope'))).toEqual([]);
  });
});

describe('inheritance', () => {
  it('inherits folder auth and reports authFrom', async () => {
    const f = await put('api/x.req.yaml', 'url: http://x\n');
    await put('api/_folder.yaml', 'auth: { type: bearer, token: T }\n');
    const e = await loadEffective(root, 'api/x');
    expect(e.auth).toEqual({ type: 'bearer', token: 'T' });
    expect(e.authFrom).toBe('api');
    expect(e.file).toBe(f);
    expect(e.id).toBe('api/x');
  });
  it('request auth overrides', async () => {
    await put('api/x.req.yaml', 'url: http://x\nauth: { type: bearer, token: R }\n');
    await put('api/_folder.yaml', 'auth: { type: bearer, token: T }\n');
    const e = await loadEffective(root, 'api/x');
    expect(e.auth).toEqual({ type: 'bearer', token: 'R' });
    expect(e.authFrom).toBeUndefined();
  });
  it('explicit inherit and none default', async () => {
    await put('x.req.yaml', 'url: http://x\nauth: { type: inherit }\n');
    const e = await loadEffective(root, 'x');
    expect(e.auth).toEqual({ type: 'none' });
    expect(e.authFrom).toBeUndefined();
  });
  it('nearest folder wins', async () => {
    await put('a/b/x.req.yaml', 'url: http://x\n');
    await put('a/_folder.yaml', 'auth: { type: bearer, token: OUTER }\n');
    await put('a/b/_folder.yaml', 'auth: { type: bearer, token: INNER }\n');
    const chain = await loadFolderChain(root, path.join(root, 'a/b/x.req.yaml'));
    expect(chain.map((c) => c.dir)).toEqual([path.join(root, 'a'), path.join(root, 'a/b')]);
    const e = await loadEffective(root, 'a/b/x');
    expect(e.auth).toEqual({ type: 'bearer', token: 'INNER' });
    expect(e.authFrom).toBe('a/b');
  });
  it('headers merge case-insensitively', () => {
    const chain = [
      { dir: '/r/a', folder: folder('headers: [{name: X-A, value: outer}, {name: X-B, value: outer}, {name: X-C, value: outer}]') },
      { dir: '/r/a/b', folder: folder('headers: [{name: x-a, value: inner}]') },
    ];
    const r = req('url: http://x\nheaders: [{name: X-B, value: req}, {name: X-C, value: off, enabled: false}]\n');
    const e = effectiveRequest(r, chain, '/r/a/b/x.req.yaml', '/r');
    expect(e.inheritedHeaders).toEqual([
      { name: 'X-C', value: 'outer' }, { name: 'x-a', value: 'inner' },
    ]);
    expect(e.headers).toEqual(r.headers);
  });
  it('settings merge per key', () => {
    const chain = [
      { dir: '/r/a', folder: folder('settings: { timeout: 5s, verifyTls: false }') },
      { dir: '/r/a/b', folder: folder('settings: { timeout: 9s }') },
    ];
    const e = effectiveRequest(req('url: http://x\nsettings: { followRedirects: false }\n'), chain, '/r/a/b/x.req.yaml', '/r');
    expect(e.settings).toEqual({ timeout: '9s', verifyTls: false, followRedirects: false });
  });
  it('root _folder.yaml auth reports authFrom "."', async () => {
    await put('x.req.yaml', 'url: http://x\n');
    await put('_folder.yaml', 'auth: { type: bearer, token: ROOT }\n');
    const e = await loadEffective(root, 'x');
    expect(e.auth).toEqual({ type: 'bearer', token: 'ROOT' });
    expect(e.authFrom).toBe('.');
  });
  it('unparseable _folder.yaml makes loadFolderChain throw', async () => {
    const f = await put('a/x.req.yaml', 'url: http://x\n');
    await put('a/_folder.yaml', 'auth: { type: nope }\n');
    await expect(loadFolderChain(root, f)).rejects.toThrow(/_folder\.yaml/);
  });
  it('settings skip explicitly undefined values', () => {
    const chain = [{ dir: '/r', folder: folder('settings: { timeout: 5s }') }];
    const r = { ...req('url: http://x\n'), settings: { timeout: undefined, verifyTls: false } };
    expect(effectiveRequest(r, chain, '/r/x.req.yaml', '/r').settings).toEqual({ timeout: '5s', verifyTls: false });
  });
  it('loadEffective missing id throws', async () => {
    await expect(loadEffective(root, 'nope')).rejects.toThrow('Request not found: nope');
  });
  it('loadEffective throws on parse errors', async () => {
    await put('bad.req.yaml', 'method: NOPE\nurl: x\n');
    await expect(loadEffective(root, 'bad')).rejects.toThrow(/unknown method/);
  });
});
