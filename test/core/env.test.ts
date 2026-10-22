import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseDotenv, listEnvironments, loadEnvironment, createEnvironment, addVariables, addSecretNames, variableSource,
} from '../../src/core/env';

async function setup() {
  const ws = await mkdtemp(join(tmpdir(), 'env-'));
  const root = join(ws, '.http');
  await mkdir(join(root, 'env'), { recursive: true });
  return { ws, root };
}

describe('env', () => {
  it('parseDotenv handles quotes comments export', () => {
    const r = parseDotenv('# c\nA=1\nexport B="two words"\nC=\'x y\'\nD=val # trailing\n\nE="a#b"\nF=\n');
    expect(r).toEqual({ A: '1', B: 'two words', C: 'x y', D: 'val', E: 'a#b', F: '' });
  });

  it('env overrides yaml', async () => {
    const { root } = await setup();
    await writeFile(join(root, 'env/local.yaml'), 'variables:\n  host: a\n  token: yamlTok\n');
    await writeFile(join(root, 'env/local.env'), 'token=envTok\n');
    const env = await loadEnvironment(root, 'local');
    expect(env.variables).toEqual({ host: 'a', token: 'yamlTok' });
    expect(env.secrets).toEqual({ token: 'envTok' });
    expect(variableSource(root, env, 'token')).toEqual({ kind: 'secret', file: 'env/local.env' });
    expect(variableSource(root, env, 'host')).toEqual({ kind: 'variable', file: 'env/local.yaml' });
    expect(variableSource(root, env, 'nope')).toBeUndefined();
  });

  it('missing files give an empty environment and list excludes examples', async () => {
    const { root } = await setup();
    expect(await loadEnvironment(root, 'ghost')).toEqual({ name: 'ghost', variables: {}, secrets: {} });
    await writeFile(join(root, 'env/b.yaml'), 'variables: {}\n');
    await writeFile(join(root, 'env/a.env'), '');
    await writeFile(join(root, 'env/a.env.example'), '');
    expect(await listEnvironments(root)).toEqual(['a', 'b']);
    expect(await listEnvironments(join(root, 'nothing'))).toEqual([]);
  });

  it('createEnvironment writes files and updates gitignore once', async () => {
    const { ws, root } = await setup();
    const first = await createEnvironment(root, 'local', ws);
    expect(first.gitignoreUpdated).toBe(true);
    expect(await readFile(join(root, 'env/local.yaml'), 'utf8')).toContain('variables');
    expect(await readFile(join(root, 'env/local.env'), 'utf8')).toBe('');
    expect(await readFile(join(root, 'env/local.env.example'), 'utf8')).toBe('');
    const gi = await readFile(join(ws, '.gitignore'), 'utf8');
    expect(gi).toContain('.http/env/*.env');
    expect(gi).toContain('!.http/env/*.env.example');
    const second = await createEnvironment(root, 'local', ws);
    expect(second.gitignoreUpdated).toBe(false);
    expect(await readFile(join(ws, '.gitignore'), 'utf8')).toBe(gi);
  });

  it('addVariables keeps existing values and comments', async () => {
    const { root } = await setup();
    await writeFile(join(root, 'env/local.yaml'), '# top\nvariables:\n  host: a # keep\n');
    await addVariables(root, 'local', { host: 'zzz', port: '80' });
    const t = await readFile(join(root, 'env/local.yaml'), 'utf8');
    expect(t).toContain('# top');
    expect(t).toContain('# keep');
    expect(t).toMatch(/host: a/);
    expect(t).toMatch(/port: ['"]?80['"]?/);
    expect((await loadEnvironment(root, 'local')).variables).toEqual({ host: 'a', port: '80' });
  });

  it('addSecretNames writes example', async () => {
    const { root } = await setup();
    await writeFile(join(root, 'env/local.env'), 'A=1\n');
    await addSecretNames(root, 'local', ['A', 'B']);
    expect(await readFile(join(root, 'env/local.env.example'), 'utf8')).toBe('A=\nB=\n');
    expect(await readFile(join(root, 'env/local.env'), 'utf8')).toBe('A=1\nB=\n');
    await addSecretNames(root, 'local', ['B', 'C']);
    expect(await readFile(join(root, 'env/local.env.example'), 'utf8')).toBe('A=\nB=\nC=\n');
  });

  it.each([['variables: {}\n'], ['variables:\n'], [undefined], ['variables: { a: 1 }\n']])(
    'addVariables writes block style for %j',
    async (initial) => {
      const { root } = await setup();
      if (initial !== undefined) await writeFile(join(root, 'env/local.yaml'), initial);
      await addVariables(root, 'local', { baseUrl: 'http://x' });
      const t = await readFile(join(root, 'env/local.yaml'), 'utf8');
      expect(t).toMatch(/^variables:\n( {2}a: 1\n)? {2}baseUrl: /);
      expect(t).not.toContain('{');
      expect((await loadEnvironment(root, 'local')).variables.baseUrl).toBe('http://x');
    },
  );

  it('createEnvironment file accepts addVariables in block style', async () => {
    const { ws, root } = await setup();
    await createEnvironment(root, 'local', ws);
    await addVariables(root, 'local', { a: 'b' });
    expect(await readFile(join(root, 'env/local.yaml'), 'utf8')).toBe('variables:\n  a: b\n');
  });

  it('createEnvironment skips gitignore when root is outside workspace', async () => {
    const { ws } = await setup();
    const other = ws + '2';
    await mkdir(join(other, '.http'), { recursive: true });
    expect((await createEnvironment(join(other, '.http'), 'local', ws)).gitignoreUpdated).toBe(false);
  });

  it('createEnvironment git-ignores .env files when the root is the workspace folder', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'env-'));
    expect((await createEnvironment(ws, 'local', ws)).gitignoreUpdated).toBe(true);
    expect(await readFile(join(ws, '.gitignore'), 'utf8')).toBe('env/*.env\n!env/*.env.example\n');
  });

  it('variableSource treats an empty secret as not set', () => {
    expect(variableSource('', { name: 'local', variables: {}, secrets: { t: '' } }, 't')).toBeUndefined();
  });

  it('rejects invalid environment names', async () => {
    const { ws, root } = await setup();
    for (const bad of ['../x', '.hidden', 'a/b', '']) {
      await expect(loadEnvironment(root, bad)).rejects.toThrow(`Invalid environment name: ${bad}`);
      await expect(createEnvironment(root, bad, ws)).rejects.toThrow('Invalid environment name');
      await expect(addVariables(root, bad, {})).rejects.toThrow('Invalid environment name');
      await expect(addSecretNames(root, bad, [])).rejects.toThrow('Invalid environment name');
    }
  });

  it('ignores prototype keys', async () => {
    const { root } = await setup();
    const env = await loadEnvironment(root, 'local');
    expect(variableSource(root, env, 'constructor')).toBeUndefined();
    await addVariables(root, 'local', { constructor: 'x' });
    expect((await loadEnvironment(root, 'local')).variables.constructor).toBe('x');
  });

  it('names the file in YAML parse errors', async () => {
    const { root } = await setup();
    await writeFile(join(root, 'env/local.yaml'), 'variables: [\n');
    await expect(loadEnvironment(root, 'local')).rejects.toThrow('local.yaml');
  });
});
