import { parse } from 'yaml';
import { applyEdits, type EditOp } from '../yamlEdit';

export interface MergeResult { text: string; conflicts: string[] }   // conflict = human path, e.g. 'url', 'query.limit', 'body.json.name', 'auth'

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const has = (o: Obj, k: string) => Object.prototype.hasOwnProperty.call(o, k);

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  if (!isObj(a) || !isObj(b)) return false;
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => has(b, k) && deepEqual(a[k], b[k]));
}

/** Three-way rule for one value: user unchanged takes next; spec unchanged or same change keeps current; else conflict. */
function pick(b: unknown, c: unknown, n: unknown): { value: unknown; takeNext: boolean; conflict: boolean } {
  if (deepEqual(c, n)) return { value: c, takeNext: false, conflict: false };
  if (deepEqual(c, b)) return { value: n, takeNext: true, conflict: false };
  if (deepEqual(n, b)) return { value: c, takeNext: false, conflict: false };
  return { value: c, takeNext: false, conflict: true };
}

const DROP = Symbol('drop');

/**
 * Merges keyed maps (JSON objects, pathParams) recursively. Keeps the user's key order and appends new keys.
 * `b` undefined for a key means the key was not in the base. Arrays are scalars.
 */
function mergeValue(b: unknown, c: unknown, n: unknown, path: string[], conflicts: string[], label: (p: string[]) => string): unknown {
  if (isObj(c) && isObj(n)) {
    const bo = isObj(b) ? b : {};
    const out: Obj = {};
    for (const k of Object.keys(c)) {
      if (has(n, k)) out[k] = mergeValue(has(bo, k) ? bo[k] : undefined, c[k], n[k], [...path, k], conflicts, label);
      else if (has(bo, k) && deepEqual(c[k], bo[k])) continue; // removed by the spec, untouched by the user
      else {
        if (has(bo, k)) conflicts.push(label([...path, k])); // removed by the spec, changed by the user
        out[k] = c[k];
      }
    }
    for (const k of Object.keys(n)) {
      if (has(c, k)) continue;
      if (!has(bo, k)) out[k] = n[k]; // added by the spec
      else if (!deepEqual(n[k], bo[k])) conflicts.push(label([...path, k])); // removed by the user, changed by the spec
    }
    return out;
  }
  const r = pick(b, c, n);
  if (r.conflict) conflicts.push(label(path));
  return r.value;
}

/** The base to use when there is no snapshot: next, limited to what the current value also has. */
function restrict(n: unknown, c: unknown): unknown {
  if (!isObj(n) || !isObj(c)) return n;
  return Object.fromEntries(Object.keys(n).filter((k) => has(c, k)).map((k) => [k, restrict(n[k], c[k])]));
}

/** `idx` is the entry's index in the YAML sequence (nameless and non-mapping items included). */
interface Entry { name: string; value: string; enabled: boolean; raw: Obj; idx: number }
function entries(v: unknown): Entry[] | undefined {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) return undefined;
  const out: Entry[] = [];
  v.forEach((e, idx) => {
    if (!isObj(e) || e.name === undefined || e.name === null) return;
    out.push({ name: String(e.name), value: e.value === undefined || e.value === null ? '' : String(e.value), enabled: e.enabled !== false, raw: e, idx });
  });
  return out;
}
const byName = (list: Entry[]) => {
  const m = new Map<string, Entry>();
  for (const e of list) if (!m.has(e.name)) m.set(e.name, e);
  return m;
};
const sameEntry = (a: Entry, b: Entry) => a.value === b.value && a.enabled === b.enabled;

