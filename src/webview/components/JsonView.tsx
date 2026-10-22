import type { ComponentChildren } from 'preact';

/** Pretty-printed JSON with token colours from the theme's debug token colours. */
export function JsonView({ value }: { value: unknown }) {
  const out: ComponentChildren[] = [];
  render(value, '', out);
  return <pre class="code json-view">{out}</pre>;
}

function render(v: unknown, indent: string, out: ComponentChildren[]): void {
  if (v === null || typeof v === 'boolean') { out.push(<span class="j-bool">{String(v)}</span>); return; }
  if (typeof v === 'number') { out.push(<span class="j-num">{String(v)}</span>); return; }
  if (typeof v === 'string') { out.push(<span class="j-str">{JSON.stringify(v)}</span>); return; }
  const inner = `${indent}  `;
  if (Array.isArray(v)) {
    if (v.length === 0) { out.push('[]'); return; }
    out.push('[\n');
    v.forEach((item, i) => {
      out.push(inner);
      render(item, inner, out);
      out.push(i < v.length - 1 ? ',\n' : '\n');
    });
    out.push(`${indent}]`);
    return;
  }
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length === 0) { out.push('{}'); return; }
  out.push('{\n');
  entries.forEach(([k, item], i) => {
    out.push(inner, <span class="j-key">{JSON.stringify(k)}</span>, ': ');
    render(item, inner, out);
    out.push(i < entries.length - 1 ? ',\n' : '\n');
  });
  out.push(`${indent}}`);
}
