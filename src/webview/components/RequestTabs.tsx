import type { HostMessage } from '../../core/protocol';
import { useMapExists } from '../hooks';
import { mapEntryOp } from '../ops';
import { folderLabel, pathParamNames } from '../util';
import { edit } from '../vscode';
import { AuthEditor } from './AuthEditor';
import { BodyEditor } from './BodyEditor';
import { TextField } from './Field';
import { KeyValueTable } from './KeyValueTable';
import { SettingsEditor } from './SettingsEditor';
import { Tabs } from './Tabs';

type State = Extract<HostMessage, { type: 'state' }>;
type Request = NonNullable<State['request']>;

const BODY_LABEL: Record<Request['body']['type'], string> = {
  none: '', json: 'JSON', text: 'Text', form: 'Form', multipart: 'Multipart', file: 'File',
};

export function RequestTabs({ state, request, tab, onTab }: { state: State; request: Request; tab: string; onTab(t: string): void }) {
  const names = pathParamNames(request.url);
  for (const k of Object.keys(request.pathParams)) if (!names.includes(k)) names.push(k);
  const tabs = [
    { id: 'params', label: 'Params', count: request.query.length + names.length },
    { id: 'headers', label: 'Headers', count: request.headers.length },
    { id: 'auth', label: 'Auth' },
    { id: 'body', label: 'Body', note: BODY_LABEL[request.body.type] },
    { id: 'settings', label: 'Settings' },
  ];
  const active = tabs.some((t) => t.id === tab) ? tab : 'params';
  return (
    <>
      <Tabs class="request-tabs" tabs={tabs} active={active} onChange={onTab} />
      <div class="tab-body">
        {active === 'params' && <Params request={request} names={names} present={state.present.pathParams} />}
        {active === 'headers' && (
          <KeyValueTable
            path={['headers']}
            rows={request.headers}
            readOnly={state.inherited.headers.filter((h) => h.enabled !== false).map((h) => ({
              name: h.name, value: h.value,
              tag: `from ${h.from === undefined ? 'folder' : h.from === '.' ? 'root' : h.from}`,
              title: `Inherited from ${h.from === undefined ? 'a folder' : folderLabel(h.from)}; add a header with the same name to override it`,
            }))}
            namePlaceholder="Header"
          />
        )}
        {active === 'auth' && <AuthEditor auth={request.auth} inherited={state.inherited.auth} authFrom={state.inherited.authFrom} />}
        {active === 'body' && <BodyEditor body={request.body} />}
        {active === 'settings' && <SettingsEditor settings={request.settings} inherited={state.inherited.settings} present={state.present.settings} />}
      </div>
    </>
  );
}

function Params({ request, names, present }: { request: Request; names: string[]; present: boolean }) {
  const inUrl = pathParamNames(request.url);
  const mapExists = useMapExists(present);
  const setParam = (name: string, v: string) => edit(mapEntryOp(['pathParams'], mapExists(), name, v));
  return (
    <>
      <h3 class="section-title">Query</h3>
      <KeyValueTable path={['query']} rows={request.query} namePlaceholder="Parameter" />
      {names.length > 0 && (
        <>
          <h3 class="section-title">Path</h3>
          <div class="kv" role="table">
            {names.map((n) => {
              const unused = !inUrl.includes(n);
              return (
                <div class="kv-row" role="row" key={n}>
                  <span />
                  <div class={`kv-cell kv-name${unused ? ' dim' : ''}`} title={unused ? 'Not used in the URL' : undefined}>{n}</div>
                  <TextField class="kv-value" value={request.pathParams[n] ?? ''} placeholder="Value" onCommit={(v) => setParam(n, v)} />
                  {Object.hasOwn(request.pathParams, n)
                    ? <button class="icon-button kv-delete" title="Delete" aria-label="Delete" onClick={() => edit({ op: 'delete', path: ['pathParams', n] })}>×</button>
                    : <span class="kv-tag" />}
                </div>
              );
            })}
          </div>
        </>
      )}
    </>
  );
}
