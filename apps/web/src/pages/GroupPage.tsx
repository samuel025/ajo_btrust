import { useState } from 'react';
import { autopayEvent, effectiveGroup, joinEvent, receiptEvent, roundCount, roundDeadline, recipientForRound, type GroupDef, type GroupKey, type RoundState } from '@ajo/core';
import { loadActivity, loadGroup, publish, type GroupActivity } from '../lib/ledger';
import { usePoll } from '../lib/hooks';
import { payInvoice } from '../lib/pay';
import { formatDate, formatSats, frequencyLabel, shortKey, validateAddress } from '../lib/format';
import type { Ctx } from '../App';

/** The first round that isn't complete, or undefined once everyone has been paid. */
function currentRound(group: GroupDef, rounds: Map<number, RoundState>): number | undefined {
  for (let n = 0; n < roundCount(group); n++) if (rounds.get(n)?.status !== 'complete') return n;
  return undefined;
}

export function GroupPage({ ctx, author, id }: { ctx: Ctx; author: string; id: string }) {
  const relay = ctx.settings.relay;
  const { data: loaded, error } = usePoll(() => loadGroup(relay, { author, id }, ctx.signer), [relay, author, id], 10000);
  if (error) return <p className="error">Couldn't load this group from {relay}. {error}</p>;
  if (!loaded) return <p className="muted">Loading group…</p>;
  return <Loaded ctx={ctx} published={loaded.group} groupKey={loaded.key} />;
}

