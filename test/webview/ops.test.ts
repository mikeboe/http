import { describe, expect, it } from 'vitest';
import { parseRequest } from '../../src/core/model';
import type { RequestDef } from '../../src/core/model';
import { applyEdits } from '../../src/core/yamlEdit';
import type { EditOp } from '../../src/core/yamlEdit';
import {
  authFieldOp, authTypeOp, bodyTypeOp, enabledOp, mapEntryOp, partKindOp, rowDeleteOp, rowOp, settingOp,
} from '../../src/webview/ops';

const BASE = `name: Ops
method: POST
url: "{{baseUrl}}/users/{{id}}"
headers:
  - { name: A, value: "1" }
  - { name: B, value: "2", enabled: false }
body:
  json: '{"a": 1}'
`;

/** Applies ops like the host does and returns the re-parsed request. */
function apply(text: string, ...ops: EditOp[]): { text: string; request: RequestDef } {
  const next = applyEdits(text, ops);
  const { request, errors } = parseRequest(next);
  expect(errors).toEqual([]);
  return { text: next, request: request! };
}
const parse = (text: string) => parseRequest(text).request!;

describe('webview edit ops round-trip through applyEdits and parseRequest', () => {
  it('switches body types, carrying content', () => {
    let { text, request } = apply(BASE, bodyTypeOp('text', parse(BASE).body));
    expect(request.body).toEqual({ type: 'text', contentType: 'text/plain', content: '{"a": 1}' });
    ({ text, request } = apply(text, bodyTypeOp('json', request.body)));
    expect(request.body).toEqual({ type: 'json', content: '{"a": 1}' });
    ({ text, request } = apply(text, bodyTypeOp('form', request.body)));
    expect(request.body).toEqual({ type: 'form', fields: [] });
    ({ text, request } = apply(text, rowOp(['body', 'form'], 0, 0, 'name', 'f')));
    ({ text, request } = apply(text, bodyTypeOp('multipart', request.body)));
    expect(request.body).toEqual({ type: 'multipart', parts: [{ name: 'f', value: '' }] });
    ({ text, request } = apply(text, partKindOp(['body', 'multipart'], 0, { name: 'f', value: '' }, 'file')));
    expect(request.body).toEqual({ type: 'multipart', parts: [{ name: 'f', file: '' }] });
    ({ text, request } = apply(text, bodyTypeOp('file', request.body)));
    expect(request.body).toEqual({ type: 'file', path: '' });
    ({ request } = apply(text, bodyTypeOp('none', request.body)));
    expect(request.body).toEqual({ type: 'none' });
  });

  it('switches auth types and edits fields', () => {
    let { text, request } = apply(BASE, authTypeOp('bearer', undefined));
    expect(request.auth).toEqual({ type: 'bearer', token: '' });
    ({ text, request } = apply(text, authFieldOp('token', '{{tok}}')));
    expect(request.auth).toEqual({ type: 'bearer', token: '{{tok}}' });
    ({ text, request } = apply(text, authTypeOp('clientCredentials', request.auth)));
    expect(request.auth).toEqual({ type: 'oauth2', grant: 'clientCredentials', tokenUrl: '', clientId: '' });
    ({ text, request } = apply(text, authFieldOp('scope', 'read')));
    expect(request.auth).toMatchObject({ scope: 'read' });
    ({ text, request } = apply(text, authFieldOp('scope', '', true)));
    expect(request.auth).not.toHaveProperty('scope');
    ({ text, request } = apply(text, authTypeOp('authorizationCode', request.auth)));
    expect(request.auth).toEqual({ type: 'oauth2', grant: 'authorizationCode', authUrl: '', tokenUrl: '', clientId: '', pkce: true });
    ({ text, request } = apply(text, authTypeOp('apiKey', request.auth)));
    expect(request.auth).toEqual({ type: 'apiKey', in: 'header', name: 'X-API-Key', value: '' });
    ({ request } = apply(text, authTypeOp('inherit', request.auth)));
    expect(request.auth).toBeUndefined();
  });

  it('deletes rows, toggles enabled and inserts from the empty row', () => {
    let { text, request } = apply(BASE, enabledOp(['headers'], 1, true), enabledOp(['headers'], 0, false));
    expect(request.headers).toEqual([{ name: 'A', value: '1', enabled: false }, { name: 'B', value: '2' }]);
    ({ text, request } = apply(text, rowDeleteOp(['headers'], 0)));
    expect(request.headers).toEqual([{ name: 'B', value: '2' }]);
    // Two commits on the new row before the state comes back: insert, then set.
    const first = rowOp(['headers'], 1, 1, 'name', 'C');
    const second = rowOp(['headers'], 1, 1, 'value', '3', 1);
    expect([first.op, second.op]).toEqual(['insert', 'set']);
    ({ request } = apply(text, first, second));
    expect(request.headers).toEqual([{ name: 'B', value: '2' }, { name: 'C', value: '3' }]);
    // Query is absent on disk: insert creates the list.
    expect(apply(BASE, rowOp(['query'], 0, 0, 'name', 'q')).request.query).toEqual([{ name: 'q', value: '' }]);
  });

  it('sets path params when the map is absent, null or present', () => {
    // Absent: the whole map, then sub-keys for later quick edits (the "created" flag).
    let { text, request } = apply(BASE, mapEntryOp(['pathParams'], false, 'id', 'u1'), mapEntryOp(['pathParams'], true, 'other', 'x'));
    expect(request.pathParams).toEqual({ id: 'u1', other: 'x' });
    ({ request } = apply(text, mapEntryOp(['pathParams'], Object.keys(request.pathParams).length > 0, 'id', 'u2')));
    expect(request.pathParams).toEqual({ id: 'u2', other: 'x' });
    // Null on disk (`pathParams:` with no value) shows as empty in the model: the whole map is set.
    const nul = `${BASE}pathParams:\n`;
    expect(parse(nul).pathParams).toEqual({});
    expect(apply(nul, mapEntryOp(['pathParams'], false, 'id', 'u3')).request.pathParams).toEqual({ id: 'u3' });
  });

  it('sets settings on an absent map and removes an empty timeout', () => {
    let { text, request } = apply(BASE, settingOp(false, 'timeout', '5s'), settingOp(true, 'followRedirects', false));
    expect(request.settings).toEqual({ timeout: '5s', followRedirects: false });
    ({ text, request } = apply(text, settingOp(true, 'verifyTls', false)));
    expect(request.settings).toEqual({ timeout: '5s', followRedirects: false, verifyTls: false });
    ({ request } = apply(text, settingOp(true, 'timeout', '')));
    expect(request.settings).toEqual({ followRedirects: false, verifyTls: false });
    expect(apply(`${BASE}settings:\n`, settingOp(false, 'verifyTls', true)).request.settings).toEqual({ verifyTls: true });
  });
});
