import type { TimelineEntry } from './http';
import type { Auth, Diagnostic, KV, RequestDef } from './model';
import type { EditOp } from './yamlEdit';

/** Messages between the extension host and the request editor webview. */

export interface VariableInfo { name: string; kind: 'variable' | 'secret' | 'pathParam' | 'missing'; file?: string; value?: string /* never for secrets */ }

export interface ResponseView {
  entryId: string; timestamp: number; ok: boolean; error?: string; status?: number; statusText?: string;
  timeMs?: number; sizeBytes?: number; headers?: [string, string][]; contentType?: string; bodyText?: string; bodyBase64?: string;
  truncated?: boolean; timeline: TimelineEntry[];
}

export type HostMessage =
  | {
    type: 'state'; request?: RequestDef; errors: Diagnostic[]; inherited: { auth: Auth; authFrom?: string; headers: KV[] };
    env: { name?: string; names: string[] }; variables: VariableInfo[]; requestIds: string[];
  }
  | { type: 'sending' } | { type: 'response'; response: ResponseView }
  | { type: 'history'; items: { entryId: string; timestamp: number; status?: number; ok: boolean }[] };

export type WebviewMessage =
  | { type: 'ready' } | { type: 'edit'; ops: EditOp[] } | { type: 'send' } | { type: 'cancel' }
  | { type: 'openText' } | { type: 'selectEnv'; name: string } | { type: 'showHistory'; entryId: string } | { type: 'copyResponse' };
