import { describe, expect, it } from 'vitest';
import type { ImportPlan } from '../../src/core/openapi/importer';
import { adaptGuide, skillText } from '../../src/ext/agentGuide';
import { duplicateText, slug, withName } from '../../src/ext/fileOps';
import { webviewHtml } from '../../src/ext/html';
import { planSummary, suggestSpecName } from '../../src/ext/importPlan';

describe('webviewHtml', () => {
  it('has the CSP, the nonce-tagged script, the stylesheet and the app root', () => {
    const html = webviewHtml({ cspSource: 'vscode-src', nonce: 'N1', scriptUri: 'S.js', styleUri: 'S.css' });
    expect(html).toContain(`content="default-src 'none'; style-src vscode-src 'unsafe-inline'; script-src 'nonce-N1'; img-src vscode-src data:; font-src vscode-src;"`);
    expect(html).toContain('<script nonce="N1" src="S.js"></script>');
    expect(html).toContain('<link rel="stylesheet" href="S.css">');
    expect(html).toContain('<div id="app"></div>');
  });
});

describe('planSummary', () => {
  const n = (k: number) => Array.from({ length: k }, () => ({ relPath: 'x', operationId: 'o', after: '', conflicts: [], specText: '' }));
  it('counts each kind', () => {
    const plan = { added: n(12), updated: n(5), removed: n(1), conflicted: n(2) } as unknown as ImportPlan;
    expect(planSummary(plan)).toBe('12 added, 5 updated, 1 removed, 2 conflicts');
    expect(planSummary({ ...plan, conflicted: n(1) })).toBe('12 added, 5 updated, 1 removed, 1 conflict');
  });
});

describe('suggestSpecName', () => {
  it('uses the file or URL name', () => {
    expect(suggestSpecName('specs/petstore.yaml')).toBe('petstore');
    expect(suggestSpecName('https://api.github.com/openapi.json')).toBe('github');
    expect(suggestSpecName('https://example.com/v1/billing.json')).toBe('billing');
  });
});

describe('fileOps', () => {
  it('slugs names', () => {
    expect(slug('Get user by ID')).toBe('get-user-by-id');
    expect(slug('  ***  ')).toBe('request');
  });
  it('renames keeping comments', () => {
    expect(withName('# keep\nname: A\nurl: x\n', 'B')).toBe('# keep\nname: B\nurl: x\n');
  });
  it('duplicates detach from the OpenAPI source', () => {
    const out = duplicateText('name: A\nurl: x\nsource:\n  spec: s\n  operationId: o\n', 'A copy');
    expect(out).toBe('name: A copy\nurl: x\n');
  });
});

describe('agent guide', () => {
  it('follows the configured root', () => {
    expect(adaptGuide('see .http/env/', '.http')).toBe('see .http/env/');
    expect(adaptGuide('see .http/env/', 'api/requests')).toBe('see api/requests/env/');
    expect(skillText('body')).toMatch(/^---\nname: http-requests\ndescription: .+\n---\n\nbody$/);
  });
});
