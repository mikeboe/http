import type { ResponseView } from '../../core/protocol';
import { formatBytes, formatTime, statusClass } from '../util';
import { post } from '../vscode';
import { JsonView } from './JsonView';
import { Tabs } from './Tabs';

export interface HistoryItem { entryId: string; timestamp: number; status?: number; ok: boolean }

/** Bodies above this size are shown raw only: pretty-printing them would stall the webview. */
const PRETTY_LIMIT = 2_000_000;

interface Props {
  response?: ResponseView; sending: boolean; history: HistoryItem[];
  tab: string; onTab(t: string): void; raw: boolean; onRaw(raw: boolean): void;
}

const time = (ts: number) => new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });

export function ResponsePane({ response, sending, history, tab, onTab, raw, onRaw }: Props) {
  const r = response;
  const tabs = [
    { id: 'body', label: 'Body' },
    { id: 'headers', label: 'Headers', count: r?.headers?.length },
    { id: 'timeline', label: 'Timeline', count: r?.timeline.length },
  ];
  const active = tabs.some((t) => t.id === tab) ? tab : 'body';
  const cls = r ? statusClass(r.ok, r.status) : undefined;
  return (
    <>
      <div class="response-meta">
        {r && (
          <>
            <span class={`status-badge status-${cls}`}>
              {r.ok ? `${r.status ?? ''} ${r.statusText ?? ''}`.trim() : 'Error'}
            </span>
            {r.timeMs !== undefined && <span class="meta-item">{formatTime(r.timeMs)}</span>}
            {r.sizeBytes !== undefined && <span class="meta-item">{formatBytes(r.sizeBytes)}</span>}
          </>
        )}
        {sending && <span class="meta-item sending">Sending…</span>}
        <span class="spacer" />
        {r?.ok && r.entryId && <button class="secondary small" title="Copy the response body" onClick={() => post({ type: 'copyResponse' })}>Copy</button>}
        {history.length > 0 && (
          <select
            class="history-select"
            aria-label="History"
            title="Previous responses"
            value={r?.entryId ?? ''}
            onChange={(e) => post({ type: 'showHistory', entryId: e.currentTarget.value })}
          >
            {!history.some((h) => h.entryId === r?.entryId) && <option value="">History</option>}
            {history.slice(0, 20).map((h) => (
              <option key={h.entryId} value={h.entryId}>{`${time(h.timestamp)} · ${h.ok ? h.status ?? '' : 'error'}`}</option>
            ))}
          </select>
        )}
      </div>
      {!r
        ? <div class="empty-state">{sending ? 'Sending request…' : 'Send the request to see the response (Ctrl+Enter).'}</div>
        : (
          <>
            {!r.ok && <div class="response-error" role="alert"><strong>Request failed</strong><div>{r.error ?? 'Unknown error'}</div></div>}
            <Tabs class="response-tabs" tabs={tabs} active={active} onChange={onTab} />
            <div class="tab-body">
              {active === 'body' && <ResponseBody r={r} raw={raw} onRaw={onRaw} />}
              {active === 'headers' && <HeaderList headers={r.headers ?? []} />}
              {active === 'timeline' && <Timeline r={r} />}
            </div>
          </>
        )}
    </>
  );
}

function parseJson(r: ResponseView): { value: unknown } | undefined {
  const text = r.bodyText;
  if (text === undefined || text.length > PRETTY_LIMIT || r.truncated) return undefined;
  const looksJson = /\bjson\b|\+json/.test(r.contentType ?? '') || /^\s*[[{]/.test(text);
  if (!looksJson) return undefined;
  try { return { value: JSON.parse(text) }; } catch { return undefined; }
}

function ResponseBody({ r, raw, onRaw }: { r: ResponseView; raw: boolean; onRaw(raw: boolean): void }) {
  const json = parseJson(r);
  const image = r.bodyBase64 !== undefined && r.contentType?.startsWith('image/');
  return (
    <div class="response-body">
      {r.truncated && <div class="notice notice-warning">Truncated: the body was larger than the limit and only the start is shown.</div>}
      {json && (
        <div class="toolbar">
          <span class="spacer" />
          <label class="form-check"><input type="checkbox" checked={raw} onChange={(e) => onRaw(e.currentTarget.checked)} /> Raw</label>
        </div>
      )}
      {image && <div class="response-image"><img alt="Response image" src={`data:${r.contentType};base64,${r.bodyBase64}`} /></div>}
      {!image && r.bodyText === undefined && <p class="hint">{r.ok ? 'No body.' : 'No response.'}</p>}
      {!image && r.bodyText !== undefined && (json && !raw ? <JsonView value={json.value} /> : <pre class="code">{r.bodyText}</pre>)}
    </div>
  );
}

function HeaderList({ headers }: { headers: [string, string][] }) {
  if (!headers.length) return <p class="hint">No headers.</p>;
  return (
    <div class="header-list">
      {headers.map(([k, v], i) => (
        <div class="header-row" key={i}><span class="header-name">{k}</span><span class="header-value">{v}</span></div>
      ))}
    </div>
  );
}

function Timeline({ r }: { r: ResponseView }) {
  if (!r.timeline.length) return <p class="hint">Nothing recorded.</p>;
  return (
    <ol class="timeline">
      {r.timeline.map((t, i) => (
        <li key={i} class={`timeline-entry timeline-${t.kind}`}>
          <div class="timeline-head"><span class="timeline-kind">{t.kind}</span><span class="timeline-text">{t.text}</span></div>
          {t.headers && t.headers.length > 0 && <HeaderList headers={t.headers} />}
        </li>
      ))}
    </ol>
  );
}
