import { useEffect, useState } from 'react';
import { LANGUAGES, type Language } from '@ajo/core';
import type { Ctx } from '../App';
import { frequencyLabel, shortKey, validateAddress } from '../lib/format';
import type { Invite } from '../lib/invite';
import { usePoll } from '../lib/hooks';
import { loadGroupIfMember, sendJoinRequest } from '../lib/ledger';
import { loadPending, savePending } from '../lib/pending';
import { withNaira } from '../lib/rate';

/** Where a person lands from an invite link: see what the group is, ask to join, wait to be approved. */
export function InvitePage({ ctx, invite }: { ctx: Ctx; invite: Invite }) {
  const ref = { author: invite.author, id: invite.id };
  const groupRoute = `/g/${invite.author}/${encodeURIComponent(invite.id)}`;
  const [address, setAddress] = useState('');
  const [language, setLanguage] = useState<Language>('en');
  const [sent, setSent] = useState(() => !!loadPending(ref));
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  // Once the organizer approves, the group becomes readable to this person: go to it.
  const { data: group } = usePoll(() => loadGroupIfMember(ctx.settings.relay, ref, ctx.signer), [ctx.settings.relay, invite.author, invite.id], 3000);
  useEffect(() => {
    if (group || ctx.signer.pubkey === invite.author) ctx.navigate(groupRoute);
  }, [group, ctx.signer.pubkey, invite.author]);

  const ask = async (e: React.FormEvent) => {
    e.preventDefault();
    const problem = validateAddress(address);
    if (problem) return setError(problem);
    setError(undefined);
    setBusy(true);
    try {
      await sendJoinRequest(ctx.settings.relay, ctx.signer, ref, { lightningAddress: address.trim(), language });
      savePending(ref, { lightningAddress: address.trim(), language });
      setSent(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="narrow">
      <h1>You're invited to {invite.name}</h1>
      <p className="muted">
        {withNaira(invite.amountSats, ctx.rate)} per round · {frequencyLabel[invite.frequency]}. Organized by {shortKey(invite.author)}.
      </p>
      <p className="muted small">This is what the link says. Once you're added you'll see the real group, and you can check it matches before you pay anything.</p>

      {sent ? (
        <section className="card">
          <h2>Waiting for the organizer</h2>
          <p>Your request is sent. When {shortKey(invite.author)} adds you, this page opens the group by itself. You can close it and come back to this link later.</p>
          {ctx.signer.kind === 'local' && <p className="muted small">You're using a key stored in this browser, so come back on this same browser.</p>}
        </section>
      ) : (
        <form className="card" onSubmit={ask}>
          <h2>Ask to join</h2>
          <p className="muted">Members pay you at your Lightning address when it's your turn to receive. Only the organizer sees this.</p>
          <label>Your Lightning address
            <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="you@wallet.com" />
          </label>
          <label>Language for reminders
            <select value={language} onChange={(e) => setLanguage(e.target.value as Language)}>
              {Object.entries(LANGUAGES).map(([code, name]) => <option key={code} value={code}>{name}</option>)}
            </select>
          </label>
          {error && <p className="error">{error}</p>}
          <button disabled={busy}>{busy ? 'Sending…' : 'Ask to join'}</button>
        </form>
      )}
    </div>
  );
}
