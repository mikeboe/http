import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// engines.vscode ^1.90.0: VS Code 1.90 runs extensions on Electron 29, i.e. Node 20.9.0.
const VSCODE_NODE = [20, 9, 0];

const root = join(__dirname, '../..');
const parseV = (v: string) => v.replace(/^v/, '').split('.').map((x) => Number.parseInt(x, 10) || 0).concat([0, 0, 0]).slice(0, 3);
const cmp = (a: number[], b: number[]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** Enough of semver ranges for engines fields: `||`, `>=`, `>`, `<`, `<=`, `^`, `~`, exact, `x`/`*`. */
function satisfies(v: number[], range: string): boolean {
  return range.split('||').some((alt) => {
    const parts = alt.trim().replace(/(>=|<=|>|<|=)\s+/g, '$1').split(/\s+/).filter(Boolean);
    return parts.every((p) => {
      if (p === '*' || p === 'x') return true;
      const m = /^(>=|<=|>|<|=|\^|~)?(.*)$/.exec(p)!;
      const w = parseV(m[2]);
      const c = cmp(v, w);
      switch (m[1]) {
        case '>=': return c >= 0;
        case '>': return c > 0;
        case '<=': return c <= 0;
        case '<': return c < 0;
        case '^': return c >= 0 && v[0] === w[0];
        case '~': return c >= 0 && v[0] === w[0] && v[1] === w[1];
        default: return c === 0 || (!m[2].includes('.') && v[0] === w[0]);
      }
    });
  });
}

describe('runtime dependencies', () => {
  it('the range checker works', () => {
    expect(satisfies([20, 9, 0], '>=22.19.0')).toBe(false);
    expect(satisfies([20, 9, 0], '>= 16')).toBe(true);
    expect(satisfies([20, 9, 0], '^18.17 || >=20')).toBe(true);
    expect(satisfies([20, 9, 0], '>=20.18.1')).toBe(false);
  });
  it('every production dependency supports the Node of the oldest supported VS Code', () => {
    const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')) as {
      packages: Record<string, { dev?: boolean; engines?: { node?: string } }>;
    };
    const bad = Object.entries(lock.packages)
      .filter(([name, p]) => name && !p.dev && p.engines?.node && !satisfies(VSCODE_NODE, p.engines.node))
      .map(([name, p]) => `${name} (${p.engines!.node})`);
    expect(bad).toEqual([]);
  });
  it('engines.vscode stays ^1.90.0', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    expect(pkg.engines.vscode).toBe('^1.90.0');
  });
});
