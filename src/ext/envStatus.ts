import * as path from 'node:path';
import * as vscode from 'vscode';
import { createEnvironment, listEnvironments, loadEnvironment } from '../core/env';
import type { Environment } from '../core/env';
import { getRoots } from './services';

const KEY = 'yamlHttp.environment';
const NONE: Environment = { name: '', variables: {}, secrets: {} };

export interface CurrentEnv { name?: string; names: string[]; env: Environment; error?: string }

/** The active environment: a status-bar picker, remembered per workspace. */
export class EnvStatus implements vscode.Disposable {
  private item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(private state: vscode.Memento) {
    this.item.command = 'yamlHttp.selectEnvironment';
    this.item.tooltip = 'YAML HTTP: select environment';
    void this.update();
  }

  /** Never throws: a broken environment file is reported in `error`, with no variables. */
  async current(): Promise<CurrentEnv> {
    const roots = getRoots();
    if (!roots) return { names: [], env: NONE };
    let names: string[];
    try { names = await listEnvironments(roots.root); } catch (e) { return { names: [], env: NONE, error: (e as Error).message }; }
    const stored = this.state.get<string>(KEY);
    const name = stored && names.includes(stored) ? stored : names[0];
    if (!name) return { names, env: NONE };
    try { return { name, names, env: await loadEnvironment(roots.root, name) }; } catch (e) {
      return { name, names, env: { ...NONE, name }, error: (e as Error).message };
    }
  }

  async set(name: string): Promise<void> {
    await this.state.update(KEY, name);
    await this.update();
    this.emitter.fire();
  }

  async update(): Promise<void> {
    const { name, error } = await this.current();
    this.item.text = `$(server-environment) ${name ?? 'No environment'}${error ? ' $(warning)' : ''}`;
    this.item.tooltip = error ? `YAML HTTP: ${error}` : 'YAML HTTP: select environment';
    if (getRoots()) this.item.show();
    else this.item.hide();
  }

  async pick(): Promise<void> {
    const roots = getRoots();
    if (!roots) throw new Error('Open a folder first: YAML HTTP keeps requests in the workspace.');
    const { name, names } = await this.current();
    const CREATE = '$(add) Create environment…';
    const items: vscode.QuickPickItem[] = [
      ...names.map((n) => ({ label: n, description: n === name ? 'active' : undefined })),
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      { label: CREATE },
    ];
    const picked = await vscode.window.showQuickPick(items, { title: 'YAML HTTP environment' });
    if (!picked) return;
    if (picked.label !== CREATE) { await this.set(picked.label); return; }
    const created = await vscode.window.showInputBox({
      title: 'New environment', prompt: 'Name, e.g. local or staging',
      validateInput: (v) => (/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(v) ? (names.includes(v) ? 'Already exists' : undefined) : 'Use letters, digits, _ . -'),
    });
    if (!created) return;
    const { gitignoreUpdated } = await createEnvironment(roots.root, created, roots.workspaceDir);
    if (gitignoreUpdated) {
      const rel = path.relative(roots.workspaceDir, roots.root).split(path.sep).join('/');
      void vscode.window.showInformationMessage(`Added ${rel}/env/*.env to .gitignore so secrets stay out of git.`);
    }
    await this.set(created);
  }

  dispose(): void { this.item.dispose(); this.emitter.dispose(); }
}
