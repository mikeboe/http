import { HTTP_METHODS, methodColour } from '../util';
import { edit, post } from '../vscode';
import { flushPendingEdits, TextField } from './Field';

interface Props {
  method: string; url: string; sending: boolean;
  env: { name?: string; names: string[] };
}

export function send(): void {
  flushPendingEdits();
  post({ type: 'send' });
}

export function UrlBar({ method, url, sending, env }: Props) {
  return (
    <div class="url-bar">
      <select
        class="method-select"
        aria-label="Method"
        value={method}
        style={{ color: methodColour(method) }}
        onChange={(e) => edit({ op: 'set', path: ['method'], value: e.currentTarget.value })}
      >
        {HTTP_METHODS.map((m) => <option key={m} value={m} style={{ color: methodColour(m) }}>{m}</option>)}
      </select>
      <TextField
        class="url-input"
        value={url}
        placeholder="https://api.example.com/path"
        ariaLabel="URL"
        // An empty url makes the file invalid; keep the text local until there is one.
        onCommit={(v) => (v.trim() === '' ? false : edit({ op: 'set', path: ['url'], value: v }))}
      />
      {sending
        ? <button class="send-button cancel" title="Cancel (Escape)" onClick={() => post({ type: 'cancel' })}>Cancel</button>
        : <button class="send-button" title="Send (Ctrl+Enter)" onClick={send}>Send</button>}
      <select
        class="env-select"
        aria-label="Environment"
        title="Environment"
        disabled={env.names.length === 0}
        value={env.name ?? ''}
        onChange={(e) => post({ type: 'selectEnv', name: e.currentTarget.value })}
      >
        {env.name === undefined && <option value="">{env.names.length ? 'No environment' : 'No environments'}</option>}
        {env.names.map((n) => <option key={n} value={n}>{n}</option>)}
      </select>
    </div>
  );
}
