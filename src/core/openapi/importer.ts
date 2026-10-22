import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parse, stringify } from 'yaml';
import { addSecretNames, addVariables, createEnvironment, listEnvironments, loadEnvironment } from '../env';
import { applyEdits } from '../yamlEdit';
import { listTree, type TreeNode } from '../workspace';
import { generate } from './generate';
import { loadSpec } from './load';
import { mergeRequest, mergeWithoutBase, type MergeResult } from './merge';

export interface FileChange { relPath: string; operationId: string; before?: string; after: string; conflicts: string[]; specText: string }
export interface ImportPlan {
  specName: string; source: string; target: string; added: FileChange[]; updated: FileChange[];
  conflicted: FileChange[]; removed: FileChange[]; unchanged: number; newVariables: Record<string, string>; secretVars: string[];
  /** The newly generated text per operationId (and `_folder`), written as the next snapshot by `applyImport`. */
  snapshot: Record<string, string>;
}

const FOLDER_ID = '_folder';
const SPECS_DIR = '.openapi';
const toPosix = (p: string) => p.split(path.sep).join('/');

function checkSpecName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name) || name.includes('..')) throw new Error(`Invalid spec name: ${name}`);
}

/** Normalises a root-relative folder and refuses paths that leave the root. */
function checkTarget(root: string, target: string): string {
  const rel = toPosix(path.relative(root, path.resolve(root, target)));
  if (rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) throw new Error(`Target folder must be inside the root: ${target}`);
  return rel;
}

