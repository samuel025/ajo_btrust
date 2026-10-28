import { useEffect, useRef, useState } from 'react';
import { LANGUAGES, isUpcoming, roundOpensAt, standings, askEvent, autopayEvent, effectiveGroup, joinEvent, receiptEvent, roundCount, roundDeadline, recipientForRound, type GroupDef, type GroupKey, type Language, type RoundState } from '@ajo/core';
import { loadActivity, loadGroup, publish, publishGroupUpdate, type GroupActivity } from '../lib/ledger';
import { inviteLink } from '../lib/invite';
import { clearPending, loadPending } from '../lib/pending';
import { usePoll } from '../lib/hooks';
import { payInvoice } from '../lib/pay';
import { formatDate, formatDateTime, formatSats, frequencyLabel, nextNineAm, recordText, shortKey, validateAddress, validateBitcoinAddress } from '../lib/format';
import { formatNaira, satsToNaira, withNaira, type Rate } from '../lib/rate';
import { walletNetwork } from '../lib/onchain/config';
import { InvoiceQr } from '../components/InvoiceQr';
import { PayoutField } from '../components/PayoutField';
import { PayOnChain } from '../components/PayOnChain';
import { invoiceStatus } from '../lib/invoice';
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
  return <Loaded ctx={ctx} published={loaded.group} groupKey={loaded.key} author={author} />;
}

