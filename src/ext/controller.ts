// vscode-free: the request editor's logic, driven by webview messages.
import * as path from 'node:path';
import type { Environment } from '../core/env';
import { variableSource } from '../core/env';
import type { HistoryEntry, HistoryStore } from '../core/history';
import { parseRequest } from '../core/model';
import type { Diagnostic, FolderDef, RequestDef, Settings } from '../core/model';
import { parse } from 'yaml';
import type { HostMessage, Inherited, Present, ResponseView, RowExpectation, VariableInfo, WebviewMessage } from '../core/protocol';
import { referencedVariables } from '../core/template';
import { effectiveRequest, listTree, loadFolderChain, requestIdFromPath } from '../core/workspace';
import type { TreeNode } from '../core/workspace';
import { applyEdits } from '../core/yamlEdit';

export interface DocumentPort { getText(): string; applyText(newText: string): Promise<boolean>; file: string }
export interface ControllerDeps {
  root: string; post(m: HostMessage): void; run(id: string, signal: AbortSignal): Promise<HistoryEntry>;
  getEnv(): Promise<{ name?: string; names: string[]; env: Environment }>; history: HistoryStore; openText(): void; selectEnv(name: string): void;
  /** Copies text to the clipboard (used by `copyResponse`). */
  copy?(text: string): void;
  /** The file is outside the configured root: `root` is its own folder, with no folder settings or environments. */
  standalone?: boolean;
}

export const STANDALONE_NOTICE = 'File is outside the yamlHttp root; folder settings and environments are unavailable.';

/** The root a request editor works in: the configured root if the file is under it, else the file's own folder. */
export function editorRoot(file: string, configuredRoot?: string): { root: string; standalone: boolean } {
  if (configuredRoot) {
    const rel = path.relative(configuredRoot, file);
    if (rel && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel)) return { root: configuredRoot, standalone: false };
  }
  return { root: path.dirname(file), standalone: true };
}

export function toResponseView(e: HistoryEntry): ResponseView {
  const v: ResponseView = { entryId: e.id, timestamp: e.timestamp, ok: e.ok, timeline: e.timeline };
  if (e.error !== undefined) v.error = e.error;
  const r = e.response;
  if (r) {
    Object.assign(v, {
      status: r.status, statusText: r.statusText, timeMs: r.timeMs, sizeBytes: r.sizeBytes, headers: r.headers,
    });
    if (r.contentType !== undefined) v.contentType = r.contentType;
    if (r.bodyText !== undefined) v.bodyText = r.bodyText;
    else if (r.contentType?.startsWith('image/')) v.bodyBase64 = r.bodyBase64;
    if (r.truncated) v.truncated = true;
  }
  return v;
}

/** Every user-editable string in a request that may contain `{{variables}}`. */
export function requestStrings(r: RequestDef): string[] {
  const out = [r.url];
  for (const kv of [...r.query, ...r.headers]) out.push(kv.name, kv.value);
  out.push(...Object.values(r.pathParams));
  if (r.auth) for (const [k, v] of Object.entries(r.auth)) if (k !== 'type' && typeof v === 'string') out.push(v);
  const b = r.body;
  switch (b.type) {
    case 'json': out.push(b.content); break;
    case 'text': out.push(b.contentType, b.content); break;
    case 'form': for (const f of b.fields) out.push(f.name, f.value); break;
    case 'multipart': for (const p of b.parts) out.push(p.name, p.value ?? '', p.file ?? ''); break;
    case 'file': out.push(b.path); break;
  }
  return out;
}

