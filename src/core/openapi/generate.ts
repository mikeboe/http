import { stringify } from 'yaml';
import { exampleFromSchema } from './example';
import type { OpenApiDoc } from './load';

export type { OpenApiDoc } from './load';
export { exampleFromSchema } from './example';

export interface GeneratedRequest { operationId: string; relPath: string; text: string }
export interface Generated {
  requests: GeneratedRequest[]; folderText?: string; baseUrlVar: string; baseUrl?: string; secretVars: string[];
}

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch'];
const SKIPPED_HEADERS = ['accept', 'content-type', 'authorization'];

const words = (s: string) => s.split(/[^A-Za-z0-9]+/).filter(Boolean);
const camel = (s: string) => words(s).map((w, i) => (i === 0 ? w[0].toLowerCase() : w[0].toUpperCase()) + w.slice(1)).join('');
const slug = (s: string, sep: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, sep).replace(new RegExp(`^${sep}+|${sep}+$`, 'g'), '');
const kebab = (s: string) => slug(s.replace(/([a-z0-9])([A-Z])/g, '$1-$2'), '-');
const dump = (o: unknown) => stringify(o, { lineWidth: 0 });

function baseUrlOf(doc: OpenApiDoc): string | undefined {
  const server = doc.servers?.[0];
  if (!server || typeof server.url !== 'string') return undefined;
  return server.url.replace(/\{([^}]+)\}/g, (m: string, n: string) => String(server.variables?.[n]?.default ?? m));
}

function paramValue(p: any): string {
  const v = p.example ?? Object.values<any>(p.examples ?? {})[0]?.value ?? p.schema?.example ?? p.schema?.default;
  if (v === undefined || v === null) return '';
  return typeof v === 'object' ? (Array.isArray(v) ? v.join(',') : JSON.stringify(v)) : String(v);
}

function kvOf(p: any) {
  const kv: Record<string, unknown> = { name: p.name, value: paramValue(p) };
  if (!p.required) kv.enabled = false;
  return kv;
}

function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? 'null';
}

function bodyOf(requestBody: any): Record<string, unknown> | undefined {
  const content = requestBody?.content;
  if (!content) return undefined;
  const json = content['application/json'];
  if (json) {
    const ex = json.example !== undefined ? json.example
      : Object.values<any>(json.examples ?? {})[0]?.value !== undefined ? Object.values<any>(json.examples)[0].value
        : exampleFromSchema(json.schema);
    return { json: jsonText(ex) };
  }
  const kind = content['application/x-www-form-urlencoded'] ? 'form' : content['multipart/form-data'] ? 'multipart' : undefined;
  if (!kind) return undefined;
  const schema = (content['application/x-www-form-urlencoded'] ?? content['multipart/form-data']).schema;
  const fields = Object.entries<any>(schema?.properties ?? {}).map(([name, prop]) => {
    const ex = exampleFromSchema(prop);
    return { name, value: ex === null || ex === undefined ? '' : typeof ex === 'object' ? JSON.stringify(ex) : String(ex) };
  });
  return { [kind]: fields };
}

class SecretVars {
  readonly names: string[] = [];
  constructor(private prefix: string) {}
  use(suffix: string): string {
    const name = this.prefix + suffix;
    if (!this.names.includes(name)) this.names.push(name);
    return `{{${name}}}`;
  }
}

