// One command to get ready for the demo: checks the pieces, starts the web app and the coordinator bot,
// and prints the wallet words and steps. Stop it with Ctrl+C.   npm run demo
import { spawn } from 'node:child_process';
import net from 'node:net';
import { getPublicKey, nip19 } from 'nostr-tools';
import { Account, Esplora, chosenNetwork, scanWallet, seedFromMnemonic } from '../apps/web/src/lib/onchain/index';

const { BOT_NSEC, RELAYS, ONCHAIN_TEST_MNEMONIC } = process.env;
const problems: string[] = [];
if (!BOT_NSEC) problems.push('BOT_NSEC is not set in .env (run `npm run keygen -w @ajo/bot`)');
if (!RELAYS) problems.push('RELAYS is not set in .env (for example ws://localhost:7777)');
if (!ONCHAIN_TEST_MNEMONIC) problems.push('ONCHAIN_TEST_MNEMONIC is not set in .env (run `npm run e2e:bitcoin -w @ajo/web` once)');
if (problems.length) { console.error('Not ready:\n - ' + problems.join('\n - ')); process.exit(1); }

const open = (host: string, port: number) => new Promise<boolean>((resolve) => {
  const s = net.connect({ host, port, timeout: 1500 }, () => { s.destroy(); resolve(true); });
  s.on('error', () => resolve(false)).on('timeout', () => { s.destroy(); resolve(false); });
});

const relay = new URL(RELAYS!.split(',')[0]!.replace(/^ws/, 'http'));
if (!(await open(relay.hostname, Number(relay.port) || 80))) {
  console.error(`The relay at ${RELAYS} isn't answering. Start it first (see README, "Run it"), then run this again.`);
  process.exit(1);
}
const botKey = nip19.decode(BOT_NSEC as `nsec1${string}`).data as Uint8Array;
const coordinator = nip19.npubEncode(getPublicKey(botKey));

const chain = chosenNetwork({});
const wallet = new Account(seedFromMnemonic(ONCHAIN_TEST_MNEMONIC!), chain);
let balance = 'unknown (could not reach the block explorer)';
try {
  const snap = await scanWallet(wallet, new Esplora(chain.esplora));
  balance = `${snap.confirmedSats} sats${snap.pendingSats ? ` (+${snap.pendingSats} waiting)` : ''}`;
} catch { /* printed as unknown */ }

const dry = process.env.DEMO_DRY === '1'; // print the instructions without starting anything
const children: ReturnType<typeof spawn>[] = [];
const run = (name: string, cmd: string, args: string[], env: NodeJS.ProcessEnv = {}) => {
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  const tag = (d: Buffer) => d.toString().split('\n').filter(Boolean).forEach((l) => console.log(`[${name}] ${l}`));
  child.stdout!.on('data', tag);
  child.stderr!.on('data', tag);
  children.push(child);
};
if (dry) console.log('(dry run: nothing is started)');
else if (await open('127.0.0.1', 5173)) console.log('The web app is already running on :5173, so it was left alone.');
else run('web', 'npm', ['run', 'dev', '-w', '@ajo/web']);
if (!dry) run('bot', 'npm', ['start', '-w', '@ajo/bot'], { ORGANIZERS: '*' });

console.log(`
=========================== DEMO READY ===========================
Web app:       http://localhost:5173
Coordinator:   ${coordinator}
               (the bot runs any group that names it: demo only)

Funded test wallet (${chain.name}, worthless test coins): ${balance}
  Words:   ${ONCHAIN_TEST_MNEMONIC}
  Address: ${wallet.address(0, 0)}
  Faucet:  ${chain.faucet ?? 'n/a'}

Steps (docs/DEMO.md has the script):
  Window A (normal): Create a test key → Wallet → create a Bitcoin wallet → New group
                     (Bitcoin on-chain, 500 sats) → Join with "Use my wallet's address".
  Window B (private): Create a test key → Wallet → Restore from twelve words (the words above)
                     → open A's invite link → Ask to join.
  Window A: Add to group → Start the group.   Window B: Pay from my wallet.
Stop everything with Ctrl+C.
===================================================================
`);
if (dry) process.exit(0);
const stop = () => { children.forEach((c) => c.kill()); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
setInterval(() => undefined, 1 << 30);