function Loaded({ ctx, published, groupKey }: { ctx: Ctx; published: GroupDef; groupKey: GroupKey }) {
  const relay = ctx.settings.relay;
  const me = ctx.signer.pubkey;
  const { data: activity, refresh } = usePoll(() => loadActivity(relay, published, groupKey, ctx.signer), [relay, published.id]);
  // A deferred recipient changes the payout order; the coordinator records it in the round state.
  const group = activity ? effectiveGroup(published, activity.rounds) : published;
  const isMember = group.payoutOrder.includes(me);
  const current = activity ? currentRound(group, activity.rounds) : undefined;

  return (
    <>
      <h1>{group.name}</h1>
      <p className="muted">
        {formatSats(group.amountSats)} per round · {frequencyLabel[group.frequency]} · {group.payoutOrder.length} members
      </p>

      {!isMember && <p className="error">You're not a member of this group.</p>}
      {isMember && activity && !activity.addresses[me] && <JoinCard ctx={ctx} group={group} groupKey={groupKey} onDone={refresh} />}
      {isMember && activity && activity.addresses[me] && (
        <ActionCard ctx={ctx} group={group} groupKey={groupKey} activity={activity} round={current} onPaid={refresh} />
      )}

      {isMember && activity?.addresses[me] && <AutopayCard ctx={ctx} group={group} enabled={activity.autopay} onChanged={refresh} />}

      <h2>Schedule</h2>
      <table>
        <thead><tr><th>Round</th><th>Recipient</th><th>Due</th><th>Paid</th></tr></thead>
        <tbody>
          {group.payoutOrder.map((_, n) => {
            const state = activity?.rounds.get(n);
            const recipient = state?.recipient ?? recipientForRound(group, n);
            const owing = group.payoutOrder.length - 1;
            return (
              <tr key={n} className={n === current ? 'current' : undefined}>
                <td>{n + 1}</td>
                <td>{shortKey(recipient)}{recipient === me && <span className="tag">you</span>}</td>
                <td>{formatDate(state?.deadline ?? roundDeadline(group, n))}</td>
                <td>{state?.status === 'complete' ? 'Complete' : state ? `${state.paid.length} of ${owing}` : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <h2>Members</h2>
      <ul className="members">
        {group.payoutOrder.map((m) => (
          <li key={m}>
            <span>{shortKey(m)}{m === me && <span className="tag">you</span>}</span>
            <span className="muted small">{activity?.addresses[m] ?? 'not joined yet'}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

function JoinCard({ ctx, group, groupKey, onDone }: { ctx: Ctx; group: GroupDef; groupKey: GroupKey; onDone: () => void }) {
  const [address, setAddress] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const join = async (e: React.FormEvent) => {
    e.preventDefault();
    const problem = validateAddress(address);
    if (problem) return setError(problem);
    setBusy(true);
    try {
      await publish(ctx.settings.relay, ctx.signer, joinEvent({ groupId: group.id, lightningAddress: address.trim() }, groupKey));
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card" onSubmit={join}>
      <h2>Join this group</h2>
      <p className="muted">By joining you agree to pay {formatSats(group.amountSats)} each round. Members pay you at this Lightning address when it's your turn.</p>
      <label>Your Lightning address
        <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="you@wallet.com" />
      </label>
      {error && <p className="error">{error}</p>}
      <button disabled={busy}>{busy ? 'Joining…' : 'Join'}</button>
    </form>
  );
}

function ActionCard({ ctx, group, groupKey, activity, round, onPaid }: {
  ctx: Ctx; group: GroupDef; groupKey: GroupKey; activity: GroupActivity; round: number | undefined; onPaid: () => void;
}) {
  const me = ctx.signer.pubkey;
  const [status, setStatus] = useState<'idle' | 'paying' | 'sent'>('idle');
  const [error, setError] = useState<string>();

  if (round === undefined) return <section className="card"><h2>All done</h2><p>Every member has been paid. This cycle is complete.</p></section>;
  const state = activity.rounds.get(round);
  const heading = `Round ${round + 1}`;

  if (!state) return <section className="card"><h2>{heading}</h2><p className="muted">Waiting for the coordinator to open this round.</p></section>;

  if (state.recipient === me) {
    return (
      <section className="card">
        <h2>{heading}: your turn to receive</h2>
        <p>{state.paid.length} of {group.payoutOrder.length - 1} members have paid you so far. The money goes straight to your wallet.</p>
      </section>
    );
  }
  if (state.paid.includes(me) || status === 'sent') {
    return <section className="card"><h2>{heading}</h2><p>✓ You've paid. {state.paid.includes(me) ? 'The coordinator has confirmed it.' : 'Waiting for the coordinator to confirm.'}</p></section>;
  }

  const invoice = state.invoices[me];
  const pay = async () => {
    setError(undefined);
    setStatus('paying');
    try {
      const preimage = await payInvoice(ctx.settings.nwcUrl, invoice!);
      await publish(ctx.settings.relay, ctx.signer, receiptEvent({
        groupId: group.id, round, payer: me, recipient: state.recipient, invoice: invoice!, preimage,
      }, groupKey));
      setStatus('sent');
      onPaid();
    } catch (err) {
      setError((err as Error).message);
      setStatus('idle');
    }
  };

  return (
    <section className="card">
      <h2>{heading}: pay {shortKey(state.recipient)}</h2>
      <p>{formatSats(group.amountSats)} due by {formatDate(state.deadline)}.</p>
      {activity.autopay && <p className="muted">Auto-pay is on, so the coordinator will pay this for you. You can also pay now.</p>}
      {!invoice && <p className="muted">Waiting for the coordinator to get your invoice from the recipient.</p>}
      {invoice && !ctx.settings.nwcUrl && <p className="muted">Connect your wallet in <a href="#/settings">Settings</a> to pay from here.</p>}
      {error && <p className="error">{error}</p>}
      <button disabled={!invoice || !ctx.settings.nwcUrl || status === 'paying'} onClick={pay}>
        {status === 'paying' ? 'Paying…' : `Pay ${formatSats(group.amountSats)}`}
      </button>
    </section>
  );
}

function AutopayCard({ ctx, group, enabled, onChanged }: { ctx: Ctx; group: GroupDef; enabled: boolean; onChanged: () => void }) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const save = async (nwcUrl: string | null) => {
    setError(undefined);
    if (nwcUrl !== null && !nwcUrl.startsWith('nostr+walletconnect://')) return setError('Paste a wallet connection that starts with nostr+walletconnect://');
    setBusy(true);
    try {
      await publish(ctx.settings.relay, ctx.signer, await autopayEvent(group.id, nwcUrl, group.coordinator, ctx.signer.cipher));
      setUrl('');
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (enabled) {
    return (
      <section className="card">
        <h2>Auto-pay is on</h2>
        <p className="muted">The coordinator pays your {formatSats(group.amountSats)} each round, up to the budget you set in your wallet.</p>
        {error && <p className="error">{error}</p>}
        <button className="secondary" disabled={busy} onClick={() => save(null)}>Turn off</button>
      </section>
    );
  }
  return (
    <details className="card">
      <summary><strong>Pay automatically (optional)</strong></summary>
      <p className="muted">
        In your wallet, create a new connection that can only pay invoices, with a budget of about {formatSats(group.amountSats)} per{' '}
        {group.frequency === 'monthly' ? 'month' : 'week'}. Paste it here and the coordinator pays your share each round. Only the
        coordinator can read it, and you can turn it off at any time.
      </p>
      <label>Wallet connection for the coordinator
        <input type="password" autoComplete="off" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="nostr+walletconnect://…" />
      </label>
      {error && <p className="error">{error}</p>}
      <button disabled={busy || !url} onClick={() => save(url.trim())}>Turn on auto-pay</button>
    </details>
  );
}