/** Merges a `{name, value, enabled?}` list keyed by name. */
function mergeList(key: string, b: unknown, c: unknown, n: unknown, ops: EditOp[], conflicts: string[]): void {
  const cur = entries(c);
  const nxt = entries(n);
  if (!nxt) return;
  if (!cur) { // the user's value is not a list: keep it, flag it if the spec changed something
    if (!deepEqual(b, n)) conflicts.push(key);
    return;
  }
  const bMap = byName(entries(b) ?? []), cMap = byName(cur), nMap = byName(nxt);
  const fieldOps: EditOp[] = [];
  const removed: number[] = [];
  for (const [name, ce] of cMap) {
    const be = bMap.get(name);
    const ne = nMap.get(name);
    if (ne) {
      const v = pick(be?.value, ce.value, ne.value);
      if (v.takeNext) fieldOps.push({ op: 'set', path: [key, ce.idx, 'value'], value: ne.raw.value ?? '' });
      const en = pick(be?.enabled, ce.enabled, ne.enabled);
      if (en.takeNext) {
        fieldOps.push(ne.raw.enabled === undefined
          ? { op: 'delete', path: [key, ce.idx, 'enabled'] }
          : { op: 'set', path: [key, ce.idx, 'enabled'], value: ne.raw.enabled });
      }
      if (v.conflict || en.conflict) conflicts.push(`${key}.${name}`);
    } else if (be) {
      if (sameEntry(ce, be)) removed.push(ce.idx);
      else conflicts.push(`${key}.${name}`);
    }
  }
  ops.push(...fieldOps);
  // Delete from the end so earlier indexes stay valid.
  for (const i of removed.sort((x, y) => y - x)) ops.push({ op: 'delete', path: [key, i] });
  // The sequence after the deletes, by name (null for nameless items), used for insert positions.
  const slots: (string | null)[] = (c as unknown[] | undefined ?? [])
    .map((e, i) => (removed.includes(i) ? undefined : isObj(e) && e.name !== undefined && e.name !== null ? String(e.name) : null))
    .filter((x): x is string | null => x !== undefined);
  let inserted = 0;
  nxt.forEach((ne, ni) => {
    if (cMap.has(ne.name)) return;
    const be = bMap.get(ne.name);
    if (be) { // removed by the user
      if (!sameEntry(ne, be)) conflicts.push(`${key}.${ne.name}`);
      return;
    }
    // After the nearest preceding spec entry, else before the nearest following one, else at the end.
    let at = slots.length;
    const prev = nxt.slice(0, ni).reverse().find((e) => slots.includes(e.name));
    if (prev) at = slots.indexOf(prev.name) + 1;
    else {
      const following = nxt.slice(ni + 1).find((e) => slots.includes(e.name));
      if (following) at = slots.indexOf(following.name);
    }
    slots.splice(at, 0, ne.name);
    ops.push({ op: 'insert', path: [key], index: at, value: ne.raw });
    inserted++;
  });
  if (slots.length === 0 && removed.length && !inserted) ops.push({ op: 'delete', path: [key] });
}

function setOrDelete(path: string[], value: unknown): EditOp {
  return value === undefined ? { op: 'delete', path } : { op: 'set', path, value };
}

/** Merges a top-level value as one scalar (method, url, auth). */
function mergeScalar(key: string, b: Obj, c: Obj, n: Obj, ops: EditOp[], conflicts: string[]): void {
  const r = pick(b[key], c[key], n[key]);
  if (r.takeNext) ops.push(setOrDelete([key], n[key]));
  if (r.conflict) conflicts.push(key);
}

const str = (v: unknown) => (v === undefined || v === null ? '' : String(v));
function stringMap(v: unknown): Obj | undefined {
  if (v === undefined || v === null) return {};
  return isObj(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, str(x)])) : undefined;
}

function mergePathParams(b: Obj, c: Obj, n: Obj, ops: EditOp[], conflicts: string[]): void {
  const cur = stringMap(c.pathParams), nxt = stringMap(n.pathParams);
  if (!nxt) return;
  if (!cur) { // the user's value is not a map: keep it, flag it if the spec changed something
    if (!deepEqual(b.pathParams, n.pathParams)) conflicts.push('pathParams');
    return;
  }
  const merged = mergeValue(stringMap(b.pathParams) ?? {}, cur, nxt, [], conflicts, (p) => `pathParams.${p.join('.')}`) as Obj;
  if (deepEqual(merged, cur)) return;
  if (Object.keys(merged).length === 0) { ops.push({ op: 'delete', path: ['pathParams'] }); return; }
  for (const k of Object.keys(cur)) if (!has(merged, k)) ops.push({ op: 'delete', path: ['pathParams', k] });
  for (const [k, v] of Object.entries(merged)) if (cur[k] !== v) ops.push({ op: 'set', path: ['pathParams', k], value: v });
}

