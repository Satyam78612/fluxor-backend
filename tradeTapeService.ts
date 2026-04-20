import axios from 'axios';
import { RedisClientType } from 'redis';

// ─── Public types (re-exported for the route + frontend) ─────────────────────
export interface TradeTick {
    side: 'buy' | 'sell';
    priceUsd: number;
    amount: number;     // human-readable token amount
    timestamp: number;  // unix seconds
}

// ─── Chain Maps ───────────────────────────────────────────────────────────────
// Birdeye expects a lowercase chain name in the `x-chain` header
const BIRDEYE_CHAIN: Record<number, string> = {
    1: 'ethereum',
    56: 'bsc',
    137: 'polygon',
    10: 'optimism',
    42161: 'arbitrum',
    8453: 'base',
    43114: 'avalanche',
    5000: 'mantle',
    101: 'solana',   // Birdeye is the best Solana source
    146: 'sonic',
    80094: 'berachain',
};

// Internal chain string → Birdeye x-chain header
const BIRDEYE_CHAINS: Record<string, string> = {
    solana: 'solana',
    ethereum: 'ethereum',
    bsc: 'bsc',
    polygon: 'polygon',
    arbitrum: 'arbitrum',
    optimism: 'optimism',
    base: 'base',
    avalanche: 'avalanche',
    mantle: 'mantle',
    monad: 'monad',
    hyperevm: 'hyperevm'
};

// Codex only covers major EVM chains (no Solana, no Mantle/Sonic/Berachain yet)
const CODEX_NETWORK: Record<number, number> = {
    1: 1,
    56: 56,
    137: 137,
    10: 10,
    42161: 42161,
    8453: 8453,
    43114: 43114,
};

const TAPE_TTL_SECS = 10; // Redis TTL — matches the frontend poll interval

// ─── Birdeye Fetch ────────────────────────────────────────────────────────────
// Docs: https://docs.birdeye.so/reference/get-defi-v3-token-txs
// Cost: 20 CU / call  |  Rate: 1 RPS  |  Monthly cap: 30,000 CU = 1,500 calls
async function fetchBirdeye(address: string, chainId: number): Promise<TradeTick[]> {
    const chain = BIRDEYE_CHAIN[chainId];
    if (!chain) return [];

    const res = await axios.get(
        'https://public-api.birdeye.so/defi/v3/token/txs',
        {
            params: { address, tx_type: 'swap', offset: 0, limit: 20 },
            headers: {
                'X-API-KEY': process.env.BIRDEYE_API_KEY ?? '',
                'x-chain': chain,
            },
            timeout: 5_000,
        },
    );

    const items: any[] = res.data?.data?.items ?? [];

    return items.flatMap((tx): TradeTick[] => {
        const isBuy = tx.side === 'buy';

        // For a buy:  "to"   = the token being received (base token the user bought)
        // For a sell: "from" = the token being sent     (base token the user sold)
        const baseToken = isBuy ? tx.to : tx.from;

        const priceUsd: number =
            baseToken?.priceUsd ?? baseToken?.nearestValue ?? 0;
        const amount: number = baseToken?.uiAmount ?? 0;

        if (!priceUsd || !amount) return [];

        return [{
            side: isBuy ? 'buy' : 'sell',
            priceUsd,
            amount,
            timestamp: tx.blockUnixTime ?? Math.floor(Date.now() / 1_000),
        }];
    });
}

// ─── Codex Fetch ─────────────────────────────────────────────────────────────
// Docs: https://docs.codex.io/api-reference/queries/gettokenevents
// Cost: 1 call / request  |  Rate: 5 RPS  |  Monthly cap: 10,000 calls
const CODEX_GQL = `
  query TradeTape($address: String!, $networkId: Int!) {
    getTokenEvents(
      query: { address: $address, networkId: $networkId }
      limit: 20
    ) {
      items {
        eventType
        timestamp
        priceUsd
        quoteToken
        token0 { amount uiAmount }
        token1 { amount uiAmount }
      }
    }
  }
`;

