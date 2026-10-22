import type { TimelineEntry } from './http';
import type { Auth, Diagnostic, KV, RequestDef, Settings } from './model';
import type { EditOp, YamlPath } from './yamlEdit';

/** Messages between the extension host and the request editor webview. */

export interface VariableInfo { name: string; kind: 'variable' | 'secret' | 'pathParam' | 'missing'; file?: string; value?: string /* never for secrets */ }

export interface ResponseView {
  entryId: string; timestamp: number; ok: boolean; error?: string; status?: number; statusText?: string;
  timeMs?: number; sizeBytes?: number; headers?: [string, string][]; contentType?: string; bodyText?: string; bodyBase64?: string;
  truncated?: boolean; timeline: TimelineEntry[];
}

/**
 * What the folder chain provides. `from` is the folder (relative to root, `.` for the root) that set
 * each header, and in `settings.from`, each setting.
 */
export interface Inherited {
  auth: Auth; authFrom?: string;
  headers: (KV & { from?: string })[];
  settings: Settings & { from?: Record<string, string> };
}

export type HostMessage =
  | {
    type: 'state'; request?: RequestDef; errors: Diagnostic[]; inherited: Inherited;
    env: { name?: string; names: string[] }; variables: VariableInfo[]; requestIds: string[];
  }
  | { type: 'sending' } | { type: 'response'; response: ResponseView }
  | { type: 'history'; items: { entryId: string; timestamp: number; status?: number; ok: boolean }[] };

/**
 * Ctrl/Cmd+Enter inside the request editor is handled by the webview itself, which posts `send`
 * (implemented in Task 11). The `yamlHttp.send` keybinding only covers `*.req.yaml` text editors, so it
 * never fires while focus is elsewhere (SCM input, chat) with the request editor merely active.
 */
/**
 * Guards an index-based row edit: the list entry at `path` must still be named one of `names` (the name
 * the webview shows, plus names it sent that the host has not echoed yet). Otherwise the edit is skipped.
 */
export interface RowExpectation { path: YamlPath; names: string[] }

export type WebviewMessage =
  | { type: 'ready' } | { type: 'edit'; ops: EditOp[]; expect?: RowExpectation } | { type: 'send' } | { type: 'cancel' }
  | { type: 'openText' } | { type: 'selectEnv'; name: string } | { type: 'showHistory'; entryId: string } | { type: 'copyResponse' };
