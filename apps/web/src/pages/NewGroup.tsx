import { useState } from 'react';
import { nip19 } from 'nostr-tools';
import { createGroupKey, groupEvent, type Frequency, type GroupRail } from '@ajo/core';
import { publish } from '../lib/ledger';
import { nextNineAm, parseMembers, toHexPubkey } from '../lib/format';
import { formatNaira, nairaToSats, satsToNaira } from '../lib/rate';
import type { Ctx } from '../App';

/** Today's date in the person's own timezone, as the date field wants it (yyyy-mm-dd). */
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export function NewGroup({ ctx }: { ctx: Ctx }) {
  const me = nip19.npubEncode(ctx.signer.pubkey);
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('50000');
  const [frequency, setFrequency] = useState<Frequency>('weekly');
  const [rail, setRail] = useState<GroupRail>('lightning');
  const [start, setStart] = useState(today);
  const [coordinator, setCoordinator] = useState(ctx.settings.coordinator);
  const [members, setMembers] = useState(`${me}\n`);
  // Inviting by link is the easy path; pasting npubs is for organizers who already have them.
  const [mode, setMode] = useState<'invite' | 'npubs'>('invite');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(undefined);
    try {
      const payoutOrder = mode === 'invite' ? [ctx.signer.pubkey] : parseMembers(members);
      if (mode === 'npubs' && payoutOrder.length < 2) throw new Error('A group needs at least two members.');
      if (!payoutOrder.includes(ctx.signer.pubkey)) throw new Error('Include yourself in the member list.');
      const amountSats = Number(amount);
      if (!Number.isInteger(amountSats) || amountSats < 1) throw new Error('Enter the contribution as a whole number of sats.');
      if (!coordinator.trim()) throw new Error('Enter the coordinator bot\'s key (or set a default in Settings).');
      const id = `${name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Math.random().toString(36).slice(2, 7)}`;

      setBusy(true);
      await publish(ctx.settings.relay, ctx.signer, await groupEvent({
        id, name: name.trim(), amountSats, frequency, payoutOrder,
        // The first round is due at 9:00 on the chosen day. The 10-minute testing period ignores the date.
        // If 9:00 on that day has already passed (as it has for today, later in the day), the first round is due at the next 9:00.
        startDate: frequency === 'testing' ? Math.floor(Date.now() / 1000) + 600 : Math.max(Math.floor(new Date(`${start}T09:00:00`).getTime() / 1000), nextNineAm(Date.now())),
        // With a list of members the group starts now; with invite links it starts when the organizer says so.
        startedAt: mode === 'npubs' ? Math.floor(Date.now() / 1000) : undefined,
        coordinator: toHexPubkey(coordinator),
        forming: mode === 'invite' || undefined,
        rail: rail === 'onchain' ? 'onchain' : undefined,
      }, createGroupKey(), ctx.signer.cipher));
      ctx.navigate(`/g/${ctx.signer.pubkey}/${encodeURIComponent(id)}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <form className="narrow" onSubmit={submit}>
      <h1>New group</h1>
      <label>Group name
        <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Office ajo" />
      </label>
      <div className="grid2">
        <label>Contribution per round (sats)
          <input required inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} />
          {ctx.rate && Number(amount) > 0 && <span className="muted small">≈ {formatNaira(satsToNaira(Number(amount), ctx.rate.ngnPerBtc))} today</span>}
        </label>
        <label>How often
          <select value={frequency} onChange={(e) => setFrequency(e.target.value as Frequency)}>
            <option value="weekly">Weekly</option>
            <option value="biweekly">Every two weeks</option>
            <option value="monthly">Monthly</option>
            {import.meta.env.DEV && <option value="testing">Every 10 minutes (testing only)</option>}
          </select>
        </label>
      </div>
      {ctx.rate && (
        <label>Or set the contribution in naira
          <input inputMode="numeric" placeholder="e.g. 5000" onChange={(e) => {
            const naira = Number(e.target.value);
            if (naira > 0) setAmount(String(nairaToSats(naira, ctx.rate!.ngnPerBtc)));
          }} />
          <span className="muted small">Converted to sats at today's rate. The group is fixed in sats, so the naira value will drift.</span>
        </label>
      )}
      <label>First round is due
        <input type="date" required min={today()} value={start} onChange={(e) => setStart(e.target.value)} />
      </label>
      <fieldset className="mode">
        <legend>How do members pay?</legend>
        <label className="radio"><input type="radio" checked={rail === 'lightning'} onChange={() => setRail('lightning')} /> Lightning <span className="muted small">(instant, near-zero fees; needs a Lightning wallet)</span></label>
        <label className="radio"><input type="radio" checked={rail === 'onchain'} onChange={() => setRail('onchain')} /> Bitcoin on-chain <span className="muted small">(works with the wallet in this app; each payment pays a network fee and takes a few minutes to confirm, so it suits larger, less frequent rounds)</span></label>
      </fieldset>
      <fieldset className="mode">
        <legend>Who is in the group?</legend>
        <label className="radio"><input type="radio" checked={mode === 'invite'} onChange={() => setMode('invite')} /> I'll send an invite link <span className="muted small">(easiest: people join from the link and you approve them)</span></label>
        <label className="radio"><input type="radio" checked={mode === 'npubs'} onChange={() => setMode('npubs')} /> I already have everyone's Nostr keys</label>
      </fieldset>
      {mode === 'npubs' && (
        <label>Members, in payout order (one npub per line)
          <textarea rows={5} required value={members} onChange={(e) => setMembers(e.target.value)} />
          <span className="muted small">The first person is paid in round 1. Everyone is paid exactly once.</span>
        </label>
      )}
      <label>Coordinator bot key (npub or hex)
        <input value={coordinator} onChange={(e) => setCoordinator(e.target.value)} placeholder="npub1…" />
        <span className="muted small">The bot that runs rounds and checks payments for this group.</span>
      </label>
      {error && <p className="error">{error}</p>}
      <button aria-busy={busy} disabled={busy}>{busy ? 'Publishing…' : 'Create group'}</button>
    </form>
  );
}
