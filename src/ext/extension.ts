import * as path from 'node:path';
import * as vscode from 'vscode';
import { HistoryStore } from '../core/history';
import { CookieJar } from '../core/http';
import { runRequest } from '../core/runner';
import { registerCodeLens } from './codelens';
import { registerCommands } from './commands';
import { registerPreviewProvider } from './commands/import';
import { RequestEditorProvider } from './editorProvider';
import { EnvStatus } from './envStatus';
import { SecretTokenStore } from './secrets';
import { getRoots, requireRoots, VIEW_TYPE } from './services';
import type { Ext } from './services';
import { RequestTree } from './tree';

export function activate(context: vscode.ExtensionContext): void {
  const storage = context.storageUri ?? context.globalStorageUri;
  const history = new HistoryStore(path.join(storage.fsPath, 'history'));
  const tokens = new SecretTokenStore(context.secrets, context.globalState);
  const jars = new Map<string, CookieJar>();
  const env = new EnvStatus(context.workspaceState);
  const tree = new RequestTree();

  const run: Ext['run'] = async (id, signal) => {
    const { root } = requireRoots();
    const cur = await env.current();
    if (cur.error) throw new Error(cur.error);
    const envName = cur.name ?? '';
    let jar = jars.get(envName);
    if (!jar) jars.set(envName, (jar = new CookieJar()));
    const { entry } = await runRequest(id, {
      root, envName, env: cur.env, history, jar, tokens, signal,
      openBrowser: async (url) => { await vscode.env.openExternal(vscode.Uri.parse(url, true)); },
    });
    return entry;
  };
  const editors = new RequestEditorProvider({ extensionUri: context.extensionUri, history, env, run });
  const ext: Ext = { context, history, tokens, jars, env, tree, editors, run };

  // Debounced: one refresh per burst of file events under the root.
  let timer: NodeJS.Timeout | undefined;
  const onFiles = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { tree.refresh(); editors.refreshAll(); void env.update(); }, 150);
  };
  let watcher: vscode.FileSystemWatcher | undefined;
  const watch = () => {
    watcher?.dispose();
    const roots = getRoots();
    watcher = roots ? vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(roots.root), '**')) : undefined;
    watcher?.onDidCreate(onFiles);
    watcher?.onDidChange(onFiles);
    watcher?.onDidDelete(onFiles);
  };
  watch();

  context.subscriptions.push(
    env,
    { dispose: () => { watcher?.dispose(); clearTimeout(timer); } },
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, editors, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.window.registerTreeDataProvider('yamlHttp.requests', tree),
    registerCodeLens(),
    registerPreviewProvider(),
    env.onDidChange(() => editors.envChanged()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('yamlHttp.root')) return;
      watch();
      onFiles();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => { watch(); onFiles(); }),
    ...registerCommands(ext),
  );
}

export function deactivate(): void {}
