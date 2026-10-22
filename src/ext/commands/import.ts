import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { listEnvironments } from '../../core/env';
import { applyImport, listSpecs, planImport, planReimport } from '../../core/openapi/importer';
import type { FileChange, ImportPlan } from '../../core/openapi/importer';
import type { TreeNode } from '../../core/workspace';
import { isEmptyPlan, planFiles, planSummary, SPEC_NAME, suggestSpecName } from '../importPlan';
import type { ChangeKind } from '../importPlan';
import { requireRoots } from '../services';
import type { Ext, Roots } from '../services';

const SCHEME = 'yamlhttp-preview';
const previews = new Map<string, string>();
let previewSeq = 0;

export function registerPreviewProvider(): vscode.Disposable {
  return vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
    provideTextDocumentContent: (uri) => previews.get(uri.toString()) ?? '',
  });
}

function previewUri(label: string, relPath: string, text: string): vscode.Uri {
  const uri = vscode.Uri.from({ scheme: SCHEME, path: `/${label}/${relPath}`, query: String(++previewSeq) });
  previews.set(uri.toString(), text);
  return uri;
}

function showDiff(c: FileChange, against: 'after' | 'spec'): Thenable<unknown> {
  const left = previewUri('current', c.relPath, c.before ?? '');
  const right = against === 'after' ? previewUri('after', c.relPath, c.after) : previewUri('spec', c.relPath, c.specText);
  const title = `${c.relPath} (${c.before === undefined ? 'new' : 'current'} ↔ ${against === 'after' ? 'after import' : 'spec version'})`;
  return vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true, preserveFocus: true });
}

const KIND_ICON: Record<ChangeKind, string> = { added: 'diff-added', updated: 'diff-modified', removed: 'diff-removed', conflict: 'warning' };
type Item = vscode.QuickPickItem & { action?: 'apply' | 'cancel'; change?: FileChange };
const SPEC_DIFF: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('git-compare'), tooltip: 'Compare with the spec version' };

/** Summary + per-file diffs; resolves true when the user chose Apply. */
function confirmPlan(plan: ImportPlan): Promise<boolean> {
  return new Promise((resolve) => {
    const qp = vscode.window.createQuickPick<Item>();
    qp.title = `Import "${plan.specName}": ${planSummary(plan)}`;
    qp.placeholder = 'Select a file to see its diff, then Apply or Cancel';
    qp.ignoreFocusOut = true;
    qp.matchOnDescription = true;
    qp.items = [
      { label: '$(check) Apply', action: 'apply' },
      { label: '$(close) Cancel', action: 'cancel' },
      { label: 'Files', kind: vscode.QuickPickItemKind.Separator },
      ...planFiles(plan).map(({ kind, change }): Item => ({
        label: `$(${KIND_ICON[kind]}) ${change.relPath}`,
        description: kind === 'conflict' ? `conflict: ${change.conflicts.join(', ')}` : kind,
        change,
        buttons: kind === 'conflict' ? [SPEC_DIFF] : undefined,
      })),
    ];
    let done = false;
    const finish = (ok: boolean) => { if (!done) { done = true; resolve(ok); qp.dispose(); } };
    qp.onDidAccept(() => {
      const sel = qp.selectedItems[0];
      if (sel?.change) void showDiff(sel.change, 'after');
      else if (sel?.action) finish(sel.action === 'apply');
    });
    qp.onDidTriggerItemButton((e) => { if (e.item.change) void showDiff(e.item.change, 'spec'); });
    qp.onDidHide(() => finish(false));
    qp.show();
  });
}

async function readOptional(file: string): Promise<string | undefined> {
  try { return await readFile(file, 'utf8'); } catch { return undefined; }
}