export function collectVariables(root: string, r: RequestDef, env: Environment): VariableInfo[] {
  const names: string[] = [];
  for (const s of requestStrings(r)) {
    let refs: string[];
    try { refs = referencedVariables(s); } catch { continue; } // malformed template: nothing to show
    for (const n of refs) if (!names.includes(n)) names.push(n);
  }
  return names.map((name): VariableInfo => {
    if (Object.hasOwn(r.pathParams, name)) return { name, kind: 'pathParam', value: r.pathParams[name] };
    const src = variableSource(root, env, name);
    if (src?.kind === 'secret') return { name, kind: 'secret', file: src.file };
    if (src) return { name, kind: 'variable', file: src.file, value: env.variables[name] };
    return { name, kind: 'missing' };
  });
}

/** The folder chain's contribution, with the folder each header and setting comes from. */
function inheritedFrom(
  root: string, chain: { dir: string; folder: FolderDef }[],
  eff: { auth: Inherited['auth']; authFrom?: string; inheritedHeaders: RequestDef['headers'] },
): Inherited {
  const folderName = (dir: string) => path.relative(root, dir).split(path.sep).join('/') || '.';
  // effectiveRequest returns the folders' own header objects, so each one can be traced to its folder.
  const headers = eff.inheritedHeaders.map((h) => {
    const owner = chain.find((c) => c.folder.headers.includes(h));
    return owner ? { ...h, from: folderName(owner.dir) } : { ...h };
  });
  const settings: Settings = {};
  const from: Record<string, string> = {};
  for (const { dir, folder } of chain) {
    for (const [k, v] of Object.entries(folder.settings)) {
      if (v === undefined) continue;
      (settings as Record<string, unknown>)[k] = v;
      from[k] = folderName(dir);
    }
  }
  const out: Inherited = { auth: eff.auth, headers, settings: Object.keys(from).length ? { ...settings, from } : {} };
  if (eff.authFrom !== undefined) out.authFrom = eff.authFrom;
  return out;
}

/** Which edited maps and lists exist in the YAML text (the parsed model shows absent ones as empty). */
export function presentIn(text: string): Present {
  let raw: unknown;
  try { raw = parse(text); } catch { raw = undefined; }
  const o = (raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const isMap = (v: unknown) => v !== null && typeof v === 'object' && !Array.isArray(v);
  return { settings: isMap(o.settings), pathParams: isMap(o.pathParams), query: Array.isArray(o.query), headers: Array.isArray(o.headers) };
}

/** Whether the list entry at `e.path` is still named one of `e.names`. */
export function rowMatches(text: string, e: RowExpectation): boolean {
  let cur: unknown;
  try { cur = parse(text); } catch { return false; }
  for (const k of e.path) {
    if (cur === null || typeof cur !== 'object') return false;
    cur = (cur as Record<string | number, unknown>)[k];
  }
  if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return false;
  const name = (cur as { name?: unknown }).name;
  return e.names.includes(name === undefined || name === null ? '' : String(name));
}

function flattenIds(nodes: TreeNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.kind === 'request') out.push(n.id);
    else flattenIds(n.children ?? [], out);
  }
  return out;
}

export class EditorController {
  private abort?: AbortController;
  private edits: Promise<unknown> = Promise.resolve();
  private shown?: HistoryEntry;
  private refreshSeq = 0;
  private disposed = false;

  constructor(private doc: DocumentPort, private deps: ControllerDeps) {}

  /** Aborts an in-flight send; nothing is posted afterwards. Call when the editor closes. */
  dispose(): void {
    this.disposed = true;
    this.abort?.abort();
  }

  private post(m: HostMessage): void { if (!this.disposed) this.deps.post(m); }

  private get id(): string { return requestIdFromPath(this.deps.root, this.doc.file); }

  async handle(m: WebviewMessage): Promise<void> {
    switch (m.type) {
      case 'ready': await this.refresh(); await this.postHistory(); return;
      case 'edit': await this.edit(m.ops, m.expect); return;
      case 'send': await this.send(); return;
      case 'cancel': this.abort?.abort(); return;
      case 'openText': this.deps.openText(); return;
      case 'selectEnv': this.deps.selectEnv(m.name); return;
      case 'showHistory': {
        const entry = await this.deps.history.get(m.entryId);
        if (entry) { this.shown = entry; this.post({ type: 'response', response: toResponseView(entry) }); }
        return;
      }
      case 'copyResponse': {
        const r = this.shown?.response;
        if (r && this.deps.copy) this.deps.copy(r.bodyText ?? r.bodyBase64);
        return;
      }
    }
  }

