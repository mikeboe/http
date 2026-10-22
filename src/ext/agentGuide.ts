// vscode-free: the "Add agent instructions" texts.

/** The guide is written for the default `.http/` root; point it at the configured one. */
export function adaptGuide(guide: string, relRoot: string): string {
  const prefix = relRoot === '' || relRoot === '.' ? './' : `${relRoot.replace(/\/+$/, '')}/`;
  return prefix === '.http/' ? guide : guide.split('.http/').join(prefix);
}

export function skillText(guide: string): string {
  return `---
name: http-requests
description: Use when creating, editing, chaining or running HTTP requests stored as YAML files (*.req.yaml, _folder.yaml, env/) in this repository.
---

${guide}`;
}