const bodyKey = (v: unknown) => (v === undefined || v === null ? undefined : isObj(v) && Object.keys(v).length === 1 ? Object.keys(v)[0] : '?');
function parseJson(v: unknown): { ok: boolean; value?: unknown } {
  if (typeof v !== 'string') return v === undefined ? { ok: false } : { ok: true, value: v };
  try { return { ok: true, value: JSON.parse(v) }; } catch { return { ok: false }; }
}

function mergeBody(b: Obj, c: Obj, n: Obj, ops: EditOp[], conflicts: string[]): void {
  const bk = bodyKey(b.body), ck = bodyKey(c.body), nk = bodyKey(n.body);
  if (ck !== nk) {
    if (ck === bk && deepEqual(c.body, b.body)) ops.push(setOrDelete(['body'], n.body));
    else if (nk !== bk || ck === bk) conflicts.push('body');
    return;
  }
  if (ck !== 'json') {
    if (ck !== undefined) mergeScalar('body', b, c, n, ops, conflicts);
    return;
  }
  const cj = (c.body as Obj).json, nj = (n.body as Obj).json;
  const cur = parseJson(cj);
  if (!cur.ok) { conflicts.push('body.json'); return; }
  const nxt = parseJson(nj);
  if (!nxt.ok) return;
  // No usable base JSON: treat it like a missing snapshot (only additions apply).
  const base = bk === 'json' ? parseJson((b.body as Obj).json) : { ok: false };
  const merged = mergeValue(base.ok ? base.value : restrict(nxt.value, cur.value), cur.value, nxt.value, [], conflicts,
    (p) => ['body.json', ...p].join('.'));
  if (deepEqual(merged, cur.value)) return;
  ops.push({ op: 'set', path: ['body', 'json'], value: typeof cj === 'string' ? JSON.stringify(merged, null, 2) : merged });
}

const asObj = (text: string): Obj => {
  const v = parse(text) as unknown;
  return isObj(v) ? v : {};
};

function mergeObjects(b: Obj, current: string, n: Obj): MergeResult {
  const c = asObj(current);
  const ops: EditOp[] = [];
  const conflicts: string[] = [];
  mergeScalar('method', b, c, n, ops, conflicts);
  mergeScalar('url', b, c, n, ops, conflicts);
  for (const key of ['query', 'headers']) mergeList(key, b[key], c[key], n[key], ops, conflicts);
  mergePathParams(b, c, n, ops, conflicts);
  mergeBody(b, c, n, ops, conflicts);
  mergeScalar('auth', b, c, n, ops, conflicts);
  return { text: ops.length ? applyEdits(current, ops) : current, conflicts };
}

/**
 * Three-way merge of a request (or `_folder.yaml`) file: `base` is the last generated text, `current` the
 * file on disk, `next` the newly generated text. Edits are applied to `current`, so `name`, `settings`,
 * comments and unknown keys are never touched.
 */
export function mergeRequest(base: string, current: string, next: string): MergeResult {
  return mergeObjects(asObj(base), current, asObj(next));
}

/**
 * Merge when there is no snapshot for the file (first import, or the file predates the snapshot).
 * The base is taken as "current, but with the spec's values": only what the spec adds is applied, and
 * every differing value keeps the user's version without a conflict. Nothing is removed.
 */
export function mergeWithoutBase(current: string, next: string): MergeResult {
  const c = asObj(current), n = asObj(next);
  // Keys the current file lacks stay out of the base, so the spec's value is added.
  const b: Obj = {};
  for (const k of ['method', 'url', 'auth']) if (has(n, k) && has(c, k)) b[k] = n[k];
  for (const key of ['query', 'headers']) {
    const names = new Set((entries(c[key]) ?? []).map((e) => e.name));
    if (Array.isArray(n[key])) b[key] = (n[key] as unknown[]).filter((e) => isObj(e) && names.has(str(e.name)));
  }
  if (isObj(n.pathParams)) b.pathParams = restrict(n.pathParams, isObj(c.pathParams) ? c.pathParams : {});
  if (n.body !== undefined && c.body !== undefined) b.body = n.body;
  if (bodyKey(c.body) === 'json' && bodyKey(n.body) === 'json') {
    const cj = parseJson((c.body as Obj).json), nj = parseJson((n.body as Obj).json);
    if (cj.ok && nj.ok) b.body = { json: JSON.stringify(restrict(nj.value, cj.value)) };
  }
  return mergeObjects(b, current, n);
}
