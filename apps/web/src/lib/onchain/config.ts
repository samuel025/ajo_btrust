import { chosenNetwork, type NetworkConfig } from './network';

/** The network the wallet runs on, from the build settings. A reason is given when the settings are unusable. */
export function walletNetwork(): { net?: NetworkConfig; problem?: string } {
  try {
    const net = chosenNetwork({ network: import.meta.env.VITE_BTC_NETWORK, allowMainnet: import.meta.env.VITE_ALLOW_MAINNET });
    const esplora = import.meta.env.VITE_ESPLORA_URL;
    return { net: esplora ? { ...net, esplora } : net };
  } catch (e) {
    return { problem: (e as Error).message };
  }
}
