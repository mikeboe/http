import { isScalar, isSeq, parseDocument, Scalar, visit, type Document, type Node } from 'yaml';

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
  return doc.toString({ lineWidth: 0 });
}
