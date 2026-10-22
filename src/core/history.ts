import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename as fsRename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HttpResponse, TimelineEntry } from './http';

export interface HistoryEntry {
  id: string; requestId: string; env: string; timestamp: number; ok: boolean;
  usedSecrets: boolean; response?: HttpResponse; timeline: TimelineEntry[]; error?: string;
}
/** A history entry without its response body (what `list` returns). */
export type ResponseMeta = Omit<HttpResponse, 'bodyBase64' | 'bodyText'>;
export type HistorySummary = Omit<HistoryEntry, 'response'> & { response?: ResponseMeta };

/** On disk: metadata only; the body bytes live in `bodies/<uuid>`. Older files may still carry inline bodies. */
type StoredEntry = Omit<HistoryEntry, 'response'> & {
  response?: ResponseMeta & { text?: boolean; bodyBase64?: string; bodyText?: string };
};

const KEEP = 20;
const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');
const ID = /^([0-9a-f]{40})\.(.+)\.([0-9a-f-]{36})$/;
const uuidOf = (id: string) => id.slice(id.lastIndexOf('.') + 1);

function summary(e: StoredEntry): HistorySummary {
  if (!e.response) return e as HistorySummary;
  const { text: _t, bodyBase64: _b, bodyText: _x, ...meta } = e.response;
  return { ...e, response: meta };
}

export class HistoryStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private dir: string) {}

  // Serialises mutations so concurrent adds to the same file don't lose entries.
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private key(requestId: string, env: string): string { return `${sha1(requestId)}.${env}`; }
  private file(requestId: string, env: string): string { return join(this.dir, `${this.key(requestId, env)}.json`); }
  private bodyFile(id: string): string { return join(this.dir, 'bodies', uuidOf(id)); }

  private async read(file: string): Promise<StoredEntry[]> {
    let text: string;
    try { text = await readFile(file, 'utf8'); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
    try {
      const data = JSON.parse(text);
      if (Array.isArray(data)) return data;
    } catch { /* corrupt: quarantine below */ }
    await fsRename(file, `${file}.corrupt-${Date.now()}`);
    return [];
  }

  private async write(file: string, entries: StoredEntry[]): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const tmp = `${file}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(entries));
    await fsRename(tmp, file);
  }

  private async files(): Promise<string[]> {
    try { return (await readdir(this.dir)).filter((f) => f.endsWith('.json')); } catch { return []; }
  }

  /** Re-attaches the body to a stored entry. */
  private async full(e: StoredEntry): Promise<HistoryEntry> {
    const r = e.response;
    if (!r || r.bodyBase64 !== undefined) return e as HistoryEntry; // no response, or a legacy inline body
    let data: Buffer;
    try { data = await readFile(this.bodyFile(e.id)); } catch { data = Buffer.alloc(0); }
    const { text, ...meta } = r;
    const response: HttpResponse = { ...meta, bodyBase64: data.toString('base64') };
    if (text) response.bodyText = data.toString('utf8');
    return { ...e, response };
  }

  private async dropBodies(entries: StoredEntry[]): Promise<void> {
    for (const e of entries) await unlink(this.bodyFile(e.id)).catch(() => undefined);
  }

  add(e: Omit<HistoryEntry, 'id'>): Promise<HistoryEntry> {
    return this.exclusive(async () => {
      const key = this.key(e.requestId, e.env);
      const entry: HistoryEntry = { ...e, id: `${key}.${randomUUID()}` };
      const stored: StoredEntry = { ...entry, response: undefined };
      if (e.response) {
        const { bodyBase64, bodyText, ...meta } = e.response;
        stored.response = bodyText !== undefined ? { ...meta, text: true } : meta;
        await mkdir(join(this.dir, 'bodies'), { recursive: true });
        await writeFile(this.bodyFile(entry.id), Buffer.from(bodyBase64, 'base64'));
      } else delete stored.response;
      const file = this.file(e.requestId, e.env);
      const sorted = [stored, ...(await this.read(file))].sort((a, b) => b.timestamp - a.timestamp);
      await this.write(file, sorted.slice(0, KEEP));
      await this.dropBodies(sorted.slice(KEEP));
      return entry;
    });
  }

  /** Newest first, without response bodies. */
  async list(requestId: string, env: string): Promise<HistorySummary[]> {
    const all = await this.read(this.file(requestId, env));
    return all.sort((a, b) => b.timestamp - a.timestamp).map(summary);
  }

  async get(id: string): Promise<HistoryEntry | undefined> {
    const m = ID.exec(id);
    if (m) {
      const hit = (await this.read(join(this.dir, `${m[1]}.${m[2]}.json`))).find((e) => e.id === id);
      if (hit) return this.full(hit);
    }
    // Legacy ids, or entries moved by rename: scan the (small, metadata-only) list files.
    for (const f of await this.files()) {
      const hit = (await this.read(join(this.dir, f))).find((e) => e.id === id);
      if (hit) return this.full(hit);
    }
    return undefined;
  }

  async latestOk(requestId: string, env: string): Promise<HistoryEntry | undefined> {
    const all = (await this.read(this.file(requestId, env))).sort((a, b) => b.timestamp - a.timestamp);
    const hit = all.find((e) => e.ok);
    return hit ? this.full(hit) : undefined;
  }

  rename(oldId: string, newId: string): Promise<void> {
    return this.exclusive(async () => {
      if (oldId === newId) return;
      const prefix = `${sha1(oldId)}.`;
      for (const f of (await this.files()).filter((x) => x.startsWith(prefix))) {
        const env = f.slice(prefix.length, -'.json'.length);
        const moved = (await this.read(join(this.dir, f))).map((e) => ({ ...e, requestId: newId }));
        const target = this.file(newId, env);
        const merged = [...moved, ...(await this.read(target))].sort((a, b) => b.timestamp - a.timestamp);
        await this.write(target, merged.slice(0, KEEP));
        await this.dropBodies(merged.slice(KEEP));
        await unlink(join(this.dir, f));
      }
    });
  }
}
