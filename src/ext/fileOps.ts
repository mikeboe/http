// vscode-free: file naming and content helpers for tree actions.
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { parseDocument, stringify } from 'yaml';
import { applyEdits } from '../core/yamlEdit';

export const REQ_EXT = '.req.yaml';

export function slug(name: string): string {
  const s = name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|-+$/g, '');
  return s || 'request';
}

/** A file or folder name that stays inside its parent directory. */
export function checkEntryName(name: string): string | undefined {
  if (!name.trim()) return 'Enter a name';
  if (/[\\/]/.test(name) || name === '.' || name === '..') return 'Names cannot contain / or \\';
  return undefined;
}

const exists = (p: string) => access(p).then(() => true, () => false);

/** `dir/stem<ext>`, or `dir/stem-2<ext>`, `-3`, … if taken. */
export async function uniquePath(dir: string, stem: string, ext: string): Promise<string> {
  let candidate = join(dir, stem + ext);
  for (let i = 2; await exists(candidate); i++) candidate = join(dir, `${stem}-${i}${ext}`);
  return candidate;
}

export function newRequestText(name: string): string {
  return stringify({ name, method: 'GET', url: 'https://example.com' }, { lineWidth: 0 });
}

/** Sets `name`; leaves the text unchanged if it is not valid YAML. */
export function withName(text: string, name: string): string {
  if (parseDocument(text).errors.length) return text;
  return applyEdits(text, [{ op: 'set', path: ['name'], value: name }]);
}

/** A copy is a new, user-owned request: renamed and detached from its OpenAPI source. */
export function duplicateText(text: string, name: string): string {
  if (parseDocument(text).errors.length) return text;
  const ops = [{ op: 'set' as const, path: ['name'], value: name }];
  const hasSource = parseDocument(text).has('source');
  return applyEdits(text, hasSource ? [...ops, { op: 'delete' as const, path: ['source'] }] : ops);
}
