import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8'));

describe('package.json contributions', () => {
  it('yamlValidation only claims files under .http (and *.req.yaml anywhere)', () => {
    const map = Object.fromEntries(
      (pkg.contributes.yamlValidation as { fileMatch: string; url: string }[]).map((v) => [v.url, v.fileMatch]),
    );
    expect(map).toEqual({
      './schemas/request.schema.json': '**/*.req.yaml',
      './schemas/folder.schema.json': '**/.http/**/_folder.yaml',
      './schemas/environment.schema.json': '**/.http/env/*.yaml',
    });
  });
});
