import type { HttpResponse } from './http';

function tokens(path: string): (string | number)[] | undefined {
  const out: (string | number)[] = [];
  const re = /\.?([^.[\]]+)|\[(\d+)\]/y;
  let i = 0;
  while (i < path.length) {
    re.lastIndex = i;
    const m = re.exec(path);
    if (!m) return undefined;
    out.push(m[2] !== undefined ? Number(m[2]) : m[1]);
    i = re.lastIndex;
  }
  return out;
}

const show = (v: unknown): string | undefined =>
  v === undefined ? undefined : typeof v === 'string' ? v : JSON.stringify(v);

export function extractValue(r: HttpResponse, path: string): string | undefined {
  if (path === 'status') return String(r.status);
  if (path.startsWith('headers.')) {
    const name = path.slice('headers.'.length).toLowerCase();
    const vals = r.headers.filter(([k]) => k.toLowerCase() === name).map(([, v]) => v);
    return vals.length ? vals.join(', ') : undefined;
  }
  if (path === 'body') return r.bodyText;
  if (path.startsWith('body.') || path.startsWith('body[')) {
    if (r.bodyText === undefined) return undefined;
    let cur: unknown;
    try { cur = JSON.parse(r.bodyText); } catch { return undefined; }
    const toks = tokens(path.slice('body'.length));
    if (!toks) return undefined;
    for (const t of toks) {
      if (cur === null || typeof cur !== 'object') return undefined;
      if (typeof t === 'number' ? !Array.isArray(cur) : Array.isArray(cur) || !Object.hasOwn(cur, t)) return undefined;
      cur = (cur as Record<string | number, unknown>)[t];
    }
    return show(cur);
  }
  return undefined;
}
