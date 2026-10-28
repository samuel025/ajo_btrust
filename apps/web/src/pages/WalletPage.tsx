import { useCallback, useEffect, useState } from 'react';
import type { Ctx } from '../App';
import { BitcoinWallet } from './BitcoinWallet';
import { InvoiceQr } from '../components/InvoiceQr';
import { withNaira, formatNaira, satsToNaira } from '../lib/rate';
import {
  createInvoice, describeWalletError, invoiceFromAddress, invoiceIsExpired, invoiceSettled, isNwcUrl, parseSendInput,
  sendPayment, walletBalanceSats, walletInfo, walletTransactions, type Payment, type ReceiveInvoice, type Tx, type WalletInfo,
} from '../lib/wallet';

/** Two wallets side by side: Bitcoin held with your own keys here, and Lightning through a wallet you connect. */
export function WalletPage({ ctx }: { ctx: Ctx }) {
  const [kind, setKind] = useState<'bitcoin' | 'lightning'>('bitcoin');
  return (
    <>
      <h1>Wallet</h1>
      <div className="tabs" role="tablist" aria-label="Wallet type">
        <button role="tab" aria-selected={kind === 'bitcoin'} className={kind === 'bitcoin' ? 'tab on' : 'tab'} onClick={() => setKind('bitcoin')}>Bitcoin (your keys)</button>
        <button role="tab" aria-selected={kind === 'lightning'} className={kind === 'lightning' ? 'tab on' : 'tab'} onClick={() => setKind('lightning')}>Lightning (connect a wallet)</button>
      </div>
      {kind === 'bitcoin' ? <BitcoinWallet ctx={ctx} /> : <LightningWallet ctx={ctx} />}
    </>
  );
}

function LightningWallet({ ctx }: { ctx: Ctx }) {
  const url = ctx.settings.nwcUrl;
  return url ? <Connected ctx={ctx} url={url} /> : <ConnectCard ctx={ctx} />;
}

