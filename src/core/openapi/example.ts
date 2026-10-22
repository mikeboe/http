const MAX_DEPTH = 8;

function stringExample(format: unknown): string {
  switch (format) {
    case 'date-time': return '2024-01-01T00:00:00Z';
    case 'email': return 'user@example.com';
    case 'uuid': return '00000000-0000-0000-0000-000000000000';
    default: return '';
  }
}

function build(schema: any, depth: number): unknown {
  if (!schema || typeof schema !== 'object' || depth > MAX_DEPTH) return null;
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  if (Array.isArray(schema.allOf)) {
    const merged: Record<string, unknown> = {};
    for (const part of [{ ...schema, allOf: undefined }, ...schema.allOf]) {
      const v = build(part, depth + 1);
      if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(merged, v);
    }
    return merged;
  }
  const alt = schema.oneOf ?? schema.anyOf;
  if (Array.isArray(alt) && alt.length) return build(alt[0], depth + 1);
  const type = Array.isArray(schema.type) ? schema.type.find((t: string) => t !== 'null') : schema.type
    ?? (schema.properties ? 'object' : schema.items ? 'array' : undefined);
  switch (type) {
    case 'string': return stringExample(schema.format);
    case 'integer': case 'number': return 0;
    case 'boolean': return false;
    case 'array': return [build(schema.items, depth + 1)];
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(schema.properties ?? {})) out[k] = build(v, depth + 1);
      return out;
    }
    default: return null;
  }
}

/** Builds an example value for a (dereferenced) JSON schema. */
export function exampleFromSchema(schema: any): unknown {
  return build(schema, 0);
}
