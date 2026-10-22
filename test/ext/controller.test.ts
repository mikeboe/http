import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Environment } from '../../src/core/env';
import { HistoryStore } from '../../src/core/history';
import type { HistoryEntry } from '../../src/core/history';
import type { HostMessage } from '../../src/core/protocol';
import { EditorController, editorRoot, STANDALONE_NOTICE, toResponseView } from '../../src/ext/controller';
import type { ControllerDeps, DocumentPort } from '../../src/ext/controller';

const REQ = `name: Get user
method: GET
url: "{{baseUrl}}/users/{{id}}"
pathParams:
  id: u_1
headers:
  - { name: X-Key, value: "{{apiKey}}" }
  - { name: X-Other, value: "{{nowhere}}" }
`;

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function setup(opts: {
  text?: string; files?: Record<string, string>; run?: ControllerDeps['run']; getEnv?: ControllerDeps['getEnv']; standalone?: boolean;
} = {}) {
  const base = await mkdtemp(join(tmpdir(), 'ctl-'));
  temps.push(base);
  const root = join(base, '.http');
  const files = { '_folder.yaml': 'auth: { type: bearer, token: "{{apiKey}}" }\nheaders:\n  - { name: Accept, value: application/json }\n', ...opts.files };
  for (const [name, text] of Object.entries(files)) {
    const f = join(root, name);
    await mkdir(join(f, '..'), { recursive: true });
    await writeFile(f, text);
  }
  const file = join(root, 'users', 'get.req.yaml');
  await mkdir(join(root, 'users'), { recursive: true });
  await writeFile(file, opts.text ?? REQ);
  const applied: string[] = [];
  const doc: DocumentPort & { text: string } = {
    text: opts.text ?? REQ,
    file,
    getText() { return this.text; },
    async applyText(t: string) { applied.push(t); this.text = t; return true; },
  };
  const posted: HostMessage[] = [];
  const env: Environment = { name: 'dev', variables: { baseUrl: 'https://api.test' }, secrets: { apiKey: 's3cr3t' } };
  const history = new HistoryStore(join(base, 'hist'));
  const calls = { openText: 0, selectEnv: [] as string[] };
  const deps: ControllerDeps = {
    root: opts.standalone ? join(root, 'users') : root,
    standalone: opts.standalone,
    post: (m) => posted.push(m),
    run: opts.run ?? (async () => { throw new Error('unexpected run'); }),
    getEnv: opts.getEnv ?? (async () => ({ name: 'dev', names: ['dev', 'prod'], env })),
    history,
    openText: () => { calls.openText++; },
    selectEnv: (n) => { calls.selectEnv.push(n); },
  };
  const ctl = new EditorController(doc, deps);
  return { ctl, doc, posted, applied, history, root, calls };
}

const states = (posted: HostMessage[]) => posted.filter((m): m is Extract<HostMessage, { type: 'state' }> => m.type === 'state');