function ConnectCard({ ctx }: { ctx: Ctx }) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const connect = async (e: React.FormEvent) => {
    e.preventDefault();
    const url = text.trim();
    if (!isNwcUrl(url)) return setError('That is not a wallet connection. It starts with nostr+walletconnect://');
    setError(undefined);
    setBusy(true);
    try {
      await walletInfo(url); // prove it works before keeping it
      ctx.updateSettings({ nwcUrl: url });
    } catch (err) {
      setError(describeWalletError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={connect}>
      <p className="muted">
        Send and receive Bitcoin over Lightning from your own wallet. The money stays in <i>your</i> wallet; this page only asks it to
        pay or to make an invoice, through Nostr Wallet Connect (NWC).
      </p>
      <section className="card">
        <h2>Connect your wallet</h2>
        <ol className="steps">
          <li>In your wallet (for example Alby Hub: Connections, then Add connection), create a connection.</li>
          <li>Give it only what you need. A <b>spending budget</b> is wise.</li>
          <li>Copy the connection and paste it here.</li>
        </ol>
        <label>Wallet connection
          <input type="password" autoComplete="off" value={text} onChange={(e) => setText(e.target.value)} placeholder="nostr+walletconnect://…" />
          <span className="muted small">Kept in this browser only. Treat it like a password.</span>
        </label>
        {error && <p className="error">{error}</p>}
        <button aria-busy={busy} disabled={busy || !text.trim()}>{busy ? 'Checking…' : 'Connect'}</button>
      </section>
    </form>
  );
}

type Tab = 'receive' | 'send' | 'history';

function Connected({ ctx, url }: { ctx: Ctx; url: string }) {
  const [info, setInfo] = useState<WalletInfo>();
  const [balance, setBalance] = useState<number>();
  const [txs, setTxs] = useState<Tx[]>();
  const [error, setError] = useState<string>();
  const [tab, setTab] = useState<Tab>('receive');
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const i = await walletInfo(url);
      setInfo(i);
      const [b, t] = await Promise.all([
        i.methods.includes('get_balance') ? walletBalanceSats(url) : Promise.resolve(undefined),
        i.methods.includes('list_transactions') ? walletTransactions(url) : Promise.resolve(undefined),
      ]);
      setBalance(b);
      setTxs(t);
    } catch (e) {
      setError(describeWalletError(e));
    } finally {
      setLoading(false);
    }
  }, [url]);
  useEffect(() => { void refresh(); }, [refresh]);

  const testNetwork = !!info && info.network !== '' && info.network !== 'mainnet';
  const can = (m: string) => !info || info.methods.includes(m);
  // Test coins have no value, so nothing below the balance should price them in naira either.
  // Until the wallet says which network it is on, assume the safer answer: no naira.
  const priced: Ctx = !info || testNetwork ? { ...ctx, rate: undefined } : ctx;

  return (
    <>
      <section className="card">
        <div className="row">
          <div>
            <div className="muted small">{!info ? 'connecting…' : [info.alias, info.network && (testNetwork ? `${info.network} (test coins)` : info.network)].filter(Boolean).join(' · ') || 'wallet connected'}</div>
            {info && !can('get_balance')
              ? <div className="muted">This connection can't read the balance.</div>
              : <div className="balance">{balance === undefined ? '…' : `${balance.toLocaleString('en')} sats`}</div>}
            {balance !== undefined && !testNetwork && ctx.rate && <div className="muted">≈ {formatNaira(satsToNaira(balance, ctx.rate.ngnPerBtc))}</div>}
            {testNetwork && <div className="muted small">Test coins have no value, so no naira estimate is shown.</div>}
          </div>
          <div className="right">
            <button className="secondary" aria-busy={loading} disabled={loading} onClick={refresh}>{loading ? 'Refreshing…' : 'Refresh'}</button>
          </div>
        </div>
        {info?.budget && <BudgetMeter budget={info.budget} />}
        {error && <p className="error">{error}</p>}
        <details>
          <summary className="small muted">About this connection</summary>
          <p className="muted small">It can: {info ? info.methods.map((m) => m.replace(/_/g, ' ')).join(', ') : '…'}.</p>
          <button className="secondary" onClick={() => ctx.updateSettings({ nwcUrl: '' })}>Disconnect this wallet</button>
        </details>
      </section>

      <div className="tabs" role="tablist">
        {(['receive', 'send', 'history'] as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'tab on' : 'tab'} onClick={() => setTab(t)}>
            {t === 'receive' ? 'Receive' : t === 'send' ? 'Send' : 'History'}
          </button>
        ))}
      </div>

      {tab === 'receive' && (can('make_invoice') ? <Receive url={url} ctx={priced} onDone={refresh} /> : <Missing what="create invoices" />)}
      {tab === 'send' && (can('pay_invoice') ? <Send url={url} ctx={priced} onDone={refresh} /> : <Missing what="send payments" />)}
      {tab === 'history' && <History txs={txs} ctx={priced} missing={!can('list_transactions')} />}
    </>
  );
}

const Missing = ({ what }: { what: string }) => (
  <section className="card"><p className="muted">This connection isn't allowed to {what}. Create a connection with that permission in your wallet.</p></section>
);

function BudgetMeter({ budget }: { budget: NonNullable<WalletInfo['budget']> }) {
  const left = Math.max(0, budget.totalSats - budget.usedSats);
  const pct = Math.min(100, Math.round((budget.usedSats / budget.totalSats) * 100));
  return (
    <div className="budget">
      <div className="small">Spending budget: {budget.usedSats.toLocaleString('en')} of {budget.totalSats.toLocaleString('en')} sats used
        {budget.period ? ` (${budget.period})` : ''}; {left.toLocaleString('en')} left
        {budget.renewsAt ? `, renews ${new Date(budget.renewsAt * 1000).toLocaleDateString('en', { day: 'numeric', month: 'short' })}` : ''}.</div>
      <div className="meter" aria-hidden="true"><i style={{ width: `${pct}%` }} /></div>
    </div>
  );
}

