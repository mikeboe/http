import type { Auth } from '../../core/model';
import { edit } from '../vscode';
import { TextField } from './Field';

type Kind = 'inherit' | 'none' | 'basic' | 'bearer' | 'apiKey' | 'clientCredentials' | 'authorizationCode';

const KINDS: [Kind, string][] = [
  ['inherit', 'Inherit from folder'],
  ['none', 'No auth'],
  ['basic', 'Basic'],
  ['bearer', 'Bearer token'],
  ['apiKey', 'API key'],
  ['clientCredentials', 'OAuth 2 (client credentials)'],
  ['authorizationCode', 'OAuth 2 (authorization code)'],
];

function kindOf(a: Auth | undefined): Kind {
  if (!a) return 'inherit';
  return a.type === 'oauth2' ? a.grant : a.type;
}

const label = (k: Kind) => KINDS.find(([id]) => id === k)?.[1] ?? k;

/** A fresh auth value for a type, keeping fields the old one shares with it. */
function template(k: Kind, old: Auth | undefined): Auth | undefined {
  const o = (old ?? {}) as Record<string, unknown>;
  const s = (key: string, def = '') => (typeof o[key] === 'string' ? (o[key] as string) : def);
  const opt = (keys: string[]) => Object.fromEntries(keys.filter((key) => typeof o[key] === 'string').map((key) => [key, o[key]]));
  switch (k) {
    case 'inherit': return undefined;
    case 'none': return { type: 'none' };
    case 'basic': return { type: 'basic', username: s('username'), password: s('password') };
    case 'bearer': return { type: 'bearer', token: s('token') };
    case 'apiKey': return { type: 'apiKey', in: o.in === 'query' ? 'query' : 'header', name: s('name', 'X-API-Key'), value: s('value') };
    case 'clientCredentials':
      return { type: 'oauth2', grant: 'clientCredentials', tokenUrl: s('tokenUrl'), clientId: s('clientId'), ...opt(['clientSecret', 'scope']) };
    case 'authorizationCode':
      return {
        type: 'oauth2', grant: 'authorizationCode', authUrl: s('authUrl'), tokenUrl: s('tokenUrl'), clientId: s('clientId'),
        ...opt(['clientSecret', 'scope', 'redirectUri']), pkce: typeof o.pkce === 'boolean' ? o.pkce : true,
      };
  }
}

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
  const kind = kindOf(auth?.type === 'inherit' ? undefined : auth);
  const values = (auth ?? {}) as Record<string, unknown>;
  const setField = (f: FieldDef, v: string) => {
    if (f.optional && v === '') edit({ op: 'delete', path: ['auth', f.key] });
    else edit({ op: 'set', path: ['auth', f.key], value: v });
  };
  return (
    <div class="form">
      <label class="form-row">
        <span class="form-label">Type</span>
        <select
          value={kind}
          onChange={(e) => {
            const next = template(e.currentTarget.value as Kind, auth);
            edit(next ? { op: 'set', path: ['auth'], value: next } : { op: 'delete', path: ['auth'] });
          }}
        >
          {KINDS.map(([id, text]) => <option key={id} value={id}>{text}</option>)}
        </select>
      </label>
      {kind === 'inherit' && (
        <p class="hint">
          {authFrom === undefined
            ? 'No folder sets auth, so none is sent.'
            : `Inherited from ${authFrom === '.' ? 'the root folder' : authFrom}: ${label(kindOf(inherited))}`}
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
