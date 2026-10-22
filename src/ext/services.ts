import * as path from 'node:path';
import * as vscode from 'vscode';
import type { TokenStore } from '../core/auth';
import type { HistoryEntry, HistoryStore } from '../core/history';
import type { CookieJar } from '../core/http';
import type { RequestEditorProvider } from './editorProvider';
import type { EnvStatus } from './envStatus';
import type { RequestTree } from './tree';

export interface Roots { workspaceDir: string; root: string }

/** `yamlHttp.root`, relative to the first workspace folder. */
export function getRoots(): Roots | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return undefined;
  const rel = vscode.workspace.getConfiguration('yamlHttp').get<string>('root') || '.http';
  return { workspaceDir: folder.uri.fsPath, root: path.resolve(folder.uri.fsPath, rel) };
}

export function requireRoots(): Roots {
  const r = getRoots();
  if (!r) throw new Error('Open a folder first: YAML HTTP keeps requests in the workspace.');
  return r;
}

/** Everything the commands share. */
export interface Ext {
  context: vscode.ExtensionContext;
  history: HistoryStore;
  tokens: TokenStore;
  jars: Map<string, CookieJar>;
  env: EnvStatus;
  tree: RequestTree;
  editors: RequestEditorProvider;
  run(id: string, signal: AbortSignal): Promise<HistoryEntry>;
}

export const VIEW_TYPE = 'yamlHttp.requestEditor';

export const openInEditor = (uri: vscode.Uri, viewColumn?: vscode.ViewColumn) =>
  vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE, viewColumn === undefined ? undefined : { viewColumn, preserveFocus: true });

/** Wraps a command so failures show as error messages instead of vanishing. */
export function guarded<A extends unknown[]>(fn: (...args: A) => unknown): (...args: A) => Promise<void> {
  return async (...args: A) => {
    try { await fn(...args); } catch (e) { void vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e)); }
  };
}
