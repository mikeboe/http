import { useEffect, useRef, useState } from 'preact/hooks';
import type { Body } from '../../core/model';
import { edit } from '../vscode';
import { TextArea, TextField } from './Field';
import { KeyValueTable } from './KeyValueTable';

type Kind = Body['type'];

const KINDS: [Kind, string][] = [
  ['none', 'No body'], ['json', 'JSON'], ['text', 'Text'], ['form', 'Form (URL-encoded)'], ['multipart', 'Multipart form'], ['file', 'File'],
];

/** The on-disk value of `body` for a type, carrying text content across json/text. */
function onDisk(k: Kind, old: Body): unknown {
  const content = old.type === 'json' || old.type === 'text' ? old.content : '';
  switch (k) {
    case 'none': return { none: true };
    case 'json': return { json: content };
    case 'text': return { text: { contentType: 'text/plain', content } };
    case 'form': return { form: old.type === 'multipart' ? old.parts.filter((p) => p.file === undefined).map((p) => ({ ...p, value: p.value ?? '' })) : [] };
    case 'multipart': return { multipart: old.type === 'form' ? old.fields : [] };
    case 'file': return { file: '' };
  }
}

export function BodyEditor({ body }: { body: Body }) {
  const [formatError, setFormatError] = useState<string>();
  // The text being edited, which may be ahead of `body` until the host echoes the edit.
  const content = body.type === 'json' || body.type === 'text' ? body.content : '';
  const latest = useRef(content);
  useEffect(() => { latest.current = content; }, [content]);
  const format = (content: string) => {
    try {
      const pretty = JSON.stringify(JSON.parse(content), null, 2);
      setFormatError(undefined);
      if (pretty !== content) edit({ op: 'set', path: ['body', 'json'], value: pretty });
    } catch (e) {
      setFormatError(`Can't format: ${(e as Error).message}`);
    }
  };
  return (
    <div class="body-editor">
      <div class="toolbar">
        <select
          aria-label="Body type"
          value={body.type}
          onChange={(e) => { setFormatError(undefined); edit({ op: 'set', path: ['body'], value: onDisk(e.currentTarget.value as Kind, body) }); }}
        >
          {KINDS.map(([id, text]) => <option key={id} value={id}>{text}</option>)}
        </select>
        {body.type === 'text' && (
          <TextField class="content-type" value={body.contentType} placeholder="Content type" ariaLabel="Content type" template={false}
            onCommit={(v) => edit({ op: 'set', path: ['body', 'text', 'contentType'], value: v })} />
        )}
        <span class="spacer" />
        {body.type === 'json' && <button class="secondary" onClick={() => format(latest.current)}>Format</button>}
      </div>
      {formatError && body.type === 'json' && <div class="notice notice-error">{formatError}</div>}
      {body.type === 'none' && <p class="hint">This request has no body.</p>}
      {body.type === 'json' && (
        <TextArea value={body.content} ariaLabel="JSON body" placeholder="{}" onDraft={(v) => { latest.current = v; }} onCommit={(v) => { setFormatError(undefined); edit({ op: 'set', path: ['body', 'json'], value: v }); }} />
      )}
      {body.type === 'text' && (
        <TextArea value={body.content} ariaLabel="Text body" onCommit={(v) => edit({ op: 'set', path: ['body', 'text', 'content'], value: v })} />
      )}
      {body.type === 'form' && <KeyValueTable path={['body', 'form']} rows={body.fields} namePlaceholder="Field" />}
      {body.type === 'multipart' && <KeyValueTable path={['body', 'multipart']} rows={body.parts} parts namePlaceholder="Field" />}
      {body.type === 'file' && (
        <label class="form-row">
          <span class="form-label">File path, relative to this request</span>
          <TextField value={body.path} placeholder="./payload.json" ariaLabel="File path" onCommit={(v) => edit({ op: 'set', path: ['body', 'file'], value: v })} />
        </label>
      )}
    </div>
  );
}
