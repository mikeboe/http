import { isSeq, parseDocument, Scalar, visit, type Document } from 'yaml';

export type YamlPath = (string | number)[];
export type EditOp =
  | { op: 'set'; path: YamlPath; value: unknown }
  | { op: 'delete'; path: YamlPath }
  | { op: 'insert'; path: YamlPath; index: number; value: unknown }
  | { op: 'move'; path: YamlPath; from: number; to: number };

/** Create a node from a JS value; multiline strings become block literals. */
function makeNode(doc: Document, value: unknown): unknown {
  const node = doc.createNode(value);
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
      case 'set':
        doc.setIn(op.path, makeNode(doc, op.value));
        break;
      case 'delete':
        doc.deleteIn(op.path);
        break;
      case 'insert': {
        let seq = doc.getIn(op.path, true);
        if (!isSeq(seq)) {
          doc.setIn(op.path, doc.createNode([]));
          seq = doc.getIn(op.path, true);
        }
        if (!isSeq(seq)) throw new Error(`cannot insert: ${op.path.join('.')} is not a sequence`);
        const i = Math.max(0, Math.min(op.index, seq.items.length));
        seq.items.splice(i, 0, makeNode(doc, op.value) as never);
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
  return doc.toString();
}
