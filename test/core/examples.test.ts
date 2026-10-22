import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseFolder, parseRequest } from '../../src/core/model';

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const files = walk(join(__dirname, '../../examples'));

describe('examples', () => {
  const reqs = files.filter((f) => f.endsWith('.req.yaml'));
  const folders = files.filter((f) => f.endsWith('_folder.yaml'));

  it('has samples', () => {
    expect(reqs.length).toBeGreaterThan(0);
    expect(folders.length).toBeGreaterThan(0);
  });
  it.each(reqs)('parses %s', (f) => {
    expect(parseRequest(readFileSync(f, 'utf8')).errors).toEqual([]);
  });
  it.each(folders)('parses %s', (f) => {
    expect(parseFolder(readFileSync(f, 'utf8')).errors).toEqual([]);
  });
});
