import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
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
  it('persists usedSecrets', async () => {
    const h = await mk();
    const x = await h.add({ ...e('a', 'dev', 1), usedSecrets: true });
    expect((await h.get(x.id))?.usedSecrets).toBe(true);
  });
});
