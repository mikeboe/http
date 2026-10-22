// Pure builders for the edit ops the webview posts. Paths are on-disk YAML paths.
import type { Auth, Body, MultipartPart, Settings } from '../core/model';
import type { EditOp, YamlPath } from '../core/yamlEdit';

export type BodyKind = Body['type'];
export type AuthKind = 'inherit' | 'none' | 'basic' | 'bearer' | 'apiKey' | 'clientCredentials' | 'authorizationCode';

/** Switches the body type, carrying text content across json/text and fields across form/multipart. */
export function bodyTypeOp(kind: BodyKind, old: Body): EditOp {
  const content = old.type === 'json' || old.type === 'text' ? old.content : '';
  let value: unknown;
  switch (kind) {
    case 'none': value = { none: true }; break;
    case 'json': value = { json: content }; break;
    case 'text': value = { text: { contentType: 'text/plain', content } }; break;
    case 'form':
      value = { form: old.type === 'multipart' ? old.parts.filter((p) => p.file === undefined).map((p) => ({ ...p, value: p.value ?? '' })) : [] };
      break;
    case 'multipart': value = { multipart: old.type === 'form' ? old.fields : [] }; break;
    case 'file': value = { file: '' }; break;
  }
  return { op: 'set', path: ['body'], value };
}

export function authKind(a: Auth | undefined): AuthKind {
  if (!a || a.type === 'inherit') return 'inherit';
  return a.type === 'oauth2' ? a.grant : a.type;
}

/** Switches the auth type, keeping fields the old auth shares with the new one. Inherit removes `auth`. */
export function authTypeOp(kind: AuthKind, old: Auth | undefined): EditOp {
  const o = (old ?? {}) as Record<string, unknown>;
  const s = (key: string, def = '') => (typeof o[key] === 'string' ? (o[key] as string) : def);
  const opt = (keys: string[]) => Object.fromEntries(keys.filter((key) => typeof o[key] === 'string').map((key) => [key, o[key]]));
  let value: Auth;
  switch (kind) {
    case 'inherit': return { op: 'delete', path: ['auth'] };
    case 'none': value = { type: 'none' }; break;
    case 'basic': value = { type: 'basic', username: s('username'), password: s('password') }; break;
    case 'bearer': value = { type: 'bearer', token: s('token') }; break;
    case 'apiKey': value = { type: 'apiKey', in: o.in === 'query' ? 'query' : 'header', name: s('name', 'X-API-Key'), value: s('value') }; break;
    case 'clientCredentials':
      value = { type: 'oauth2', grant: 'clientCredentials', tokenUrl: s('tokenUrl'), clientId: s('clientId'), ...opt(['clientSecret', 'scope']) };
      break;
    case 'authorizationCode':
      value = {
        type: 'oauth2', grant: 'authorizationCode', authUrl: s('authUrl'), tokenUrl: s('tokenUrl'), clientId: s('clientId'),
        ...opt(['clientSecret', 'scope', 'redirectUri']), pkce: typeof o.pkce === 'boolean' ? o.pkce : true,
      };
      break;
  }
  return { op: 'set', path: ['auth'], value };
}

/** Sets an auth field; an emptied optional field is removed. */
export function authFieldOp(key: string, v: string, optional = false): EditOp {
  return optional && v === '' ? { op: 'delete', path: ['auth', key] } : { op: 'set', path: ['auth', key], value: v };
}

export const rowDeleteOp = (path: YamlPath, i: number): EditOp => ({ op: 'delete', path: [...path, i] });

/** Enabled is the default, so checking a row removes the key. */
export const enabledOp = (path: YamlPath, i: number, checked: boolean): EditOp =>
  (checked ? { op: 'delete', path: [...path, i, 'enabled'] } : { op: 'set', path: [...path, i, 'enabled'], value: false });

/**
 * A change in a list row. Typing into the empty row at `rows` inserts an entry, unless that row was
 * already inserted (`inserted`) and its state has not come back yet.
 */
export function rowOp(path: YamlPath, rows: number, i: number, key: 'name' | 'value' | 'file', v: string, inserted?: number): EditOp {
  if (i < rows || inserted === i) return { op: 'set', path: [...path, i, key], value: v };
  const row = key === 'name' ? { name: v, value: '' } : { name: '', [key]: v };
  return { op: 'insert', path, index: i, value: row };
}

/** Switches a multipart part between a text value and a file. */
export function partKindOp(path: YamlPath, i: number, part: MultipartPart, kind: 'value' | 'file'): EditOp {
  const next: MultipartPart = { name: part.name };
  if (kind === 'file') next.file = ''; else next.value = '';
  if (part.enabled === false) next.enabled = false;
  return { op: 'set', path: [...path, i], value: next };
}

/**
 * Sets `key` in the map at `path`. When the map may be absent or null on disk (`exists` false),
 * the whole map is set instead; callers then treat it as existing until the state comes back.
 */
export function mapEntryOp(path: YamlPath, exists: boolean, key: string, value: unknown): EditOp {
  return exists ? { op: 'set', path: [...path, key], value } : { op: 'set', path, value: { [key]: value } };
}

/** Sets a request setting; an empty timeout is removed. */
export function settingOp(exists: boolean, key: keyof Settings, value: string | boolean): EditOp {
  if (key === 'timeout' && value === '') return { op: 'delete', path: ['settings', 'timeout'] };
  return mapEntryOp(['settings'], exists, key, value);
}
