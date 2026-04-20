import axios from 'axios';
import { RedisClientType } from 'redis';

export interface TradeTick {
    side: 'buy' | 'sell';
    priceUsd: number;
    amount: number;
    timestamp: number;
}

// ─── Chain Maps ───────────────────────────────────────────────────────────────
// Birdeye: numeric chainId → x-chain header string
// Only the chains Birdeye officially supports.
// NOTE: sonic (146) and berachain (80094) are NOT in Birdeye's list.
const BIRDEYE_CHAIN: Record<number, string> = {
    101: 'solana',
    1: 'ethereum',
    56: 'bsc',
    137: 'polygon',
    42161: 'arbitrum',
    10: 'optimism',
    8453: 'base',
    43114: 'avalanche',
    5000: 'mantle',
    143: 'monad',
    999: 'hyperevm',
};

// Codex: numeric chainId → Codex networkId
// IMPORTANT: Codex Solana networkId = 1399811149, NOT 101.
// We still route Solana through Birdeye exclusively for better quality.
const CODEX_NETWORK: Record<number, number> = {
    1: 1,
    56: 56,
    43114: 43114,
    137: 137,
    80094: 80094,   // Berachain (not in Birdeye, so Codex is the only source)
    999: 999,     // HyperEVM
    9745: 9745,    // Plasma
    143: 143,     // Monad
    8453: 8453,
    42161: 42161,
    10: 10,
    5000: 5000,
    146: 146,
    1399811149: 1399811149
};

const TAPE_TTL_SECS = 10;

// ─── Birdeye Fetch ────────────────────────────────────────────────────────────
async function fetchBirdeye(address: string, chainId: number): Promise<TradeTick[]> {
    const chain = BIRDEYE_CHAIN[chainId];
    if (!chain) return [];

    const apiKey = process.env.BIRDEYE_API_KEY ?? '';
    if (!apiKey) {
        console.error('[tradeTape] ❌ BIRDEYE_API_KEY is not set in environment variables!');
        return [];
    }

    const res = await axios.get(
        'https://public-api.birdeye.so/defi/v3/token/txs',
        {
            params: { address, tx_type: 'swap', offset: 0, limit: 20 },
            headers: {
                'X-API-KEY': apiKey,
                'x-chain': chain,
            },
            timeout: 5_000,
        },
    );

    const items: any[] = res.data?.data?.items ?? [];

    if (items.length === 0) {
        // Log to help diagnose: wrong response shape or no activity
        const dataKeys = Object.keys(res.data?.data ?? {});
        console.log(`[tradeTape] Birdeye 0 items for ${address.slice(0, 8)}… (${chain}). data keys: [${dataKeys.join(', ')}]`);
        return [];
    }

    // Log sample field names once for debugging
    console.log(`[tradeTape] Birdeye item keys sample: [${Object.keys(items[0]).join(', ')}]`);

    return items.flatMap((tx): TradeTick[] => {
        const isBuy = tx.side === 'buy';

        // buy  → "to"   = token the user received (what they bought)
        // sell → "from" = token the user sent    (what they sold)
        const baseToken = isBuy ? tx.to : tx.from;

        const priceUsd: number =
            baseToken?.priceUsd ??
            baseToken?.price ??
            baseToken?.nearestValue ??
            tx.price ??
            0;

        const amount: number =
            baseToken?.uiAmount ??
            baseToken?.amount ??
            0;

        if (!priceUsd || !amount) return [];

        return [{
            side: isBuy ? 'buy' : 'sell',
            priceUsd,
            amount,
            timestamp: tx.blockUnixTime ?? tx.timestamp ?? Math.floor(Date.now() / 1_000),
        }];
    });
}

