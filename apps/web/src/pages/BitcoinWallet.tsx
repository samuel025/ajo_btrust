import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Ctx } from '../App';
import { QrImage } from '../components/QrImage';
import { formatNaira, satsToNaira } from '../lib/rate';
import { Esplora, pickFeeRate } from '../lib/onchain/esplora';
import { Account, checkAddress } from '../lib/onchain/keys';
import { walletNetwork } from '../lib/onchain/config';
import type { NetworkConfig } from '../lib/onchain/network';
import { setUnlocked, useUnlocked } from '../lib/onchain/session';
import { scanWallet, type Snapshot } from '../lib/onchain/scan';
import { checksPass, isValidMnemonic, newMnemonic, normalizeMnemonic, pickChecks, seedFromMnemonic } from '../lib/onchain/seed';
import { SendError, assertSaneFee, buildTransaction, planSend, type Built, type Plan } from '../lib/onchain/send';
import { loadVault, openMnemonic, removeVault, saveVault, sealMnemonic, type VaultRecord } from '../lib/onchain/vault';

/** An on-chain Bitcoin wallet. The keys are made and kept here, in this browser, protected by a password. */
export function BitcoinWallet({ ctx }: { ctx: Ctx }) {
  const { net, problem } = useMemo(walletNetwork, []);
  const [vault, setVault] = useState<VaultRecord | undefined>(loadVault);
  const account = useUnlocked();
  const setAccount = setUnlocked;
  if (!net) return <section className="card"><p className="error">{problem}</p></section>;

  if (account) return <Unlocked ctx={ctx} net={net} account={account} onLock={() => setAccount(undefined)} onRemoved={() => { setAccount(undefined); setVault(undefined); }} />;
  if (vault && vault.network !== net.name) {
    return (
      <section className="card">
        <h2>Another network</h2>
        <p>The wallet on this device was made for <b>{vault.network}</b>, but this app is set to <b>{net.name}</b>.</p>
        <button className="secondary" onClick={() => { if (confirm('Remove it from this device? Make sure you have its recovery phrase.')) { removeVault(); setVault(undefined); } }}>Remove it from this device</button>
      </section>
    );
  }
  if (vault) return <Unlock net={net} vault={vault} onOpen={setAccount} />;
  return <Setup net={net} onDone={(record, acct) => { setVault(record); setAccount(acct); }} />;
}

const Words = ({ phrase }: { phrase: string }) => (
  <ol className="words">{phrase.split(' ').map((w, i) => <li key={i}><span className="muted small">{i + 1}</span> {w}</li>)}</ol>
);

