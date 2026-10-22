import * as vscode from 'vscode';
import type { HistoryEntry, HistoryStore } from '../core/history';
import type { WebviewMessage } from '../core/protocol';
import { EditorController } from './controller';
import type { DocumentPort } from './controller';
import type { EnvStatus } from './envStatus';
import { makeNonce, webviewHtml } from './html';
import { requireRoots } from './services';

interface ProviderDeps {
  extensionUri: vscode.Uri; history: HistoryStore; env: EnvStatus;
  run(id: string, signal: AbortSignal): Promise<HistoryEntry>;
}

/** The custom editor for `*.req.yaml`: a webview over the text document. */
export class RequestEditorProvider implements vscode.CustomTextEditorProvider {
  private open = new Map<string, Set<EditorController>>();
  private pendingSend = new Set<string>();

  constructor(private deps: ProviderDeps) {}

  async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
    const { root } = requireRoots();
    const dist = vscode.Uri.joinPath(this.deps.extensionUri, 'dist');
    const webview = panel.webview;
    webview.options = { enableScripts: true, localResourceRoots: [dist] };
    webview.html = webviewHtml({
      cspSource: webview.cspSource, nonce: makeNonce(),
      scriptUri: webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.js')).toString(),
      styleUri: webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.css')).toString(),
    });

    const port: DocumentPort = {
      file: document.uri.fsPath,
      getText: () => document.getText(),
      applyText: (text) => {
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);
        return Promise.resolve(vscode.workspace.applyEdit(edit));
      },
    };
    const ctl = new EditorController(port, {
      root,
      post: (m) => { void webview.postMessage(m); },
      // The runner reads from disk, so send what the user sees.
      run: async (id, signal) => { if (document.isDirty) await document.save(); return this.deps.run(id, signal); },
      getEnv: () => this.deps.env.current(),
      history: this.deps.history,
      openText: () => { void vscode.commands.executeCommand('vscode.openWith', document.uri, 'default'); },
      selectEnv: (name) => { void this.deps.env.set(name); },
      copy: (text) => { void vscode.env.clipboard.writeText(text); },
    });

    const key = document.uri.toString();
    const set = this.open.get(key) ?? new Set();
    set.add(ctl);
    this.open.set(key, set);

    const report = (e: unknown) => { void vscode.window.showErrorMessage(`YAML HTTP: ${e instanceof Error ? e.message : String(e)}`); };
    const subs = [
      webview.onDidReceiveMessage((m: WebviewMessage) => {
        void ctl.handle(m).then(() => {
          if (m.type === 'ready' && this.pendingSend.delete(key)) return ctl.handle({ type: 'send' });
        }).catch(report);
      }),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() === key && e.contentChanges.length) ctl.refresh().catch(report);
      }),
    ];
    panel.onDidDispose(() => {
      subs.forEach((s) => s.dispose());
      set.delete(ctl);
      if (!set.size) this.open.delete(key);
    });
  }

  private all(): EditorController[] { return [...this.open.values()].flatMap((s) => [...s]); }

  /** After file changes under root. */
  refreshAll(): void { for (const c of this.all()) void c.refresh().catch(() => undefined); }

  /** After the active environment changes: variables and history depend on it. */
  envChanged(): void {
    for (const c of this.all()) void Promise.all([c.refresh(), c.postHistory()]).catch(() => undefined);
  }

  /** Sends through an open editor for `uri`; false if none is open. */
  sendIn(uri: vscode.Uri): boolean {
    const first = this.open.get(uri.toString())?.values().next().value;
    if (!first) return false;
    void first.handle({ type: 'send' });
    return true;
  }

  /** Sends once the editor for `uri` (about to be opened) is ready. */
  sendWhenReady(uri: vscode.Uri): void { this.pendingSend.add(uri.toString()); }
}
