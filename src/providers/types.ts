export type ProtocolId = 'dlmm' | 'dammv2';
export const PROTOCOLS: ProtocolId[] = ['dlmm', 'dammv2'];

/** Porsi nilai token Y (0..1) dari nilai USD token X & Y; undefined jika keduanya 0 / tidak ada. */
export const shareOf = (x?: number, y?: number) => (x !== undefined && y !== undefined && x + y > 0 ? y / (x + y) : undefined);

export interface PositionInfo {
  protocol: ProtocolId;
  position: string;
  pool: string;
  pair: string;
  openedAt?: number;
  closedAt?: number;
  depositUsd?: number;
  depositSol?: number;
  valueUsd?: number;
  withdrawUsd?: number;
  feesUsd?: number;
  pnlUsd?: number;
  pnlSol?: number;
  /** Dalam persen (1.5 = 1.5%). */
  pnlPct?: number;
  minPrice?: number;
  maxPrice?: number;
  poolPrice?: number;
  outOfRange?: boolean;
  /** Jumlah bin (DLMM). */
  bins?: number;
  /** Fee yang belum diklaim (posisi open). */
  unclaimedFeesUsd?: number;
  /**
   * Porsi nilai dalam token Y (quote, mis. SOL) 0..1: saldo saat ini untuk posisi open,
   * hasil withdraw untuk posisi closed. Dipakai memperkirakan letak harga di range.
   */
  shareY?: number;
  /** Range penuh (DAMM v2 non-concentrated). */
  fullRange?: boolean;
  /** Strategi likuiditas DLMM dari transaksi add, mis. "Spot" atau "BidAsk 86% + Spot 14%". */
  strategy?: string;
  /** Sisi deposit saat posisi dibuka: x = hanya token X, y = hanya token Y, both = keduanya. */
  openSide?: 'x' | 'y' | 'both';
  /** Range saat open: jumlah bin dan % harga bin terbawah/teratas terhadap harga saat open. */
  openRange?: { bins: number; minPct: number; maxPct: number; binStep: number };
  symbolX?: string;
  symbolY?: string;
  iconX?: string;
  iconY?: string;
  /** Fee yang sudah diklaim. */
  claimedFeesUsd?: number;
  /** Rincian per token (untuk panel detail posisi). */
  breakdown?: {
    current?: TokenPair;
    unclaimed?: TokenPair;
    claimed?: TokenPair;
    deposits?: TokenPair;
    withdrawals?: TokenPair;
  };
}

export interface TokenAmount {
  amount: number;
  usd: number;
}

export interface TokenPair {
  x: TokenAmount;
  y: TokenAmount;
}

export interface Provider {
  id: ProtocolId;
  /** Posisi yang sedang open. Harus throw jika API gagal (jangan kembalikan list kosong). */
  getOpenPositions(wallet: string): Promise<PositionInfo[]>;
  /** Lengkapi detail posisi yang baru dibuka (range, deposit, dll). */
  enrichOpened(wallet: string, positions: PositionInfo[]): Promise<PositionInfo[]>;
  /** Cari data posisi yang sudah ditutup. Map key = alamat posisi. */
  findClosed(wallet: string, positions: { position: string; pool: string }[]): Promise<Map<string, PositionInfo>>;
}
