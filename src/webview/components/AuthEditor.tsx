import type { Auth } from '../../core/model';
import { type AuthKind, authFieldOp, authKind, authTypeOp } from '../ops';
import { folderLabel } from '../util';
import { edit } from '../vscode';
import { TextField } from './Field';

type Kind = AuthKind;

const KINDS: [Kind, string][] = [
  ['inherit', 'Inherit from folder'],
  ['none', 'No auth'],
  ['basic', 'Basic'],
  ['bearer', 'Bearer token'],
  ['apiKey', 'API key'],
  ['clientCredentials', 'OAuth 2 (client credentials)'],
  ['authorizationCode', 'OAuth 2 (authorization code)'],
];

const label = (k: Kind) => KINDS.find(([id]) => id === k)?.[1] ?? k;

interface FieldDef { key: string; label: string; optional?: boolean; placeholder?: string }

const FIELDS: Partial<Record<Kind, FieldDef[]>> = {
  basic: [{ key: 'username', label: 'Username' }, { key: 'password', label: 'Password' }],
  bearer: [{ key: 'token', label: 'Token', placeholder: '{{token}}' }],
  apiKey: [{ key: 'name', label: 'Name' }, { key: 'value', label: 'Value' }],
  clientCredentials: [
    { key: 'tokenUrl', label: 'Token URL' }, { key: 'clientId', label: 'Client ID' },
    { key: 'clientSecret', label: 'Client secret', optional: true }, { key: 'scope', label: 'Scope', optional: true },
  ],
  authorizationCode: [
    { key: 'authUrl', label: 'Authorization URL' }, { key: 'tokenUrl', label: 'Token URL' }, { key: 'clientId', label: 'Client ID' },
    { key: 'clientSecret', label: 'Client secret', optional: true }, { key: 'scope', label: 'Scope', optional: true },
    { key: 'redirectUri', label: 'Redirect URI', optional: true },
  ],
};

export function AuthEditor({ auth, inherited, authFrom }: { auth?: Auth; inherited: Auth; authFrom?: string }) {
  const kind = authKind(auth);
  const values = (auth ?? {}) as Record<string, unknown>;
  const setField = (f: FieldDef, v: string) => edit(authFieldOp(f.key, v, f.optional));
  return (
    <div class="form">
      <label class="form-row">
        <span class="form-label">Type</span>
        <select
          value={kind}
          onChange={(e) => edit(authTypeOp(e.currentTarget.value as Kind, auth))}
        >
          {KINDS.map(([id, text]) => <option key={id} value={id}>{text}</option>)}
        </select>
      </label>
      {kind === 'inherit' && (
        <p class="hint">
          {authFrom === undefined
            ? 'No folder sets auth, so none is sent.'
            : `Inherited from ${folderLabel(authFrom)}: ${label(authKind(inherited))}`}
        </p>
      )}
      {kind === 'none' && <p class="hint">No auth is sent, even if a folder sets it.</p>}
      {kind === 'apiKey' && (
        <label class="form-row">
          <span class="form-label">Add to</span>
          <select value={values.in === 'query' ? 'query' : 'header'} onChange={(e) => edit({ op: 'set', path: ['auth', 'in'], value: e.currentTarget.value })}>
            <option value="header">Header</option>
            <option value="query">Query parameter</option>
          </select>
        </label>
      )}
      {(FIELDS[kind] ?? []).map((f) => (
        <label class="form-row" key={`${kind}.${f.key}`}>
          <span class="form-label">{f.label}{f.optional ? <span class="dim"> (optional)</span> : null}</span>
          <TextField value={typeof values[f.key] === 'string' ? (values[f.key] as string) : ''} placeholder={f.placeholder} ariaLabel={f.label} onCommit={(v) => setField(f, v)} />
        </label>
      ))}
      {kind === 'authorizationCode' && (
        <label class="form-row form-check">
          <input type="checkbox" checked={values.pkce !== false} onChange={(e) => edit({ op: 'set', path: ['auth', 'pkce'], value: e.currentTarget.checked })} />
          <span>Use PKCE</span>
        </label>
      )}
    </div>
  );
}