function Setup({ net, onDone }: { net: NetworkConfig; onDone: (record: VaultRecord, account: Account) => void }) {
  const [mode, setMode] = useState<'choose' | 'show' | 'verify' | 'restore' | 'password'>('choose');
  const [phrase, setPhrase] = useState('');
  const [typed, setTyped] = useState('');
  const [checks, setChecks] = useState<number[]>([]);
  const [answers, setAnswers] = useState(['', '', '']);
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const create = () => { setPhrase(newMnemonic()); setError(undefined); setMode('show'); };
  const toVerify = () => { setChecks(pickChecks(12)); setAnswers(['', '', '']); setMode('verify'); };

  const finish = async (words: string) => {
    if (pw.length < 8) return setError('Use a password of at least 8 characters.');
    if (pw !== pw2) return setError("The two passwords don't match.");
    setError(undefined);
    setBusy(true);
    try {
      const acct = new Account(seedFromMnemonic(words), net);
      const record = { ...(await sealMnemonic(words, pw, net.name)), address: acct.address(0, 0) };
      if (!saveVault(record)) throw new Error("This browser won't let the wallet be saved. Check that site data isn't blocked.");
      onDone(record, acct);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const passwordForm = (words: string) => (
    <form onSubmit={(e) => { e.preventDefault(); void finish(words); }}>
      <p className="muted">Choose a password. It locks the wallet on this device. It is <b>not</b> your backup: the twelve words are.</p>
      <label>Password<input type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} /></label>
      <label>Again<input type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} /></label>
      {error && <p className="error">{error}</p>}
      <button disabled={busy}>{busy ? 'Saving…' : 'Create wallet'}</button>
    </form>
  );

  return (
    <section className="card">
      {net.testCoins && <p className="notice small">This wallet is on the <b>{net.name}</b> test network. Its coins are worthless test coins.</p>}
      {mode === 'choose' && (
        <>
          <h2>Your own Bitcoin wallet</h2>
          <p className="muted">The keys are made here and stay on this device, protected by a password. Nobody else, including us, can move your coins. You back it up by writing down twelve words.</p>
          <button onClick={create}>Create a new wallet</button>{' '}
          <button className="secondary" onClick={() => { setError(undefined); setMode('restore'); }}>Restore from twelve words</button>
        </>
      )}
      {mode === 'show' && (
        <>
          <h2>Write these twelve words down</h2>
          <p className="warn"><b>They are the only way to get your coins back.</b> Write them on paper, in order. Never type them into a website, send them in a message, or take a screenshot. Anyone who has them can take your coins.</p>
          <Words phrase={phrase} />
          <button onClick={toVerify}>I wrote them down</button>
        </>
      )}
      {mode === 'verify' && (
        <>
          <h2>Check your backup</h2>
          <p className="muted">Type the words you wrote down at these positions.</p>
          {checks.map((position, i) => (
            <label key={position}>Word {position + 1}
              <input autoComplete="off" autoCapitalize="none" value={answers[i]} onChange={(e) => setAnswers(answers.map((a, k) => (k === i ? e.target.value : a)))} />
            </label>
          ))}
          {error && <p className="error">{error}</p>}
          <button onClick={() => (checksPass(phrase, checks, answers) ? (setError(undefined), setMode('password')) : setError("Those don't match. Look at your written words again."))}>Continue</button>{' '}
          <button className="secondary" onClick={() => setMode('show')}>Show the words again</button>
        </>
      )}
      {mode === 'password' && <><h2>Lock it with a password</h2>{passwordForm(phrase)}</>}
      {mode === 'restore' && (
        <>
          <h2>Restore a wallet</h2>
          <label>Your twelve words
            <textarea rows={3} autoComplete="off" autoCapitalize="none" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="word1 word2 word3 …" />
          </label>
          {typed.trim() !== '' && !isValidMnemonic(typed) && <p className="error">That isn't a valid recovery phrase. Check for a typo or a missing word.</p>}
          {isValidMnemonic(typed) && passwordForm(normalizeMnemonic(typed))}
          <button className="secondary" onClick={() => setMode('choose')}>Back</button>
        </>
      )}
    </section>
  );
}

function Unlock({ net, vault, onOpen }: { net: NetworkConfig; vault: VaultRecord; onOpen: (a: Account) => void }) {
  const [pw, setPw] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const go = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      onOpen(new Account(seedFromMnemonic(await openMnemonic(vault, pw)), net));
    } catch {
      setError('Wrong password.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="card" onSubmit={go}>
      <h2>Unlock your wallet</h2>
      <label>Password<input type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} /></label>
      {error && <p className="error">{error}</p>}
      <button disabled={busy || !pw}>{busy ? 'Unlocking…' : 'Unlock'}</button>
    </form>
  );
}

type Tab = 'receive' | 'send' | 'history' | 'backup';

function Unlocked({ ctx, net, account, onLock, onRemoved }: { ctx: Ctx; net: NetworkConfig; account: Account; onLock: () => void; onRemoved: () => void }) {
  const api = useMemo(() => new Esplora(net.esplora), [net]);
  const [snap, setSnap] = useState<Snapshot>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<Tab>('receive');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try { setSnap(await scanWallet(account, api)); } catch (e) { setError((e as Error).message); } finally { setLoading(false); }
  }, [account, api]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const showNaira = !net.testCoins && !!ctx.rate;
  const naira = (sats: number) => (showNaira ? ` (≈ ${formatNaira(satsToNaira(sats, ctx.rate!.ngnPerBtc))})` : '');

  return (
    <>
      <section className="card">
        <div className="row">
          <div>
            <div className="muted small">{net.testCoins ? `${net.name} test network, worthless test coins` : 'Bitcoin'}</div>
            <div className="balance">{snap ? `${snap.confirmedSats.toLocaleString('en')} sats` : '…'}</div>
            {snap && showNaira && <div className="muted">≈ {formatNaira(satsToNaira(snap.confirmedSats, ctx.rate!.ngnPerBtc))}</div>}
            {snap && snap.pendingSats > 0 && <div className="muted small">+ {snap.pendingSats.toLocaleString('en')} sats waiting for a confirmation</div>}
          </div>
          <div className="right">
            <button className="secondary" disabled={loading} onClick={refresh}>{loading ? 'Refreshing…' : 'Refresh'}</button>{' '}
            <button className="secondary" onClick={onLock}>Lock</button>
          </div>
        </div>
        {error && <p className="error">{error}</p>}
      </section>

      <div className="tabs" role="tablist">
        {(['receive', 'send', 'history', 'backup'] as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'tab on' : 'tab'} onClick={() => setTab(t)}>{t[0]!.toUpperCase() + t.slice(1)}</button>
        ))}
      </div>

      {tab === 'receive' && <ReceiveOnChain net={net} account={account} snap={snap} />}
      {tab === 'send' && <SendOnChain net={net} account={account} api={api} snap={snap} naira={naira} onSent={refresh} />}
      {tab === 'history' && <HistoryOnChain net={net} snap={snap} naira={naira} />}
      {tab === 'backup' && <Backup net={net} onRemoved={onRemoved} />}
    </>
  );
}

