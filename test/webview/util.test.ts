import { describe, expect, it } from 'vitest';
import { HTTP_METHODS as CORE_METHODS } from '../../src/core/model';
import { formatBytes, HTTP_METHODS, pathParamNames, statusClass, templateParts, variableNames } from '../../src/webview/util';

describe('webview util', () => {
  it('keeps the method list in sync with the model', () => {
    expect(HTTP_METHODS).toEqual(CORE_METHODS);
  });

  it('splits templates keeping source text', () => {
    expect(templateParts('a{{ x }}b\\{{y}}{{response("r","$.id")}}')).toEqual([
      { kind: 'text', text: 'a' },
      { kind: 'var', text: '{{ x }}', name: 'x' },
      { kind: 'text', text: 'b\\{{y}}' },
      { kind: 'expr', text: '{{response("r","$.id")}}' },
    ]);
    expect(templateParts('open {{x')).toEqual([{ kind: 'text', text: 'open {{x' }]);
    expect(variableNames('{{a}}/{{b}}/{{a}}')).toEqual(['a', 'b']);
  });

  it('finds path params in the url path only', () => {
    expect(pathParamNames('{{baseUrl}}/users/{{id}}/posts/{{postId}}?q={{q}}')).toEqual(['id', 'postId']);
    expect(pathParamNames('https://{{host}}/a/{{id}}#{{frag}}')).toEqual(['id']);
    expect(pathParamNames('/a/{{id}}')).toEqual(['id']);
    expect(pathParamNames('{{baseUrl}}')).toEqual([]);
  });

  it('formats sizes and status classes', () => {
    expect(formatBytes(318)).toBe('318 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(statusClass(true, 201)).toBe('ok');
    expect(statusClass(true, 404)).toBe('warn');
    expect(statusClass(true, 302)).toBe('warn');
    expect(statusClass(true, 503)).toBe('error');
    expect(statusClass(false)).toBe('error');
  });
});
