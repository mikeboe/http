import { describe, expect, it } from 'vitest';
import { parseDuration, parseRequest } from '../../src/core/model';

const FULL = `name: Create user
method: POST
url: "{{baseUrl}}/users/{{id}}/roles"
pathParams:
  id: u_8f2k1
query:
  - { name: notify, value: "true" }
  - { name: debug, value: "1", enabled: false }
headers:
  - { name: Content-Type, value: application/json }
auth:
  type: bearer
  token: "{{apiToken}}"
body:
  json: |
    {
      "name": "Ada Lovelace",
      "email": "ada@example.com"
    }
settings:
  timeout: 10s
  followRedirects: true
  verifyTls: true
source:
  spec: petstore
  operationId: createUser
`;

describe('parseRequest', () => {
  it('parses full request', () => {
    const r = parseRequest(FULL);
    expect(r.errors).toEqual([]);
    expect(r.request).toEqual({
      name: 'Create user',
      method: 'POST',
      url: '{{baseUrl}}/users/{{id}}/roles',
      pathParams: { id: 'u_8f2k1' },
      query: [
        { name: 'notify', value: 'true' },
        { name: 'debug', value: '1', enabled: false },
      ],
      headers: [{ name: 'Content-Type', value: 'application/json' }],
      auth: { type: 'bearer', token: '{{apiToken}}' },
      body: { type: 'json', content: '{\n  "name": "Ada Lovelace",\n  "email": "ada@example.com"\n}\n' },
      settings: { timeout: '10s', followRedirects: true, verifyTls: true },
      source: { spec: 'petstore', operationId: 'createUser' },
    });
  });

  it('json mapping body is stringified', () => {
    const r = parseRequest('url: x\nbody:\n  json: {a: 1}\n');
    expect(r.errors).toEqual([]);
    expect(r.request?.body).toEqual({ type: 'json', content: '{\n  "a": 1\n}' });
  });

  it('defaults', () => {
    const r = parseRequest('url: x');
    expect(r.request).toMatchObject({
      method: 'GET', query: [], headers: [], pathParams: {}, body: { type: 'none' }, settings: {},
    });
  });

  it('missing url is error', () => {
    const r = parseRequest('method: GET');
    expect(r.request).toBeUndefined();
    expect(r.errors[0].message).toMatch(/url/);
  });

  it('invalid yaml reports line', () => {
    const r = parseRequest('url: [unclosed\nmethod: GET');
    expect(r.request).toBeUndefined();
    expect(typeof r.errors[0].line).toBe('number');
  });

  it('unknown method is error', () => {
    const r = parseRequest('url: x\nmethod: FETCH');
    expect(r.request).toBeUndefined();
    expect(r.errors[0].message).toMatch(/FETCH/);
  });

  it('unknown key warns', () => {
    const r = parseRequest('url: x\nfoo: 1');
    expect(r.request?.url).toBe('x');
    expect(r.errors.map((e) => e.message)).toEqual(['unknown key "foo"']);
  });
});

describe('parseDuration', () => {
  it('parses units', () => {
    expect(parseDuration('500ms')).toBe(500);
    expect(parseDuration('10s')).toBe(10000);
    expect(parseDuration('30m')).toBe(1800000);
    expect(parseDuration('2h')).toBe(7200000);
  });
  it('throws on invalid', () => {
    expect(() => parseDuration('x')).toThrow();
  });
});