describe('EditorController', () => {
  it('ready posts state with request and inherited auth', async () => {
    const { ctl, posted } = await setup({ files: { 'other.req.yaml': 'url: https://x.test\n' } });
    await ctl.handle({ type: 'ready' });
    const s = states(posted)[0];
    expect(s.request?.name).toBe('Get user');
    expect(s.errors).toEqual([]);
    expect(s.inherited.auth).toEqual({ type: 'bearer', token: '{{apiKey}}' });
    expect(s.inherited.authFrom).toBe('.');
    expect(s.inherited.headers).toEqual([{ name: 'Accept', value: 'application/json', from: '.' }]);
    expect(s.inherited.settings).toEqual({});
    expect(s.env).toEqual({ name: 'dev', names: ['dev', 'prod'] });
    expect(s.requestIds.sort()).toEqual(['other', 'users/get']);
    expect(posted.some((m) => m.type === 'history')).toBe(true);
  });

  it('edit applies ops and doc text changes', async () => {
    const { ctl, doc } = await setup();
    await ctl.handle({ type: 'edit', ops: [{ op: 'set', path: ['method'], value: 'POST' }] });
    expect(doc.text).toContain('method: POST');
    expect(doc.text).toContain('name: Get user');
  });

  it('edit applies to latest text', async () => {
    const { ctl, doc } = await setup();
    await ctl.handle({ type: 'ready' });
    doc.text = doc.text.replace('name: Get user', 'name: Renamed # mine');
    await ctl.handle({ type: 'edit', ops: [{ op: 'set', path: ['method'], value: 'PUT' }] });
    expect(doc.text).toContain('name: Renamed # mine');
    expect(doc.text).toContain('method: PUT');
  });

  it('row edits whose row no longer has the expected name are skipped and the state refreshed', async () => {
    const { ctl, doc, applied, posted } = await setup();
    // An outside edit inserted a header above X-Other since the webview last saw the rows.
    doc.text = doc.text.replace('  - { name: X-Other', '  - { name: X-New, value: n }\n  - { name: X-Other');
    const before = doc.text;
    await ctl.handle({ type: 'edit', ops: [{ op: 'set', path: ['headers', 1, 'value'], value: 'v2' }], expect: { path: ['headers', 1], names: ['X-Other'] } });
    expect(doc.text).toBe(before);
    expect(applied).toEqual([]);
    expect(states(posted).length).toBe(1);
    await ctl.handle({ type: 'edit', ops: [{ op: 'set', path: ['headers', 2, 'value'], value: 'v2' }], expect: { path: ['headers', 2], names: ['X-Other'] } });
    expect(doc.text).toContain('{ name: X-Other, value: "v2" }');
    // any of the names the webview may have sent is accepted
    await ctl.handle({ type: 'edit', ops: [{ op: 'set', path: ['headers', 0, 'name'], value: 'X-Keyz' }], expect: { path: ['headers', 0], names: ['X-Ke', 'X-Key'] } });
    expect(doc.text).toContain('name: X-Keyz');
  });

  it('state says which maps and lists exist on disk', async () => {
    const t = await setup();
    await t.ctl.handle({ type: 'ready' });
    expect(states(t.posted)[0].present).toEqual({ settings: false, pathParams: true, query: false, headers: true });
    const u = await setup({ text: 'url: http://x\nsettings:\n  x-unknown: 1\npathParams:\n' });
    await u.ctl.handle({ type: 'ready' });
    expect(states(u.posted)[0].present).toEqual({ settings: true, pathParams: false, query: false, headers: false });
  });

  it('controller does not edit invalid document', async () => {
    const { ctl, applied, posted } = await setup({ text: 'name: [unclosed\nurl: x\n' });
    await ctl.handle({ type: 'edit', ops: [{ op: 'set', path: ['method'], value: 'POST' }] });
    expect(applied).toEqual([]);
    const s = states(posted).at(-1)!;
    expect(s.request).toBeUndefined();
    expect(s.errors.length).toBeGreaterThan(0);
  });

  it('secret variables have no value', async () => {
    const { ctl, posted } = await setup();
    await ctl.refresh();
    const vars = states(posted)[0].variables;
    expect(vars).toEqual([
      { name: 'baseUrl', kind: 'variable', file: 'env/dev.yaml', value: 'https://api.test' },
      { name: 'id', kind: 'pathParam', value: 'u_1' },
      { name: 'apiKey', kind: 'secret', file: 'env/dev.env' },
      { name: 'nowhere', kind: 'missing' },
    ]);
    expect(JSON.stringify(posted)).not.toContain('s3cr3t');
  });

  it('send posts sending then response and history', async () => {
    let entry: HistoryEntry | undefined;
    const t = await setup({
      run: async (id) => {
        entry = await t.history.add({
          requestId: id, env: 'dev', timestamp: 1000, ok: true, usedSecrets: false, timeline: [],
          response: { status: 200, statusText: 'OK', headers: [['content-type', 'application/json']], url: 'u', bodyBase64: 'e30=', bodyText: '{}', contentType: 'application/json', sizeBytes: 2, timeMs: 5 },
        });
        return entry;
      },
    });
    await t.ctl.handle({ type: 'send' });
    expect(t.posted.map((m) => m.type)).toEqual(['sending', 'response', 'history']);
    const r = t.posted[1] as Extract<HostMessage, { type: 'response' }>;
    expect(r.response).toMatchObject({ entryId: entry!.id, ok: true, status: 200, bodyText: '{}' });
    expect(r.response.bodyBase64).toBeUndefined();
    const h = t.posted[2] as Extract<HostMessage, { type: 'history' }>;
    expect(h.items).toEqual([{ entryId: entry!.id, timestamp: 1000, status: 200, ok: true }]);
  });

  it('send waits for edits still being applied', async () => {
    let seen: string | undefined;
    const t = await setup({
      run: async (id) => {
        seen = t.doc.text;
        return { id: 'x', requestId: id, env: 'dev', timestamp: 1, ok: false, usedSecrets: false, timeline: [], error: 'stop' };
      },
    });
    const applyLate = t.doc.applyText.bind(t.doc);
    t.doc.applyText = (text) => new Promise((resolve) => setTimeout(() => resolve(applyLate(text)), 30));
    const editing = t.ctl.handle({ type: 'edit', ops: [{ op: 'set', path: ['method'], value: 'DELETE' }] });
    await t.ctl.handle({ type: 'send' });
    await editing;
    expect(seen).toContain('method: DELETE');
  });

  it('inherited headers and settings name the folder they come from', async () => {
    const { ctl, posted } = await setup({
      files: {
        '_folder.yaml': 'headers:\n  - { name: Accept, value: application/json }\nsettings: { timeout: 30s, verifyTls: false }\n',
        'users/_folder.yaml': 'headers:\n  - { name: X-Team, value: users }\nsettings: { timeout: 5s }\n',
      },
    });
    await ctl.refresh();
    const s = states(posted)[0];
    expect(s.inherited.headers).toEqual([
      { name: 'Accept', value: 'application/json', from: '.' },
      { name: 'X-Team', value: 'users', from: 'users' },
    ]);
    expect(s.inherited.settings).toEqual({ timeout: '5s', verifyTls: false, from: { timeout: 'users', verifyTls: '.' } });
  });

  it('cancel aborts run signal', async () => {
    let seen: AbortSignal | undefined;
    const t = await setup({
      run: (id, signal) => {
        seen = signal;
        return new Promise((resolve) => signal.addEventListener('abort', () => {
          resolve({ id: 'x', requestId: id, env: 'dev', timestamp: 1, ok: false, usedSecrets: false, timeline: [], error: 'aborted' });
        }));
      },
    });
    const sending = t.ctl.handle({ type: 'send' });
    await new Promise((r) => setTimeout(r, 10));
    expect(seen?.aborted).toBe(false);
    await t.ctl.handle({ type: 'cancel' });
    expect(seen?.aborted).toBe(true);
    await sending;
    expect(t.posted.some((m) => m.type === 'response')).toBe(true);
  });

  it('a slower, older refresh does not overwrite a newer state', async () => {
    const env: Environment = { name: 'dev', variables: {}, secrets: {} };
    let first = true;
    const t = await setup({
      getEnv: async () => {
        if (first) { first = false; await new Promise((r) => setTimeout(r, 30)); }
        return { name: 'dev', names: ['dev'], env };
      },
    });
    const older = t.ctl.refresh();
    t.doc.text = t.doc.text.replace('name: Get user', 'name: Newer');
    await t.ctl.refresh();
    await older;
    expect(states(t.posted).map((s) => s.request?.name)).toEqual(['Newer']);
  });

  it('dispose aborts an in-flight send and stops posting', async () => {
    let seen: AbortSignal | undefined;
    const t = await setup({
      run: (id, signal) => {
        seen = signal;
        return new Promise((resolve) => signal.addEventListener('abort', () => {
          resolve({ id: 'x', requestId: id, env: 'dev', timestamp: 1, ok: false, usedSecrets: false, timeline: [], error: 'aborted' });
        }));
      },
    });
    const sending = t.ctl.handle({ type: 'send' });
    await new Promise((r) => setTimeout(r, 10));
    t.ctl.dispose();
    expect(seen?.aborted).toBe(true);
    await sending;
    await t.ctl.refresh();
    expect(t.posted.map((m) => m.type)).toEqual(['sending']);
  });

  it('standalone file edits without folder inheritance and shows a notice', async () => {
    const t = await setup({ standalone: true, files: { 'users/_folder.yaml': 'auth: { type: basic, username: u, password: p }\n' } });
    await t.ctl.handle({ type: 'ready' });
    const s = states(t.posted)[0];
    expect(s.errors).toEqual([{ message: STANDALONE_NOTICE }]);
    expect(s.request?.name).toBe('Get user');
    expect(s.inherited).toEqual({ auth: { type: 'none' }, headers: [], settings: {} });
    expect(s.requestIds).toEqual([]);
    await t.ctl.handle({ type: 'edit', ops: [{ op: 'set', path: ['method'], value: 'POST' }] });
    expect(t.doc.text).toContain('method: POST');
  });

  it('openText and selectEnv delegate to deps', async () => {
    const t = await setup();
    await t.ctl.handle({ type: 'openText' });
    await t.ctl.handle({ type: 'selectEnv', name: 'prod' });
    expect(t.calls).toEqual({ openText: 1, selectEnv: ['prod'] });
  });
});

