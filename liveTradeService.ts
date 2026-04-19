import axios from 'axios';

// ─── Types ────────────────────────────────────────────────────────────────────

interface TokenDeployment {
    chainId?: number;
    liquidityUsd?: number;
    address: string;
}

export interface LiveTradeToken {
    id: string;
    native_identifier?: string;
    deployments?: TokenDeployment[];
}

export interface TradeRow {
    price: number;
    amount: number;
    side: 'buy' | 'sell';
    time: number;
}

export interface LiveTradeData {
    tokenId: string;
    contractAddress: string;
    chain: string;
    price: number;
    priceChange5m: number;
    priceChange1h: number;
    priceChange24h: number;
    volume5m: number;
    volume1h: number;
    volume24h: number;
    liquidityUsd: number;
    buys5m: number;
    sells5m: number;
    buys1h: number;
    sells1h: number;
    buys24h: number;
    sells24h: number;
    trades: TradeRow[];   // ← real individual trades from Birdeye
    updatedAt: number;
}

interface CacheEntry {
    data: LiveTradeData;
    cachedAt: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 10_000;
const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY || '472c8e1b4ccb4ef2842054a24c344687';
const BIRDEYE_BASE = 'https://public-api.birdeye.so';

// Birdeye chain slugs — maps DexScreener chainId strings to Birdeye chain param
const DEX_TO_BIRDEYE_CHAIN: Record<string, string> = {
    solana: 'solana',
    ethereum: 'ethereum',
    bsc: 'bsc',
    polygon: 'polygon',
    arbitrum: 'arbitrum',
    optimism: 'optimism',
    base: 'base',
    avalanche: 'avalanche',
    mantle: 'mantle',
};

// ─── In-memory cache ──────────────────────────────────────────────────────────

const cache = new Map<string, CacheEntry>();

// ─── Address resolver ─────────────────────────────────────────────────────────

export function resolveAddressForToken(tokenId: string, tokens: LiveTradeToken[]): string | null {
    const token = tokens.find(t => t.id.toLowerCase() === tokenId.toLowerCase());
    if (!token) return null;

    if (token.native_identifier) return token.native_identifier;

    if (token.deployments?.length) {
        return [...token.deployments].sort(
            (a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0)
        )[0].address;
    }

    return null;
}

// ─── DexScreener fetch (price/volume/txn metrics) ────────────────────────────

async function fetchDexScreenerMetrics(tokenId: string, contractAddress: string): Promise<Omit<LiveTradeData, 'trades'> | null> {
    try {
        const res = await axios.get(
            `https://api.dexscreener.com/latest/dex/tokens/${contractAddress}`,
            { timeout: 6000 }
        );

        if (res.status === 429 || res.headers['content-type']?.includes('text/html')) {
            console.warn('[LiveTrade] ⚠️ DexScreener rate limited');
            return null;
        }

        const pairs: any[] = res.data?.pairs;
        if (!pairs?.length) return null;

        const best = [...pairs].sort(
            (a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0)
        )[0];

        return {
            tokenId,
            contractAddress,
            chain: best.chainId ?? 'unknown',
            price: parseFloat(best.priceUsd ?? '0'),
            priceChange5m: parseFloat(best.priceChange?.m5 ?? '0'),
            priceChange1h: parseFloat(best.priceChange?.h1 ?? '0'),
            priceChange24h: parseFloat(best.priceChange?.h24 ?? '0'),
            volume5m: best.volume?.m5 ?? 0,
            volume1h: best.volume?.h1 ?? 0,
            volume24h: best.volume?.h24 ?? 0,
            liquidityUsd: best.liquidity?.usd ?? 0,
            buys5m: best.txns?.m5?.buys ?? 0,
            sells5m: best.txns?.m5?.sells ?? 0,
            buys1h: best.txns?.h1?.buys ?? 0,
            sells1h: best.txns?.h1?.sells ?? 0,
            buys24h: best.txns?.h24?.buys ?? 0,
            sells24h: best.txns?.h24?.sells ?? 0,
            updatedAt: Date.now(),
        };

    } catch (err) {
        console.error(`[LiveTrade] ❌ DexScreener error for ${contractAddress}:`, err);
        return null;
    }
}

// ─── Birdeye fetch (individual trade rows) ───────────────────────────────────

async function fetchBirdeyeTrades(contractAddress: string, dexChain: string): Promise<TradeRow[]> {
    try {
        const birdeyeChain = DEX_TO_BIRDEYE_CHAIN[dexChain] ?? 'solana';

        const res = await axios.get(`${BIRDEYE_BASE}/defi/txs/token`, {
            params: {
                address: contractAddress,
                tx_type: 'swap',
                limit: 20,
                sort_type: 'desc',
            },
            headers: {
                'X-API-KEY': BIRDEYE_API_KEY,
                'x-chain': birdeyeChain,
            },
            timeout: 6000,
        });

        const items: any[] = res.data?.data?.items ?? [];
        if (!items.length) return [];

        return items.map(tx => ({
            price: tx.price ?? 0,
            amount: tx.ui_amount ?? 0,
            side: tx.side === 'buy' ? 'buy' : 'sell',
            time: (tx.blockUnixTime ?? 0) * 1000, // convert to ms
        }));

    } catch (err: any) {
        // Non-fatal — we still return metrics even if trades fail
        console.warn(`[LiveTrade] ⚠️ Birdeye trades error: ${err.message}`);
        return [];
    }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function getLiveTradeData(
    tokenId: string,
    tokens: LiveTradeToken[]
): Promise<LiveTradeData | null> {
    const id = tokenId.toLowerCase();

    // Cache hit
    const cached = cache.get(id);
    if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
        console.log(`[LiveTrade] ⚡ Cache hit → "${id}"`);
        return cached.data;
    }

    const contractAddress = resolveAddressForToken(id, tokens);
    if (!contractAddress) {
        console.warn(`[LiveTrade] ⚠️ No address for "${id}"`);
        return null;
    }

    console.log(`[LiveTrade] 🔍 Fetching → "${id}" (${contractAddress})`);

    // Fetch both in parallel
    const [metrics, trades] = await Promise.all([
        fetchDexScreenerMetrics(id, contractAddress),
        fetchBirdeyeTrades(contractAddress, 'solana'), // will be overridden below
    ]);

    if (!metrics) return null;

    // Re-fetch trades with the correct chain now that we know it from metrics
    const realTrades = await fetchBirdeyeTrades(contractAddress, metrics.chain);

    const data: LiveTradeData = {
        ...metrics,
        trades: realTrades.length > 0 ? realTrades : trades,
    };

    cache.set(id, { data, cachedAt: Date.now() });
    return data;
}