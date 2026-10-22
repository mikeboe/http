import * as vscode from 'vscode';
import type { HistoryEntry, HistoryStore } from '../core/history';
import type { WebviewMessage } from '../core/protocol';
import { EditorController, editorRoot } from './controller';
import type { DocumentPort } from './controller';
import type { EnvStatus } from './envStatus';
import { makeNonce, webviewHtml } from './html';
import { getRoots } from './services';
import { changedRange } from '../core/yamlEdit';

interface ProviderDeps {
  extensionUri: vscode.Uri; history: HistoryStore; env: EnvStatus;
  /** `standaloneRoot`: run a file outside the configured root against its own folder, without an environment. */
  run(id: string, signal: AbortSignal, standaloneRoot?: string): Promise<HistoryEntry>;
}

const PENDING_SEND_MS = 10_000;

export function reportError(e: unknown): void {
  void vscode.window.showErrorMessage(`YAML HTTP: ${e instanceof Error ? e.message : String(e)}`);
}

/** The custom editor for `*.req.yaml`: a webview over the text document. */
export class RequestEditorProvider implements vscode.CustomTextEditorProvider {
  private open = new Map<string, Set<EditorController>>();
  /** Editors about to open that should send once ready; entries expire. */
  private pendingSend = new Map<string, NodeJS.Timeout>();

  constructor(private deps: ProviderDeps) {}

  async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
    const { root, standalone } = editorRoot(document.uri.fsPath, getRoots()?.root);
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
        // Replace only the span that changed, so untouched lines (and the text editor's view of them) stay put.
        const { start, end, text: middle } = changedRange(document.getText(), text);
        if (start === end && middle === '') return Promise.resolve(true);
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, new vscode.Range(document.positionAt(start), document.positionAt(end)), middle);
        return Promise.resolve(vscode.workspace.applyEdit(edit));
      },
    };
    const ctl = new EditorController(port, {
      root,
      standalone,
      post: (m) => { void webview.postMessage(m); },
      // The runner reads from disk, so send what the user sees.
      run: async (id, signal) => {
        if (document.isDirty) await document.save();
        return this.deps.run(id, signal, standalone ? root : undefined);
      },
      getEnv: async () => (standalone ? { names: [], env: { name: '', variables: {}, secrets: {} } } : this.deps.env.current()),
      history: this.deps.history,
      openText: () => { void vscode.commands.executeCommand('vscode.openWith', document.uri, 'default'); },
      selectEnv: (name) => { void this.deps.env.set(name); },
      copy: (text) => { void vscode.env.clipboard.writeText(text); },
    });

    const key = document.uri.toString();
    const set = this.open.get(key) ?? new Set();
    set.add(ctl);
    this.open.set(key, set);

    const subs = [
      webview.onDidReceiveMessage((m: WebviewMessage) => {
        void ctl.handle(m).then(() => {
          if (m.type === 'ready' && this.takePending(key)) return ctl.handle({ type: 'send' });
        }).catch(reportError);
      }),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() === key && e.contentChanges.length) ctl.refresh().catch(reportError);
      }),
    ];
    panel.onDidDispose(() => {
      ctl.dispose();
      subs.forEach((s) => s.dispose());
      set.delete(ctl);
      if (!set.size) this.open.delete(key);
    });
  }

  private all(): EditorController[] { return [...this.open.values()].flatMap((s) => [...s]); }

  /** After file changes under root. */
  refreshAll(): void { for (const c of this.all()) void c.refresh().catch(reportError); }

  /** After the active environment changes: variables and history depend on it. */
  envChanged(): void {
    for (const c of this.all()) void Promise.all([c.refresh(), c.postHistory()]).catch(reportError);
  }

  /** Sends through an open editor for `uri`; false if none is open. */
  sendIn(uri: vscode.Uri): boolean {
    const first = this.open.get(uri.toString())?.values().next().value;
    if (!first) return false;
    void first.handle({ type: 'send' }).catch(reportError);
    return true;
  }

  /** Sends once the editor for `uri` (about to be opened) is ready. */
  sendWhenReady(uri: vscode.Uri): void {
    const key = uri.toString();
    this.takePending(key);
    this.pendingSend.set(key, setTimeout(() => this.pendingSend.delete(key), PENDING_SEND_MS));
  }

  /** Forgets a pending send (e.g. the editor failed to open); true if there was one. */
  takePending(key: string): boolean {
    const t = this.pendingSend.get(key);
    if (t === undefined) return false;
    clearTimeout(t);
    this.pendingSend.delete(key);
    return true;
  }
}
