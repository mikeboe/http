import { isDeepStrictEqual } from 'node:util';
import { isMap, isScalar, isSeq, LineCounter, parseDocument, Scalar, visit, type Document, type Node, type ToStringOptions } from 'yaml';

export type YamlPath = (string | number)[];
export type EditOp =
  | { op: 'set'; path: YamlPath; value: unknown }
  | { op: 'delete'; path: YamlPath }
  | { op: 'insert'; path: YamlPath; index: number; value: unknown }
  | { op: 'move'; path: YamlPath; from: number; to: number };

/** Create a node from a JS value; multiline strings become block literals. */
function makeNode(doc: Document, value: unknown): Node {
  const node = doc.createNode(value) as Node;
  visit(node, {
    Scalar(_k, s) {
      if (typeof s.value === 'string' && s.value.includes('\n')) s.type = Scalar.BLOCK_LITERAL;
    },
  });
  return node;
}

export function applyEdits(text: string, ops: EditOp[]): string {
  const doc = parseDocument(text);
  if (doc.errors.length) throw new Error(`invalid YAML: ${doc.errors[0].message.split('\n')[0]}`);

  for (const op of ops) {
    switch (op.op) {
      case 'set': {
        const old = doc.getIn(op.path, true);
        const multiline = typeof op.value === 'string' && op.value.includes('\n');
        const plain = op.value === null || ['string', 'number', 'boolean'].includes(typeof op.value);
        if (isScalar(old) && plain && !multiline) {
          // Update in place: keeps comments and quote style.
          old.value = op.value;
          if (old.type === Scalar.BLOCK_LITERAL || old.type === Scalar.BLOCK_FOLDED) old.type = undefined;
          if (typeof op.value !== 'string') old.type = undefined;
          break;
        }
        const node = makeNode(doc, op.value);
        if (old && typeof old === 'object' && 'comment' in old) {
          const o = old as Node;
          if (o.comment && !node.comment) node.comment = o.comment;
          if (o.commentBefore && !node.commentBefore) node.commentBefore = o.commentBefore;
        }
        doc.setIn(op.path, node);
        break;
      }
      case 'delete':
        doc.deleteIn(op.path);
        break;
      case 'insert': {
        let seq = doc.getIn(op.path, true);
        const cur = doc.getIn(op.path);
        if (cur === undefined || cur === null) {
          doc.setIn(op.path, doc.createNode([]));
          seq = doc.getIn(op.path, true);
        }
        if (!isSeq(seq)) throw new Error(`cannot insert: ${op.path.join('.')} is not a sequence`);
        const i = Math.max(0, Math.min(op.index, seq.items.length));
        seq.items.splice(i, 0, makeNode(doc, op.value));
        break;
      }
      case 'move': {
        const seq = doc.getIn(op.path, true);
        if (!isSeq(seq)) throw new Error(`cannot move: ${op.path.join('.')} is not a sequence`);
        const n = seq.items.length;
        if (op.from < 0 || op.from >= n || op.to < 0 || op.to >= n) throw new Error('move index out of range');
        const [item] = seq.items.splice(op.from, 1);
        seq.items.splice(op.to, 0, item);
        break;
      }
    }
  }
  const next = doc.toString({ lineWidth: 0, ...detectStyle(text) });
  return preserveLines(text, next, doc.toJS());
}