describe('editorRoot', () => {
  it('uses the configured root only for files under it', () => {
    expect(editorRoot('/w/.http/a/b.req.yaml', '/w/.http')).toEqual({ root: '/w/.http', standalone: false });
    expect(editorRoot('/w/other/b.req.yaml', '/w/.http')).toEqual({ root: '/w/other', standalone: true });
    expect(editorRoot('/w/.httpx/b.req.yaml', '/w/.http')).toEqual({ root: '/w/.httpx', standalone: true });
    expect(editorRoot('/tmp/b.req.yaml', undefined)).toEqual({ root: '/tmp', standalone: true });
  });
});

describe('toResponseView', () => {
  const base: HistoryEntry = { id: 'e', requestId: 'r', env: 'dev', timestamp: 1, ok: true, usedSecrets: false, timeline: [] };
  const resp = { status: 200, statusText: 'OK', headers: [] as [string, string][], url: 'u', sizeBytes: 3, timeMs: 1 };
  it('keeps base64 only for images without text', () => {
    expect(toResponseView({ ...base, response: { ...resp, bodyBase64: 'AAA', contentType: 'image/png' } }).bodyBase64).toBe('AAA');
    expect(toResponseView({ ...base, response: { ...resp, bodyBase64: 'AAA', contentType: 'application/octet-stream' } }).bodyBase64).toBeUndefined();
    expect(toResponseView({ ...base, response: { ...resp, bodyBase64: 'AAA', bodyText: 'x', contentType: 'image/svg+xml' } }).bodyBase64).toBeUndefined();
  });
  it('carries errors without a response', () => {
    expect(toResponseView({ ...base, ok: false, error: 'boom' })).toEqual({ entryId: 'e', timestamp: 1, ok: false, error: 'boom', timeline: [] });
  });
});