function ReceiveOnChain({ net, account, snap }: { net: NetworkConfig; account: Account; snap?: Snapshot }) {
  const [copied, setCopied] = useState(false);
  if (!snap) return <section className="card"><p className="muted">Looking at the blockchain…</p></section>;
  const address = account.address(0, snap.nextReceive);
  const copy = async () => { try { await navigator.clipboard.writeText(address); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* select by hand */ } };
  return (
    <section className="card">
      <h2>Receive Bitcoin</h2>
      <div className="qr">
        <QrImage text={`bitcoin:${address}`} label="Bitcoin address QR code" />
        <div>
          <p className="muted small">Your address</p>
          <p><code className="address" data-testid="receive-address">{address}</code></p>
          <button className="secondary" onClick={copy}>{copied ? 'Copied' : 'Copy address'}</button>
        </div>
      </div>
      <p className="muted small">A new address is shown after this one has been used, which keeps your payments harder to link together. Old addresses still work.</p>
      {net.faucet && <p className="muted small">Need test coins? Get some free at <a href={net.faucet} target="_blank" rel="noreferrer">{net.faucet.replace('https://', '')}</a>.</p>}
    </section>
  );
}

const SPEEDS = [{ key: 'slow', label: 'Slow', target: 12 }, { key: 'normal', label: 'Normal', target: 3 }, { key: 'fast', label: 'Fast', target: 1 }] as const;

