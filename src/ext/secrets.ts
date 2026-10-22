import type * as vscode from 'vscode';
import type { TokenStore } from '../core/auth';

const KEYS = 'yamlHttp.tokenKeys';

/** OAuth tokens in SecretStorage. SecretStorage cannot list keys, so they are tracked in globalState for `clear()`. */
export class SecretTokenStore implements TokenStore {
  constructor(private secrets: vscode.SecretStorage, private state: vscode.Memento) {}

  private keys(): string[] { return this.state.get<string[]>(KEYS, []); }

  get(key: string): Promise<string | undefined> { return Promise.resolve(this.secrets.get(key)); }

  async set(key: string, value: string): Promise<void> {
    await this.secrets.store(key, value);
    const keys = this.keys();
    if (!keys.includes(key)) await this.state.update(KEYS, [...keys, key]);
  }

  async delete(key: string): Promise<void> {
    await this.secrets.delete(key);
    await this.state.update(KEYS, this.keys().filter((k) => k !== key));
  }

  async clear(): Promise<void> {
    for (const k of this.keys()) await this.secrets.delete(k);
    await this.state.update(KEYS, []);
  }
}