function authOf(scheme: any, scopes: string[], vars: SecretVars): Record<string, unknown> | undefined {
  if (!scheme) return undefined;
  if (scheme.type === 'http' && /^bearer$/i.test(scheme.scheme)) return { type: 'bearer', token: vars.use('Token') };
  if (scheme.type === 'http' && /^basic$/i.test(scheme.scheme)) {
    return { type: 'basic', username: vars.use('Username'), password: vars.use('Password') };
  }
  if (scheme.type === 'apiKey' && (scheme.in === 'header' || scheme.in === 'query')) {
    return { type: 'apiKey', in: scheme.in, name: scheme.name, value: vars.use('ApiKey') };
  }
  if (scheme.type === 'oauth2') {
    const cc = scheme.flows?.clientCredentials;
    const ac = scheme.flows?.authorizationCode;
    const flow = cc ?? ac;
    if (!flow) return undefined;
    const scope = (scopes.length ? scopes : Object.keys(flow.scopes ?? {})).join(' ');
    const auth: Record<string, unknown> = { type: 'oauth2', grant: cc ? 'clientCredentials' : 'authorizationCode' };
    if (!cc) auth.authUrl = ac.authorizationUrl;
    auth.tokenUrl = flow.tokenUrl;
    auth.clientId = vars.use('ClientId');
    auth.clientSecret = vars.use('ClientSecret');
    if (scope) auth.scope = scope;
    return auth;
  }
  return undefined;
}

export function generate(doc: OpenApiDoc, specName: string): Generated {
  const prefix = camel(specName);
  const baseUrlVar = `${prefix}BaseUrl`;
  const schemes = doc.components?.securitySchemes ?? {};
  const vars = new SecretVars(prefix);
  const requirementOf = (security: any): { name: string; scopes: string[] } | undefined => {
    const first = Array.isArray(security) ? security[0] : undefined;
    const name = first && Object.keys(first)[0];
    return name ? { name, scopes: first[name] ?? [] } : undefined;
  };
  const ops: { path: string; method: string; op: any; item: any }[] = [];
  for (const [path, item] of Object.entries<any>(doc.paths ?? {})) {
    for (const method of METHODS) if (item?.[method]) ops.push({ path, method, op: item[method], item });
  }
  const folderReq = requirementOf(doc.security) ?? ops.map((o) => requirementOf(o.op.security)).find(Boolean);
  const folderAuth = folderReq && authOf(schemes[folderReq.name], folderReq.scopes, vars);

  const used = new Set<string>();
  const requests: GeneratedRequest[] = [];
  for (const { path, method, op, item } of ops) {
    const operationId: string = op.operationId ?? slug(`${method}_${path}`, '_');
    const folder = slug(String(op.tags?.[0] ?? ''), '-');
    const base = `${folder ? `${folder}/` : ''}${kebab(operationId)}`;
    let relPath = `${base}.req.yaml`;
    for (let n = 2; used.has(relPath); n++) relPath = `${base}-${n}.req.yaml`;
    used.add(relPath);

    const params = new Map<string, any>();
    for (const p of [...(item.parameters ?? []), ...(op.parameters ?? [])]) params.set(`${p.in}:${p.name}`, p);
    const all = [...params.values()];
    const pathParams = Object.fromEntries(all.filter((p) => p.in === 'path').map((p) => [p.name, paramValue(p)]));
    const query = all.filter((p) => p.in === 'query').map(kvOf);
    const headers = all.filter((p) => p.in === 'header' && !SKIPPED_HEADERS.includes(p.name.toLowerCase())).map(kvOf);

    let auth: Record<string, unknown> | undefined;
    if (op.security !== undefined) {
      const req = requirementOf(op.security);
      if (!req) auth = { type: 'none' };
      else if (req.name !== folderReq?.name) auth = authOf(schemes[req.name], req.scopes, vars);
    }
    const body = bodyOf(op.requestBody);

    const obj: Record<string, unknown> = {
      name: op.summary || operationId,
      method: method.toUpperCase(),
      url: `{{${baseUrlVar}}}${path.replace(/\{([^}]+)\}/g, '{{$1}}')}`,
    };
    if (Object.keys(pathParams).length) obj.pathParams = pathParams;
    if (query.length) obj.query = query;
    if (headers.length) obj.headers = headers;
    if (auth) obj.auth = auth;
    if (body) obj.body = body;
    obj.source = { spec: specName, operationId };
    requests.push({ operationId, relPath, text: dump(obj) });
  }
  return {
    requests,
    folderText: folderAuth ? dump({ auth: folderAuth }) : undefined,
    baseUrlVar,
    baseUrl: baseUrlOf(doc),
    secretVars: vars.names,
  };
}
