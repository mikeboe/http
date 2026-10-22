import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename as fsRename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HttpResponse, TimelineEntry } from './http';

export interface HistoryEntry {
  id: string; requestId: string; env: string; timestamp: number; ok: boolean;
  response?: HttpResponse; timeline: TimelineEntry[]; error?: string;
}

const KEEP = 20;
const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');

export class HistoryStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private dir: string) {}

  // Serialises mutations so concurrent adds to the same file don't lose entries.
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private file(requestId: string, env: string): string {
    return join(this.dir, `${sha1(requestId)}.${env}.json`);
  }

  private async read(file: string): Promise<HistoryEntry[]> {
    try {
      const data = JSON.parse(await readFile(file, 'utf8'));
      return Array.isArray(data) ? data : [];
    } catch { return []; }
  }

  private async write(file: string, entries: HistoryEntry[]): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const tmp = `${file}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(entries));
    await fsRename(tmp, file);
  }

  private async files(): Promise<string[]> {
    try { return (await readdir(this.dir)).filter((f) => f.endsWith('.json')); } catch { return []; }
  }

  add(e: Omit<HistoryEntry, 'id'>): Promise<HistoryEntry> {
    return this.exclusive(async () => {
      const entry: HistoryEntry = { ...e, id: randomUUID() };
      const file = this.file(e.requestId, e.env);
      const all = [entry, ...(await this.read(file))].sort((a, b) => b.timestamp - a.timestamp).slice(0, KEEP);
      await this.write(file, all);
      return entry;
    });
  }

  async list(requestId: string, env: string): Promise<HistoryEntry[]> {
    const all = await this.read(this.file(requestId, env));
    return all.sort((a, b) => b.timestamp - a.timestamp);
  }

  async get(id: string): Promise<HistoryEntry | undefined> {
    for (const f of await this.files()) {
      const hit = (await this.read(join(this.dir, f))).find((e) => e.id === id);
      if (hit) return hit;
    }
    return undefined;
  }

  async latestOk(requestId: string, env: string): Promise<HistoryEntry | undefined> {
    return (await this.list(requestId, env)).find((e) => e.ok);
  }

  rename(oldId: string, newId: string): Promise<void> {
    return this.exclusive(async () => {
      if (oldId === newId) return;
      const prefix = `${sha1(oldId)}.`;
      for (const f of (await this.files()).filter((x) => x.startsWith(prefix))) {
        const env = f.slice(prefix.length, -'.json'.length);
        const moved = (await this.read(join(this.dir, f))).map((e) => ({ ...e, requestId: newId }));
        const target = this.file(newId, env);
        const merged = [...moved, ...(await this.read(target))].sort((a, b) => b.timestamp - a.timestamp).slice(0, KEEP);
        await this.write(target, merged);
        await unlink(join(this.dir, f));
      }
    });
  }
}
