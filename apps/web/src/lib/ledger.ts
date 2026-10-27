import { SimplePool, type EventTemplate, type NostrEvent } from 'nostr-tools';
import {
  KIND_GROUP, KIND_JOIN, KIND_ROUND, parseGroup, parseJoin, parseRound,
  type GroupDef, type GroupKey, type GroupRef, type RoundState,
} from '@ajo/core';
import type { Signer } from './signer';

const pool = new SimplePool();

/** A group with the key that decrypts its events, readable only by its members. */
export interface LoadedGroup { ref: GroupRef; group: GroupDef; key: GroupKey }

const newest = (events: NostrEvent[]) => [...events].sort((a, b) => b.created_at - a.created_at);

export async function myGroups(relay: string, signer: Signer): Promise<LoadedGroup[]> {
  const events = await pool.querySync([relay], { kinds: [KIND_GROUP], '#p': [signer.pubkey] });
  const seen = new Set<string>();
  const groups: LoadedGroup[] = [];
  for (const event of newest(events)) {
    const key = `${event.pubkey}:${event.tags.find((t) => t[0] === 'd')?.[1]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      groups.push(await parseGroup(event, signer.pubkey, signer.cipher));
    } catch { /* not for us, or malformed */ }
  }
  return groups;
}

export async function loadGroup(relay: string, ref: GroupRef, signer: Signer): Promise<LoadedGroup | undefined> {
  const events = await pool.querySync([relay], { kinds: [KIND_GROUP], authors: [ref.author], '#d': [ref.id] });
  const latest = newest(events)[0];
  return latest && parseGroup(latest, signer.pubkey, signer.cipher);
}

export interface GroupActivity {
  addresses: Record<string, string>;
  rounds: Map<number, RoundState>;
}

export async function loadActivity(relay: string, group: GroupDef, key: GroupKey): Promise<GroupActivity> {
  const [joins, roundEvents] = await Promise.all([
    pool.querySync([relay], { kinds: [KIND_JOIN], '#a': [group.id] }),
    pool.querySync([relay], { kinds: [KIND_ROUND], authors: [group.coordinator], '#a': [group.id] }),
  ]);

  const addresses: Record<string, string> = {};
  for (const event of [...joins].sort((a, b) => a.created_at - b.created_at)) {
    if (!group.payoutOrder.includes(event.pubkey)) continue;
    try { addresses[event.pubkey] = parseJoin(event, key).lightningAddress; } catch { /* skip */ }
  }

  const rounds = new Map<number, RoundState>();
  for (const event of newest(roundEvents)) {
    try {
      const state = parseRound(event, group, key);
      if (!rounds.has(state.round)) rounds.set(state.round, state);
    } catch { /* skip */ }
  }
  return { addresses, rounds };
}

export async function publish(relay: string, signer: Signer, template: EventTemplate) {
  const event = await signer.sign(template);
  await Promise.any(pool.publish([relay], event));
  return event;
}