// ─── Codex Fetch ─────────────────────────────────────────────────────────────
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

    const apiKey = process.env.CODEX_API_KEY ?? '';
    if (!apiKey) {
        console.error('[tradeTape] ❌ CODEX_API_KEY is not set in environment variables!');
        return [];
    }

    const res = await axios.post(
        'https://graph.codex.io/graphql',
        { query: CODEX_GQL, variables: { address, networkId } },
        {
            headers: { Authorization: apiKey },
            timeout: 5_000,
        },
    );

    if (res.data?.errors?.length) {
        console.error('[tradeTape] Codex GQL errors:', JSON.stringify(res.data.errors));
        return [];
    }

    const items: any[] = res.data?.data?.getTokenEvents?.items ?? [];

    if (items.length === 0) {
        console.log(`[tradeTape] Codex 0 items for ${address.slice(0, 8)}… (networkId:${networkId})`);
        return [];
    }

    return items.flatMap((e): TradeTick[] => {
        if (e.eventType !== 'Swap') return [];

        const priceUsd = parseFloat(e.priceUsd ?? '0');
        if (!priceUsd) return [];

        // quoteToken = which slot is the USD/pricing side
        // The OTHER slot is the base token we want the amount for
        const baseIsToken0 = e.quoteToken === 'token1';
        const baseSlot = baseIsToken0 ? e.token0 : e.token1;

        // Codex amounts signed from pool perspective:
        //   negative → leaving pool  → user bought
        //   positive → entering pool → user sold
        const rawAmount = parseFloat(baseSlot?.amount ?? '0');
        const amount = Math.abs(
            parseFloat(baseSlot?.uiAmount ?? baseSlot?.amount ?? '0')
        );
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
export async function getTradeTape(
    address: string,
    chainId: number,
    redisClient: RedisClientType,
): Promise<TradeTick[]> {

    const cacheKey = `tape:${chainId}:${address.toLowerCase()}`;

    // 1. Redis cache
    try {
        const hit = await redisClient.get(cacheKey);
        if (hit) {
            console.log(`[tradeTape] ✅ cache hit → chain:${chainId} ${address.slice(0, 8)}…`);
            return JSON.parse(hit);
        }
    } catch { /* non-fatal */ }

    const birdeyeSupported = !!BIRDEYE_CHAIN[chainId];
    const codexSupported = !!CODEX_NETWORK[chainId];

    if (!birdeyeSupported && !codexSupported) {
        console.warn(`[tradeTape] ⚠️ chainId ${chainId} not supported by either Birdeye or Codex`);
        return [];
    }

    let ticks: TradeTick[] = [];

    if (chainId === 101) {
        // ── Solana: Birdeye only ──────────────────────────────────────────
        try {
            ticks = await fetchBirdeye(address, chainId);
            console.log(`[tradeTape] Birdeye Solana → ${ticks.length} ticks`);
        } catch (err: any) {
            console.error('[tradeTape] Birdeye Solana error:', err?.response?.status ?? err?.message);
        }
    } else {
        // ── EVM: parallel, prefer Birdeye ─────────────────────────────────
        const [bRes, cRes] = await Promise.allSettled([
            birdeyeSupported
                ? fetchBirdeye(address, chainId)
                : Promise.resolve([] as TradeTick[]),
            codexSupported
                ? fetchCodex(address, chainId)
                : Promise.resolve([] as TradeTick[]),
        ]);

        const bTicks = bRes.status === 'fulfilled' ? bRes.value : [];
        const cTicks = cRes.status === 'fulfilled' ? cRes.value : [];

        if (bRes.status === 'rejected')
            console.error('[tradeTape] Birdeye rejected:', (bRes as any).reason?.response?.status ?? (bRes as any).reason?.message);
        if (cRes.status === 'rejected')
            console.error('[tradeTape] Codex rejected:', (cRes as any).reason?.response?.status ?? (cRes as any).reason?.message);

        if (bTicks.length > 0) {
            ticks = bTicks;
            console.log(`[tradeTape] ✅ Birdeye EVM → ${bTicks.length} ticks (chain:${chainId})`);
        } else if (cTicks.length > 0) {
            ticks = cTicks;
            console.log(`[tradeTape] ✅ Codex fallback → ${cTicks.length} ticks (chain:${chainId})`);
        } else {
            console.warn(`[tradeTape] ⚠️ Both empty → chain:${chainId} ${address.slice(0, 8)}…`);
        }
    }

    // 2. Cache — even empty results for 30 s to avoid hammering APIs on dead addresses
    try {
        await redisClient.set(
            cacheKey,
            JSON.stringify(ticks),
            { EX: ticks.length > 0 ? TAPE_TTL_SECS : 30 }
        );
    } catch { /* non-fatal */ }

    return ticks;
}