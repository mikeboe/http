import type { RowExpectation, WebviewMessage } from '../core/protocol';
import type { EditOp } from '../core/yamlEdit';

interface VsCodeApi { postMessage(m: unknown): void; getState(): unknown; setState(s: unknown): unknown }
declare function acquireVsCodeApi(): VsCodeApi;

const api = acquireVsCodeApi();

/** UI state kept across webview reloads (VS Code's `setState`). */
export interface UiState { ratio?: number; requestTab?: string; responseTab?: string; raw?: boolean }

export function post(m: WebviewMessage): void { api.postMessage(m); }

export function edit(...ops: EditOp[]): void { post({ type: 'edit', ops }); }

/** An edit to one list row; the host skips it if the row at that index is no longer the expected one. */
export function editRow(expect: RowExpectation, ...ops: EditOp[]): void { post({ type: 'edit', ops, expect }); }

export function getUiState(): UiState { return (api.getState() as UiState | undefined) ?? {}; }

export function setUiState(patch: UiState): void { api.setState({ ...getUiState(), ...patch }); }
