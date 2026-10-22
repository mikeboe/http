import * as vscode from 'vscode';
import { clearTokens } from '../core/auth';
import type { TreeNode } from '../core/workspace';
import { addAgentInstructions } from './commands/agent';
import { importOpenApi, reimportOpenApi } from './commands/import';
import { duplicate, newFolder, newRequest, remove, rename } from './commands/tree';
import { guarded, openInEditor } from './services';
import type { Ext } from './services';

const isRequest = (uri?: vscode.Uri) => !!uri && uri.path.endsWith('.req.yaml');

/** The request a command applies to: its argument (Uri or tree node), else the active editor. */
function targetUri(arg?: vscode.Uri | TreeNode): vscode.Uri | undefined {
  if (arg instanceof vscode.Uri) return arg;
  if (arg && 'kind' in arg && arg.kind === 'request') return vscode.Uri.file(arg.path);
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (input instanceof vscode.TabInputCustom || input instanceof vscode.TabInputText) return input.uri;
  return vscode.window.activeTextEditor?.document.uri;
}

async function send(ext: Ext, arg?: vscode.Uri | TreeNode): Promise<void> {
  const uri = targetUri(arg);
  if (!isRequest(uri)) throw new Error('Open a .req.yaml request to send it.');
  if (ext.editors.sendIn(uri!)) return;
  // Responses are shown in the request editor: open it next to the text and send once it is ready.
  ext.editors.sendWhenReady(uri!);
  await openInEditor(uri!, vscode.ViewColumn.Beside);
}

export function registerCommands(ext: Ext): vscode.Disposable[] {
  const reg = <A extends unknown[]>(id: string, fn: (...args: A) => unknown) => vscode.commands.registerCommand(id, guarded(fn));
  return [
    reg('yamlHttp.send', (arg?: vscode.Uri | TreeNode) => send(ext, arg)),
    reg('yamlHttp.openAsText', async (arg?: vscode.Uri) => {
      const uri = targetUri(arg);
      if (isRequest(uri)) await vscode.commands.executeCommand('vscode.openWith', uri, 'default');
    }),
    reg('yamlHttp.openInEditor', async (arg?: vscode.Uri) => {
      const uri = targetUri(arg);
      if (isRequest(uri)) await openInEditor(uri!);
    }),
    reg('yamlHttp.selectEnvironment', () => ext.env.pick()),
    reg('yamlHttp.importOpenApi', (node?: TreeNode) => importOpenApi(ext, node)),
    reg('yamlHttp.reimportOpenApi', (node?: TreeNode) => reimportOpenApi(ext, node)),
    reg('yamlHttp.clearCookies', () => {
      for (const jar of ext.jars.values()) jar.clear();
      void vscode.window.showInformationMessage('YAML HTTP: cookies cleared.');
    }),
    reg('yamlHttp.clearOAuthTokens', async () => {
      await clearTokens(ext.tokens);
      void vscode.window.showInformationMessage('YAML HTTP: OAuth tokens cleared.');
    }),
    reg('yamlHttp.addAgentInstructions', () => addAgentInstructions(ext)),
    reg('yamlHttp.newRequest', (node?: TreeNode) => newRequest(ext, node)),
    reg('yamlHttp.newFolder', (node?: TreeNode) => newFolder(ext, node)),
    reg('yamlHttp.rename', (node?: TreeNode) => rename(ext, node)),
    reg('yamlHttp.duplicate', (node?: TreeNode) => duplicate(ext, node)),
    reg('yamlHttp.delete', (node?: TreeNode) => remove(ext, node)),
    reg('yamlHttp.refresh', () => ext.tree.refresh()),
  ];
}
