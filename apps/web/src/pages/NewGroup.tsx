import { useState } from 'react';
import { nip19 } from 'nostr-tools';
import { createGroupKey, groupEvent, type Frequency } from '@ajo/core';
import { publish } from '../lib/ledger';
import { parseMembers, toHexPubkey } from '../lib/format';
import type { Ctx } from '../App';

const inAWeek = () => new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);

export function NewGroup({ ctx }: { ctx: Ctx }) {
  const me = nip19.npubEncode(ctx.signer.pubkey);
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('50000');
  const [frequency, setFrequency] = useState<Frequency>('weekly');
  const [start, setStart] = useState(inAWeek);
  const [coordinator, setCoordinator] = useState(ctx.settings.coordinator);
  const [members, setMembers] = useState(`${me}\n`);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(undefined);
    try {
      const payoutOrder = parseMembers(members);
      if (payoutOrder.length < 2) throw new Error('A group needs at least two members.');
      if (!payoutOrder.includes(ctx.signer.pubkey)) throw new Error('Include yourself in the member list.');
      const amountSats = Number(amount);
      if (!Number.isInteger(amountSats) || amountSats < 1) throw new Error('Enter the contribution as a whole number of sats.');
      if (!coordinator.trim()) throw new Error('Enter the coordinator bot\'s key (or set a default in Settings).');
      const id = `${name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Math.random().toString(36).slice(2, 7)}`;

      setBusy(true);
      await publish(ctx.settings.relay, ctx.signer, await groupEvent({
        id, name: name.trim(), amountSats, frequency, payoutOrder,
        startDate: Math.floor(new Date(`${start}T09:00:00`).getTime() / 1000),
        coordinator: toHexPubkey(coordinator),
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
        </label>
        <label>How often
          <select value={frequency} onChange={(e) => setFrequency(e.target.value as Frequency)}>
            <option value="weekly">Weekly</option>
            <option value="biweekly">Every two weeks</option>
            <option value="monthly">Monthly</option>
          </select>
        </label>
      </div>
      <label>First round is due
        <input type="date" required value={start} onChange={(e) => setStart(e.target.value)} />
      </label>
      <label>Members, in payout order (one npub per line)
        <textarea rows={5} required value={members} onChange={(e) => setMembers(e.target.value)} />
        <span className="muted small">The first person is paid in round 1. Everyone is paid exactly once.</span>
      </label>
      <label>Coordinator bot key (npub or hex)
        <input value={coordinator} onChange={(e) => setCoordinator(e.target.value)} placeholder="npub1…" />
        <span className="muted small">The bot that runs rounds and checks payments for this group.</span>
      </label>
      {error && <p className="error">{error}</p>}
      <button disabled={busy}>{busy ? 'Publishing…' : 'Create group'}</button>
    </form>
  );
}