async function previewAndApply(ext: Ext, roots: Roots, plan: ImportPlan): Promise<void> {
  if (isEmptyPlan(plan)) {
    void vscode.window.showInformationMessage(`"${plan.specName}" is up to date: nothing to change.`);
    return;
  }
  if (!(await confirmPlan(plan))) return;
  const takeSpec = new Set<string>();
  if (plan.conflicted.length) {
    const picked = await vscode.window.showQuickPick(
      plan.conflicted.map((c) => ({ label: c.relPath, description: c.conflicts.join(', ') })),
      { canPickMany: true, ignoreFocusOut: true, title: 'Take the spec version for these files (unchecked files keep your changes)' },
    );
    if (!picked) return;
    for (const p of picked) takeSpec.add(p.label);
  }
  const gitignore = path.join(roots.workspaceDir, '.gitignore');
  const hadEnvs = (await listEnvironments(roots.root)).length > 0;
  const before = await readOptional(gitignore);
  try {
    await applyImport(roots.root, roots.workspaceDir, plan, takeSpec);
  } catch (e) {
    void vscode.window.showErrorMessage((e as Error).message);
    return;
  }
  ext.tree.refresh();
  await ext.env.update();
  void vscode.window.showInformationMessage(`Imported "${plan.specName}": ${planSummary(plan)}.`);
  if (!hadEnvs && (await readOptional(gitignore)) !== before) {
    void vscode.window.showInformationMessage('Created environment "local" and added its .env secrets file to .gitignore.');
  }
}

async function pickSource(workspaceDir: string): Promise<string | undefined> {
  const how = await vscode.window.showQuickPick(
    [{ label: '$(file) From file…', id: 'file' }, { label: '$(globe) From URL…', id: 'url' }],
    { title: 'Import OpenAPI (3.0 / 3.1)' },
  );
  if (!how) return undefined;
  if (how.id === 'url') {
    return vscode.window.showInputBox({
      title: 'OpenAPI URL', placeHolder: 'https://example.com/openapi.json', ignoreFocusOut: true,
      validateInput: (v) => { try { return /^https?:$/.test(new URL(v).protocol) ? undefined : 'Use an http(s) URL'; } catch { return 'Not a URL'; } },
    });
  }
  const files = await vscode.window.showOpenDialog({
    canSelectMany: false, defaultUri: vscode.Uri.file(workspaceDir), filters: { OpenAPI: ['yaml', 'yml', 'json'] },
  });
  const file = files?.[0]?.fsPath;
  if (!file) return undefined;
  // Inside the workspace, store a relative path so the registry works on every machine.
  const rel = path.relative(workspaceDir, file);
  return rel.startsWith('..') || path.isAbsolute(rel) ? file : rel.split(path.sep).join('/');
}

export async function importOpenApi(ext: Ext, node?: TreeNode): Promise<void> {
  const roots = requireRoots();
  const source = await pickSource(roots.workspaceDir);
  if (!source) return;
  const existing = new Set((await listSpecs(roots.root)).map((s) => s.name));
  const specName = await vscode.window.showInputBox({
    title: 'Spec name', prompt: 'Names the folder, the base URL variable and the import record', value: suggestSpecName(source), ignoreFocusOut: true,
    validateInput: (v) => (!SPEC_NAME.test(v) || v.includes('..') ? 'Use letters, digits, _ . - (starting with a letter or digit)'
      : existing.has(v) ? `"${v}" is already imported: use Re-import OpenAPI` : undefined),
  });
  if (!specName) return;
  const target = await vscode.window.showInputBox({
    title: 'Target folder', prompt: `Relative to ${path.basename(roots.root)}/`, ignoreFocusOut: true,
    value: node?.kind === 'folder' ? `${node.id}/${specName}` : specName,
  });
  if (target === undefined) return;
  const plan = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Reading ${source}…` },
    () => planImport(roots.root, { specName, source, target: target || '.', baseDir: roots.workspaceDir }),
  );
  await previewAndApply(ext, roots, plan);
}

export async function reimportOpenApi(ext: Ext, node?: TreeNode): Promise<void> {
  const roots = requireRoots();
  const specs = await listSpecs(roots.root);
  if (!specs.length) {
    void vscode.window.showInformationMessage('No OpenAPI specs have been imported yet. Use "Import OpenAPI…" first.');
    return;
  }
  const here = node?.kind === 'folder' ? specs.filter((s) => s.target === node.id) : [];
  const candidates = here.length ? here : specs;
  const name = candidates.length === 1 ? candidates[0].name : (await vscode.window.showQuickPick(
    candidates.map((s) => ({ label: s.name, description: s.source, detail: `into ${s.target || '.'}, last imported ${s.importedAt}` })),
    { title: 'Re-import OpenAPI spec' },
  ))?.label;
  if (!name) return;
  const plan = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Re-reading ${name}…` },
    () => planReimport(roots.root, name, roots.workspaceDir),
  );
  await previewAndApply(ext, roots, plan);
}
