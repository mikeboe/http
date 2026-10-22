import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { describe, expect, it } from 'vitest';
import { exampleFromSchema, generate } from '../../src/core/openapi/generate';
import { loadSpec } from '../../src/core/openapi/load';
import { parseFolder, parseRequest } from '../../src/core/model';

const FIX = path.resolve(__dirname, '../fixtures');
const load = () => loadSpec('petstore.yaml', FIX);
const parsed = (text: string) => {
  const r = parseRequest(text);
  expect(r.errors).toEqual([]);
  return r.request!;
};

describe('generate', () => {
  it('generates one file per operation in tag folders', async () => {
    const g = generate(await load(), 'petstore');
    expect(g.requests.map((r) => r.relPath)).toEqual([
      'pets/list-pets.req.yaml', 'pets/create-pet.req.yaml', 'pets/get-pet.req.yaml',
      'store/place-order.req.yaml', 'health.req.yaml', 'get-pets-petid-photos.req.yaml',
    ]);
    expect(g.baseUrlVar).toBe('petstoreBaseUrl');
    expect(g.baseUrl).toBe('https://api.petstore.test/v1');
    const r = parsed(g.requests[0].text);
    expect(r.name).toBe('List pets');
    expect(r.source).toEqual({ spec: 'petstore', operationId: 'listPets' });
    expect(g.requests[2].text.startsWith('name: getPet\n')).toBe(true);
  });

  it('path params become variables and pathParams', async () => {
    const g = generate(await load(), 'petstore');
    const r = parsed(g.requests[2].text);
    expect(r.url).toBe('{{petstoreBaseUrl}}/pets/{{petId}}');
    expect(r.pathParams).toEqual({ petId: '7' });
    expect(parsed(g.requests[5].text).pathParams).toEqual({ petId: '' });
  });

  it('optional query disabled', async () => {
    const r = parsed(generate(await load(), 'petstore').requests[0].text);
    expect(r.query).toEqual([
      { name: 'limit', value: '20', enabled: false },
      { name: 'status', value: 'available' },
    ]);
    expect(r.headers).toEqual([{ name: 'X-Trace', value: 'abc', enabled: false }]);
  });

  it('body example from ref schema', async () => {
    const g = generate(await load(), 'petstore');
    expect(g.requests[1].text).toContain('json: |');
    const r = parsed(g.requests[1].text);
    expect(r.body.type === 'json' && JSON.parse(r.body.content)).toEqual({
      id: 1, name: 'Rex', status: 'available', born: '2024-01-01T00:00:00Z', tags: [{ id: 0, label: '' }],
    });
    expect(parsed(g.requests[3].text).body).toEqual({
      type: 'form', fields: [{ name: 'petId', value: '3' }, { name: 'note', value: '' }],
    });
  });

  it('folder auth from security scheme and secretVars', async () => {
    const g = generate(await load(), 'petstore');
    expect(parseFolder(g.folderText!).folder?.auth).toEqual({ type: 'bearer', token: '{{petstoreToken}}' });
    expect(parsed(g.requests[3].text).auth).toEqual({ type: 'apiKey', in: 'header', name: 'X-API-Key', value: '{{petstoreApiKey}}' });
    expect(parsed(g.requests[0].text).auth).toBeUndefined();
    expect(g.secretVars).toEqual(['petstoreToken', 'petstoreApiKey']);
    expect(generate(await load(), 'my-api').secretVars[0]).toBe('myApiToken');
  });

  it('oauth2 folder auth', () => {
    const doc = {
      openapi: '3.0.0', security: [{ o: ['read'] }],
      components: { securitySchemes: { o: { type: 'oauth2', flows: { clientCredentials: { tokenUrl: 'https://t', scopes: { read: '' } } } } } },
      paths: { '/a': { get: {} } },
    };
    const g = generate(doc, 'x');
    expect(parseFolder(g.folderText!).folder?.auth).toEqual({
      type: 'oauth2', grant: 'clientCredentials', tokenUrl: 'https://t', clientId: '{{xClientId}}', clientSecret: '{{xClientSecret}}', scope: 'read',
    });
    expect(g.secretVars).toEqual(['xClientId', 'xClientSecret']);
  });

  it('basic auth', () => {
    const doc = {
      openapi: '3.0.0', security: [{ b: [] }],
      components: { securitySchemes: { b: { type: 'http', scheme: 'basic' } } },
      paths: { '/a': { get: {} } },
    };
    const g = generate(doc, 'x');
    expect(parseFolder(g.folderText!).folder?.auth).toEqual({ type: 'basic', username: '{{xUsername}}', password: '{{xPassword}}' });
    expect(g.secretVars).toEqual(['xUsername', 'xPassword']);
  });

  it('multipart body', () => {
    const doc = {
      openapi: '3.0.0',
      paths: { '/up': { post: { operationId: 'up', requestBody: { content: { 'multipart/form-data': { schema: {
        type: 'object', properties: { title: { type: 'string', example: 'hi' }, file: { type: 'string', format: 'binary' } } } } } } } } },
    };
    expect(parsed(generate(doc, 's').requests[0].text).body).toEqual({
      type: 'multipart', parts: [{ name: 'title', value: 'hi' }, { name: 'file', value: '' }],
    });
  });

  it('security folder fallback, explicit empty, and none', () => {
    const schemes = { a: { type: 'apiKey', in: 'header', name: 'K' }, b: { type: 'http', scheme: 'bearer' } };
    const mk = (security: unknown, ops: any) => generate({ openapi: '3.0.0', security, components: { securitySchemes: schemes }, paths: { '/1': { get: { operationId: 'one', ...ops[0] } }, '/2': { get: { operationId: 'two', ...ops[1] } } } }, 's');
    // missing global: first op's security becomes folder auth
    let g = mk(undefined, [{ security: [{ b: [] }] }, {}]);
    expect(parseFolder(g.folderText!).folder?.auth).toEqual({ type: 'bearer', token: '{{sToken}}' });
    expect(parsed(g.requests[0].text).auth).toBeUndefined();
    expect(parsed(g.requests[1].text).auth).toEqual({ type: 'none' });
    // explicit empty global: no folder auth, no token leak
    g = mk([], [{ security: [{ b: [] }] }, {}]);
    expect(g.folderText).toBeUndefined();
    expect(parsed(g.requests[0].text).auth).toEqual({ type: 'bearer', token: '{{sToken}}' });
    expect(parsed(g.requests[1].text).auth).toBeUndefined();
    // global with op security: [] and a differing op
    g = mk([{ b: [] }], [{ security: [] }, { security: [{ a: [] }] }]);
    expect(parsed(g.requests[0].text).auth).toEqual({ type: 'none' });
    expect(parsed(g.requests[1].text).auth).toMatchObject({ type: 'apiKey' });
  });

  it('same scheme with different scopes gets its own auth', () => {
    const flows = { clientCredentials: { tokenUrl: 'https://t', scopes: { r: '', w: '' } } };
    const g = generate({
      openapi: '3.0.0', security: [{ o: ['r'] }],
      components: { securitySchemes: { o: { type: 'oauth2', flows } } },
      paths: { '/1': { get: { operationId: 'one' } }, '/2': { get: { operationId: 'two', security: [{ o: ['r', 'w'] }] } } },
    }, 's');
    expect(parsed(g.requests[0].text).auth).toBeUndefined();
    expect(parsed(g.requests[1].text).auth).toMatchObject({ type: 'oauth2', scope: 'r w' });
  });

  it('spec and operation names are sanitized', () => {
    const var0 = (n: string) => generate({ openapi: '3.0.0', paths: {} }, n).baseUrlVar;
    expect(var0('API')).toBe('apiBaseUrl');
    expect(var0('my-api')).toBe('myApiBaseUrl');
    expect(var0('Pet Store v2')).toBe('petStoreV2BaseUrl');
    expect(var0('2fa')).toBe('api2faBaseUrl');
    expect(var0('---')).toBe('apiBaseUrl');
    const g = generate({ openapi: '3.0.0', paths: { '/a': { get: { operationId: '!!!' } } } }, 's');
    expect(g.requests[0].relPath).toBe('get-0.req.yaml');
  });

  it('fallback operationId and untagged root', async () => {
    const g = generate(await load(), 'petstore');
    const r = g.requests[5];
    expect(r.operationId).toBe('get_pets_petid_photos');
    expect(r.relPath).toBe('get-pets-petid-photos.req.yaml');
    expect(g.requests[4].relPath).toBe('health.req.yaml');
  });

  it('dedupes file names', () => {
    const op = { operationId: 'same' };
    const g = generate({ openapi: '3.0.0', paths: { '/a': { get: op }, '/b': { get: op } } }, 's');
    expect(g.requests.map((r) => r.relPath)).toEqual(['same.req.yaml', 'same-2.req.yaml']);
  });

  it('generated text parses with parseRequest without errors', async () => {
    const g = generate(await load(), 'petstore');
    for (const r of g.requests) expect(parseRequest(r.text).errors).toEqual([]);
    expect(generate(await load(), 'petstore')).toEqual(g);
  });

  it('rejects swagger 2', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oas-'));
    fs.writeFileSync(path.join(dir, 's.yaml'), 'swagger: "2.0"\ninfo: {title: t, version: "1"}\npaths: {}\n');
    try {
      await expect(loadSpec('s.yaml', dir)).rejects.toThrow('Only OpenAPI 3.x is supported');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('exampleFromSchema', () => {
  it('covers types, allOf, oneOf, and recursion', () => {
    expect(exampleFromSchema({ type: 'string', format: 'email' })).toBe('user@example.com');
    expect(exampleFromSchema({ type: 'boolean' })).toBe(false);
    expect(exampleFromSchema({ allOf: [{ type: 'object', properties: { a: { type: 'integer' } } }, { type: 'object', properties: { b: { type: 'string' } } }] })).toEqual({ a: 0, b: '' });
    expect(exampleFromSchema({ oneOf: [{ type: 'integer' }, { type: 'string' }] })).toBe(0);
    const loop: any = { type: 'object', properties: {} };
    loop.properties.self = loop;
    expect(() => exampleFromSchema(loop)).not.toThrow();
  });
});
