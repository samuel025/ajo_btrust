import http from 'node:http';
import { LANGUAGES, type Language } from '@ajo/core';
import { answerGuide, draftGroup, type Complete, type GuideTurn } from './ai-features';

/** How many calls a client may make, so the free AI quota can't be used up by one visitor. */
export interface Limits { perMinute: number; perDay: number; globalPerDay: number }
export const DEFAULT_LIMITS: Limits = { perMinute: 6, perDay: 60, globalPerDay: 400 };

const MAX_BODY_BYTES = 4096;
const lagosToday = (now: number) => new Date(now).toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });

/** Counts calls per client and overall in sliding windows. Returns how many seconds to wait, or 0 if the call is allowed. */
export class RateLimiter {
  private perClient = new Map<string, number[]>();
  private all: number[] = [];
  constructor(private limits: Limits, private now: () => number = Date.now) {}

  check(client: string): number {
    const t = this.now();
    const day = t - 86_400_000;
    this.all = this.all.filter((x) => x > day);
    const mine = (this.perClient.get(client) ?? []).filter((x) => x > day);
    if (this.all.length >= this.limits.globalPerDay) return 3600;
    if (mine.length >= this.limits.perDay) return Math.ceil((mine[0]! + 86_400_000 - t) / 1000);
    const lastMinute = mine.filter((x) => x > t - 60_000);
    if (lastMinute.length >= this.limits.perMinute) return Math.ceil((lastMinute[0]! + 60_000 - t) / 1000);
    mine.push(t);
    this.all.push(t);
    this.perClient.set(client, mine);
    if (this.perClient.size > 5000) for (const [k, v] of this.perClient) if (!v.some((x) => x > day)) this.perClient.delete(k);
    return 0;
  }
}

export interface AiServerOptions {
  /** The language model. Without it the AI features answer "not available". */
  complete?: Complete;
  limits?: Limits;
  /** Which website may call this from a browser. Defaults to any, since nothing here uses cookies or accounts. */
  allowedOrigin?: string;
  now?: () => number;
  onError?: (error: unknown) => void;
}

const isLanguage = (v: unknown): v is Language => typeof v === 'string' && v in LANGUAGES;

/**
 * A small web service next to the coordinator for the AI features that happen before or outside a group: turning a
 * description into group settings, and answering wallet questions. It holds no accounts, keeps nothing, and the model's key
 * never leaves the server.
 */
export function aiServer(options: AiServerOptions = {}): http.Server {
  const { complete, allowedOrigin = '*', now = Date.now } = options;
  const limiter = new RateLimiter(options.limits ?? DEFAULT_LIMITS, now);

  return http.createServer(async (req, res) => {
    const send = (status: number, body: unknown, extra: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': allowedOrigin, vary: 'Origin', ...extra });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-origin': allowedOrigin, 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '600' });
      res.end();
      return;
    }
    const path = (req.url ?? '/').split('?')[0];
    if (req.method === 'GET' && path === '/status') return send(200, { enabled: !!complete });
    if (req.method !== 'POST' || (path !== '/group-draft' && path !== '/guide')) return send(404, { error: 'not found' });

    // read a small JSON body
    let raw = '';
    let tooBig = false;
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > MAX_BODY_BYTES) { tooBig = true; break; }
    }
    if (tooBig) return send(413, { error: 'That is too long.' });
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw || '{}'); if (!body || typeof body !== 'object') throw new Error(); } catch { return send(400, { error: 'Send a JSON body.' }); }

    if (!complete) return send(503, { error: 'The assistant is not available right now.' });
    const client = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? 'unknown').split(',')[0]!.trim();
    const wait = limiter.check(client);
    if (wait > 0) return send(429, { error: 'Too many requests. Please try again a little later.', retryAfterSeconds: wait }, { 'retry-after': String(wait) });

    try {
      if (path === '/group-draft') {
        const description = typeof body.description === 'string' ? body.description.trim() : '';
        if (description.length < 5 || description.length > 600) return send(400, { error: 'Describe your group in a sentence or two (5 to 600 characters).' });
        return send(200, { draft: await draftGroup(complete, description, lagosToday(now())) });
      }
      const question = typeof body.question === 'string' ? body.question.trim() : '';
      if (!question || question.length > 500) return send(400, { error: 'Ask a question of up to 500 characters.' });
      const language = isLanguage(body.language) ? body.language : 'en';
      const history: GuideTurn[] = Array.isArray(body.history)
        ? body.history.slice(-4).flatMap((t: unknown) => {
            const turn = t as { role?: unknown; text?: unknown };
            return (turn.role === 'user' || turn.role === 'guide') && typeof turn.text === 'string' ? [{ role: turn.role, text: turn.text.slice(0, 500) }] : [];
          })
        : [];
      return send(200, { reply: await answerGuide(complete, question, language, history) });
    } catch (e) {
      options.onError?.(e);
      return send(503, { error: 'The assistant is not available right now.' });
    }
  });
}
