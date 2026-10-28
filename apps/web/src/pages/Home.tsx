import { myGroups } from '../lib/ledger';
import { usePoll } from '../lib/hooks';
import { formatDate, frequencyLabel, shortKey } from '../lib/format';
import { withNaira } from '../lib/rate';
import type { Ctx } from '../App';
import { nip19 } from 'nostr-tools';
import { Bitcoin, Clock, Users, Zap } from 'lucide-react';

export function Home({ ctx }: { ctx: Ctx }) {
  const { data: groups, error } = usePoll(() => myGroups(ctx.settings.relay, ctx.signer), [ctx.settings.relay], 8000);

  return (
    <>
      <h1>Your groups</h1>
      <p className="muted small">Signed in as <span className="badge num">{shortKey(ctx.signer.pubkey)}</span>
        <button className="link" onClick={() => navigator.clipboard?.writeText(nip19.npubEncode(ctx.signer.pubkey))}>copy npub</button>
      </p>
      {error && <p className="error">Can't reach the relay at {ctx.settings.relay}. {error}</p>}
      {!groups && !error && <div className="list" aria-busy="true" aria-label="Loading your groups"><div className="skeleton" /><div className="skeleton" /></div>}
      {groups?.length === 0 && (
        <section className="card empty">
          <span className="glyph"><Users size={26} aria-hidden="true" /></span>
          <h2>You're not in any group yet</h2>
          <p className="muted">Create one and invite people with a link, or share your npub with an organizer so they can add you.</p>
          <a className="button" href="#/new">Create a group</a>
        </section>
      )}
      <div className="list">
        {groups?.map(({ ref, group }) => (
          <a key={`${ref.author}:${ref.id}`} className="card group-card" href={`#/g/${ref.author}/${encodeURIComponent(ref.id)}`}>
            <span className="avatar" style={{ background: 'var(--text)', color: 'var(--bg)' }} aria-hidden="true">{group.name.slice(0, 2).toUpperCase()}</span>
            <div>
              <strong>{group.name}</strong>
              <div className="meta">
                <span className="badge"><Users size={13} aria-hidden="true" />{group.payoutOrder.length}</span>
                <span className="badge"><Clock size={13} aria-hidden="true" />{frequencyLabel[group.frequency]}</span>
                {group.rail === 'onchain' ? <span className="badge info"><Bitcoin size={13} aria-hidden="true" />On-chain</span> : <span className="badge warn"><Zap size={13} aria-hidden="true" />Lightning</span>}
              </div>
            </div>
            <div className="right">
              <div className="amount">{withNaira(group.amountSats, ctx.rate)}</div>
              <div className="muted small">starts {formatDate(group.startDate)}</div>
            </div>
          </a>
        ))}
      </div>
    </>
  );
}