function Receive({ url, ctx, onDone }: { url: string; ctx: Ctx; onDone: () => void }) {
  const [amount, setAmount] = useState('1000');
  const [note, setNote] = useState('');
  const [inv, setInv] = useState<ReceiveInvoice>();
  const [paid, setPaid] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!inv || paid) return;
    let alive = true;
    const timer = setInterval(async () => {
      try {
        if (await invoiceSettled(url, inv.paymentHash) && alive) { setPaid(true); onDone(); }
      } catch { /* try again on the next tick */ }
    }, 3000);
    return () => { alive = false; clearInterval(timer); };
  }, [inv, paid, url, onDone]);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    const sats = Number(amount);
    if (!Number.isInteger(sats) || sats < 1) return setError('Enter the amount as a whole number of sats.');
    setError(undefined);
    setBusy(true);
    try {
      setInv(await createInvoice(url, sats, note.trim() || 'Bitcoin Ajo wallet'));
      setPaid(false);
    } catch (err) {
      setError(describeWalletError(err));
    } finally {
      setBusy(false);
    }
  };

  if (inv) {
    return (
      <section className="card">
        {paid ? (
          <>
            <h2>Received</h2>
            <p>✓ {withNaira(Number(amount), ctx.rate)} arrived in your wallet.</p>
          </>
        ) : (
          <>
            <h2>Waiting for {withNaira(Number(amount), ctx.rate)}</h2>
            <InvoiceQr invoice={inv.invoice} />
            <p className="muted small">Show this to the sender, or send them the invoice. This page notices when it is paid.</p>
          </>
        )}
        <button className="secondary" onClick={() => { setInv(undefined); setPaid(false); }}>{paid ? 'Receive another' : 'Cancel'}</button>
      </section>
    );
  }
  return (
    <form className="card" onSubmit={create}>
      <h2>Receive</h2>
      <label>Amount (sats)
        <input inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} />
        {ctx.rate && Number(amount) > 0 && <span className="muted small">≈ {formatNaira(satsToNaira(Number(amount), ctx.rate.ngnPerBtc))} today</span>}
      </label>
      <label>What is it for? (optional)
        <input value={note} maxLength={120} onChange={(e) => setNote(e.target.value)} placeholder="Ajo contribution, market sale…" />
      </label>
      {error && <p className="error">{error}</p>}
      <button aria-busy={busy} disabled={busy}>{busy ? 'Creating…' : 'Create invoice'}</button>
    </form>
  );
}

