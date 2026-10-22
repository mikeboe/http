import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { TreeNode } from '../../core/workspace';
import { requestIdFromPath } from '../../core/workspace';
import { checkEntryName, duplicateText, newRequestText, REQ_EXT, slug, uniquePath, withName } from '../fileOps';
import { openInEditor, requireRoots } from '../services';
import type { Ext } from '../services';

const RESERVED = new Set(['env', '.openapi', '.schema']);

/** The folder a "new …" action targets: the folder node, a request's folder, or the root. */
function targetDir(root: string, node?: TreeNode): string {
  if (!node) return root;
  return node.kind === 'folder' ? node.path : path.dirname(node.path);
}

function requestIdsUnder(node: TreeNode, out: string[] = []): string[] {
  for (const c of node.children ?? []) {
    if (c.kind === 'request') out.push(c.id);
    else requestIdsUnder(c, out);
  }
  return out;
}

export async function newRequest(ext: Ext, node?: TreeNode): Promise<void> {
  const { root } = requireRoots();
  const name = await vscode.window.showInputBox({ title: 'New request', prompt: 'Request name', validateInput: (v) => (v.trim() ? undefined : 'Enter a name') });
  if (!name) return;
  const dir = targetDir(root, node);
  await mkdir(dir, { recursive: true });
  const file = await uniquePath(dir, slug(name), REQ_EXT);
  await writeFile(file, newRequestText(name.trim()), { flag: 'wx' });
  ext.tree.refresh();
  await openInEditor(vscode.Uri.file(file));
}

export async function newFolder(ext: Ext, node?: TreeNode): Promise<void> {
  const { root } = requireRoots();
  const dir = targetDir(root, node);
  const name = await vscode.window.showInputBox({
    title: 'New folder', prompt: 'Folder name',
    validateInput: (v) => checkEntryName(v) ?? (dir === root && RESERVED.has(v) ? `"${v}" is reserved` : undefined),
  });
  if (!name) return;
  await mkdir(path.join(dir, name));
  ext.tree.refresh();
}

export async function rename(ext: Ext, node?: TreeNode): Promise<void> {
  if (!node) return;
  const { root } = requireRoots();
  const parent = path.dirname(node.path);
  if (node.kind === 'folder') {
    const name = await vscode.window.showInputBox({ title: 'Rename folder', value: node.name, validateInput: checkEntryName });
    if (!name || name === node.name) return;
    const target = path.join(parent, name);
    const edit = new vscode.WorkspaceEdit();
    edit.renameFile(vscode.Uri.file(node.path), vscode.Uri.file(target));
    if (!(await vscode.workspace.applyEdit(edit))) throw new Error(`Could not rename ${node.name}: ${name} may already exist`);
    const newPrefix = path.relative(root, target).split(path.sep).join('/');
    for (const id of requestIdsUnder(node)) await ext.history.rename(id, newPrefix + id.slice(node.id.length));
    ext.tree.refresh();
    return;
  }
  // A request: the name is what the tree shows, and the file follows it.
  const name = await vscode.window.showInputBox({ title: 'Rename request', value: node.name, validateInput: (v) => (v.trim() ? undefined : 'Enter a name') });
  if (!name || name === node.name) return;
  const uri = vscode.Uri.file(node.path);
  const doc = await vscode.workspace.openTextDocument(uri);
  const text = doc.getText();
  const next = withName(text, name.trim());
  const stem = slug(name);
  const sameFile = path.basename(node.path) === stem + REQ_EXT;
  const target = sameFile ? node.path : await uniquePath(parent, stem, REQ_EXT);
  const edit = new vscode.WorkspaceEdit();
  if (next !== text) edit.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(text.length)), next);
  if (!sameFile) edit.renameFile(uri, vscode.Uri.file(target));
  if (!(await vscode.workspace.applyEdit(edit))) throw new Error(`Could not rename ${node.name}`);
  await (await vscode.workspace.openTextDocument(vscode.Uri.file(target))).save();
  if (!sameFile) await ext.history.rename(node.id, requestIdFromPath(root, target));
  ext.tree.refresh();
}

export async function duplicate(ext: Ext, node?: TreeNode): Promise<void> {
  if (node?.kind !== 'request') return;
  const text = await readFile(node.path, 'utf8');
  const name = `${node.name} copy`;
  const file = await uniquePath(path.dirname(node.path), `${path.basename(node.path, REQ_EXT)}-copy`, REQ_EXT);
  await writeFile(file, duplicateText(text, name), { flag: 'wx' });
  ext.tree.refresh();
  await openInEditor(vscode.Uri.file(file));
}

export async function remove(ext: Ext, node?: TreeNode): Promise<void> {
  if (!node) return;
  const what = node.kind === 'folder' ? `folder "${node.name}" and everything in it` : `"${node.name}"`;
  const ok = await vscode.window.showWarningMessage(`Delete ${what}?`, { modal: true }, 'Delete');
  if (ok !== 'Delete') return;
  await vscode.workspace.fs.delete(vscode.Uri.file(node.path), { recursive: true, useTrash: true });
  ext.tree.refresh();
}
