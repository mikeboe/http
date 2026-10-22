import { describe, it, expect } from 'vitest';
import {
  parseTemplate, referencedVariables, renderTemplate, TemplateError, MissingVariableError, type TemplateContext,
} from '../../src/core/template';

const vars: Record<string, { value: string; secret: boolean }> = {
  host: { value: 'example.com', secret: false },
  token: { value: 's3cret', secret: true },
  x: { value: '{{x}}', secret: false },
};
const ctx: TemplateContext = {
  lookup: (n) => vars[n],
  response: async (request, path, maxAge) => ({ value: `${request}:${path}:${maxAge ?? ''}`, secret: true }),
};

describe('template', () => {
  it('renders vars', async () => {
    const r = await renderTemplate('https://{{ host }}/a/{{host}}', ctx);
    expect(r).toEqual({ value: 'https://example.com/a/example.com', secrets: [] });
    expect(referencedVariables('{{host}} {{ token }} {{host}} {{response("a","b")}}')).toEqual(['host', 'token']);
  });

  it('renders response call with maxAge', async () => {
    expect(parseTemplate(`{{response('login', "$.token", '5m')}}`)).toEqual([
      { kind: 'response', request: 'login', path: '$.token', maxAge: '5m' },
    ]);
    const r = await renderTemplate(`{{response("login","$.id")}}`, ctx);
    expect(r.value).toBe('login:$.id:');
    const r2 = await renderTemplate(`{{ response('login', '$.id', '5m') }}`, ctx);
    expect(r2.value).toBe('login:$.id:5m');
  });

  it('escape', async () => {
    expect((await renderTemplate('a \\{{host}} b', ctx)).value).toBe('a {{host}} b');
  });

  it('missing variable throws MissingVariableError with name', async () => {
    await expect(renderTemplate('{{nope}}', ctx)).rejects.toMatchObject({ variable: 'nope' });
    await expect(renderTemplate('{{nope}}', ctx)).rejects.toBeInstanceOf(MissingVariableError);
  });

  it('does not expand recursively', async () => {
    expect((await renderTemplate('{{x}}', ctx)).value).toBe('{{x}}');
  });

  it('collects secrets', async () => {
    const r = await renderTemplate('Bearer {{token}} {{response("a","b")}} {{host}}', ctx);
    expect(r.secrets).toEqual(['s3cret', 'a:b:']);
  });

  it('unterminated braces throws TemplateError', () => {
    expect(() => parseTemplate('a {{host')).toThrow(TemplateError);
    expect(() => parseTemplate('{{ bad name }}')).toThrow(TemplateError);
  });
});
