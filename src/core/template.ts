export type Segment =
  | { kind: 'text'; text: string }
  | { kind: 'var'; name: string }
  | { kind: 'response'; request: string; path: string; maxAge?: string };

export class TemplateError extends Error {}

export class MissingVariableError extends Error {
  constructor(public variable: string) {
    super(`Variable "${variable}" is not set.`);
  }
}

const VAR = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const Q = `(?:"([^"]*)"|'([^']*)')`;
const RESPONSE = new RegExp(`^response\\(\\s*${Q}\\s*,\\s*${Q}\\s*(?:,\\s*${Q}\\s*)?\\)$`);

function parseExpression(inner: string): Segment {
  const expr = inner.trim();
  if (VAR.test(expr)) return { kind: 'var', name: expr };
  const m = RESPONSE.exec(expr);
  if (m) {
    const seg: Segment = { kind: 'response', request: m[1] ?? m[2], path: m[3] ?? m[4] };
    const maxAge = m[5] ?? m[6];
    if (maxAge !== undefined) seg.maxAge = maxAge;
    return seg;
  }
  throw new TemplateError(`Invalid template expression "{{${inner}}}"`);
}

export function parseTemplate(s: string): Segment[] {
  const out: Segment[] = [];
  let text = '';
  let i = 0;
  while (i < s.length) {
    if (s.startsWith('\\{{', i)) {
      text += '{{';
      i += 3;
    } else if (s.startsWith('{{', i)) {
      const end = s.indexOf('}}', i + 2);
      if (end < 0) throw new TemplateError('Unterminated "{{" in template');
      if (text) out.push({ kind: 'text', text });
      text = '';
      out.push(parseExpression(s.slice(i + 2, end)));
      i = end + 2;
    } else {
      text += s[i++];
    }
  }
  if (text) out.push({ kind: 'text', text });
  return out;
}

export function referencedVariables(s: string): string[] {
  const names: string[] = [];
  for (const seg of parseTemplate(s)) if (seg.kind === 'var' && !names.includes(seg.name)) names.push(seg.name);
  return names;
}

export interface TemplateContext {
  lookup(name: string): { value: string; secret: boolean } | undefined;
  response(request: string, path: string, maxAge?: string): Promise<{ value: string; secret: boolean }>;
}

export async function renderTemplate(s: string, ctx: TemplateContext): Promise<{ value: string; secrets: string[] }> {
  let value = '';
  const secrets: string[] = [];
  for (const seg of parseTemplate(s)) {
    if (seg.kind === 'text') {
      value += seg.text;
      continue;
    }
    let r: { value: string; secret: boolean } | undefined;
    if (seg.kind === 'var') {
      r = ctx.lookup(seg.name);
      if (!r) throw new MissingVariableError(seg.name);
    } else {
      r = await ctx.response(seg.request, seg.path, seg.maxAge);
    }
    value += r.value;
    if (r.secret && r.value !== '' && !secrets.includes(r.value)) secrets.push(r.value);
  }
  return { value, secrets };
}