async function readOptional(file: string): Promise<string | undefined> {
  try { return await fs.readFile(file, 'utf8'); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}
const exists = async (file: string) => (await readOptional(file)) !== undefined;

async function readYaml(file: string): Promise<Record<string, unknown> | undefined> {
  const text = await readOptional(file);
  if (text === undefined) return undefined;
  const v = parse(text) as unknown;
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Every request file under root whose `source.spec` is specName, keyed by operationId (first one found wins). */
async function findSourced(root: string, specName: string): Promise<Map<string, { relPath: string; text: string; removed: boolean }>> {
  const found = new Map<string, { relPath: string; text: string; removed: boolean }>();
  const walk = async (nodes: TreeNode[]) => {
    for (const n of nodes) {
      if (n.kind === 'folder') { await walk(n.children ?? []); continue; }
      const text = await readOptional(n.path);
      if (text === undefined) continue;
      let source: any;
      try { source = (parse(text) as any)?.source; } catch { continue; } // unreadable YAML cannot be matched
      if (source?.spec !== specName || typeof source.operationId !== 'string' || found.has(source.operationId)) continue;
      found.set(source.operationId, { relPath: toPosix(path.relative(root, n.path)), text, removed: source.removed === true });
    }
  };
  await walk(await listTree(root));
  return found;
}

/** Base URL is a new variable when some environment lacks it (or there are none yet). */
async function newVariablesFor(root: string, name: string, value: string | undefined): Promise<Record<string, string>> {
  if (value === undefined) return {};
  const envs = await listEnvironments(root);
  if (!envs.length) return { [name]: value };
  for (const env of envs) {
    if (!Object.prototype.hasOwnProperty.call((await loadEnvironment(root, env)).variables, name)) return { [name]: value };
  }
  return {};
}

export async function planImport(
  root: string, opts: { specName: string; source: string; target: string; baseDir: string },
): Promise<ImportPlan> {
  checkSpecName(opts.specName);
  const target = checkTarget(root, opts.target);
  const gen = generate(await loadSpec(opts.source, opts.baseDir), opts.specName);
  const snapshotFile = path.join(root, SPECS_DIR, `${opts.specName}.snapshot.yaml`);
  const oldSnapshot = (await readYaml(snapshotFile)) ?? {};
  const baseOf = (id: string) => (typeof oldSnapshot[id] === 'string' ? (oldSnapshot[id] as string) : undefined);
  const plan: ImportPlan = {
    specName: opts.specName, source: opts.source, target, added: [], updated: [], conflicted: [], removed: [], unchanged: 0,
    newVariables: await newVariablesFor(root, gen.baseUrlVar, gen.baseUrl), secretVars: gen.secretVars, snapshot: {},
  };
  const merge = (id: string, current: string, next: string): MergeResult => {
    const base = baseOf(id);
    // No snapshot entry (first import, or the file predates the snapshot): only spec additions apply.
    return base === undefined ? mergeWithoutBase(current, next) : mergeRequest(base, current, next);
  };
  const classify = (relPath: string, operationId: string, before: string, r: MergeResult, specText: string) => {
    const change: FileChange = { relPath, operationId, before, after: r.text, conflicts: r.conflicts, specText };
    if (r.conflicts.length) plan.conflicted.push(change);
    else if (r.text !== before) plan.updated.push(change);
    else plan.unchanged++;
  };

  const sourced = await findSourced(root, opts.specName);
  const taken = new Set<string>();
  const freePath = async (rel: string) => {
    const stem = rel.slice(0, -'.req.yaml'.length);
    let candidate = rel;
    for (let n = 2; taken.has(candidate) || (await exists(path.join(root, candidate))); n++) candidate = `${stem}-${n}.req.yaml`;
    taken.add(candidate);
    return candidate;
  };

  for (const req of gen.requests) {
    plan.snapshot[req.operationId] = req.text;
    const file = sourced.get(req.operationId);
    if (file) {
      let r = merge(req.operationId, file.text, req.text);
      // The operation is back in the spec.
      if (file.removed) r = { ...r, text: applyEdits(r.text, [{ op: 'delete', path: ['source', 'removed'] }]) };
      classify(file.relPath, req.operationId, file.text, r, req.text);
    } else if (baseOf(req.operationId) !== undefined) {
      plan.unchanged++; // imported before and deleted by the user: not re-created
    } else {
      const relPath = await freePath(path.posix.join(target, req.relPath));
      plan.added.push({ relPath, operationId: req.operationId, after: req.text, conflicts: [], specText: req.text });
    }
  }

  const ids = new Set(gen.requests.map((r) => r.operationId));
  for (const [operationId, file] of sourced) {
    if (ids.has(operationId)) continue;
    if (file.removed) { plan.unchanged++; continue; }
    const after = applyEdits(file.text, [{ op: 'set', path: ['source', 'removed'], value: true }]);
    plan.removed.push({ relPath: file.relPath, operationId, before: file.text, after, conflicts: [], specText: after });
  }

  // _folder.yaml: merged like a request; only its auth and headers are spec-owned.
  const folderRel = path.posix.join(target, '_folder.yaml');
  const folderCurrent = await readOptional(path.join(root, folderRel));
  const folderNext = gen.folderText ?? '';
  if (gen.folderText !== undefined) plan.snapshot[FOLDER_ID] = gen.folderText;
  if (folderCurrent !== undefined) {
    classify(folderRel, FOLDER_ID, folderCurrent, merge(FOLDER_ID, folderCurrent, folderNext), folderNext);
  } else if (gen.folderText !== undefined) {
    if (baseOf(FOLDER_ID) !== undefined) plan.unchanged++; // deleted by the user
    else plan.added.push({ relPath: folderRel, operationId: FOLDER_ID, after: gen.folderText, conflicts: [], specText: gen.folderText });
  }
  return plan;
}

export async function planReimport(root: string, specName: string, baseDir: string): Promise<ImportPlan> {
  checkSpecName(specName);
  const reg = await readYaml(path.join(root, SPECS_DIR, `${specName}.yaml`));
  if (!reg || typeof reg.source !== 'string' || typeof reg.target !== 'string') throw new Error(`Spec not registered: ${specName}`);
  return planImport(root, { specName, source: reg.source, target: reg.target, baseDir });
}

export async function applyImport(root: string, workspaceDir: string, plan: ImportPlan, takeSpec: Set<string>): Promise<void> {
  checkSpecName(plan.specName);
  for (const c of [...plan.added, ...plan.updated, ...plan.conflicted, ...plan.removed]) {
    const file = path.join(root, checkTarget(root, c.relPath));
    await fs.mkdir(path.dirname(file), { recursive: true });
    const isNew = plan.added.includes(c);
    // Added files never overwrite something that appeared after planning.
    await fs.writeFile(file, takeSpec.has(c.relPath) ? c.specText : c.after, isNew ? { flag: 'wx' } : {});
  }

  let envs = await listEnvironments(root);
  if (!envs.length) {
    await createEnvironment(root, 'local', workspaceDir);
    envs = ['local'];
  }
  for (const env of envs) {
    if (Object.keys(plan.newVariables).length) await addVariables(root, env, plan.newVariables);
    if (plan.secretVars.length) await addSecretNames(root, env, plan.secretVars);
  }

  const dir = path.join(root, SPECS_DIR);
  await fs.mkdir(dir, { recursive: true });
  const registry = { source: plan.source, target: plan.target, importedAt: new Date().toISOString() };
  await fs.writeFile(path.join(dir, `${plan.specName}.yaml`), stringify(registry, { lineWidth: 0 }));
  await fs.writeFile(path.join(dir, `${plan.specName}.snapshot.yaml`), stringify(plan.snapshot, { lineWidth: 0 }));
}

export async function listSpecs(root: string): Promise<{ name: string; source: string; target: string; importedAt: string }[]> {
  let files: string[];
  try { files = await fs.readdir(path.join(root, SPECS_DIR)); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const out: { name: string; source: string; target: string; importedAt: string }[] = [];
  for (const f of files.filter((x) => x.endsWith('.yaml') && !x.endsWith('.snapshot.yaml')).sort()) {
    let reg: Record<string, unknown> | undefined;
    try { reg = await readYaml(path.join(root, SPECS_DIR, f)); } catch { continue; } // broken registry file
    if (!reg || typeof reg.source !== 'string' || typeof reg.target !== 'string') continue;
    out.push({ name: f.slice(0, -'.yaml'.length), source: reg.source, target: reg.target, importedAt: String(reg.importedAt ?? '') });
  }
  return out;
}
