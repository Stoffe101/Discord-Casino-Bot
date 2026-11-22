import { performance } from 'node:perf_hooks';
import { routeOf } from './outbound-guard.js';

/** Discord API request timings, grouped by what the request was for. */
export type RequestKind = 'interaction reply' | 'interaction follow-up/edit' | 'message create' | 'message edit' | 'other';

interface Bucket {
  count: number;
  totalMs: number;
  maxMs: number;
  errors: number;
  recent: number[];
}

const RECENT = 200;

export function requestKind(method: string, url: string): RequestKind {
  const s = routeOf(url).split('/').filter(Boolean);
  if (s[0] === 'interactions') return 'interaction reply';
  if (s[0] === 'webhooks') return 'interaction follow-up/edit';
  if (s[0] === 'channels' && s[2] === 'messages') return method === 'POST' && s.length === 3 ? 'message create' : method === 'PATCH' ? 'message edit' : 'other';
  return 'other';
}

export class RestMetrics {
  private readonly buckets = new Map<RequestKind, Bucket>();
  rateLimited = 0;

  /** Wrap a REST manager's HTTP function (outermost, so it measures real network time). */
  install(rest: { options: { makeRequest(url: string, init: { method?: string | undefined }): Promise<unknown> } }): void {
    const inner = rest.options.makeRequest.bind(rest.options);
    rest.options.makeRequest = async (url, init) => {
      const started = performance.now();
      let failed = false;
      try {
        const res = (await inner(url, init)) as { status?: number };
        if (res?.status === 429) this.rateLimited++;
        failed = typeof res?.status === 'number' && res.status >= 400;
        return res;
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        this.record(requestKind((init.method ?? 'GET').toUpperCase(), url), performance.now() - started, failed);
      }
    };
  }

  record(kind: RequestKind, ms: number, failed = false): void {
    let b = this.buckets.get(kind);
    if (!b) {
      b = { count: 0, totalMs: 0, maxMs: 0, errors: 0, recent: [] };
      this.buckets.set(kind, b);
    }
    b.count++;
    b.totalMs += ms;
    b.maxMs = Math.max(b.maxMs, ms);
    if (failed) b.errors++;
    b.recent.push(ms);
    if (b.recent.length > RECENT) b.recent.shift();
  }

  summary(): Record<string, { count: number; avgMs: number; p95Ms: number; maxMs: number; errors: number }> {
    const out: Record<string, { count: number; avgMs: number; p95Ms: number; maxMs: number; errors: number }> = {};
    for (const [kind, b] of this.buckets) {
      const sorted = [...b.recent].sort((x, y) => x - y);
      out[kind] = {
        count: b.count,
        avgMs: Math.round(b.totalMs / b.count),
        p95Ms: Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0),
        maxMs: Math.round(b.maxMs),
        errors: b.errors,
      };
    }
    return out;
  }

  /** One line for the admin health screen. */
  line(): string {
    const s = this.summary();
    const parts = Object.entries(s).map(([kind, v]) => `${kind} ${v.count}× avg ${v.avgMs} ms (p95 ${v.p95Ms})`);
    return parts.length ? parts.join(' · ') : 'no requests yet';
  }
}
