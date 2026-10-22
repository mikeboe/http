// vscode-free: how an OpenAPI import plan is presented before it is applied.
import type { FileChange, ImportPlan } from '../core/openapi/importer';

export type ChangeKind = 'added' | 'updated' | 'removed' | 'conflict';

export function planSummary(p: ImportPlan): string {
  const c = p.conflicted.length;
  return `${p.added.length} added, ${p.updated.length} updated, ${p.removed.length} removed, ${c} ${c === 1 ? 'conflict' : 'conflicts'}`;
}

export function planFiles(p: ImportPlan): { kind: ChangeKind; change: FileChange }[] {
  return [
    ...p.conflicted.map((change) => ({ kind: 'conflict' as const, change })),
    ...p.added.map((change) => ({ kind: 'added' as const, change })),
    ...p.updated.map((change) => ({ kind: 'updated' as const, change })),
    ...p.removed.map((change) => ({ kind: 'removed' as const, change })),
  ];
}

export const isEmptyPlan = (p: ImportPlan) => planFiles(p).length === 0;

/** A default spec name from a file path or URL, e.g. `specs/petstore.yaml` → `petstore`. */
export function suggestSpecName(source: string): string {
  let base = source;
  try {
    const u = new URL(source);
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      const last = u.pathname.split('/').filter(Boolean).pop();
      base = last && !/^(openapi|swagger|api|spec)(\.\w+)?$/i.test(last) ? last : u.hostname.split('.').filter((p) => p !== 'www' && p !== 'api')[0] ?? 'api';
    }
  } catch { /* a file path */ }
  const file = base.split(/[\\/]/).pop() ?? base;
  const stem = file.replace(/\.(ya?ml|json)$/i, '');
  const name = stem.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^[^A-Za-z0-9]+|-+$/g, '');
  return name || 'api';
}

export const SPEC_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
