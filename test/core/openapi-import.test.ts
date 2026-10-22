import * as path from 'node:path';
import { mkdtemp, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { applyImport, listSpecs, planImport, planReimport } from '../../src/core/openapi/importer';
import { parseRequest } from '../../src/core/model';
import { listTree } from '../../src/core/workspace';

const FIX = path.resolve(__dirname, '../fixtures');
const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });

async function setup() {
  const ws = await mkdtemp(path.join(tmpdir(), 'oas-import-'));
  dirs.push(ws);
  const root = path.join(ws, '.http');
  await mkdir(root, { recursive: true });
  return { ws, root };
}
const opts = (source = 'petstore.yaml') => ({ specName: 'petstore', source, target: 'petstore', baseDir: FIX });
const read = (root: string, rel: string) => readFile(path.join(root, rel), 'utf8');

async function imported() {
  const s = await setup();
  await applyImport(s.root, s.ws, await planImport(s.root, opts()), new Set());
  return s;
}
const counts = (p: Awaited<ReturnType<typeof planImport>>) => ({
  added: p.added.length, updated: p.updated.length, conflicted: p.conflicted.length, removed: p.removed.length, unchanged: p.unchanged,
});

describe('importer', () => {
  it('first import writes files folder env registry snapshot', async () => {
    const { ws, root } = await setup();
    const plan = await planImport(root, opts());
    expect(plan.added.map((c) => c.relPath)).toEqual([
      'petstore/pets/list-pets.req.yaml', 'petstore/pets/create-pet.req.yaml', 'petstore/pets/get-pet.req.yaml',
      'petstore/store/place-order.req.yaml', 'petstore/health.req.yaml', 'petstore/get-pets-petid-photos.req.yaml',
      'petstore/_folder.yaml',
    ]);
    expect(plan.added[6].operationId).toBe('_folder');
    expect(counts(plan)).toEqual({ added: 7, updated: 0, conflicted: 0, removed: 0, unchanged: 0 });
    expect(plan.newVariables).toEqual({ petstoreBaseUrl: 'https://api.petstore.test/v1' });
    expect(plan.secretVars).toEqual(['petstoreToken', 'petstoreApiKey']);
    await applyImport(root, ws, plan, new Set());

    const list = parseRequest(await read(root, 'petstore/pets/list-pets.req.yaml')).request!;
    expect(list.source).toEqual({ spec: 'petstore', operationId: 'listPets' });
    expect(await read(root, 'petstore/_folder.yaml')).toContain('token: "{{petstoreToken}}"');
    expect(parse(await read(root, 'env/local.yaml'))).toEqual({ variables: { petstoreBaseUrl: 'https://api.petstore.test/v1' } });
    expect(await read(root, 'env/local.env.example')).toBe('petstoreToken=\npetstoreApiKey=\n');
    expect(await read(ws, '.gitignore')).toContain('.http/env/*.env');
    const reg = parse(await read(root, '.openapi/petstore.yaml'));
    expect(reg).toMatchObject({ source: 'petstore.yaml', target: 'petstore' });
    expect(Number.isNaN(Date.parse(reg.importedAt))).toBe(false);
    const snap = parse(await read(root, '.openapi/petstore.snapshot.yaml'));
    expect(Object.keys(snap)).toEqual(['listPets', 'createPet', 'getPet', 'placeOrder', 'health', 'get_pets_petid_photos', '_folder']);
    expect(snap.listPets).toBe(plan.added[0].specText);
    expect(await listSpecs(root)).toEqual([{ name: 'petstore', source: 'petstore.yaml', target: 'petstore', importedAt: reg.importedAt }]);
  });

  it('existing envs get the base url, a clash gets -2', async () => {
    const { ws, root } = await setup();
    await mkdir(path.join(root, 'env'), { recursive: true });
    await writeFile(path.join(root, 'env/dev.yaml'), 'variables:\n  petstoreBaseUrl: http://localhost\n');
    await writeFile(path.join(root, 'env/prod.yaml'), 'variables:\n  other: 1\n');
    await mkdir(path.join(root, 'petstore'), { recursive: true });
    await writeFile(path.join(root, 'petstore/health.req.yaml'), 'method: GET\nurl: mine\n');
    const plan = await planImport(root, opts());
    expect(plan.added.map((c) => c.relPath)).toContain('petstore/health-2.req.yaml');
    await applyImport(root, ws, plan, new Set());
    expect(await read(root, 'petstore/health.req.yaml')).toBe('method: GET\nurl: mine\n');
    expect(parse(await read(root, 'env/dev.yaml')).variables.petstoreBaseUrl).toBe('http://localhost');
    expect(parse(await read(root, 'env/prod.yaml')).variables.petstoreBaseUrl).toBe('https://api.petstore.test/v1');
    expect(await listTree(root).then((t) => t.find((n) => n.name === 'env'))).toBeUndefined();
  });

  it('reimport v2 plan counts', async () => {
    const { root } = await imported();
    const plan = await planImport(root, opts('petstore-v2.yaml'));
    expect(plan.added.map((c) => [c.relPath, c.operationId])).toEqual([['petstore/pets/delete-pet.req.yaml', 'deletePet']]);
    expect(plan.updated.map((c) => c.operationId).sort()).toEqual(['createPet', 'getPet', 'listPets']);
    expect(plan.removed.map((c) => c.operationId)).toEqual(['health']);
    expect(plan.conflicted).toEqual([]);
    expect(plan.unchanged).toBe(3);
    expect(plan.newVariables).toEqual({});
    const get = plan.updated.find((c) => c.operationId === 'getPet')!;
    expect(get.before).toContain('/pets/{{petId}}');
    expect(get.after).toContain('/pet/{{petId}}');
    const create = parseRequest(plan.updated.find((c) => c.operationId === 'createPet')!.after).request!;
    expect(create.body.type === 'json' && Object.keys(JSON.parse(create.body.content))).toEqual(['id', 'name', 'status', 'tags', 'age']);
  });

  it('moved file still matched', async () => {
    const { root } = await imported();
    await mkdir(path.join(root, 'mine'), { recursive: true });
    await rename(path.join(root, 'petstore/pets/get-pet.req.yaml'), path.join(root, 'mine/fetch.req.yaml'));
    const plan = await planImport(root, opts('petstore-v2.yaml'));
    const get = plan.updated.find((c) => c.operationId === 'getPet')!;
    expect(get.relPath).toBe('mine/fetch.req.yaml');
    expect(plan.added.map((c) => c.operationId)).toEqual(['deletePet']);
  });

  it('removed marked source.removed', async () => {
    const { ws, root } = await imported();
    const plan = await planImport(root, opts('petstore-v2.yaml'));
    await applyImport(root, ws, plan, new Set());
    const health = parseRequest(await read(root, 'petstore/health.req.yaml')).request!;
    expect(health.source).toEqual({ spec: 'petstore', operationId: 'health', removed: true });
    const tree = await listTree(root);
    const node = tree.find((n) => n.name === 'petstore')!.children!.find((n) => n.name === 'Health')!;
    expect(node.removed).toBe(true);
    expect((await listSpecs(root))[0].source).toBe('petstore-v2.yaml');
    // Applying again changes nothing; bringing the operation back clears the flag.
    expect(counts(await planReimport(root, 'petstore', FIX))).toEqual({ added: 0, updated: 0, conflicted: 0, removed: 0, unchanged: 8 });
    const back = await planImport(root, opts());
    expect(back.updated.find((c) => c.operationId === 'health')!.after).not.toContain('removed');
  });

  it('takeSpec overwrites conflicted file', async () => {
    const { ws, root } = await imported();
    const rel = 'petstore/pets/get-pet.req.yaml';
    const mine = (await read(root, rel)).replace('/pets/{{petId}}', '/my/pets/{{petId}}').replace('name: getPet', 'name: Mine');
    await writeFile(path.join(root, rel), mine);
    const plan = await planImport(root, opts('petstore-v2.yaml'));
    expect(plan.conflicted.map((c) => [c.relPath, c.conflicts])).toEqual([[rel, ['url']]]);
    expect(plan.conflicted[0].after).toBe(mine);
    await applyImport(root, ws, plan, new Set([rel]));
    expect(await read(root, rel)).toBe(plan.conflicted[0].specText);
    expect(parseRequest(await read(root, rel)).request!.url).toBe('{{petstoreBaseUrl}}/pet/{{petId}}');
  });

  it('reimport of unchanged spec gives unchanged only', async () => {
    const { root } = await imported();
    const plan = await planReimport(root, 'petstore', FIX);
    expect(counts(plan)).toEqual({ added: 0, updated: 0, conflicted: 0, removed: 0, unchanged: 7 });
    expect(plan).toMatchObject({ specName: 'petstore', source: 'petstore.yaml', target: 'petstore' });
  });

  it('no snapshot: existing file keeps user values', async () => {
    const { ws, root } = await imported();
    await rm(path.join(root, '.openapi/petstore.snapshot.yaml'));
    const rel = 'petstore/pets/get-pet.req.yaml';
    await writeFile(path.join(root, rel), (await read(root, rel)).replace('"7"', '"9"'));
    const plan = await planImport(root, opts('petstore-v2.yaml'));
    expect(plan.conflicted).toEqual([]);
    // Only additions apply: a new query param and a new body field. getPet's changed url keeps the user's.
    expect(plan.updated.map((c) => c.operationId).sort()).toEqual(['createPet', 'listPets']);
    expect(plan.updated.find((c) => c.operationId === 'createPet')!.after).toContain('"born"');
    expect(plan.removed.map((c) => c.operationId)).toEqual(['health']);
    await applyImport(root, ws, plan, new Set());
    expect(await read(root, rel)).toContain('/pets/{{petId}}');
    expect(parse(await read(root, '.openapi/petstore.snapshot.yaml')).getPet).toContain('/pet/{{petId}}');
  });

  it('applying an unchanged reimport leaves files byte-identical', async () => {
    const { ws, root } = await imported();
    const snapshotFiles = async () => {
      const out: Record<string, string> = {};
      const walk = async (dir: string) => {
        for (const e of await readdir(dir, { withFileTypes: true })) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) { if (e.name !== '.openapi') await walk(full); } else out[path.relative(root, full)] = await readFile(full, 'utf8');
        }
      };
      await walk(root);
      return out;
    };
    const before = await snapshotFiles();
    expect(Object.keys(before)).toContain('env/local.yaml');
    await applyImport(root, ws, await planReimport(root, 'petstore', FIX), new Set());
    expect(await snapshotFiles()).toEqual(before);
  });

  it('refuses a plan when files changed since planning', async () => {
    const { ws, root } = await imported();
    const plan = await planImport(root, opts('petstore-v2.yaml'));
    const rel = 'petstore/pets/get-pet.req.yaml';
    const edited = `${await read(root, rel)}# edited after preview\n`;
    await writeFile(path.join(root, rel), edited);
    await rm(path.join(root, 'petstore/health.req.yaml'));
    await expect(applyImport(root, ws, plan, new Set())).rejects.toThrow(
      `Files changed since the import was planned: ${rel}, petstore/health.req.yaml; re-run the import`);
    expect(await read(root, rel)).toBe(edited);
    await expect(read(root, 'petstore/pets/delete-pet.req.yaml')).rejects.toThrow();
    expect(parse(await read(root, '.openapi/petstore.yaml')).source).toBe('petstore.yaml');
  });
});
