import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HistoryStore } from '../../src/core/history';
import type { HttpResponse } from '../../src/core/http';

const resp = (status: number): HttpResponse => ({
  status, statusText: '', headers: [], url: 'http://x', bodyBase64: '', sizeBytes: 0, timeMs: 1,
});
const mk = async () => new HistoryStore(await mkdtemp(join(tmpdir(), 'hist-')));
const e = (requestId: string, env: string, timestamp: number, ok = true) => ({
  requestId, env, timestamp, ok, usedSecrets: false, response: resp(ok ? 200 : 500), timeline: [],
});

describe('HistoryStore', () => {
  it('keeps 20', async () => {
    const h = await mk();
    for (let i = 0; i < 25; i++) await h.add(e('a', 'dev', i));
    const l = await h.list('a', 'dev');
    expect(l).toHaveLength(20);
    expect(l[0].timestamp).toBe(24);
    expect(l[19].timestamp).toBe(5);
  });
  it('latestOk skips failures', async () => {
    const h = await mk();
    await h.add(e('a', 'dev', 1));
    await h.add(e('a', 'dev', 2, false));
    expect((await h.latestOk('a', 'dev'))?.timestamp).toBe(1);
    expect(await h.latestOk('b', 'dev')).toBeUndefined();
  });
  it('per env separation', async () => {
    const h = await mk();
    await h.add(e('a', 'dev', 1));
    await h.add(e('a', 'prod', 2));
    expect(await h.list('a', 'dev')).toHaveLength(1);
    expect((await h.list('a', 'prod'))[0].timestamp).toBe(2);
  });
  it('get by id and rename', async () => {
    const h = await mk();
    const x = await h.add(e('a', 'dev', 1));
    await h.add(e('a', 'prod', 2));
    expect((await h.get(x.id))?.requestId).toBe('a');
    expect(await h.get('nope')).toBeUndefined();
    await h.rename('a', 'b');
    expect(await h.list('a', 'dev')).toEqual([]);
    expect(await h.list('b', 'dev')).toHaveLength(1);
    expect(await h.list('b', 'prod')).toHaveLength(1);
    expect((await h.get(x.id))?.requestId).toBe('b');
  });
  it('quarantines corrupt files instead of losing them silently', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hist-'));
    const h = new HistoryStore(dir);
    const x = await h.add(e('a', 'dev', 1));
    const name = (await readdir(dir)).find((f) => f.endsWith('.json'))!;
    await writeFile(join(dir, name), '{not json');
    expect(await h.list('a', 'dev')).toEqual([]);
    const y = await h.add(e('a', 'dev', 2));
    expect((await h.list('a', 'dev')).map((r) => r.id)).toEqual([y.id]);
    const corrupt = (await readdir(dir)).filter((f) => f.startsWith(name + '.corrupt-'));
    expect(corrupt).toHaveLength(1);
    expect(x.id).not.toBe(y.id);
  });
  it('stores bodies once, outside the list file, and loads them on get/latestOk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hist-'));
    const h = new HistoryStore(dir);
    const body = 'BODY-' + 'x'.repeat(100);
    const r: HttpResponse = { ...resp(200), contentType: 'application/json', bodyText: body, bodyBase64: Buffer.from(body).toString('base64') };
    const x = await h.add({ ...e('a', 'dev', 1), response: r });
    const listFile = (await readdir(dir)).find((f) => f.endsWith('.json'))!;
    const meta = await readFile(join(dir, listFile), 'utf8');
    expect(meta).not.toContain('BODY-');
    expect(meta).not.toContain(r.bodyBase64);
    const bodies = await readdir(join(dir, 'bodies'));
    expect(bodies).toHaveLength(1);
    expect(await readFile(join(dir, 'bodies', bodies[0]), 'utf8')).toBe(body);
    const got = await h.get(x.id);
    expect(got?.response?.bodyText).toBe(body);
    expect(got?.response?.bodyBase64).toBe(r.bodyBase64);
    expect((await h.latestOk('a', 'dev'))?.response?.bodyText).toBe(body);
    const listed = (await h.list('a', 'dev'))[0];
    expect(listed.response?.status).toBe(200);
    expect('bodyText' in listed.response!).toBe(false);
  });
  it('binary bodies round-trip and pruned entries drop their body files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hist-'));
    const h = new HistoryStore(dir);
    const bin = Buffer.from([0, 255, 1, 254]);
    const first = await h.add({ ...e('a', 'dev', 0), response: { ...resp(200), bodyBase64: bin.toString('base64') } });
    expect((await h.get(first.id))?.response?.bodyBase64).toBe(bin.toString('base64'));
    expect((await h.get(first.id))?.response?.bodyText).toBeUndefined();
    for (let i = 1; i <= 20; i++) await h.add({ ...e('a', 'dev', i), response: { ...resp(200), bodyBase64: bin.toString('base64') } });
    expect(await readdir(join(dir, 'bodies'))).toHaveLength(20);
    expect(await h.get(first.id)).toBeUndefined();
  });
  it('get reads only the owning file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hist-'));
    const h = new HistoryStore(dir);
    const x = await h.add(e('a', 'dev', 1));
    const junk = ['!', '0', '3', '7', 'b', 'f', '~'].map((c) => `${c}junk.other.json`);
    for (const f of junk) await writeFile(join(dir, f), '{not json');
    expect((await h.get(x.id))?.requestId).toBe('a');
    // a scan would have quarantined (renamed) the junk files it read
    expect((await readdir(dir)).filter((f) => f.includes('junk'))).toEqual(expect.arrayContaining(junk));
    expect((await readdir(dir)).filter((f) => f.includes('corrupt'))).toEqual([]);
  });
  it('reads legacy entries with inline bodies', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hist-'));
    const h = new HistoryStore(dir);
    const probe = await h.add(e('a', 'dev', 0));
    const listFile = (await readdir(dir)).find((f) => f.endsWith('.json'))!;
    const legacy = { ...e('a', 'dev', 5), id: 'legacy-id', response: { ...resp(200), bodyText: 'old', bodyBase64: Buffer.from('old').toString('base64') } };
    await writeFile(join(dir, listFile), JSON.stringify([legacy]));
    expect((await h.get('legacy-id'))?.response?.bodyText).toBe('old');
    expect((await h.latestOk('a', 'dev'))?.response?.bodyText).toBe('old');
    expect(probe.id).not.toBe('legacy-id');
  });
  it('persists usedSecrets', async () => {
    const h = await mk();
    const x = await h.add({ ...e('a', 'dev', 1), usedSecrets: true });
    expect((await h.get(x.id))?.usedSecrets).toBe(true);
  });
});
