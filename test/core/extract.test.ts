import { describe, expect, it } from 'vitest';
import { extractValue } from '../../src/core/extract';
import type { HttpResponse } from '../../src/core/http';

const r = (o: Partial<HttpResponse> = {}): HttpResponse => ({
  status: 201, statusText: 'Created', headers: [['X-Token', 'abc']], url: 'http://x', bodyBase64: '', sizeBytes: 0, timeMs: 1,
  bodyText: '{"a":{"b":[{"c":5},{"c":{"d":1}}]},"s":"hi"}', ...o,
});

describe('extractValue', () => {
  it('status', () => expect(extractValue(r(), 'status')).toBe('201'));
  it('header case-insensitive', () => expect(extractValue(r(), 'headers.x-TOKEN')).toBe('abc'));
  it('nested body path with index', () => {
    expect(extractValue(r(), 'body.a.b[0].c')).toBe('5');
    expect(extractValue(r(), 'body.a.b[1].c')).toBe('{"d":1}');
    expect(extractValue(r(), 'body.s')).toBe('hi');
    expect(extractValue(r(), 'body')).toContain('"a"');
  });
  it('missing path undefined', () => {
    expect(extractValue(r(), 'body.a.z')).toBeUndefined();
    expect(extractValue(r(), 'body.a.b[9].c')).toBeUndefined();
    expect(extractValue(r(), 'headers.nope')).toBeUndefined();
  });
  it('non-json body with body.x undefined', () => {
    expect(extractValue(r({ bodyText: 'plain' }), 'body.x')).toBeUndefined();
    expect(extractValue(r({ bodyText: undefined }), 'body.x')).toBeUndefined();
  });
});
