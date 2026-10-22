import * as path from 'node:path';
import SwaggerParser from '@apidevtools/swagger-parser';

export type OpenApiDoc = any; // dereferenced

/** Loads and dereferences an OpenAPI 3.x spec from a file path (relative to baseDir) or an http(s) URL. */
export async function loadSpec(source: string, baseDir: string): Promise<OpenApiDoc> {
  const target = /^https?:\/\//i.test(source) ? source : path.resolve(baseDir, source);
  const doc: any = await SwaggerParser.dereference(target);
  if (typeof doc?.openapi !== 'string' || !doc.openapi.startsWith('3.')) {
    throw new Error('Only OpenAPI 3.x is supported');
  }
  return doc;
}