function SendOnChain({ net, account, api, snap, naira, onSent }: { net: NetworkConfig; account: Account; api: Esplora; snap?: Snapshot; naira: (s: number) => string; onSent: () => void }) {
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [max, setMax] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]['key']>('normal');
  const [estimates, setEstimates] = useState<Record<string, number>>();
  const [review, setReview] = useState<{ plan: Plan; built: Built; to: string }>();
  const [sent, setSent] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => { api.feeEstimates().then(setEstimates).catch(() => setEstimates({})); }, [api]);
  const rateFor = (target: number) => (estimates ? pickFeeRate(estimates, target) : 1);

  const prepare = () => {
    setError(undefined);
    try {
      if (!snap) throw new Error('Still looking at the blockchain. Try again in a moment.');
      const address = checkAddress(to, net);
      const target = SPEEDS.find((s) => s.key === speed)!.target;
      const plan = planSend({ utxos: snap.utxos, amountSats: max ? undefined : Number(amount), feeRate: rateFor(target), sendAll: max });
      assertSaneFee(plan);
      const built = buildTransaction(plan, address, account.address(1, snap.nextChange), account, net);
      setReview({ plan, built, to: address });
    } catch (e) {
      setError(e instanceof SendError || e instanceof Error ? e.message : String(e));
    }
  };

  const broadcast = async () => {
    if (!review) return;
    setBusy(true);
    setError(undefined);
    try {
      setSent(await api.broadcast(review.built.hex)); // the same signed transaction can be offered again safely
      onSent();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (sent) {
    return (
      <section className="card">
        <h2>Sent</h2>
        <p>✓ The network accepted your payment. It confirms in a few minutes (on {net.name}, usually under a minute).</p>
        <p className="muted small">Transaction: <a href={`${net.explorer}/tx/${sent}`} target="_blank" rel="noreferrer"><code>{sent.slice(0, 16)}…</code></a></p>
        <button className="secondary" onClick={() => { setSent(undefined); setReview(undefined); setTo(''); setAmount(''); setMax(false); }}>Send another</button>
      </section>
    );
  }
  if (review) {
    const total = review.plan.toSats + review.plan.feeSats;
    return (
      <section className="card">
        <h2>Check before you send</h2>
        <dl className="kv">
          <dt>To</dt><dd><code className="address">{review.to}</code></dd>
          <dt>Amount</dt><dd><b>{review.plan.toSats.toLocaleString('en')} sats</b>{naira(review.plan.toSats)}</dd>
          <dt>Network fee</dt><dd>{review.plan.feeSats.toLocaleString('en')} sats ({review.plan.feeRate} sat/vB){naira(review.plan.feeSats)}</dd>
          <dt>Total leaving</dt><dd>{total.toLocaleString('en')} sats</dd>
          <dt>Change back to you</dt><dd>{review.plan.changeSats.toLocaleString('en')} sats</dd>
        </dl>
        <p className="muted small">A Bitcoin payment can't be undone. Check the address carefully.</p>
        {error && <p className="error">{error}</p>}
        <button disabled={busy} onClick={broadcast}>{busy ? 'Sending…' : 'Sign and send'}</button>{' '}
        <button className="secondary" disabled={busy} onClick={() => { setReview(undefined); setError(undefined); }}>Edit</button>
      </section>
    );
  }
  return (
    <form className="card" onSubmit={(e) => { e.preventDefault(); prepare(); }}>
      <h2>Send Bitcoin</h2>
      <label>To address<input autoComplete="off" autoCapitalize="none" value={to} onChange={(e) => setTo(e.target.value)} placeholder={net.testCoins ? 'tb1q…' : 'bc1q…'} /></label>
      <label>Amount (sats)
        <input inputMode="numeric" disabled={max} value={max ? '' : amount} onChange={(e) => setAmount(e.target.value)} placeholder={max ? 'everything, less the fee' : ''} />
      </label>
      <label className="radio"><input type="checkbox" checked={max} onChange={(e) => setMax(e.target.checked)} /> Send everything</label>
      <fieldset className="mode">
        <legend>How fast</legend>
        {SPEEDS.map((s) => (
          <label key={s.key} className="radio"><input type="radio" name="speed" checked={speed === s.key} onChange={() => setSpeed(s.key)} /> {s.label} <span className="muted small">({rateFor(s.target)} sat/vB, about {Math.round(s.target * (net.name === 'signet' ? 0.5 : 10))} min)</span></label>
        ))}
      </fieldset>
      {error && <p className="error">{error}</p>}
      <button disabled={!to.trim() || (!max && !amount)}>Review</button>
    </form>
  );
}

function HistoryOnChain({ net, snap, naira }: { net: NetworkConfig; snap?: Snapshot; naira: (s: number) => string }) {
  if (!snap) return <section className="card"><p className="muted">Looking at the blockchain…</p></section>;
  if (!snap.txs.length) return <section className="card"><p className="muted">No payments yet.</p></section>;
  return (
    <section className="card txs">
      <ul>
        {snap.txs.map((t) => {
          const confirmations = t.confirmed && t.blockHeight ? snap.tip - t.blockHeight + 1 : 0;
          return (
            <li key={t.txid}>
              <div>
                <strong>{t.netSats >= 0 ? 'Received' : 'Sent'}</strong>
                {!t.confirmed && <span className="tag app">waiting</span>}
                <div className="muted small">
                  {t.time ? new Date(t.time * 1000).toLocaleString('en', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : 'just now'}
                  {t.confirmed ? ` · ${confirmations} confirmation${confirmations === 1 ? '' : 's'}` : ''} ·{' '}
                  <a href={`${net.explorer}/tx/${t.txid}`} target="_blank" rel="noreferrer">view</a>
                </div>
              </div>
              <div className={t.netSats >= 0 ? 'in' : 'out'}>{t.netSats >= 0 ? '+' : '−'}{Math.abs(t.netSats).toLocaleString('en')} sats{naira(Math.abs(t.netSats))}</div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Backup({ net, onRemoved }: { net: NetworkConfig; onRemoved: () => void }) {
  const [pw, setPw] = useState('');
  const [phrase, setPhrase] = useState<string>();
  const [error, setError] = useState<string>();
  const [sure, setSure] = useState('');
  const reveal = async (e: React.FormEvent) => {
    e.preventDefault();
    const vault = loadVault();
    if (!vault) return;
    try { setPhrase(await openMnemonic(vault, pw)); setError(undefined); } catch { setError('Wrong password.'); }
  };
  return (
    <>
      <section className="card">
        <h2>Your recovery phrase</h2>
        <p className="muted">These twelve words restore your wallet on any device. Make sure nobody can see your screen.</p>
        {phrase ? (
          <>
            <Words phrase={phrase} />
            <button className="secondary" onClick={() => { setPhrase(undefined); setPw(''); }}>Hide</button>
          </>
        ) : (
          <form onSubmit={reveal}>
            <label>Your password<input type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} /></label>
            {error && <p className="error">{error}</p>}
            <button disabled={!pw}>Show the words</button>
          </form>
        )}
      </section>
      <section className="card">
        <h2>Remove this wallet from this device</h2>
        <p className="warn">Without your twelve words, any coins in it are <b>gone for good</b>. Only do this once you have them written down.</p>
        <label>Type <b>remove</b> to confirm<input value={sure} onChange={(e) => setSure(e.target.value)} autoComplete="off" /></label>
        <button className="secondary" disabled={sure.trim().toLowerCase() !== 'remove'} onClick={() => { removeVault(); onRemoved(); }}>Remove wallet</button>
        {net.testCoins && <p className="muted small">It holds test coins, so nothing of value is at risk here.</p>}
      </section>
    </>
  );
}
