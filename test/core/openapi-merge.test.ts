import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { mergeRequest, mergeWithoutBase } from '../../src/core/openapi/merge';
import { parseRequest } from '../../src/core/model';

const BASE = `name: List pets
method: GET
url: '{{petstoreBaseUrl}}/pets'
query:
  - name: limit
    value: "20"
    enabled: false
  - name: status
    value: available
headers:
  - name: X-Trace
    value: abc
    enabled: false
source:
  spec: petstore
  operationId: listPets
`;

const JSON_BASE = `name: Create pet
method: POST
url: '{{petstoreBaseUrl}}/pets'
body:
  json: |-
    {
      "id": 1,
      "name": "Rex",
      "born": "2024-01-01T00:00:00Z",
      "tags": [
        {
          "id": 0
        }
      ]
    }
source:
  spec: petstore
  operationId: createPet
`;

const req = (text: string) => {
  const r = parseRequest(text);
  expect(r.errors).toEqual([]);
  return r.request!;
};
const jsonOf = (text: string) => {
  const b = req(text).body;
  return b.type === 'json' ? JSON.parse(b.content) : undefined;
};

describe('mergeRequest', () => {
  it('preferNext resolves conflicts to the spec and keeps everything else', () => {
    const current = '# mine\n' + BASE.replace('name: List pets', 'name: Mine').replace("/pets'", "/mine'")
      .replace('value: available', 'value: pending') + 'settings:\n  timeout: 5s\n';
    const next = BASE.replace("/pets'", "/animals'").replace('value: available', 'value: sold');
    const r = mergeRequest(BASE, current, next, { preferNext: true });
    expect(r.conflicts).toEqual(['url', 'query.status']);
    const m = req(r.text);
    expect(m.url).toBe('{{petstoreBaseUrl}}/animals');
    expect(m.query[1].value).toBe('sold');
    expect(m.name).toBe('Mine');
    expect(m.settings).toEqual({ timeout: '5s' });
    expect(r.text).toContain('# mine');
    // without preferNext the user's values stay
    expect(req(mergeRequest(BASE, current, next).text).url).toBe('{{petstoreBaseUrl}}/mine');
  });
  it('preferNext takes the spec body when the user json is invalid or a removed param changed', () => {
    const cur = JSON_BASE.replace('"id": 1,', '"id": 1,,');
    const next = JSON_BASE.replace('"Rex"', '"Max"');
    expect(jsonOf(mergeRequest(JSON_BASE, cur, next, { preferNext: true }).text).name).toBe('Max');
    const current = BASE.replace('value: available', 'value: pending');
    const without = BASE.replace('  - name: status\n    value: available\n', '');
    expect(req(mergeRequest(BASE, current, without, { preferNext: true }).text).query.map((q) => q.name)).toEqual(['limit']);
  });
  it('untouched file takes spec changes', () => {
    const next = BASE.replace("url: '{{petstoreBaseUrl}}/pets'", "url: '{{petstoreBaseUrl}}/v2/pets'")
      .replace('method: GET', 'method: POST').replace('value: available', 'value: sold');
    const r = mergeRequest(BASE, BASE, next);
    expect(r.conflicts).toEqual([]);
    const m = req(r.text);
    expect(m.method).toBe('POST');
    expect(m.url).toBe('{{petstoreBaseUrl}}/v2/pets');
    expect(m.query[1]).toEqual({ name: 'status', value: 'sold' });
  });

  it('user value kept when spec unchanged', () => {
    const current = BASE.replace('value: available', 'value: pending');
    const next = BASE.replace("/pets'", "/animals'");
    const r = mergeRequest(BASE, current, next);
    expect(r.conflicts).toEqual([]);
    const m = req(r.text);
    expect(m.url).toBe('{{petstoreBaseUrl}}/animals');
    expect(m.query[1]).toEqual({ name: 'status', value: 'pending' });
  });

  it('both changed keeps user and reports conflict', () => {
    const current = BASE.replace("/pets'", "/mine'").replace('value: available', 'value: pending');
    const next = BASE.replace("/pets'", "/animals'").replace('value: available', 'value: sold');
    const r = mergeRequest(BASE, current, next);
    expect(r.conflicts).toEqual(['url', 'query.status']);
    const m = req(r.text);
    expect(m.url).toBe('{{petstoreBaseUrl}}/mine');
    expect(m.query[1].value).toBe('pending');
    // Both made the same change: no conflict.
    expect(mergeRequest(BASE, next, next)).toEqual({ text: next, conflicts: [] });
  });

  it('new query param added', () => {
    const next = BASE.replace('headers:', '  - name: sort\n    value: name\n    enabled: false\nheaders:')
      .replace('query:\n', 'query:\n  - name: page\n    value: "1"\n');
    const current = BASE.replace('headers:', '  - name: mine\n    value: x\nheaders:');
    const r = mergeRequest(BASE, current, next);
    expect(r.conflicts).toEqual([]);
    expect(req(r.text).query).toEqual([
      { name: 'page', value: '1' },
      { name: 'limit', value: '20', enabled: false },
      { name: 'status', value: 'available' },
      { name: 'sort', value: 'name', enabled: false },
      { name: 'mine', value: 'x' },
    ]);
  });

  it('removed param dropped if user unchanged', () => {
    const next = BASE.replace('  - name: limit\n    value: "20"\n    enabled: false\n', '');
    const r = mergeRequest(BASE, BASE, next);
    expect(r.conflicts).toEqual([]);
    expect(req(r.text).query).toEqual([{ name: 'status', value: 'available' }]);
    // The last spec entry removed drops the key.
    const noHeaders = BASE.replace(/headers:\n(?: {2}.*\n)+/, '');
    const r2 = mergeRequest(BASE, BASE, noHeaders);
    expect(parse(r2.text).headers).toBeUndefined();
  });

  it('removed param kept with conflict if user changed', () => {
    const current = BASE.replace('value: "20"\n    enabled: false', 'value: "50"');
    const next = BASE.replace('  - name: limit\n    value: "20"\n    enabled: false\n', '');
    const r = mergeRequest(BASE, current, next);
    expect(r.conflicts).toEqual(['query.limit']);
    expect(req(r.text).query[0]).toEqual({ name: 'limit', value: '50' });
  });

  it('user-added header kept', () => {
    const current = `${BASE.replace('source:', '  - name: X-Mine\n    value: "1"\nsource:')}`;
    const next = BASE.replace('value: abc\n    enabled: false', 'value: xyz');
    const r = mergeRequest(BASE, current, next);
    expect(r.conflicts).toEqual([]);
    expect(req(r.text).headers).toEqual([{ name: 'X-Trace', value: 'xyz' }, { name: 'X-Mine', value: '1' }]);
  });

  it('json body key added and removed', () => {
    const current = JSON_BASE.replace('"Rex"', '"Fido"');
    const next = JSON_BASE.replace('"born": "2024-01-01T00:00:00Z",', '"age": 3,');
    const r = mergeRequest(JSON_BASE, current, next);
    expect(r.conflicts).toEqual([]);
    expect(r.text).toContain('json: |');
    const merged = jsonOf(r.text);
    expect(merged).toEqual({ id: 1, name: 'Fido', tags: [{ id: 0 }], age: 3 });
    expect(Object.keys(merged)).toEqual(['id', 'name', 'tags', 'age']);
    // A removed field the user changed is kept and flagged; arrays are scalars.
    const userBorn = JSON_BASE.replace('2024-01-01T00:00:00Z', '2020-05-05T00:00:00Z').replace('"id": 0', '"id": 9');
    const nextTags = next.replace('"id": 0', '"id": 5');
    const r2 = mergeRequest(JSON_BASE, userBorn, nextTags);
    expect(r2.conflicts).toEqual(['body.json.born', 'body.json.tags']);
    expect(jsonOf(r2.text)).toEqual({ id: 1, name: 'Rex', born: '2020-05-05T00:00:00Z', tags: [{ id: 9 }], age: 3 });
  });

  it('json body text untouched when nothing changes', () => {
    const current = JSON_BASE.replace('"id": 1,', '"id":   1,  ');
    expect(mergeRequest(JSON_BASE, current, JSON_BASE)).toEqual({ text: current, conflicts: [] });
  });

  it('nested json keys merge by path', () => {
    const mk = (obj: unknown) => `method: POST\nurl: u\nbody:\n  json: |-\n${JSON.stringify(obj, null, 2).replace(/^/gm, '    ')}\n`;
    const r = mergeRequest(mk({ a: { b: 1, c: 2 } }), mk({ a: { b: 5, c: 2 } }), mk({ a: { b: 1, d: 3 } }));
    expect(r.conflicts).toEqual([]);
    expect(jsonOf(r.text)).toEqual({ a: { b: 5, d: 3 } });
    const r2 = mergeRequest(mk({ a: { b: 1 } }), mk({ a: { b: 5 } }), mk({ a: { b: 6 } }));
    expect(r2.conflicts).toEqual(['body.json.a.b']);
  });

  it('invalid user json conflict', () => {
    const current = JSON_BASE.replace('"id": 1,', '"id": 1,,');
    const next = JSON_BASE.replace('"born": "2024-01-01T00:00:00Z",', '"age": 3,');
    const r = mergeRequest(JSON_BASE, current, next);
    expect(r.conflicts).toEqual(['body.json']);
    expect(r.text).toBe(current);
  });

  it('body type change', () => {
    const form = JSON_BASE.replace(/body:\n(?: {2}.*\n)+/, 'body:\n  form:\n    - name: a\n      value: "1"\n');
    // User untouched: spec type wins.
    expect(req(mergeRequest(JSON_BASE, JSON_BASE, form).text).body).toEqual({ type: 'form', fields: [{ name: 'a', value: '1' }] });
    // User changed the body content: kept and flagged.
    const r = mergeRequest(JSON_BASE, JSON_BASE.replace('"Rex"', '"Fido"'), form);
    expect(r.conflicts).toEqual(['body']);
    expect(jsonOf(r.text).name).toBe('Fido');
    // User changed the type, spec did not: kept silently.
    expect(mergeRequest(JSON_BASE, form, JSON_BASE.replace('"Rex"', '"Max"'))).toEqual({ text: form, conflicts: [] });
  });

  it('auth and pathParams', () => {
    const base = "method: GET\nurl: '{{b}}/pets/{{petId}}'\npathParams:\n  petId: \"7\"\nauth:\n  type: none\n";
    const next = "method: GET\nurl: '{{b}}/pets/{{petId}}/{{v}}'\npathParams:\n  petId: \"7\"\n  v: \"1\"\nauth:\n  type: bearer\n  token: '{{t}}'\n";
    const r = mergeRequest(base, base.replace('"7"', '"8"'), next);
    expect(r.conflicts).toEqual([]);
    const m = req(r.text);
    expect(m.pathParams).toEqual({ petId: '8', v: '1' });
    expect(m.auth).toEqual({ type: 'bearer', token: '{{t}}' });
    const userAuth = base.replace('type: none', 'type: basic\n  username: u\n  password: p');
    const r2 = mergeRequest(base, userAuth, next);
    expect(r2.conflicts).toEqual(['auth']);
    expect(req(r2.text).auth).toMatchObject({ type: 'basic' });
    const r3 = mergeRequest(base, base.replace('"7"', '"8"'), base.replace(/pathParams:\n.*\n/, ''));
    expect(r3.conflicts).toEqual(['pathParams.petId']);
  });

  it('name settings and comments preserved', () => {
    const current = `# my notes\nname: My pets # renamed\n${BASE.replace('name: List pets\n', '')}settings:\n  timeout: 5s\nextra: keep\n`;
    const next = BASE.replace('name: List pets', 'name: All pets').replace("/pets'", "/animals'");
    const r = mergeRequest(BASE, current, next);
    expect(r.conflicts).toEqual([]);
    expect(r.text).toContain('# my notes\n');
    expect(r.text).toContain('name: My pets # renamed\n');
    expect(r.text).toContain('settings:\n  timeout: 5s\n');
    expect(r.text).toContain('extra: keep\n');
    expect(r.text).toContain("url: '{{petstoreBaseUrl}}/animals'");
  });

  it('no snapshot: only spec additions apply, user values kept', () => {
    const current = BASE.replace('value: available', 'value: pending');
    const next = BASE.replace("/pets'", "/animals'").replace('headers:', '  - name: sort\n    value: name\nheaders:')
      .replace('  - name: limit\n    value: "20"\n    enabled: false\n', '');
    const r = mergeWithoutBase(current, next);
    expect(r.conflicts).toEqual([]);
    const m = req(r.text);
    expect(m.url).toBe('{{petstoreBaseUrl}}/pets');
    expect(m.query.map((q) => q.name)).toEqual(['limit', 'status', 'sort']);
    expect(m.query[1].value).toBe('pending');
  });

  it('nameless list entries do not shift edits', () => {
    const q = (...items: string[]) => `method: GET\nurl: u\nquery:\n${items.map((i) => `  - ${i}\n`).join('')}`;
    const base = q('{ name: a, value: "1" }', '{ name: b, value: "2" }');
    const current = q('{ value: draft }', '{ name: a, value: "1" }', '{ name: b, value: mine }');
    const r = mergeRequest(base, current, q('{ name: a, value: "9" }'));
    expect(r.conflicts).toEqual(['query.b']);
    expect(parse(r.text).query).toEqual([{ value: 'draft' }, { name: 'a', value: '9' }, { name: 'b', value: 'mine' }]);
    const r2 = mergeRequest(base, current, q('{ name: b, value: "2" }'));
    expect(r2.conflicts).toEqual([]);
    expect(parse(r2.text).query).toEqual([{ value: 'draft' }, { name: 'b', value: 'mine' }]);
    const r3 = mergeRequest(base, current, q('{ name: a, value: "1" }', '{ name: c, value: "3" }', '{ name: b, value: "2" }'));
    expect(parse(r3.text).query).toEqual([{ value: 'draft' }, { name: 'a', value: '1' }, { name: 'c', value: '3' }, { name: 'b', value: 'mine' }]);
  });

  it('non-list query or headers and non-map pathParams are flagged', () => {
    const base = 'method: GET\nurl: u\nquery:\n  - name: a\n    value: "1"\npathParams:\n  id: "1"\n';
    const next = base.replace('value: "1"', 'value: "2"').replace('id: "1"', 'id: "2"');
    const current = 'method: GET\nurl: u\nquery: a=1\npathParams: [1]\n';
    expect(mergeRequest(base, current, next)).toEqual({ text: current, conflicts: ['query', 'pathParams'] });
    // Spec unchanged: nothing to flag.
    expect(mergeRequest(base, current, base)).toEqual({ text: current, conflicts: [] });
  });

  it('no snapshot: spec auth and body are added to a file lacking them', () => {
    const current = 'name: Mine\nmethod: POST\nurl: u\n';
    const next = 'name: x\nmethod: POST\nurl: u\nauth:\n  type: none\nbody:\n  json: |-\n    {\n      "a": 1\n    }\n';
    const r = mergeWithoutBase(current, next);
    expect(r.conflicts).toEqual([]);
    const m = req(r.text);
    expect(m.name).toBe('Mine');
    expect(m.auth).toEqual({ type: 'none' });
    expect(jsonOf(r.text)).toEqual({ a: 1 });
  });
});
