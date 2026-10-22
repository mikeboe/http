import { isMap, LineCounter, parseDocument } from 'yaml';

export type KV = { name: string; value: string; enabled?: boolean };
export type Auth =
  | { type: 'none' } | { type: 'inherit' }
  | { type: 'basic'; username: string; password: string }
  | { type: 'bearer'; token: string }
  | { type: 'apiKey'; in: 'header' | 'query'; name: string; value: string }
  | { type: 'oauth2'; grant: 'clientCredentials'; tokenUrl: string; clientId: string; clientSecret?: string; scope?: string }
  | { type: 'oauth2'; grant: 'authorizationCode'; authUrl: string; tokenUrl: string; clientId: string; clientSecret?: string; scope?: string; pkce?: boolean; redirectUri?: string };
export type MultipartPart = { name: string; value?: string; file?: string; enabled?: boolean };
export type Body =
  | { type: 'none' } | { type: 'json'; content: string }
  | { type: 'text'; contentType: string; content: string }
  | { type: 'form'; fields: KV[] } | { type: 'multipart'; parts: MultipartPart[] }
  | { type: 'file'; path: string };
export interface Settings { timeout?: string; followRedirects?: boolean; verifyTls?: boolean }
export interface Source { spec: string; operationId: string; removed?: boolean }
export interface RequestDef {
  name: string; method: string; url: string; pathParams: Record<string, string>;
  query: KV[]; headers: KV[]; auth?: Auth; body: Body; settings: Settings; source?: Source;
}
export interface FolderDef { headers: KV[]; auth?: Auth; settings: Settings }
export interface Diagnostic { message: string; line?: number; col?: number }

export const HTTP_METHODS: readonly string[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

const REQUEST_KEYS = ['name', 'method', 'url', 'pathParams', 'query', 'headers', 'auth', 'body', 'settings', 'source'];
const FOLDER_KEYS = ['headers', 'auth', 'settings'];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

export function parseDuration(s: string): number {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(String(s).trim());
  if (!m) throw new Error(`invalid duration "${s}" (use e.g. 500ms, 10s, 30m, 2h)`);
  const unit = { ms: 1, s: 1000, m: 60000, h: 3600000 }[m[2] as 'ms' | 's' | 'm' | 'h'];
  return Math.round(Number(m[1]) * unit);
}

interface Parsed { value?: Obj; errors: Diagnostic[]; at: (key: string) => Pick<Diagnostic, 'line' | 'col'> }

function parseYamlObject(text: string, allowed: string[]): Parsed {
  const lc = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lc });
  const errors: Diagnostic[] = [];
  const pos = (offset?: number): Pick<Diagnostic, 'line' | 'col'> => {
    if (offset === undefined) return {};
    const p = lc.linePos(offset);
    return { line: p.line, col: p.col };
  };
  const at = (key: string) => {
    if (isMap(doc.contents)) {
      const pair = doc.contents.items.find((i) => String((i.key as { value?: unknown })?.value ?? i.key) === key);
      const range = (pair?.key as { range?: number[] } | undefined)?.range;
      return pos(range?.[0]);
    }
    return {};
  };
  if (doc.errors.length) {
    for (const e of doc.errors) {
      const p = e.linePos?.[0];
      errors.push({ message: e.message.split('\n')[0], line: p?.line ?? 1, col: p?.col ?? 1 });
    }
    return { errors, at };
  }
  const value = doc.toJS() as unknown;
  if (!isObj(value)) {
    errors.push({ message: 'expected a YAML mapping at the top level', line: 1, col: 1 });
    return { errors, at };
  }
  for (const k of Object.keys(value)) {
    if (!allowed.includes(k)) errors.push({ message: `unknown key "${k}"`, ...at(k) });
  }
  return { value, errors, at };
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v);
}

function kvList(v: unknown, field: string, errs: Diagnostic[], at: Parsed['at']): KV[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) { errs.push({ message: `"${field}" must be a list of {name, value}`, ...at(field) }); return []; }
  const out: KV[] = [];
  for (const item of v) {
    if (!isObj(item) || item.name === undefined) {
      errs.push({ message: `"${field}" entries need a "name"`, ...at(field) });
      continue;
    }
    const kv: KV = { name: str(item.name), value: str(item.value) };
    if (typeof item.enabled === 'boolean') kv.enabled = item.enabled;
    out.push(kv);
  }
  return out;
}

function parseBody(v: unknown, errs: Diagnostic[], at: Parsed['at']): Body {
  if (v === undefined || v === null) return { type: 'none' };
  const keys = isObj(v) ? Object.keys(v) : [];
  if (keys.length !== 1) {
    errs.push({ message: 'body must have exactly one of: json, text, form, multipart, file, none', ...at('body') });
    return { type: 'none' };
  }
  const k = keys[0];
  const val = (v as Obj)[k];
  switch (k) {
    case 'none': return { type: 'none' };
    case 'json': return { type: 'json', content: typeof val === 'string' ? val : JSON.stringify(val, null, 2) };
    case 'text':
      if (isObj(val)) return { type: 'text', contentType: str(val.contentType), content: str(val.content) };
      errs.push({ message: 'body.text must be {contentType, content}', ...at('body') });
      return { type: 'none' };
    case 'form': return { type: 'form', fields: kvList(val, 'body.form', errs, () => at('body')) };
    case 'multipart': {
      if (!Array.isArray(val)) { errs.push({ message: 'body.multipart must be a list', ...at('body') }); return { type: 'none' }; }
      const parts: MultipartPart[] = [];
      for (const p of val) {
        if (!isObj(p) || p.name === undefined) { errs.push({ message: 'body.multipart entries need a "name"', ...at('body') }); continue; }
        const part: MultipartPart = { name: str(p.name) };
        if (p.value !== undefined) part.value = str(p.value);
        if (p.file !== undefined) part.file = str(p.file);
        if (typeof p.enabled === 'boolean') part.enabled = p.enabled;
        parts.push(part);
      }
      return { type: 'multipart', parts };
    }
    case 'file': return { type: 'file', path: str(val) };
    default:
      errs.push({ message: `unknown body type "${k}"`, ...at('body') });
      return { type: 'none' };
  }
}

