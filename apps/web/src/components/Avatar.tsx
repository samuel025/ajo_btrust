import { nip19 } from 'nostr-tools';

/** A round badge for a person, made from their key: the same person always gets the same colour and letters. */
export function Avatar({ pubkey }: { pubkey: string }) {
  const npub = nip19.npubEncode(pubkey);
  let h = 0;
  for (const c of npub.slice(5, 13)) h = (h * 31 + c.charCodeAt(0)) % 360;
  return <span className="avatar" style={{ background: `hsl(${h} 52% 36%)` }} aria-hidden="true">{npub.slice(5, 7).toUpperCase()}</span>;
}
