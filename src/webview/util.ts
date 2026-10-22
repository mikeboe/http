// Pure helpers for the webview. No imports from src/core at runtime: model.ts pulls in `yaml`.

/** Mirrors HTTP_METHODS in src/core/model.ts (test/webview/util.test.ts keeps them in sync). */
export const HTTP_METHODS: readonly string[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

const METHOD_COLOURS: Record<string, string> = {
  GET: 'green', POST: 'yellow', PUT: 'blue', PATCH: 'purple', DELETE: 'red', HEAD: 'orange', OPTIONS: 'orange',
};

/** The `--vscode-charts-*` colour for a method badge. */
export function methodColour(method: string): string {
  return `var(--vscode-charts-${METHOD_COLOURS[method] ?? 'blue'})`;
}

export type TemplatePart = { kind: 'text'; text: string } | { kind: 'var'; text: string; name: string } | { kind: 'expr'; text: string };

const VAR = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/** Splits a field value into text and `{{...}}` tokens, keeping the source text of each part. `\{{` is text. */
export function templateParts(s: string): TemplatePart[] {
  const out: TemplatePart[] = [];
  let text = '';
  let i = 0;
  while (i < s.length) {
    if (s.startsWith('\\{{', i)) { text += '\\{{'; i += 3; continue; }
    if (s.startsWith('{{', i)) {
      const end = s.indexOf('}}', i + 2);
      if (end >= 0) {
        if (text) out.push({ kind: 'text', text });
        text = '';
        const src = s.slice(i, end + 2);
        const inner = s.slice(i + 2, end).trim();
        out.push(VAR.test(inner) ? { kind: 'var', text: src, name: inner } : { kind: 'expr', text: src });
        i = end + 2;
        continue;
      }
    }
    text += s[i++];
  }
  if (text) out.push({ kind: 'text', text });
  return out;
}

/** Variable names used in a string, in order, without duplicates. */
export function variableNames(s: string): string[] {
  const names: string[] = [];
  for (const p of templateParts(s)) if (p.kind === 'var' && !names.includes(p.name)) names.push(p.name);
  return names;
}

/**
 * `{{x}}` names in the path of a URL: after `scheme://host` or after a leading `{{base}}` token,
 * and before `?` or `#`.
 */
export function pathParamNames(url: string): string[] {
  let rest = url.split(/[?#]/)[0];
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]*/.exec(rest);
  if (scheme) rest = rest.slice(scheme[0].length);
  else {
    const lead = /^\{\{[^}]*\}\}/.exec(rest);
    if (lead) rest = rest.slice(lead[0].length);
  }
  return variableNames(rest);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function formatTime(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

/** Status badge class: ok (2xx), warn (1xx/3xx/4xx), error (5xx and failed sends). */
export function statusClass(ok: boolean, status?: number): 'ok' | 'warn' | 'error' {
  if (!ok || status === undefined || status >= 500) return 'error';
  if (status >= 200 && status < 300) return 'ok';
  return 'warn';
}

export const DURATION = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/;