function Loaded({ ctx, published, groupKey, author }: { ctx: Ctx; published: GroupDef; groupKey: GroupKey; author: string }) {
  const relay = ctx.settings.relay;
  const me = ctx.signer.pubkey;
  const { data: activity, refresh } = usePoll(() => loadActivity(relay, published, groupKey, ctx.signer), [relay, published.id]);
  // A deferred recipient changes the payout order; the coordinator records it in the round state.
  const group = activity ? effectiveGroup(published, activity.rounds) : published;
  const isMember = group.payoutOrder.includes(me);
  const isOrganizer = me === author;

  // A person approved from an invite link entered their address when asking: finish joining for them.
  const autoJoined = useRef(false);
  useEffect(() => {
    if (!activity || !isMember || activity.addresses[me] || autoJoined.current) return;
    const pending = loadPending({ author, id: published.id });
    if (!pending) return;
    autoJoined.current = true;
    publish(relay, ctx.signer, joinEvent({ groupId: published.id, lightningAddress: pending.lightningAddress, bitcoinAddress: pending.bitcoinAddress, language: pending.language }, groupKey))
      .then(() => { clearPending({ author, id: published.id }); refresh(); })
      .catch(() => { autoJoined.current = false; });
  }, [activity, isMember]);
  const current = activity ? currentRound(group, activity.rounds) : undefined;
  const record = activity ? standings(group, [...activity.rounds.values()]) : undefined;

  return (
    <>
      <h1>{group.name}</h1>
      <p className="muted">
        {withNaira(group.amountSats, ctx.rate)} per round · {frequencyLabel[group.frequency]} · {group.payoutOrder.length} members{group.rail === 'onchain' ? ' · paid in Bitcoin on-chain' : ''}
      </p>

      {!isMember && <p className="error">You're not a member of this group.</p>}
      {group.forming && isOrganizer && activity && <FormingCard ctx={ctx} group={published} groupKey={groupKey} requests={activity.requests} onChanged={refresh} />}
      {group.forming && !isOrganizer && <section className="card"><h2>Waiting for the organizer</h2><p>People are still being added. The schedule starts when the organizer starts the group.</p></section>}
      {isMember && activity && !activity.addresses[me] && !loadPending({ author, id: published.id }) && <JoinCard ctx={ctx} group={group} groupKey={groupKey} onDone={refresh} />}
      {!group.forming && isMember && activity && activity.addresses[me] && (
        <ActionCard key={current ?? 'done'} ctx={ctx} group={group} groupKey={groupKey} activity={activity} round={current} onPaid={refresh} />
      )}

      {!group.forming && isMember && activity && activity.notices.length > 0 && <NoticesCard notices={activity.notices} />}
      {!group.forming && group.rail !== 'onchain' && isMember && activity?.addresses[me] && <AutopayCard ctx={ctx} group={group} enabled={activity.autopay} onChanged={refresh} />}

      {!group.forming && isMember && activity?.addresses[me] && <AssistantCard ctx={ctx} group={group} thread={activity.thread} onAsked={refresh} />}

      {!group.forming && (
        <>
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
                  <td>{formatDateTime(state?.deadline ?? roundDeadline(group, n))}</td>
                  <td>{paidCell(group, n, state, owing)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </>
      )}

      <h2>Members</h2>
      <ul className="members">
        {group.payoutOrder.map((m) => {
          const r = record?.[m];
          return (
            <li key={m}>
              <span>
                {shortKey(m)}{m === me && <span className="tag">you</span>}
                <div className="muted small">{activity?.addresses[m] ?? 'not joined yet'}</div>
              </span>
              <span className="right small">
                {r && <div className={r.defaulted ? 'warn' : 'muted'}>{recordText(r)}</div>}
                {r?.collectedAndLeft && <div className="warn"><strong>Received a payout, then stopped paying</strong></div>}
              </span>
            </li>
          );
        })}
      </ul>
    </>
  );
}

/** What the "Paid" column says about a round: done, in progress, or when it opens. */
function paidCell(group: GroupDef, n: number, state: RoundState | undefined, owing: number): string {
  const now = Math.floor(Date.now() / 1000);
  if (state?.status === 'complete') return `Complete${state.defaulted?.length ? ` · ${state.defaulted.length} didn't pay` : ''}`;
  const opensAt = state?.opensAt ?? roundOpensAt(group, n);
  if (opensAt > now) return `Opens ${formatDateTime(opensAt)}`;
  return state ? `${state.paid.length} of ${owing}` : '—';
}

function JoinCard({ ctx, group, groupKey, onDone }: { ctx: Ctx; group: GroupDef; groupKey: GroupKey; onDone: () => void }) {
  const [address, setAddress] = useState('');
  const [language, setLanguage] = useState<Language>('en');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const join = async (e: React.FormEvent) => {
    e.preventDefault();
    const onchain = group.rail === 'onchain';
    const problem = onchain ? validateBitcoinAddress(address) : validateAddress(address);
    if (problem) return setError(problem);
    setBusy(true);
    try {
      await publish(ctx.settings.relay, ctx.signer, joinEvent({ groupId: group.id, lightningAddress: onchain ? '' : address.trim(), bitcoinAddress: onchain ? address.trim() : undefined, language }, groupKey));
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
      <p className="muted">By joining you agree to pay {withNaira(group.amountSats, ctx.rate)} each round. Members pay you at this {group.rail === 'onchain' ? 'Bitcoin' : 'Lightning'} address when it's your turn.</p>
      <PayoutField rail={group.rail} value={address} onChange={setAddress} />
      <label>Language for reminders
        <select value={language} onChange={(e) => setLanguage(e.target.value as Language)}>
          {Object.entries(LANGUAGES).map(([code, name]) => <option key={code} value={code}>{name}</option>)}
        </select>
      </label>
      {error && <p className="error">{error}</p>}
      <button aria-busy={busy} disabled={busy}>{busy ? 'Joining…' : 'Join'}</button>
    </form>
  );
}

function ActionCard({ ctx, group, groupKey, activity, round, onPaid }: {
  ctx: Ctx; group: GroupDef; groupKey: GroupKey; activity: GroupActivity; round: number | undefined; onPaid: () => void;
}) {
  const me = ctx.signer.pubkey;
  const [status, setStatus] = useState<'idle' | 'paying' | 'sent'>('idle');
  const [error, setError] = useState<string>();
  const [proof, setProof] = useState('');

  if (round === undefined) return <section className="card"><h2>All done</h2><p>Every member has been paid. This cycle is complete.</p></section>;
  const state = activity.rounds.get(round);
  const heading = `Round ${round + 1}`;

  if (!state) return <section className="card"><h2>{heading}</h2><p className="muted">Waiting for the coordinator to open this round.</p></section>;

  if (isUpcoming(state, Math.floor(Date.now() / 1000))) {
    return (
      <section className="card">
        <h2>{heading} opens {formatDateTime(state.opensAt!)}</h2>
        <p>
          {state.recipient === me
            ? `You'll be paid in this round. Members can start paying you when it opens, and it's due ${formatDateTime(state.deadline)}.`
            : `You'll pay ${shortKey(state.recipient)} ${withNaira(group.amountSats, ctx.rate)} in this round. You can pay from ${formatDateTime(state.opensAt!)}, and it's due ${formatDateTime(state.deadline)}.`}
        </p>
      </section>
    );
  }

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

  if (group.rail === 'onchain') {
    // Test coins have no price, so no naira estimate is shown next to them.
    const priced = ctx.rate && walletNetwork().net?.testCoins === false;
    const naira = (sats: number) => (priced ? ` (≈ ${formatNaira(satsToNaira(sats, ctx.rate!.ngnPerBtc))})` : '');
    return (
      <section className="card">
        <h2>{heading}: pay {shortKey(state.recipient)}</h2>
        <p>{withNaira(group.amountSats, ctx.rate)} due by {formatDateTime(state.deadline)}, plus the network fee.</p>
        <PayOnChain group={group} state={state} recipientAddress={activity.addresses[state.recipient]} me={me} naira={naira} onSent={onPaid} />
      </section>
    );
  }

  const invoice = state.invoices[me];
  const autoConfirm = !!state.verify?.[me];
  // An invoice that has expired can't be paid; the coordinator replaces it shortly before that happens.
  const expired = !!invoice && invoiceStatus(invoice, Math.floor(Date.now() / 1000)) === 'expired';
  const usable = !!invoice && !expired;

  const publishReceipt = async (preimage: string) => {
    await publish(ctx.settings.relay, ctx.signer, receiptEvent({
      groupId: group.id, round, payer: me, recipient: state.recipient, invoice: invoice!, preimage,
    }, groupKey));
    setStatus('sent');
    onPaid();
  };

  const pay = async () => {
    setError(undefined);
    setStatus('paying');
    try {
      await publishReceipt(await payInvoice(ctx.settings.nwcUrl, invoice!));
    } catch (err) {
      setError((err as Error).message);
      setStatus('idle');
    }
  };

  const submitProof = async () => {
    setError(undefined);
    const preimage = proof.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(preimage)) return setError('Payment proof is 64 characters of letters a-f and numbers. Your wallet shows it as the "preimage".');
    setStatus('paying');
    try {
      await publishReceipt(preimage);
    } catch (err) {
      setError((err as Error).message);
      setStatus('idle');
    }
  };

  return (
    <section className="card">
      <h2>{heading}: pay {shortKey(state.recipient)}</h2>
      <p>{withNaira(group.amountSats, ctx.rate)} due by {formatDateTime(state.deadline)}.</p>
      {ctx.rate && <p className="muted small">{rateNote(ctx.rate)}</p>}
      {activity.autopay && <p className="muted">Auto-pay is on, so the coordinator will pay this for you. You can also pay now.</p>}
      {!invoice && <p className="muted">Waiting for the coordinator to get your invoice from the recipient.</p>}
      {expired && <p className="muted">The invoice has expired. The coordinator issues a fresh one automatically, usually within a minute, and it will appear here.</p>}
      {usable && (
        <>
          <p><strong>Pay with any Lightning wallet</strong></p>
          <InvoiceQr invoice={invoice} />
          <p className="muted small">
            {autoConfirm
              ? 'Scan it or open it in your wallet. The coordinator confirms the payment by itself, usually within a minute.'
              : "Scan it or open it in your wallet. This recipient's provider can't confirm payments by itself, so afterwards paste the payment proof below, or pay with a connected wallet."}
          </p>
          {!autoConfirm && (
            <details>
              <summary>I paid, and I have the payment proof</summary>
              <label>Payment proof (preimage)
                <input value={proof} onChange={(e) => setProof(e.target.value)} placeholder="64 letters and numbers" autoComplete="off" />
              </label>
              <button type="button" className="secondary" aria-busy={status === 'paying'} disabled={!proof.trim() || status === 'paying'} onClick={submitProof}>Submit proof</button>
            </details>
          )}
          {ctx.settings.nwcUrl ? (
            <p className="muted small">Or pay with your connected wallet:</p>
          ) : (
            <p className="muted small">Tip: connect a wallet in <a href="#/settings">Settings</a> to pay with one tap instead.</p>
          )}
        </>
      )}
      {error && <p className="error">{error}</p>}
      {usable && ctx.settings.nwcUrl && (
        <button aria-busy={status === 'paying'} disabled={status === 'paying'} onClick={pay}>
          {status === 'paying' ? 'Paying…' : `Pay ${formatSats(group.amountSats)}`}
        </button>
      )}
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
      <button aria-busy={busy} disabled={busy || !url} onClick={() => save(url.trim())}>{busy ? 'Turning on…' : 'Turn on auto-pay'}</button>
    </details>
  );
}

function NoticesCard({ notices }: { notices: GroupActivity['notices'] }) {
  return (
    <section className="card notice">
      <h2>From the coordinator</h2>
      {notices.slice(0, 3).map((n) => (
        <p key={`${n.at}:${n.stage}`}>{n.text} <span className="muted small">{formatDate(n.at)}</span></p>
      ))}
    </section>
  );
}

function AssistantCard({ ctx, group, thread, onAsked }: { ctx: Ctx; group: GroupDef; thread: GroupActivity['thread']; onAsked: () => void }) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const ask = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(undefined);
    setBusy(true);
    try {
      await publish(ctx.settings.relay, ctx.signer, await askEvent(group.id, text.trim(), group.coordinator, ctx.signer.cipher));
      setText('');
      onAsked();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <h2>Ask the assistant</h2>
      <p className="muted small">Ask in English, Pidgin, Yoruba or Hausa, for example "when is my turn?" or "who hasn't paid?".</p>
      <p className="muted small">
        Questions are encrypted on the relay. But if the coordinator uses an AI service (Google Gemini) to write answers and reminders,
        your question and the group's schedule are sent to it, and on Google's free tier they may be used to improve its products.
        Don't put anything private in a question.
      </p>
      {thread.slice(-4).map(({ question, answer }) => (
        <div key={question.id} className="qa">
          <p className="q">{question.text}</p>
          <p className="a">{answer ? answer.text : <span className="muted">Thinking…</span>}</p>
        </div>
      ))}
      <form onSubmit={ask} className="askrow">
        <input value={text} maxLength={500} onChange={(e) => setText(e.target.value)} placeholder="Ask a question" />
        <button aria-busy={busy} disabled={busy || !text.trim()}>{busy ? 'Asking…' : 'Ask'}</button>
      </form>
      {error && <p className="error">{error}</p>}
    </section>
  );
}

/** The contribution is fixed in sats, so its naira value moves with the market. */
function rateNote(rate: Rate): string {
  const time = new Date(rate.fetchedAt).toLocaleTimeString('en', { hour: 'numeric', minute: '2-digit' });
  return `Naira is an estimate at the ${time} market rate. The amount is fixed in sats, so its value in naira changes.`;
}

function FormingCard({ ctx, group, groupKey, requests, onChanged }: {
  ctx: Ctx; group: GroupDef; groupKey: GroupKey; requests: GroupActivity['requests']; onChanged: () => void;
}) {
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const link = inviteLink({ author: ctx.signer.pubkey, id: group.id, name: group.name, amountSats: group.amountSats, frequency: group.frequency, rail: group.rail });

  const update = async (next: GroupDef) => {
    setError(undefined);
    setBusy(true);
    try {
      await publishGroupUpdate(ctx.settings.relay, ctx.signer, next, groupKey);
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    try { await navigator.clipboard.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* the link is in the box to copy by hand */ }
  };

  // Round 1 opens now. If the first due date the organizer chose has passed, or is under an hour away,
  // the first due time moves to the next 9:00 AM. (The 10-minute testing period is due in 10 minutes.)
  const start = () => {
    const nowMs = Date.now();
    const startDate = group.frequency === 'testing' ? Math.floor(nowMs / 1000) + 600 : Math.max(group.startDate, nextNineAm(nowMs));
    return update({ ...group, forming: undefined, startedAt: Math.floor(nowMs / 1000), startDate });
  };

  return (
    <section className="card">
      <h2>Invite people</h2>
      <p className="muted">Send this link. People open it, ask to join, and you approve them here. Anyone with the link can ask, but nobody joins without your approval.</p>
      <div className="linkbox">
        <input readOnly value={link} onFocus={(e) => e.target.select()} aria-label="Invite link" />
        <button type="button" className="secondary" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
      </div>

      <h2>Requests to join</h2>
      {requests.length === 0 && <p className="muted">No requests yet.</p>}
      <ul className="requests">
        {requests.map((r) => (
          <li key={r.id}>
            <span>{shortKey(r.member)}<div className="muted small">{r.lightningAddress || r.bitcoinAddress}</div></span>
            <button aria-busy={busy} disabled={busy} onClick={() => update({ ...group, payoutOrder: [...group.payoutOrder, r.member] })}>{busy ? 'Adding…' : 'Add to group'}</button>
          </li>
        ))}
      </ul>

      <h2>Start the group</h2>
      <p className="muted small">{group.payoutOrder.length} in the group so far, in the order they were added (the first is paid first). Starting fixes who is in and opens round 1 for payment right away. Each later round opens when the one before it is due. You can't add people after.</p>
      {error && <p className="error">{error}</p>}
      <button aria-busy={busy} disabled={busy || group.payoutOrder.length < 2} onClick={start}>{busy ? 'Starting…' : 'Start the group'}</button>
      {group.payoutOrder.length < 2 && <p className="muted small">You need at least two people to start.</p>}
    </section>
  );
}
