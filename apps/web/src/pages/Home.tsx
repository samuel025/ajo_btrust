import { myGroups } from '../lib/ledger';
import { usePoll } from '../lib/hooks';
import { formatDate, frequencyLabel, shortKey } from '../lib/format';
import { withNaira } from '../lib/rate';
import type { Ctx } from '../App';
import { nip19 } from 'nostr-tools';

export function Home({ ctx }: { ctx: Ctx }) {
  const { data: groups, error } = usePoll(() => myGroups(ctx.settings.relay, ctx.signer), [ctx.settings.relay], 8000);

  return (
    <>
      <p className="muted small">Signed in as {shortKey(ctx.signer.pubkey)}
        <button className="link" onClick={() => navigator.clipboard?.writeText(nip19.npubEncode(ctx.signer.pubkey))}>copy npub</button>
      </p>
      <h1>Your groups</h1>
      {error && <p className="error">Can't reach the relay at {ctx.settings.relay}. {error}</p>}
      {!groups && !error && <p className="muted">Loading…</p>}
      {groups?.length === 0 && (
        <section className="card">
          <p>You're not in any group yet.</p>
          <p className="muted">Create one, or share your npub with an organizer so they can add you.</p>
          <a className="button" href="#/new">Create a group</a>
        </section>
      )}
      <div className="list">
        {groups?.map(({ ref, group }) => (
          <a key={`${ref.author}:${ref.id}`} className="card row" href={`#/g/${ref.author}/${encodeURIComponent(ref.id)}`}>
            <div>
              <strong>{group.name}</strong>
              <div className="muted small">{group.payoutOrder.length} members · {frequencyLabel[group.frequency]}</div>
            </div>
            <div className="right">
              <strong>{withNaira(group.amountSats, ctx.rate)}</strong>
              <div className="muted small">starts {formatDate(group.startDate)}</div>
            </div>
          </a>
        ))}
      </div>
    </>
  );
}
