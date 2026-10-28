import { SimplePool, type EventTemplate, type NostrEvent } from 'nostr-tools';
import {
  KIND_ANSWER, KIND_ASK, KIND_AUTOPAY, KIND_GROUP, KIND_JOIN, KIND_NOTICE, KIND_REQUEST, KIND_ROUND, groupEvent, parseAnswer,
  parseAsk, parseAutopay, parseGroup, parseJoin, parseNotice, parseRequest, parseRound, requestEvent,
  type Answer, type GroupDef, type GroupKey, type GroupRef, type JoinRequest, type Language, type Notice, type Question, type RoundState,
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
  /** Whether this member currently lets the coordinator pay for them. */
  autopay: boolean;
  /** This member's questions to the assistant, oldest first, each with its answer once there is one. */
  thread: { question: Question; answer?: Answer }[];
  /** Reminders the coordinator sent this member, newest first. */
  notices: Notice[];
  /** People who asked the organizer (this member) to add them to a forming group. */
  requests: JoinRequest[];
}

export async function loadActivity(relay: string, group: GroupDef, key: GroupKey, signer: Signer): Promise<GroupActivity> {
  const [joins, roundEvents, grants, asks, answers, noticeEvents, requestEvents] = await Promise.all([
    pool.querySync([relay], { kinds: [KIND_JOIN], '#a': [group.id] }),
    pool.querySync([relay], { kinds: [KIND_ROUND], authors: [group.coordinator], '#a': [group.id] }),
    pool.querySync([relay], { kinds: [KIND_AUTOPAY], authors: [signer.pubkey], '#a': [group.id] }),
    pool.querySync([relay], { kinds: [KIND_ASK], authors: [signer.pubkey], '#a': [group.id] }),
    pool.querySync([relay], { kinds: [KIND_ANSWER], authors: [group.coordinator], '#a': [group.id], '#p': [signer.pubkey] }),
    pool.querySync([relay], { kinds: [KIND_NOTICE], authors: [group.coordinator], '#a': [group.id], '#p': [signer.pubkey] }),
    pool.querySync([relay], { kinds: [KIND_REQUEST], '#a': [group.id], '#p': [signer.pubkey] }),
  ]);

  const addresses: Record<string, string> = {};
  for (const event of [...joins].sort((a, b) => a.created_at - b.created_at)) {
    if (!group.payoutOrder.includes(event.pubkey)) continue;
    try {
      const join = parseJoin(event, key);
      // In an on-chain group the address that matters is the Bitcoin one.
      const address = group.rail === 'onchain' ? join.bitcoinAddress : join.lightningAddress;
      if (address) addresses[event.pubkey] = address;
    } catch { /* skip */ }
  }

  const rounds = new Map<number, RoundState>();
  for (const event of newest(roundEvents)) {
    try {
      const state = parseRound(event, group, key);
      if (!rounds.has(state.round)) rounds.set(state.round, state);
    } catch { /* skip */ }
  }

  // The member can read their own grant: the encryption is shared with the coordinator.
  let autopay = false;
  const latestGrant = newest(grants)[0];
  if (latestGrant) {
    try { autopay = (await parseAutopay(latestGrant, group.coordinator, signer.cipher)).nwcUrl !== null; } catch { /* unreadable: treat as off */ }
  }

  // Everything between this member and the coordinator is encrypted to the pair; the member can
  // read both directions because the shared secret is symmetric.
  const read = async <T>(events: NostrEvent[], parse: (e: NostrEvent) => Promise<T>) => {
    const out: T[] = [];
    for (const event of events) { try { out.push(await parse(event)); } catch { /* skip unreadable */ } }
    return out;
  };
  const questions = await read(asks, (e) => parseAsk(e, group.coordinator, signer.cipher));
  const replies = await read(answers, (e) => parseAnswer(e, group.coordinator, signer.cipher));
  const thread = questions
    .sort((x, y) => x.at - y.at)
    .map((question) => ({ question, answer: replies.find((r) => r.questionId === question.id) }));
  const notices = (await read(noticeEvents, (e) => parseNotice(e, group.coordinator, signer.cipher))).sort((x, y) => y.at - x.at);

  // Requests addressed to me (only an organizer receives any), minus people already added.
  const requests = (await read(requestEvents, (e) => parseRequest(e, e.pubkey, signer.cipher)))
    .filter((r) => !group.payoutOrder.includes(r.member))
    .sort((x, y) => x.at - y.at);

  return { addresses, rounds, autopay, thread, notices, requests };
}

export async function publish(relay: string, signer: Signer, template: EventTemplate) {
  const event = await signer.sign(template);
  await Promise.any(pool.publish([relay], event));
  return event;
}

/** Like loadGroup, but a person who hasn't been approved yet (no key for them) gets undefined, not an error. */
export async function loadGroupIfMember(relay: string, ref: GroupRef, signer: Signer): Promise<LoadedGroup | undefined> {
  try {
    return await loadGroup(relay, ref, signer);
  } catch (e) {
    if (/no key for you/.test(String((e as Error).message))) return undefined;
    throw e;
  }
}

/** Publishes a new version of a group the signer organizes. It must be newer than the one it replaces. */
export async function publishGroupUpdate(relay: string, signer: Signer, group: GroupDef, key: GroupKey) {
  const existing = await pool.querySync([relay], { kinds: [KIND_GROUP], authors: [signer.pubkey], '#d': [group.id] });
  const newestAt = Math.max(0, ...existing.map((e) => e.created_at));
  const createdAt = Math.max(Math.floor(Date.now() / 1000), newestAt + 1);
  return publish(relay, signer, await groupEvent(group, key, signer.cipher, createdAt));
}

/** Asks an organizer to add the signer to their group. */
export async function sendJoinRequest(relay: string, signer: Signer, ref: GroupRef, request: { lightningAddress: string; bitcoinAddress?: string; language: Language }) {
  return publish(relay, signer, await requestEvent(ref.id, ref.author, request, signer.cipher));
}