async function fetchCodex(address: string, chainId: number): Promise<TradeTick[]> {
    const networkId = CODEX_NETWORK[chainId];
    if (!networkId) return [];

    const res = await axios.post(
        'https://graph.codex.io/graphql',
        { query: CODEX_GQL, variables: { address, networkId } },
        {
            // Codex accepts raw API key directly (no "Bearer" prefix)
            headers: { Authorization: process.env.CODEX_API_KEY ?? '' },
            timeout: 5_000,
        },
    );

    const items: any[] = res.data?.data?.getTokenEvents?.items ?? [];

    return items.flatMap((e): TradeTick[] => {
        if (e.eventType !== 'Swap') return [];

        const priceUsd = parseFloat(e.priceUsd ?? '0');
        if (!priceUsd) return [];

        // `quoteToken` = 'token0' | 'token1' — the pricing/USD side of the pair.
        // The OTHER slot is the base token we're tracking.
        const baseIsToken0 = e.quoteToken === 'token1';
        const baseSlot = baseIsToken0 ? e.token0 : e.token1;

        // Codex amounts are signed from the pool's perspective:
        //   negative → token leaving pool → user bought it
        //   positive → token entering pool → user sold it
        const rawAmount = parseFloat(baseSlot?.amount ?? '0');
        const amount = Math.abs(parseFloat(baseSlot?.uiAmount ?? baseSlot?.amount ?? '0'));
        const side: 'buy' | 'sell' = rawAmount < 0 ? 'buy' : 'sell';

        if (!amount) return [];

        return [{
            side,
            priceUsd,
            amount,
            timestamp: e.timestamp ?? Math.floor(Date.now() / 1_000),
        }];
    });
}

// ─── Public Gateway ───────────────────────────────────────────────────────────
// Strategy:
//   • Solana   → Birdeye only  (Codex doesn't support Solana)
//   • EVM      → Birdeye + Codex in parallel; prefer Birdeye (better data
//                quality), fall back to Codex on Birdeye 429/timeout/empty
//   • All      → 10-second Redis cache to avoid wasting quota on repeat calls
//
// Combined free-tier capacity: ~11,500 screen loads/month (1,500 Birdeye +
// 10,000 Codex) with zero single-source bottleneck.
export async function getTradeTape(
    address: string,
    chainId: number,
    redisClient: RedisClientType,
): Promise<TradeTick[]> {

    const cacheKey = `tape:${chainId}:${address.toLowerCase()}`;

    // 1. Redis hit (10 s TTL)
    try {
        const hit = await redisClient.get(cacheKey);
        if (hit) {
            console.log(`[tradeTape] ✅ cache → chain:${chainId} ${address.slice(0, 8)}…`);
            return JSON.parse(hit);
        }
    } catch { /* non-fatal */ }

    let ticks: TradeTick[] = [];

    if (chainId === 101) {
        // ── Solana: Birdeye only ──────────────────────────────────────────────
        try {
            ticks = await fetchBirdeye(address, chainId);
            if (ticks.length)
                console.log(`[tradeTape] ✅ Birdeye Solana → ${ticks.length} ticks`);
        } catch (err: any) {
            console.error('[tradeTape] Birdeye Solana error:', err?.message ?? err);
        }
    } else {
        // ── EVM: fire both in parallel ────────────────────────────────────────
        const [birdeyeRes, codexRes] = await Promise.allSettled([
            fetchBirdeye(address, chainId),
            fetchCodex(address, chainId),
        ]);

        const bTicks = birdeyeRes.status === 'fulfilled' ? birdeyeRes.value : [];
        const cTicks = codexRes.status === 'fulfilled' ? codexRes.value : [];

        if (bTicks.length > 0) {
            ticks = bTicks;
            console.log(`[tradeTape] ✅ Birdeye EVM → ${bTicks.length} ticks`);
        } else if (cTicks.length > 0) {
            ticks = cTicks;
            console.log(`[tradeTape] ✅ Codex fallback → ${cTicks.length} ticks`);
        } else {
            console.warn(`[tradeTape] ⚠️ No data → chain:${chainId} ${address.slice(0, 8)}…`);
        }
    }

    // 2. Cache successful result
    if (ticks.length > 0) {
        try {
            await redisClient.set(cacheKey, JSON.stringify(ticks), { EX: TAPE_TTL_SECS });
        } catch { /* non-fatal */ }
    }

    return ticks;
}