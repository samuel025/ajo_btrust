/**
 * The recovery phrase, encrypted with a password and kept in this browser. The password is stretched with
 * PBKDF2 (slow on purpose, so guessing is costly) and the phrase is sealed with AES-GCM, which also detects
 * tampering. Only the encrypted form is ever stored; the phrase itself is held in memory while unlocked.
 */
export interface VaultRecord {
  v: 1;
  network: string;
  salt: string;
  iv: string;
  iterations: number;
  data: string;
  /** The wallet's first receiving address. Not a secret; kept so a group can be joined without unlocking. */
  address?: string;
  /** The first few receiving addresses, so each group can be given its own without unlocking. Not secrets. */
  addresses?: string[];
}

const ITERATIONS = 600_000;
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (text: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

async function keyFrom(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function sealMnemonic(mnemonic: string, password: string, network: string, iterations = ITERATIONS): Promise<VaultRecord> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await keyFrom(password, salt, iterations);
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(mnemonic)));
  return { v: 1, network, salt: b64(salt), iv: b64(iv), iterations, data: b64(data) };
}

/** Returns the phrase, or throws "wrong password" (which also covers a tampered record). */
export async function openMnemonic(record: VaultRecord, password: string): Promise<string> {
  try {
    const key = await keyFrom(password, unb64(record.salt), record.iterations);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(record.iv) }, key, unb64(record.data));
    return new TextDecoder().decode(plain);
  } catch {
    throw new Error('wrong password');
  }
}

const STORAGE_KEY = 'ajo.bitcoin.vault';

export function loadVault(): VaultRecord | undefined {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') ?? undefined; } catch { return undefined; }
}
export function saveVault(record: VaultRecord): boolean {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(record)); return true; } catch { return false; }
}
export function removeVault() {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* nothing to remove */ }
}

/** The encrypted record as a file's text, for a backup the person can keep. It is useless without the password. */
export const vaultToFile = (record: VaultRecord) => JSON.stringify(record, null, 2);

/** Reads a backup file; throws a message for the person if it isn't one. */
export function vaultFromFile(text: string): VaultRecord {
  let data: Partial<VaultRecord>;
  try { data = JSON.parse(text); } catch { throw new Error("That isn't a wallet backup file."); }
  const ok = data && data.v === 1 && typeof data.network === 'string' && ['salt', 'iv', 'data'].every((k) => typeof (data as Record<string, unknown>)[k] === 'string') && Number.isInteger(data.iterations) && data.iterations! > 0;
  if (!ok) throw new Error("That isn't a wallet backup file.");
  return { v: 1, network: data.network!, salt: data.salt!, iv: data.iv!, iterations: data.iterations!, data: data.data!, ...(typeof data.address === 'string' ? { address: data.address } : {}), ...(Array.isArray(data.addresses) && data.addresses.every((a) => typeof a === 'string') ? { addresses: data.addresses } : {}) };
}