/** Indentation and flow padding the source uses, so re-serialised lines match their neighbours. */
function detectStyle(text: string): Pick<ToStringOptions, 'indent' | 'indentSeq' | 'flowCollectionPadding'> {
  const lc = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lc });
  const indents = new Map<number, number>();
  let seqIndented = 0;
  let seqFlat = 0;
  let padded = 0;
  let unpadded = 0;
  const col = (n: unknown) => {
    const r = (n as { range?: [number, number, number] } | null)?.range;
    return r ? lc.linePos(r[0]) : undefined;
  };
  visit(doc, {
    Pair(_k, pair) {
      const k = col(pair.key);
      const v = pair.value;
      if (!k || !(isMap(v) || isSeq(v)) || !v.range) return;
      if (v.flow) return;
      const first = isMap(v) ? col(v.items[0]?.key) : col(v);
      if (!first || first.line === k.line) return;
      const delta = first.col - k.col;
      if (isSeq(v)) {
        if (delta === 0) seqFlat++;
        else { seqIndented++; indents.set(delta, (indents.get(delta) ?? 0) + 1); }
      } else if (delta > 0) indents.set(delta, (indents.get(delta) ?? 0) + 1);
    },
    Map(_k, m) { flow(m); },
    Seq(_k, m) { flow(m); },
  });
  function flow(n: { flow?: boolean; range?: [number, number, number] | null; items: unknown[] }) {
    if (!n.flow || !n.range || n.items.length === 0) return;
    const c = text[n.range[0] + 1];
    if (c === ' ') padded++;
    else if (c !== '\n' && c !== '\r') unpadded++;
  }
  const out: Pick<ToStringOptions, 'indent' | 'indentSeq' | 'flowCollectionPadding'> = {};
  const best = [...indents].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
  if (best) out.indent = best[0];
  if (seqFlat > seqIndented) out.indentSeq = false;
  if (unpadded > padded) out.flowCollectionPadding = false;
  return out;
}

const MAX_LCS_CELLS = 4_000_000;

/**
 * Re-serialising normalises formatting (comment spacing, flow padding…). Keep each old line whose
 * counterpart in `next` differs only in whitespace, as long as the result still means `expected`.
 */
function preserveLines(text: string, next: string, expected: unknown): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const normalized = eol === '\n' ? next : next.replace(/\n/g, eol);
  if (normalized === text) return text;
  const a = text.split(eol);
  const b = normalized.split(eol);
  const loose = (l: string) => l.trim().replace(/\s+/g, ' ').replace(/([{[]) /g, '$1').replace(/ ([}\]])/g, '$1');
  const strict = (l: string) => (/^\s*/.exec(l)?.[0] ?? '') + loose(l);
  for (const key of [loose, strict]) {
    const merged = mergeLines(a, b, key);
    if (merged === undefined) break;
    const out = merged.join(eol);
    const check = parseDocument(out);
    if (!check.errors.length && isDeepStrictEqual(check.toJS(), expected)) return out;
  }
  return normalized;
}

/** LCS over lines compared by `key`; matched lines come from `a`, the rest from `b`. */
function mergeLines(a: string[], b: string[], key: (l: string) => string): string[] | undefined {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const ka = a.slice(pre, a.length - suf).map(key);
  const kb = b.slice(pre, b.length - suf).map(key);
  const n = ka.length;
  const m = kb.length;
  if ((n + 1) * (m + 1) > MAX_LCS_CELLS) return undefined;
  const t = new Uint32Array((n + 1) * (m + 1));
  const at = (i: number, j: number) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      t[at(i, j)] = ka[i] === kb[j] ? t[at(i + 1, j + 1)] + 1 : Math.max(t[at(i + 1, j)], t[at(i, j + 1)]);
    }
  }
  const mid: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (ka[i] === kb[j]) { mid.push(a[pre + i]); i++; j++; }
    else if (t[at(i + 1, j)] >= t[at(i, j + 1)]) i++;
    else { mid.push(b[pre + j]); j++; }
  }
  while (j < m) mid.push(b[pre + j++]);
  return [...a.slice(0, pre), ...mid, ...a.slice(a.length - suf)];
}

/** The single span of `prev` to replace so it becomes `next` (common prefix and suffix left alone). */
export function changedRange(prev: string, next: string): { start: number; end: number; text: string } {
  let start = 0;
  const max = Math.min(prev.length, next.length);
  while (start < max && prev[start] === next[start]) start++;
  let suf = 0;
  while (suf < max - start && prev[prev.length - 1 - suf] === next[next.length - 1 - suf]) suf++;
  return { start, end: prev.length - suf, text: next.slice(start, next.length - suf) };
}
