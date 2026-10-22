import * as fs from 'node:fs/promises';
import { Agent, fetch, FormData } from 'undici';
import type { ResolvedRequest } from './resolve';

export interface HttpResponse {
  status: number; statusText: string; headers: [string, string][]; url: string;
  bodyBase64: string; bodyText?: string; contentType?: string; sizeBytes: number; timeMs: number; truncated?: boolean;
}
export type TimelineEntry = {
  kind: 'request' | 'redirect' | 'response' | 'dependency' | 'info' | 'error'; text: string; headers?: [string, string][];
};

export const MAX_BODY_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 10;
const MASK = '•••••';
const SENSITIVE = new Set(['authorization', 'cookie', 'proxy-authorization']);

export function mask(text: string, secrets: Set<string>): string {
  let out = text;
  for (const s of [...secrets].filter((x) => x.length >= 1).sort((a, b) => b.length - a.length)) {
    out = out.split(s).join(MASK);
  }
  return out;
}

interface StoredCookie { name: string; value: string; domain: string; hostOnly: boolean; path: string; expires?: number }

export class CookieJar {
  private cookies: StoredCookie[] = [];

  cookieHeader(url: string): string | undefined {
    const u = new URL(url);
    const now = Date.now();
    this.cookies = this.cookies.filter((c) => c.expires === undefined || c.expires > now);
    const host = u.hostname.toLowerCase();
    const pairs = this.cookies
      .filter((c) => (c.hostOnly ? host === c.domain : host === c.domain || host.endsWith('.' + c.domain))
        && (u.pathname === c.path || u.pathname.startsWith(c.path.endsWith('/') ? c.path : c.path + '/')))
      .sort((a, b) => b.path.length - a.path.length)
      .map((c) => `${c.name}=${c.value}`);
    return pairs.length ? pairs.join('; ') : undefined;
  }

  store(url: string, setCookie: string[]): void {
    const u = new URL(url);
    for (const raw of setCookie) {
      const [pair, ...attrs] = raw.split(';').map((s) => s.trim());
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const c: StoredCookie = {
        name: pair.slice(0, eq), value: pair.slice(eq + 1), domain: u.hostname.toLowerCase(), hostOnly: true,
        path: defaultPath(u.pathname),
      };
      let maxAge: number | undefined;
      for (const a of attrs) {
        const i = a.indexOf('=');
        const k = (i < 0 ? a : a.slice(0, i)).toLowerCase();
        const v = i < 0 ? '' : a.slice(i + 1);
        if (k === 'domain' && v) { c.domain = v.replace(/^\./, '').toLowerCase(); c.hostOnly = false; }
        else if (k === 'path' && v.startsWith('/')) c.path = v;
        else if (k === 'expires') { const t = Date.parse(v); if (!Number.isNaN(t)) c.expires = t; }
        else if (k === 'max-age' && /^-?\d+$/.test(v)) maxAge = Number(v);
      }
      if (maxAge !== undefined) c.expires = Date.now() + maxAge * 1000;
      this.cookies = this.cookies.filter((o) => !(o.name === c.name && o.domain === c.domain && o.path === c.path));
      if (c.expires === undefined || c.expires > Date.now()) this.cookies.push(c);
    }
  }

  clear(): void { this.cookies = []; }
}

function defaultPath(p: string): string {
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}

const TEXTUAL = /^text\/|json|xml|javascript|^application\/x-www-form-urlencoded/i;

async function buildBody(body: ResolvedRequest['body']): Promise<string | Buffer | URLSearchParams | FormData | undefined> {
  switch (body.kind) {
    case 'none': return undefined;
    case 'bytes': return body.data;
    case 'form': return new URLSearchParams(body.fields).toString();
    case 'multipart': {
      const fd = new FormData();
      for (const p of body.parts) {
        if (p.file !== undefined) fd.append(p.name, new Blob([new Uint8Array(await fs.readFile(p.file))]), p.filename);
        else fd.append(p.name, p.value ?? '');
      }
      return fd;
    }
  }
}

const hasHeader = (hs: [string, string][], name: string) => hs.some(([k]) => k.toLowerCase() === name);

