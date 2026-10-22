import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { parseDuration } from './model';
import type { Auth } from './model';
import type { EffectiveRequest } from './workspace';
import type { Environment } from './env';
import { renderTemplate } from './template';
import type { TemplateContext } from './template';

export type ResolvedBody =
  | { kind: 'none' }
  | { kind: 'bytes'; data: Buffer; contentType?: string }
  | { kind: 'form'; fields: [string, string][] }
  | { kind: 'multipart'; parts: { name: string; value?: string; file?: string; filename?: string }[] };

export interface ResolvedRequest {
  method: string; url: string; headers: [string, string][]; body: ResolvedBody;
  timeoutMs: number; followRedirects: boolean; verifyTls: boolean; secrets: Set<string>; auth: Auth;
}

const has = (o: object, k: string) => Object.hasOwn(o, k);

export async function resolveRequest(
  req: EffectiveRequest, env: Environment, response: TemplateContext['response'],
): Promise<ResolvedRequest> {
  const secrets = new Set<string>();
  const envCtx: TemplateContext = {
    lookup(name) {
      // An empty .env value (e.g. `token=` written by an import) is a placeholder, not a value.
      if (has(env.secrets, name) && env.secrets[name] !== '') return { value: env.secrets[name], secret: true };
      if (has(env.variables, name)) return { value: env.variables[name], secret: false };
      return undefined;
    },
    response,
  };
  const renderWith = async (s: string, ctx: TemplateContext) => {
    const r = await renderTemplate(s, ctx);
    for (const x of r.secrets) secrets.add(x);
    return r;
  };
  const render = async (s: string) => (await renderWith(s, envCtx)).value;

  const params = new Map<string, { value: string; secret: boolean }>();
  for (const [k, v] of Object.entries(req.pathParams ?? {})) {
    const r = await renderTemplate(v, envCtx);
    params.set(k, { value: r.value, secret: r.secrets.length > 0 });
  }
  const ctx: TemplateContext = {
    lookup: (name) => params.get(name) ?? envCtx.lookup(name),
    response,
  };
  const rend = async (s: string) => (await renderWith(s, ctx)).value;

  let url = await rend(req.url);
  const query = new URLSearchParams();
  for (const q of req.query) if (q.enabled !== false) query.append(await rend(q.name), await rend(q.value));
  const qs = query.toString();
  if (qs) {
    const hash = url.indexOf('#');
    const frag = hash >= 0 ? url.slice(hash) : '';
    const base = hash >= 0 ? url.slice(0, hash) : url;
    url = base + (base.includes('?') ? (/[?&]$/.test(base) ? '' : '&') : '?') + qs + frag;
  }

  const headers: [string, string][] = [];
  for (const h of [...req.inheritedHeaders, ...req.headers]) {
    if (h.enabled === false) continue;
    headers.push([await rend(h.name), await rend(h.value)]);
  }

  const dir = path.dirname(req.file);
  const abs = (p: string) => path.resolve(dir, p);
  const b = req.body;
  let body: ResolvedBody = { kind: 'none' };
  let defaultType: string | undefined;
  if (b.type === 'json') {
    defaultType = 'application/json';
    body = { kind: 'bytes', data: Buffer.from(await rend(b.content), 'utf8'), contentType: defaultType };
  } else if (b.type === 'text') {
    const contentType = await rend(b.contentType);
    body = { kind: 'bytes', data: Buffer.from(await rend(b.content), 'utf8'), contentType };
    defaultType = contentType;
  } else if (b.type === 'form') {
    const fields: [string, string][] = [];
    for (const f of b.fields) if (f.enabled !== false) fields.push([await rend(f.name), await rend(f.value)]);
    body = { kind: 'form', fields };
  } else if (b.type === 'multipart') {
    const parts: { name: string; value?: string; file?: string; filename?: string }[] = [];
    for (const p of b.parts) {
      if (p.enabled === false) continue;
      const name = await rend(p.name);
      if (p.file !== undefined) {
        const file = abs(await rend(p.file));
        parts.push({ name, file, filename: path.basename(file) });
      } else parts.push({ name, value: await rend(p.value ?? '') });
    }
    body = { kind: 'multipart', parts };
  } else if (b.type === 'file') {
    body = { kind: 'bytes', data: await fs.readFile(abs(await rend(b.path))) };
  }
  if (defaultType && !headers.some(([k]) => k.toLowerCase() === 'content-type')) {
    headers.push(['Content-Type', defaultType]);
  }

  const auth = JSON.parse(JSON.stringify(req.auth)) as Auth;
  for (const [k, v] of Object.entries(auth)) {
    if (typeof v === 'string' && k !== 'type') (auth as Record<string, unknown>)[k] = await rend(v);
  }

  const s = req.settings ?? {};
  return {
    method: req.method, url, headers, body,
    timeoutMs: s.timeout !== undefined ? parseDuration(s.timeout) : 30000,
    followRedirects: s.followRedirects ?? true,
    verifyTls: s.verifyTls ?? true,
    secrets, auth,
  };
}
