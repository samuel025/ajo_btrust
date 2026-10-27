import { lookup as dnsLookup } from 'node:dns';
import { isIP } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';

/** True for addresses a public Lightning provider can never legitimately be at. */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b, c] = ip.split('.').map(Number) as [number, number, number];
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
      (a === 169 && b === 254) || // link-local, including cloud metadata services
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (v === 6) {
    const lower = ip.toLowerCase();
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]!);
    return lower === '::' || lower === '::1' || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower);
  }
  return true; // not an IP address at all
}

export interface SafeFetchOptions {
  /** Allow localhost and private addresses over http, for local development only. */
  allowLocal?: boolean;
  timeoutMs?: number;
  /** Largest response body read, in bytes. */
  maxBytes?: number;
}

/**
 * A `fetch` for URLs that members control (their Lightning address, and the verify links their
 * provider returns). It refuses private and local addresses, checking the IP actually connected to
 * so a DNS trick can't point a public name at the bot's own network, refuses redirects, and caps
 * time and size. Without this, a crafted Lightning address could make the bot probe its own network.
 */
export function safeFetch(options: SafeFetchOptions = {}) {
  const { allowLocal = process.env.AJO_ALLOW_LOCAL_LNURL === '1', timeoutMs = 8000, maxBytes = 1_000_000 } = options;

  const dispatcher = new Agent({
    connect: {
      lookup: (hostname, opts, callback) => {
        dnsLookup(hostname, opts, (error, address, family) => {
          if (error) return callback(error, address as never, family as never);
          const addresses = Array.isArray(address) ? address.map((a) => a.address) : [address as string];
          if (!allowLocal && addresses.some(isPrivateAddress)) {
            return callback(new Error(`refusing to connect to a private address (${hostname})`), address as never, family as never);
          }
          callback(null, address as never, family as never);
        });
      },
    },
  });

  return async function fetchSafely(url: string | URL, init: { signal?: AbortSignal } = {}) {
    const target = new URL(url);
    if (target.protocol !== 'https:' && !(allowLocal && target.protocol === 'http:')) {
      throw new Error(`refusing a non-https URL (${target.protocol})`);
    }
    if (!allowLocal && (target.hostname === 'localhost' || isIP(target.hostname) !== 0 && isPrivateAddress(target.hostname))) {
      throw new Error(`refusing to connect to a private address (${target.hostname})`);
    }
    const response = await undiciFetch(target, {
      dispatcher,
      redirect: 'error',
      signal: init.signal ?? AbortSignal.timeout(timeoutMs),
    });
    return {
      async json(): Promise<unknown> {
        const reader = response.body?.getReader();
        if (!reader) return JSON.parse('null');
        const chunks: Uint8Array[] = [];
        let size = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > maxBytes) { await reader.cancel(); throw new Error('response too large'); }
          chunks.push(value);
        }
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
      },
    };
  };
}
