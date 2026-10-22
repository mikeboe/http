import { basename } from 'node:path';
import { applyAuth } from './auth';
import type { TokenStore } from './auth';
import type { Environment } from './env';
import { extractValue } from './extract';
import type { HistoryEntry, HistoryStore } from './history';
import { mask, SendError, send } from './http';
import type { CookieJar, TimelineEntry } from './http';
import { parseDuration } from './model';
import { resolveRequest } from './resolve';
import { MissingVariableError } from './template';
import { loadEffective } from './workspace';

export interface RunContext {
  root: string; envName: string; env: Environment; history: HistoryStore; jar: CookieJar;
  tokens: TokenStore; openBrowser(url: string): Promise<void>; signal?: AbortSignal; now?: () => number;
}
export interface RunResult { entry: HistoryEntry }
export class ChainError extends Error {}

export async function runRequest(id: string, ctx: RunContext, stack: string[] = []): Promise<RunResult> {
  return (await runInternal(id, ctx, stack)).result;
}

async function runInternal(
  id: string, ctx: RunContext, stack: string[],
): Promise<{ result: RunResult; secrets: Set<string> }> {
  const now = ctx.now ?? Date.now;
  const path = [...stack, id];
  const timeline: TimelineEntry[] = [];
  const known = new Set<string>();
  const addKnown = (r?: Set<string>) => { if (r) for (const s of r) known.add(s); };

  const response = async (request: string, valuePath: string, maxAge?: string) => {
    if (path.includes(request)) throw new ChainError(`Circular dependency: ${[...path, request].join(' → ')}`);
    let entry = await ctx.history.latestOk(request, ctx.envName);
    if (entry && maxAge !== undefined && now() - entry.timestamp > parseDuration(maxAge)) entry = undefined;
    let depSecrets = entry?.usedSecrets === true;
    if (!entry) {
      const ran = await runInternal(request, ctx, path);
      entry = ran.result.entry;
      depSecrets = ran.result.entry.usedSecrets;
      for (const s of ran.secrets) known.add(s);
      const ms = entry.response?.timeMs;
      timeline.push({
        kind: 'dependency',
        text: entry.response ? `Ran ${request} → ${entry.response.status} (${ms} ms)` : `Ran ${request} → failed`,
      });
      if (!entry.ok) {
        const why = entry.response ? `${entry.response.status} ${entry.response.statusText}` : entry.error ?? 'failed';
        throw new ChainError(`Dependency ${request} failed: ${why}`);
      }
    }
    const value = entry.response ? extractValue(entry.response, valuePath) : undefined;
    if (value === undefined) throw new ChainError(`Dependency ${request} has no value at ${valuePath}`);
    const secret = /^(body|headers)(\.|\[|$)/.test(valuePath) || depSecrets;
    if (secret) known.add(value);
    return { value, secret };
  };

  let resolvedSecrets: Set<string> | undefined;
  let result: HistoryEntry['response'];
  let error: string | undefined;
  let finalTimeline: TimelineEntry[] = timeline;
  try {
    const eff = await loadEffective(ctx.root, id);
    const req = await resolveRequest(eff, ctx.env, response);
    resolvedSecrets = req.secrets;
    addKnown(req.secrets);
    await applyAuth(req, { tokens: ctx.tokens, openBrowser: ctx.openBrowser, envName: ctx.envName, timeline });
    addKnown(req.secrets);
    const sent = await send(req, { jar: ctx.jar, signal: ctx.signal });
    result = sent.response;
    finalTimeline = [...timeline, ...sent.timeline];
  } catch (e) {
    let message = e instanceof Error ? e.message : String(e);
    if (e instanceof MissingVariableError) {
      const dir = basename(ctx.root);
      message = `Variable "${e.variable}" is not set. Add it to ${dir}/env/${ctx.envName}.env (or ${ctx.envName}.yaml).`;
    }
    addKnown(resolvedSecrets);
    if (!(e instanceof ChainError)) message = mask(message, known);
    error = message;
    finalTimeline = e instanceof SendError ? [...timeline, ...e.timeline] : timeline;
    if (finalTimeline[finalTimeline.length - 1]?.kind !== 'error') finalTimeline = [...finalTimeline, { kind: 'error', text: message }];
  }
  const ok = !!result && result.status >= 200 && result.status < 300 && !error;
  addKnown(resolvedSecrets);
  const entry = await ctx.history.add({
    requestId: id, env: ctx.envName, timestamp: now(), ok, response: result, timeline: finalTimeline, error,
    usedSecrets: known.size > 0,
  });
  return { result: { entry }, secrets: known };
}