function Send({ url, ctx, onDone }: { url: string; ctx: Ctx; onDone: () => void }) {
  const [text, setText] = useState('');
  const [amount, setAmount] = useState('');
  const [invoice, setInvoice] = useState<string>();
  const [paid, setPaid] = useState<Payment>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const target = parseSendInput(text);
  const typed = text.trim() !== '';
  const now = Math.floor(Date.now() / 1000);
  const expired = invoiceIsExpired(target, now);
  const needsAmount = target.kind === 'address' || (target.kind === 'invoice' && target.amountSats === undefined);
  const sats = Number(amount);
  const amountOk = Number.isInteger(sats) && sats > 0;

  const reset = () => { setText(''); setAmount(''); setInvoice(undefined); setPaid(undefined); setError(undefined); };

  const prepare = async () => {
    setError(undefined);
    setBusy(true);
    try {
      if (target.kind === 'address') setInvoice(await invoiceFromAddress(target.address, sats));
    } catch (err) {
      setError(describeWalletError(err));
    } finally {
      setBusy(false);
    }
  };

  const pay = async () => {
    const finalInvoice = invoice ?? (target.kind === 'invoice' ? target.invoice : undefined);
    if (!finalInvoice) return;
    const zeroAmount = target.kind === 'invoice' && target.amountSats === undefined;
    setError(undefined);
    setBusy(true);
    try {
      setPaid(await sendPayment(url, finalInvoice, zeroAmount ? sats : undefined));
      onDone();
    } catch (err) {
      setError(describeWalletError(err));
    } finally {
      setBusy(false);
    }
  };

  if (paid) {
    return (
      <section className="card">
        <h2>Sent</h2>
        <p>✓ Paid{paid.feeSats ? `, network fee ${paid.feeSats.toLocaleString('en')} sats` : ', no network fee'}.</p>
        <p className="muted small">Proof of payment (preimage): <code>{paid.preimage}</code></p>
        <button className="secondary" onClick={reset}>Send another</button>
      </section>
    );
  }

  // What will actually be paid: the invoice's own amount, or what the person typed.
  const payAmount = target.kind === 'invoice' && target.amountSats !== undefined ? target.amountSats : invoice ? sats : undefined;
  const ready = !!invoice || (target.kind === 'invoice' && !expired && (!needsAmount || amountOk));

  return (
    <section className="card">
      <h2>Send</h2>
      <label>Invoice or Lightning address
        <textarea rows={3} value={text} onChange={(e) => { setText(e.target.value); setInvoice(undefined); setError(undefined); }} placeholder="lntbs… or name@wallet.com" />
      </label>
      {typed && target.kind === 'invalid' && <p className="error">{target.reason}</p>}
      {target.kind === 'invoice' && expired && <p className="error">That invoice has expired. Ask for a new one.</p>}
      {target.kind === 'invoice' && !expired && target.amountSats !== undefined && <p>Pay <b>{withNaira(target.amountSats, ctx.rate)}</b> to this invoice.</p>}
      {needsAmount && !invoice && (
        <label>Amount (sats)
          <input inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} />
          {ctx.rate && amountOk && <span className="muted small">≈ {formatNaira(satsToNaira(sats, ctx.rate.ngnPerBtc))} today</span>}
        </label>
      )}
      {target.kind === 'address' && !invoice && <button aria-busy={busy} disabled={busy || !amountOk} onClick={prepare}>{busy ? 'Contacting…' : 'Get invoice'}</button>}
      {invoice && target.kind === 'address' && <p>Pay <b>{withNaira(sats, ctx.rate)}</b> to <b>{target.address}</b>.</p>}
      {error && <p className="error">{error}</p>}
      {ready && <button aria-busy={busy} disabled={busy} onClick={pay}>{busy ? 'Paying…' : `Pay ${payAmount !== undefined ? payAmount.toLocaleString('en') + ' sats' : ''}`.trim()}</button>}
      <p className="muted small">A payment can't be undone. If this page says it didn't hear back, check History before trying again.</p>
    </section>
  );
}

function History({ txs, ctx, missing }: { txs?: Tx[]; ctx: Ctx; missing: boolean }) {
  if (missing) return <Missing what="read the payment history" />;
  if (!txs) return <section className="card"><p className="muted">Loading…</p></section>;
  if (!txs.length) return <section className="card"><p className="muted">No payments yet.</p></section>;
  return (
    <section className="card txs">
      <ul>
        {txs.map((t, i) => (
          <li key={`${t.paymentHash ?? i}:${t.at}`}>
            <div>
              <strong>{t.type === 'incoming' ? 'Received' : 'Sent'}</strong>
              {t.state !== 'settled' && <span className="tag app">{t.state}</span>}
              <div className="muted small">{t.description || '—'} · {new Date(t.at * 1000).toLocaleString('en', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</div>
            </div>
            <div className={t.type === 'incoming' ? 'in' : 'out'}>
              {t.type === 'incoming' ? '+' : '−'}{t.amountSats.toLocaleString('en')} sats
              {t.feeSats > 0 && <div className="muted small">fee {t.feeSats}</div>}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
