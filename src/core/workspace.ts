import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parseFolder, parseRequest } from './model';
import type { Auth, FolderDef, KV, RequestDef, Settings } from './model';

export interface TreeNode {
  kind: 'folder' | 'request'; id: string; path: string; name: string;
  method?: string; removed?: boolean; invalid?: boolean; children?: TreeNode[];
}

const REQ_EXT = '.req.yaml';
const FOLDER_FILE = '_folder.yaml';
const SKIP_DIRS = new Set(['env', '.openapi', '.schema']);

const toPosix = (p: string) => p.split(path.sep).join('/');

export function requestIdFromPath(root: string, file: string): string {
  const rel = toPosix(path.relative(root, file));
  return rel.endsWith(REQ_EXT) ? rel.slice(0, -REQ_EXT.length) : rel;
}

export function requestPathFromId(root: string, id: string): string {
  return path.join(root, ...id.split('/')) + REQ_EXT;
}

async function readDir(dir: string, root: string): Promise<TreeNode[]> {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return []; }
  const folders: TreeNode[] = [];
  const requests: TreeNode[] = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (dir === root && SKIP_DIRS.has(e.name)) continue;
      folders.push({
        kind: 'folder', id: toPosix(path.relative(root, full)), path: full, name: e.name,
        children: await readDir(full, root),
      });
    } else if (e.isFile() && e.name.endsWith(REQ_EXT)) {
      const fallback = e.name.slice(0, -REQ_EXT.length);
      const node: TreeNode = { kind: 'request', id: requestIdFromPath(root, full), path: full, name: fallback };
      const { request } = parseRequest(await fs.readFile(full, 'utf8'));
      if (!request) node.invalid = true;
      else {
        node.name = request.name || fallback;
        node.method = request.method;
        if (request.source?.removed) node.removed = true;
      }
      requests.push(node);
    }
  }
  const byName = (a: TreeNode, b: TreeNode) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return [...folders.sort(byName), ...requests.sort(byName)];
}

export function listTree(root: string): Promise<TreeNode[]> {
  return readDir(root, root);
}

export async function loadFolderChain(root: string, requestFile: string): Promise<{ dir: string; folder: FolderDef }[]> {
  const rel = path.relative(root, path.dirname(requestFile));
  const parts = rel === '' ? [] : rel.split(path.sep);
  const dirs = [root];
  for (const p of parts) dirs.push(path.join(dirs[dirs.length - 1], p));
  const chain: { dir: string; folder: FolderDef }[] = [];
  for (const dir of dirs) {
    let text: string;
    try { text = await fs.readFile(path.join(dir, FOLDER_FILE), 'utf8'); } catch { continue; }
    const { folder, errors } = parseFolder(text);
    if (!folder) {
      const rel = toPosix(path.relative(root, path.join(dir, FOLDER_FILE)));
      throw new Error(`${rel}: ${errors.map((d) => d.message).join('; ')}`);
    }
    chain.push({ dir, folder });
  }
  return chain;
}

export interface EffectiveRequest extends Omit<RequestDef, 'auth'> {
  auth: Auth; authFrom?: string; inheritedHeaders: KV[]; file: string; id: string;
}

export function effectiveRequest(
  req: RequestDef, chain: { dir: string; folder: FolderDef }[], file: string, root: string,
): EffectiveRequest {
  // Headers: outermost to innermost; a later enabled header replaces an earlier one of the same name.
  const merged = new Map<string, KV>();
  for (const { folder } of chain) {
    for (const h of folder.headers) {
      if (h.enabled === false) continue;
      const key = h.name.toLowerCase();
      merged.delete(key);
      merged.set(key, h);
    }
  }
  for (const h of req.headers) {
    if (h.enabled !== false) merged.delete(h.name.toLowerCase());
  }
  const inheritedHeaders = [...merged.values()];

  let auth: Auth = { type: 'none' };
  let authFrom: string | undefined;
  if (req.auth && req.auth.type !== 'inherit') auth = req.auth;
  else {
    for (let i = chain.length - 1; i >= 0; i--) {
      const a = chain[i].folder.auth;
      if (a && a.type !== 'inherit') { auth = a; authFrom = toPosix(path.relative(root, chain[i].dir)); break; }
    }
  }

  const settings: Settings = {};
  for (const { folder } of chain) Object.assign(settings, folder.settings);
  Object.assign(settings, req.settings);

  return { ...req, auth, authFrom, inheritedHeaders, settings, file, id: requestIdFromPath(root, file) };
}

export async function loadEffective(root: string, id: string): Promise<EffectiveRequest> {
  const file = requestPathFromId(root, id);
  let text: string;
  try { text = await fs.readFile(file, 'utf8'); } catch { throw new Error(`Request not found: ${id}`); }
  const { request, errors } = parseRequest(text);
  if (!request) throw new Error(`${id}: ${errors.map((d) => d.message).join('; ')}`);
  return effectiveRequest(request, await loadFolderChain(root, file), file, root);
}
