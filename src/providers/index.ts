import { dammv2Provider } from './dammv2.js';
import { dlmmProvider } from './dlmm.js';
import type { Provider } from './types.js';

/** Tambahkan provider protokol lain (mis. DAMM v1) di sini. */
export const providers: Provider[] = [dlmmProvider, dammv2Provider];
