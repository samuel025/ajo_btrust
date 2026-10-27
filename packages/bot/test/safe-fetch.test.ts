import { createServer } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isPrivateAddress, safeFetch } from '../src/safe-fetch';

describe('isPrivateAddress', () => {
  it.each([
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', // cloud metadata
    '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fe80::1', 'fc00::1', 'fd12::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1',
    'not-an-ip',
  ])('treats %s as private', (ip) => expect(isPrivateAddress(ip)).toBe(true));

  it.each(['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '104.18.2.3', '2606:4700::1111'])('treats %s as public', (ip) => {
    expect(isPrivateAddress(ip)).toBe(false);
  });
});

describe('safeFetch', () => {
  it('refuses local and private targets, and anything that is not https', async () => {
    const guarded = safeFetch({ allowLocal: false });
    await expect(guarded('https://localhost/x')).rejects.toThrow(/private/);
    await expect(guarded('https://127.0.0.1/x')).rejects.toThrow(/private/);
    await expect(guarded('https://169.254.169.254/latest/meta-data')).rejects.toThrow(/private/);
    await expect(guarded('https://[::1]/x')).rejects.toThrow();
    await expect(guarded('http://example.com/x')).rejects.toThrow(/non-https/);
    await expect(guarded('ftp://example.com/x')).rejects.toThrow(/non-https/);
  });

  describe('with a local server (development mode)', () => {
    let server: ReturnType<typeof createServer>;
    let base: string;
    beforeAll(async () => {
      server = createServer((req, res) => {
        if (req.url === '/redirect') return void res.writeHead(302, { Location: 'http://127.0.0.1:1/' }).end();
        if (req.url === '/big') return void res.end('x'.repeat(2_000_000));
        res.setHeader('Content-Type', 'application/json').end('{"ok":true}');
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    });
    afterAll(() => void server.close());

    it('reads JSON, but refuses redirects and oversized bodies', async () => {
      const guarded = safeFetch({ allowLocal: true, maxBytes: 1_000_000 });
      expect(await (await guarded(`${base}/`)).json()).toEqual({ ok: true });
      await expect(guarded(`${base}/redirect`)).rejects.toThrow();
      await expect((await guarded(`${base}/big`)).json()).rejects.toThrow(/too large/);
    });

    it('still refuses the same server when local access is not allowed', async () => {
      await expect(safeFetch({ allowLocal: false })(`${base}/`)).rejects.toThrow();
    });
  });
});
