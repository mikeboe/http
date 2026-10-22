import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { applyEdits, changedRange } from '../../src/core/yamlEdit';

const BASE = `name: Get thing
# note
headers:
  - name: A
    value: "1"
  - name: B
    value: "2"
query:
  - name: q1
    value: x
  - name: q2
    value: y
url: http://a
`;

describe('applyEdits', () => {
  it('keeps comments', () => {
    const out = applyEdits(BASE, [{ op: 'set', path: ['url'], value: 'http://b' }]);
    expect(out).toContain('# note');
    expect(out).toBe(BASE.replace('url: http://a', 'url: http://b'));
  });

  it('multiline string becomes block literal', () => {
    const out = applyEdits('body:\n  json: x\n', [{ op: 'set', path: ['body', 'json'], value: '{\n  "a": 1\n}' }]);
    expect(out).toContain('json: |');
    expect(parse(out).body.json).toBe('{\n  "a": 1\n}');
  });

  it('replaces json mapping with block string', () => {
    const text = 'url: u\nbody:\n  json:\n    a: 1\n';
    const out = applyEdits(text, [{ op: 'set', path: ['body'], value: { json: '{\n  "a": 1\n}' } }]);
    expect(out).toContain('json: |');
    expect(parse(out).body).toEqual({ json: '{\n  "a": 1\n}' });
  });

  it('insert header', () => {
    const out = applyEdits(BASE, [{ op: 'insert', path: ['headers'], index: 1, value: { name: 'C', value: '3' } }]);
    expect(parse(out).headers.map((h: { name: string }) => h.name)).toEqual(['A', 'C', 'B']);
    expect(out).toContain('# note');
  });

  it('delete header', () => {
    const out = applyEdits(BASE, [{ op: 'delete', path: ['headers', 0] }]);
    expect(parse(out).headers).toEqual([{ name: 'B', value: '2' }]);
    expect(out).toBe(BASE.replace('  - name: A\n    value: "1"\n', ''));
  });

  it('move query', () => {
    const out = applyEdits(BASE, [{ op: 'move', path: ['query'], from: 0, to: 1 }]);
    expect(parse(out).query.map((q: { name: string }) => q.name)).toEqual(['q2', 'q1']);
  });

  it('creates missing path', () => {
    const out = applyEdits(BASE, [{ op: 'set', path: ['settings', 'timeout'], value: '5s' }]);
    expect(parse(out).settings).toEqual({ timeout: '5s' });
    expect(out).toContain('# note');
  });

  it('insert creates a missing sequence', () => {
    const out = applyEdits('url: u\n', [{ op: 'insert', path: ['headers'], index: 0, value: { name: 'A', value: '1' } }]);
    expect(parse(out).headers).toEqual([{ name: 'A', value: '1' }]);
  });

  it('throws on invalid yaml', () => {
    expect(() => applyEdits('a: [1, 2\nb: : :', [{ op: 'set', path: ['a'], value: 1 }])).toThrow();
  });

  it('does not refold untouched long scalars', () => {
    const long = 'word '.repeat(40).trim();
    const text = `desc: ${long}\nk: 5\n`;
    expect(applyEdits(text, [{ op: 'set', path: ['k'], value: 6 }])).toBe(`desc: ${long}\nk: 6\n`);
  });

  it('insert into a non-sequence throws and leaves value alone', () => {
    expect(() => applyEdits('url: u\n', [{ op: 'insert', path: ['url'], index: 0, value: 'z' }])).toThrow(/not a sequence/);
  });

  it('keeps trailing comment and quote style when setting a scalar', () => {
    const out = applyEdits('url: "http://a" # inline\nk: 1\n', [{ op: 'set', path: ['url'], value: 'http://b' }]);
    expect(out).toBe('url: "http://b" # inline\nk: 1\n');
  });

  it('keeps comment when replacing a node', () => {
    const out = applyEdits('body: x # why\n', [{ op: 'set', path: ['body'], value: { json: 'x' } }]);
    expect(out).toContain('# why');
  });

  describe('keeps untouched formatting', () => {
    const FOUR = `name: four
settings:
    timeout: 5s
    followRedirects: true
headers:
    - name: A
      value: "1"
url: http://a
`;
    it('4-space indent survives an edit elsewhere', () => {
      expect(applyEdits(FOUR, [{ op: 'set', path: ['url'], value: 'http://b' }])).toBe(FOUR.replace('http://a', 'http://b'));
    });
    it('4-space indent is used for inserted rows', () => {
      const out = applyEdits(FOUR, [{ op: 'insert', path: ['headers'], index: 1, value: { name: 'B', value: '2' } }]);
      expect(out).toBe(FOUR.replace('      value: "1"\n', '      value: "1"\n    - name: B\n      value: "2"\n'));
    });
    const UNINDENTED = `name: flat
headers:
- name: A
  value: "1"
query:
- name: q
  value: x
url: http://a
`;
    it('unindented sequences survive edits', () => {
      expect(applyEdits(UNINDENTED, [{ op: 'set', path: ['url'], value: 'http://b' }])).toBe(UNINDENTED.replace('http://a', 'http://b'));
      const out = applyEdits(UNINDENTED, [{ op: 'delete', path: ['query', 0] }]);
      expect(out).toBe(UNINDENTED.replace('query:\n- name: q\n  value: x\n', 'query: []\n'));
    });
    it('flow maps without padding and comment spacing survive', () => {
      const text = 'name: f\npathParams: {id: 1, b: x}\nurl: http://a   # the url\nsettings:\n  timeout: 5s     # slow\n';
      expect(applyEdits(text, [{ op: 'set', path: ['settings', 'timeout'], value: '9s' }]))
        .toBe(text.replace('timeout: 5s     # slow', 'timeout: 9s # slow'));
      expect(applyEdits(text, [{ op: 'set', path: ['name'], value: 'g' }])).toBe(text.replace('name: f', 'name: g'));
    });
  });

  describe('changedRange', () => {
    it('covers only the differing middle', () => {
      expect(changedRange('abcXYZdef', 'abcQdef')).toEqual({ start: 3, end: 6, text: 'Q' });
      expect(changedRange('same', 'same')).toEqual({ start: 4, end: 4, text: '' });
      expect(changedRange('aaa', 'aaaa')).toEqual({ start: 3, end: 3, text: 'a' });
      expect(changedRange('ab', '')).toEqual({ start: 0, end: 2, text: '' });
    });
  });
});