  /** Posts `state`. Call on document change, env change and file changes under root. */
  async refresh(extraErrors: Diagnostic[] = []): Promise<void> {
    const seq = ++this.refreshSeq;
    const { request, errors } = parseRequest(this.doc.getText());
    const allErrors = [...(this.deps.standalone ? [{ message: STANDALONE_NOTICE }] : []), ...errors, ...extraErrors];
    let inherited: Inherited = { auth: { type: 'none' }, headers: [], settings: {} };
    const { name, names, env } = await this.deps.getEnv();
    let variables: VariableInfo[] = [];
    if (request && !this.deps.standalone) {
      try {
        const chain = await loadFolderChain(this.deps.root, this.doc.file);
        // What the folders provide, regardless of whether this request overrides auth.
        const eff = effectiveRequest({ ...request, auth: undefined }, chain, this.doc.file, this.deps.root);
        inherited = inheritedFrom(this.deps.root, chain, eff);
      } catch (e) {
        allErrors.push({ message: (e as Error).message });
      }
    }
    if (request) {
      variables = collectVariables(this.deps.root, request, env);
    }
    // Standalone files have no tree to search (their folder may be anything, e.g. the home directory).
    const requestIds = this.deps.standalone ? [] : flattenIds(await listTree(this.deps.root));
    if (seq !== this.refreshSeq) return; // a newer refresh started: its state wins
    const present = presentIn(this.doc.getText());
    this.post({ type: 'state', request, errors: allErrors, inherited, env: { name, names }, variables, requestIds, present });
  }

  /** Posts the history list for this request in the current environment. */
  async postHistory(): Promise<void> {
    const { name } = await this.deps.getEnv();
    const items = (await this.deps.history.list(this.id, name ?? '')).map((e) => {
      const item: { entryId: string; timestamp: number; status?: number; ok: boolean } = { entryId: e.id, timestamp: e.timestamp, ok: e.ok };
      if (e.response) item.status = e.response.status;
      return item;
    });
    this.post({ type: 'history', items });
  }

  private edit(ops: Parameters<typeof applyEdits>[1], expect?: RowExpectation): Promise<void> {
    // Serialised, and always applied to the current text, so rapid edits never overwrite each other.
    const run = this.edits.then(async () => {
      const text = this.doc.getText();
      if (!parseRequest(text).request) { await this.refresh(); return; }
      // The row moved (e.g. an edit in the text editor): don't touch whatever is at that index now.
      if (expect && !rowMatches(text, expect)) { await this.refresh(); return; }
      let next: string;
      try { next = applyEdits(text, ops); } catch (e) {
        await this.refresh([{ message: `Edit failed: ${(e as Error).message}` }]);
        return;
      }
      if (next === text) return;
      if (!(await this.doc.applyText(next))) await this.refresh();
    });
    this.edits = run.catch(() => undefined);
    return run;
  }

  private async send(): Promise<void> {
    if (this.abort) return; // already in flight
    const abort = new AbortController();
    this.abort = abort;
    this.post({ type: 'sending' });
    let entry: HistoryEntry;
    try {
      // Edits posted just before the send (e.g. typing then Ctrl+Enter) must reach the document first.
      await this.edits;
      entry = await this.deps.run(this.id, abort.signal);
    } catch (e) {
      entry = { id: '', requestId: this.id, env: '', timestamp: Date.now(), ok: false, usedSecrets: false, timeline: [], error: (e as Error).message };
    } finally {
      this.abort = undefined;
    }
    this.shown = entry;
    this.post({ type: 'response', response: toResponseView(entry) });
    await this.postHistory();
  }
}
