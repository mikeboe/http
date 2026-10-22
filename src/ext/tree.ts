import * as path from 'node:path';
import * as vscode from 'vscode';
import { listSpecs } from '../core/openapi/importer';
import { listTree } from '../core/workspace';
import type { TreeNode } from '../core/workspace';
import { REQ_EXT } from './fileOps';
import { getRoots, VIEW_TYPE } from './services';

/** The "HTTP Requests" view: mirrors the root folder. */
export class RequestTree implements vscode.TreeDataProvider<TreeNode> {
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  /** Folder id → names of specs imported into it (for "Re-import"). */
  private specTargets = new Map<string, string[]>();

  refresh(): void { this.emitter.fire(); }

  specsFor(folderId: string): string[] { return this.specTargets.get(folderId) ?? []; }

  async getChildren(node?: TreeNode): Promise<TreeNode[]> {
    if (node) return node.children ?? [];
    const roots = getRoots();
    if (!roots) return [];
    this.specTargets.clear();
    for (const s of await listSpecs(roots.root)) this.specTargets.set(s.target, [...this.specsFor(s.target), s.name]);
    return listTree(roots.root);
  }

  getTreeItem(n: TreeNode): vscode.TreeItem {
    if (n.kind === 'folder') {
      const item = new vscode.TreeItem(n.name, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `folder:${n.id}`;
      item.iconPath = vscode.ThemeIcon.Folder;
      item.contextValue = this.specTargets.has(n.id) ? 'folder.spec' : 'folder';
      item.tooltip = n.id;
      return item;
    }
    const method = n.method ?? '';
    const label = method ? `${method} ${n.name}` : n.name;
    const item = new vscode.TreeItem({ label, highlights: method ? [[0, method.length]] : [] });
    item.id = `request:${n.id}`;
    item.contextValue = 'request';
    const stem = path.basename(n.path, REQ_EXT);
    if (n.invalid) {
      item.description = 'invalid';
      item.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('list.errorForeground'));
    } else if (n.removed) {
      item.description = 'removed from spec';
      item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
    } else {
      item.description = stem !== n.name ? stem : undefined;
      item.iconPath = new vscode.ThemeIcon('globe');
    }
    item.tooltip = `${n.id}${n.removed ? ' (operation removed from the OpenAPI spec)' : ''}`;
    item.command = { title: 'Open', command: 'vscode.openWith', arguments: [vscode.Uri.file(n.path), VIEW_TYPE] };
    return item;
  }
}
