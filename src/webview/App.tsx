import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { HostMessage, ResponseView } from '../core/protocol';
import { StateSeq, VarsContext } from './components/Field';
import { RequestTabs } from './components/RequestTabs';
import { type HistoryItem, ResponsePane } from './components/ResponsePane';
import { send, UrlBar } from './components/UrlBar';
import { getUiState, post, setUiState } from './vscode';

type State = Extract<HostMessage, { type: 'state' }>;

const NARROW = '(max-width: 599px)';
const clamp = (r: number) => Math.min(0.85, Math.max(0.15, r));

function useMedia(query: string): boolean {
  const [match, setMatch] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setMatch(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, [query]);
  return match;
}

export function App() {
  const ui = getUiState();
  const [state, setState] = useState<State>();
  const [seq, setSeq] = useState(0);
  const [sending, setSending] = useState(false);
  const [response, setResponse] = useState<ResponseView>();
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [ratio, setRatio] = useState(clamp(ui.ratio ?? 0.5));
  const [requestTab, setRequestTab] = useState(ui.requestTab ?? 'params');
  const [responseTab, setResponseTab] = useState(ui.responseTab ?? 'body');
  const [raw, setRaw] = useState(ui.raw ?? false);
  const stacked = useMedia(NARROW);
  const sendingRef = useRef(sending);
  sendingRef.current = sending;

  useEffect(() => {
    const onMessage = (e: MessageEvent<HostMessage>) => {
      const m = e.data;
      switch (m?.type) {
        case 'state': setState(m); setSeq((n) => n + 1); break;
        case 'sending': setSending(true); break;
        case 'response': setSending(false); setResponse(m.response); break;
        case 'history': setHistory(m.items); break;
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        send();
      } else if (e.key === 'Escape' && sendingRef.current) {
        e.preventDefault();
        post({ type: 'cancel' });
      }
    };
    window.addEventListener('message', onMessage);
    window.addEventListener('keydown', onKey);
    post({ type: 'ready' });
    return () => {
      window.removeEventListener('message', onMessage);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  const vars = useMemo(() => new Map((state?.variables ?? []).map((v) => [v.name, v])), [state?.variables]);

  const panes = useRef<HTMLDivElement>(null);
  const startDrag = (e: PointerEvent) => {
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    let last = ratio;
    const move = (ev: PointerEvent) => {
      const box = panes.current?.getBoundingClientRect();
      if (!box) return;
      last = clamp(stacked ? (ev.clientY - box.top) / box.height : (ev.clientX - box.left) / box.width);
      setRatio(last);
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      setUiState({ ratio: last });
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };
  const nudge = (e: KeyboardEvent) => {
    const step = { ArrowLeft: -0.05, ArrowUp: -0.05, ArrowRight: 0.05, ArrowDown: 0.05 }[e.key];
    if (step === undefined) return;
    e.preventDefault();
    const next = clamp(ratio + step);
    setRatio(next);
    setUiState({ ratio: next });
  };

  if (!state) return <div class="app"><div class="empty-state">Loading…</div></div>;

  const request = state.request;
  if (!request) {
    return (
      <div class="app">
        <div class="parse-error" role="alert">
          <h2>This request file can't be shown</h2>
          <ul>
            {state.errors.map((d, i) => (
              <li key={i}>{d.line !== undefined ? <span class="dim">{`Line ${d.line}${d.col !== undefined ? `:${d.col}` : ''}  `}</span> : null}{d.message}</li>
            ))}
          </ul>
          <p class="hint">Fix the YAML in the text editor; this view updates when the file is valid.</p>
          <button onClick={() => post({ type: 'openText' })}>Open as text</button>
        </div>
      </div>
    );
  }

  return (
    <StateSeq.Provider value={seq}>
      <VarsContext.Provider value={vars}>
        <div class="app">
          <UrlBar method={request.method} url={request.url} sending={sending} env={state.env} />
          {state.errors.length > 0 && (
            <div class="notice notice-warning banner">
              {state.errors.map((d, i) => <div key={i}>{d.line !== undefined ? `Line ${d.line}: ` : ''}{d.message}</div>)}
            </div>
          )}
          <div class={`panes${stacked ? ' stacked' : ''}`} ref={panes}>
            <section class="pane pane-request" style={{ flexBasis: `${ratio * 100}%` }} aria-label="Request">
              <RequestTabs state={state} request={request} tab={requestTab} onTab={(t) => { setRequestTab(t); setUiState({ requestTab: t }); }} />
            </section>
            <div
              class="divider"
              role="separator"
              tabIndex={0}
              aria-orientation={stacked ? 'horizontal' : 'vertical'}
              aria-valuenow={Math.round(ratio * 100)}
              onPointerDown={startDrag}
              onKeyDown={nudge}
            />
            <section class="pane pane-response" aria-label="Response">
              <ResponsePane
                response={response}
                sending={sending}
                history={history}
                tab={responseTab}
                onTab={(t) => { setResponseTab(t); setUiState({ responseTab: t }); }}
                raw={raw}
                onRaw={(r) => { setRaw(r); setUiState({ raw: r }); }}
              />
            </section>
          </div>
        </div>
      </VarsContext.Provider>
    </StateSeq.Provider>
  );
}