export async function send(
  req: ResolvedRequest, opts: { jar: CookieJar; signal?: AbortSignal },
): Promise<{ response: HttpResponse; timeline: TimelineEntry[] }> {
  const timeline: TimelineEntry[] = [];
  const started = Date.now();
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, req.timeoutMs);
  const onAbort = () => controller.abort();
  if (opts.signal?.aborted) controller.abort();
  else opts.signal?.addEventListener('abort', onAbort, { once: true });
  const dispatcher = req.verifyTls ? undefined : new Agent({ connect: { rejectUnauthorized: false } });

  const maskHeaders = (hs: [string, string][]): [string, string][] =>
    hs.map(([k, v]) => [k, SENSITIVE.has(k.toLowerCase()) ? MASK : mask(v, req.secrets)]);

  try {
    let method = req.method;
    let url = req.url;
    let headers = req.headers.slice();
    let body: ResolvedRequest['body'] = req.body;
    for (let hop = 0; ; hop++) {
      const sent = headers.slice();
      if (body.kind === 'bytes' && body.contentType && !hasHeader(sent, 'content-type')) sent.push(['Content-Type', body.contentType]);
      if (body.kind === 'form' && !hasHeader(sent, 'content-type')) sent.push(['Content-Type', 'application/x-www-form-urlencoded']);
      if (!hasHeader(sent, 'cookie')) {
        const c = opts.jar.cookieHeader(url);
        if (c) sent.push(['Cookie', c]);
      }
      // multipart: let fetch set the content-type with its boundary
      const outgoing = body.kind === 'multipart' ? sent.filter(([k]) => k.toLowerCase() !== 'content-type') : sent;
      timeline.push({ kind: 'request', text: `${method} ${mask(url, req.secrets)}`, headers: maskHeaders(sent) });

      let res;
      try {
        res = await fetch(url, {
          method, headers: outgoing, body: await buildBody(body), redirect: 'manual', signal: controller.signal, dispatcher,
        });
      } catch (e) {
        throw wrapError(e, timedOut, req, opts.signal);
      }
      const respHeaders: [string, string][] = [];
      res.headers.forEach((v, k) => { if (k.toLowerCase() !== 'set-cookie') respHeaders.push([k, v]); });
      const setCookies = res.headers.getSetCookie();
      for (const c of setCookies) respHeaders.push(['set-cookie', c]);
      if (setCookies.length) opts.jar.store(url, setCookies);

      const location = res.headers.get('location');
      if (req.followRedirects && [301, 302, 303, 307, 308].includes(res.status) && location) {
        await res.body?.cancel().catch(() => undefined);
        if (hop >= MAX_REDIRECTS) throw new Error(`Too many redirects (more than ${MAX_REDIRECTS})`);
        const next = new URL(location, url).toString();
        timeline.push({ kind: 'redirect', text: `${res.status} ${res.statusText} -> ${mask(next, req.secrets)}` });
        if (new URL(next).origin !== new URL(url).origin) {
          headers = headers.filter(([k]) => !['authorization', 'cookie'].includes(k.toLowerCase()));
        }
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
          if (method !== 'HEAD') method = 'GET';
          body = { kind: 'none' };
          headers = headers.filter(([k]) => !['content-type', 'content-length'].includes(k.toLowerCase()));
        }
        url = next;
        continue;
      }

      let chunks: Buffer[] = [];
      let kept = 0;
      let size = 0;
      try {
        if (res.body) {
          for await (const chunk of res.body) {
            const buf = Buffer.from(chunk);
            size += buf.length;
            if (kept < MAX_BODY_BYTES) {
              const part = buf.subarray(0, MAX_BODY_BYTES - kept);
              chunks.push(part);
              kept += part.length;
            }
          }
        }
      } catch (e) {
        throw wrapError(e, timedOut, req, opts.signal);
      }
      const data = Buffer.concat(chunks);
      chunks = [];
      const contentType = res.headers.get('content-type') ?? undefined;
      const response: HttpResponse = {
        status: res.status, statusText: res.statusText, headers: respHeaders, url,
        bodyBase64: data.toString('base64'), sizeBytes: size, timeMs: Date.now() - started,
      };
      if (contentType !== undefined) response.contentType = contentType;
      if (contentType && TEXTUAL.test(contentType.trim())) response.bodyText = data.toString('utf8');
      if (size > MAX_BODY_BYTES) response.truncated = true;
      timeline.push({ kind: 'response', text: `${res.status} ${res.statusText}`.trim(), headers: respHeaders });
      return { response, timeline };
    }
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
    await dispatcher?.close();
  }
}

function wrapError(e: unknown, timedOut: boolean, req: ResolvedRequest, signal?: AbortSignal): Error {
  if (timedOut) return new Error(`Request timed out after ${req.timeoutMs}ms`);
  if (signal?.aborted) return new Error('Request cancelled');
  const err = e as Error & { cause?: { message?: string } };
  const detail = err.cause?.message ? `: ${err.cause.message}` : '';
  return new Error(mask(`${err.message}${detail}`, req.secrets));
}
