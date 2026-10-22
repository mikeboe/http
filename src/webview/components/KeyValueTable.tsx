import { useEffect, useRef } from 'preact/hooks';
import type { YamlPath } from '../../core/yamlEdit';
import { edit } from '../vscode';
import { TextField } from './Field';

export interface Row { name: string; value?: string; file?: string; enabled?: boolean }

interface Props {
  rows: Row[];
  /** On-disk path of the list, e.g. `['headers']` or `['body', 'multipart']`. */
  path: YamlPath;
  /** Rows shown read-only and dimmed above the editable ones (e.g. inherited headers). */
  readOnly?: { name: string; value: string; tag: string }[];
  /** Multipart: each row is a text value or a file path. */
  parts?: boolean;
  namePlaceholder?: string;
}

/**
 * Editable name/value list: enabled checkbox, name, value, delete. The empty last row creates
 * an entry when typed into.
 */
export function KeyValueTable({ rows, path, readOnly = [], parts = false, namePlaceholder = 'Name' }: Props) {
  // Index of a row inserted from the empty row whose state has not come back yet.
  const inserted = useRef<number | undefined>(undefined);
  useEffect(() => { inserted.current = undefined; }, [rows.length]);

  const valueKey = (r: Row): 'value' | 'file' => (parts && r.file !== undefined ? 'file' : 'value');

  function commit(i: number, key: 'name' | 'value' | 'file', v: string) {
    if (i < rows.length || inserted.current === i) {
      edit({ op: 'set', path: [...path, i, key], value: v });
      return;
    }
    const row: Row = key === 'name' ? { name: v, value: '' } : { name: '', [key]: v };
    inserted.current = i;
    edit({ op: 'insert', path, index: i, value: row });
  }

  const all: (Row & { isNew?: boolean })[] = [...rows, { name: '', value: '', isNew: true }];
  return (
    <div class={`kv${parts ? ' kv-parts' : ''}`} role="table">
      {readOnly.map((r, i) => (
        <div class="kv-row kv-readonly" role="row" key={`ro${i}`} title={`Inherited ${r.tag}`}>
          <input type="checkbox" class="kv-enabled" checked disabled aria-label="Inherited" />
          <div class="kv-cell kv-name">{r.name}</div>
          {parts && <div />}
          <div class="kv-cell kv-value">{r.value}</div>
          <span class="kv-tag">{r.tag}</span>
        </div>
      ))}
      {all.map((r, i) => {
        const vk = valueKey(r);
        const enabled = r.enabled !== false;
        return (
          <div class={`kv-row${r.isNew ? ' kv-new' : ''}${enabled ? '' : ' kv-disabled'}`} role="row" key={i}>
            <input
              type="checkbox"
              class="kv-enabled"
              checked={enabled}
              disabled={r.isNew}
              aria-label="Enabled"
              onChange={(e) => edit(e.currentTarget.checked
                ? { op: 'delete', path: [...path, i, 'enabled'] }
                : { op: 'set', path: [...path, i, 'enabled'], value: false })}
            />
            <TextField class="kv-name" value={r.name} placeholder={namePlaceholder} onCommit={(v) => commit(i, 'name', v)} />
            {parts && (
              <select
                class="kv-kind"
                aria-label="Part type"
                value={vk}
                disabled={r.isNew}
                onChange={(e) => {
                  const next: Row = { name: r.name };
                  if (e.currentTarget.value === 'file') next.file = ''; else next.value = '';
                  if (r.enabled === false) next.enabled = false;
                  edit({ op: 'set', path: [...path, i], value: next });
                }}
              >
                <option value="value">Text</option>
                <option value="file">File</option>
              </select>
            )}
            <TextField
              class="kv-value"
              value={r[vk] ?? ''}
              placeholder={vk === 'file' ? './path/to/file' : 'Value'}
              onCommit={(v) => commit(i, vk, v)}
            />
            {r.isNew
              ? <span class="kv-tag" />
              : <button class="icon-button kv-delete" title="Delete" aria-label="Delete" onClick={() => edit({ op: 'delete', path: [...path, i] })}>×</button>}
          </div>
        );
      })}
    </div>
  );
}
