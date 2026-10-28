import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

/** Twelve random words. This is the only thing that has to be backed up. */
export const newMnemonic = (): string => generateMnemonic(wordlist, 128);

/** Lower case, single spaces: what people paste is rarely tidy. */
export const normalizeMnemonic = (text: string): string => text.trim().toLowerCase().split(/\s+/).join(' ');

export const isValidMnemonic = (text: string): boolean => {
  const words = normalizeMnemonic(text);
  return [12, 15, 18, 21, 24].includes(words.split(' ').length) && validateMnemonic(words, wordlist);
};

export const seedFromMnemonic = (text: string): Uint8Array => mnemonicToSeedSync(normalizeMnemonic(text));

/** Three distinct positions to ask for, to check the person really wrote the words down. */
export function pickChecks(wordCount: number, random: () => number = Math.random): number[] {
  const picks = new Set<number>();
  while (picks.size < 3) picks.add(Math.floor(random() * wordCount));
  return [...picks].sort((a, b) => a - b);
}

export function checksPass(mnemonic: string, positions: number[], answers: string[]): boolean {
  const words = normalizeMnemonic(mnemonic).split(' ');
  return positions.length > 0 && positions.every((p, i) => words[p] === (answers[i] ?? '').trim().toLowerCase());
}
