import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { applyEdits } from './yamlEdit';

export interface Environment {
  name: string;
  variables: Record<string, string>;
  secrets: Record<string, string>;
}

export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const rest = m[2];
    let value: string;
    const q = rest[0];
    if (q === '"' || q === "'") {
      const end = rest.indexOf(q, 1);
      value = end < 0 ? rest.slice(1) : rest.slice(1, end);
    } else {
      value = rest.replace(/\s+#.*$/, '').trim();
    }
    out[m[1]] = value;
  }
  return out;
}

const envDir = (root: string) => join(root, 'env');

async function readOptional(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

export async function listEnvironments(root: string): Promise<string[]> {
  let files: string[];
  try {
    files = await readdir(envDir(root));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const names = new Set<string>();
  for (const f of files) {
    const m = /^(.+)\.(yaml|env)$/.exec(f);
    if (m) names.add(m[1]);
  }
  return [...names].sort();
}

export async function loadEnvironment(root: string, name: string): Promise<Environment> {
  const yamlText = await readOptional(join(envDir(root), `${name}.yaml`));
  const envText = await readOptional(join(envDir(root), `${name}.env`));
  const variables: Record<string, string> = {};
  const vars = yamlText ? (parse(yamlText) as { variables?: Record<string, unknown> } | null)?.variables : undefined;
  if (vars && typeof vars === 'object') for (const [k, v] of Object.entries(vars)) variables[k] = String(v ?? '');
  return { name, variables, secrets: envText ? parseDotenv(envText) : {} };
}

export async function ensureGitignore(workspaceDir: string, relRoot: string): Promise<boolean> {
  const file = join(workspaceDir, '.gitignore');
  const text = (await readOptional(file)) ?? '';
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const wanted = [`${relRoot}/env/*.env`, `!${relRoot}/env/*.env.example`].filter((l) => !lines.includes(l));
  if (!wanted.length) return false;
  const prefix = text && !text.endsWith('\n') ? '\n' : '';
  await writeFile(file, text + prefix + wanted.join('\n') + '\n');
  return true;
}

export async function createEnvironment(
  root: string,
  name: string,
  workspaceDir: string,
): Promise<{ gitignoreUpdated: boolean }> {
  await mkdir(envDir(root), { recursive: true });
  const files: [string, string][] = [
    [`${name}.yaml`, 'variables: {}\n'],
    [`${name}.env`, ''],
    [`${name}.env.example`, ''],
  ];
  for (const [f, content] of files) {
    try {
      await writeFile(join(envDir(root), f), content, { flag: 'wx' });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }
  const rel = root.startsWith(workspaceDir) ? root.slice(workspaceDir.length).replace(/^[\\/]+/, '') : root;
  return { gitignoreUpdated: await ensureGitignore(workspaceDir, rel.split('\\').join('/')) };
}

export async function addVariables(root: string, env: string, vars: Record<string, string>): Promise<void> {
  const file = join(envDir(root), `${env}.yaml`);
  let text = (await readOptional(file)) ?? 'variables: {}\n';
  const existing = (parse(text) as { variables?: Record<string, unknown> } | null)?.variables ?? {};
  const ops = Object.entries(vars)
    .filter(([k]) => !(k in existing))
    .map(([k, value]) => ({ op: 'set' as const, path: ['variables', k], value }));
  if (!ops.length) return;
  text = applyEdits(text, ops);
  await mkdir(envDir(root), { recursive: true });
  await writeFile(file, text);
}

async function appendMissingKeys(file: string, names: string[]): Promise<void> {
  const text = (await readOptional(file)) ?? '';
  const have = parseDotenv(text);
  const missing = names.filter((n, i) => !(n in have) && names.indexOf(n) === i);
  if (!missing.length && (await readOptional(file)) !== undefined) return;
  const prefix = text && !text.endsWith('\n') ? '\n' : '';
  await writeFile(file, text + prefix + missing.map((n) => `${n}=\n`).join(''));
}

export async function addSecretNames(root: string, env: string, names: string[]): Promise<void> {
  await mkdir(envDir(root), { recursive: true });
  await appendMissingKeys(join(envDir(root), `${env}.env.example`), names);
  await appendMissingKeys(join(envDir(root), `${env}.env`), names);
}

export function variableSource(
  _root: string,
  env: Environment,
  name: string,
): { kind: 'variable' | 'secret'; file: string } | undefined {
  if (name in env.secrets) return { kind: 'secret', file: `env/${env.name}.env` };
  if (name in env.variables) return { kind: 'variable', file: `env/${env.name}.yaml` };
  return undefined;
}