function parseAuth(v: unknown, errs: Diagnostic[], at: Parsed['at']): Auth | undefined {
  if (v === undefined || v === null) return undefined;
  if (!isObj(v) || typeof v.type !== 'string') {
    errs.push({ message: 'auth needs a "type"', ...at('auth') });
    return undefined;
  }
  const need = (...keys: string[]): boolean => {
    const missing = keys.filter((k) => typeof v[k] !== 'string');
    if (missing.length) errs.push({ message: `auth type "${v.type}" needs ${missing.map((m) => `"${m}"`).join(', ')}`, ...at('auth') });
    return missing.length === 0;
  };
  switch (v.type) {
    case 'none': case 'inherit': return { type: v.type };
    case 'basic': return need('username', 'password') ? (v as unknown as Auth) : undefined;
    case 'bearer': return need('token') ? (v as unknown as Auth) : undefined;
    case 'apiKey':
      if (v.in !== 'header' && v.in !== 'query') { errs.push({ message: 'auth.in must be "header" or "query"', ...at('auth') }); return undefined; }
      return need('name', 'value') ? (v as unknown as Auth) : undefined;
    case 'oauth2':
      if (v.grant === 'clientCredentials') return need('tokenUrl', 'clientId') ? (v as unknown as Auth) : undefined;
      if (v.grant === 'authorizationCode') return need('authUrl', 'tokenUrl', 'clientId') ? (v as unknown as Auth) : undefined;
      errs.push({ message: 'auth.grant must be "clientCredentials" or "authorizationCode"', ...at('auth') });
      return undefined;
    default:
      errs.push({ message: `unknown auth type "${v.type}"`, ...at('auth') });
      return undefined;
  }
}

function parseSettings(v: unknown, errs: Diagnostic[], at: Parsed['at']): Settings {
  if (v === undefined || v === null) return {};
  if (!isObj(v)) { errs.push({ message: '"settings" must be a mapping', ...at('settings') }); return {}; }
  const s: Settings = {};
  if (v.timeout !== undefined) {
    const t = str(v.timeout);
    try { parseDuration(t); s.timeout = t; } catch (e) { errs.push({ message: (e as Error).message, ...at('settings') }); }
  }
  if (typeof v.followRedirects === 'boolean') s.followRedirects = v.followRedirects;
  if (typeof v.verifyTls === 'boolean') s.verifyTls = v.verifyTls;
  return s;
}

const isError = (d: Diagnostic) => !d.message.startsWith('unknown key');

export function parseRequest(text: string): { request?: RequestDef; errors: Diagnostic[] } {
  const p = parseYamlObject(text, REQUEST_KEYS);
  const errors = p.errors;
  if (!p.value) return { errors };
  const v = p.value;
  const method = v.method === undefined ? 'GET' : str(v.method);
  if (!HTTP_METHODS.includes(method)) errors.push({ message: `unknown method "${method}"`, ...p.at('method') });
  if (typeof v.url !== 'string' || v.url === '') errors.push({ message: 'missing required "url"', line: 1, col: 1 });
  let pathParams: Record<string, string> = {};
  if (isObj(v.pathParams)) pathParams = Object.fromEntries(Object.entries(v.pathParams).map(([k, x]) => [k, str(x)]));
  else if (v.pathParams !== undefined && v.pathParams !== null) errors.push({ message: '"pathParams" must be a mapping', ...p.at('pathParams') });
  const request: RequestDef = {
    name: str(v.name),
    method,
    url: str(v.url),
    pathParams,
    query: kvList(v.query, 'query', errors, p.at),
    headers: kvList(v.headers, 'headers', errors, p.at),
    body: parseBody(v.body, errors, p.at),
    settings: parseSettings(v.settings, errors, p.at),
  };
  const auth = parseAuth(v.auth, errors, p.at);
  if (auth) request.auth = auth;
  if (isObj(v.source) && typeof v.source.spec === 'string' && typeof v.source.operationId === 'string') {
    request.source = { spec: v.source.spec, operationId: v.source.operationId };
    if (typeof v.source.removed === 'boolean') request.source.removed = v.source.removed;
  } else if (v.source !== undefined && v.source !== null) {
    errors.push({ message: '"source" needs "spec" and "operationId"', ...p.at('source') });
  }
  return errors.some(isError) ? { errors } : { request, errors };
}

export function parseFolder(text: string): { folder?: FolderDef; errors: Diagnostic[] } {
  // An empty folder file is valid.
  if (text.trim() === '') return { folder: { headers: [], settings: {} }, errors: [] };
  const p = parseYamlObject(text, FOLDER_KEYS);
  const errors = p.errors;
  if (!p.value) return { errors };
  const folder: FolderDef = {
    headers: kvList(p.value.headers, 'headers', errors, p.at),
    settings: parseSettings(p.value.settings, errors, p.at),
  };
  const auth = parseAuth(p.value.auth, errors, p.at);
  if (auth) folder.auth = auth;
  return errors.some(isError) ? { errors } : { folder, errors };
}
