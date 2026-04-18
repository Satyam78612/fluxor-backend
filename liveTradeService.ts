import axios from 'axios';

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
    updatedAt: number;
}

interface CacheEntry {
    data: LiveTradeData;
    cachedAt: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 10_000; // Matches frontend poll interval

// ─── In-memory cache (survives request, resets on server restart) ─────────────

const cache = new Map<string, CacheEntry>(); // key: tokenId

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

// ─── DexScreener fetch ────────────────────────────────────────────────────────

async function fetchFromDexScreener(
    tokenId: string,
    contractAddress: string
): Promise<LiveTradeData | null> {
    try {
        const res = await axios.get(
            `https://api.dexscreener.com/latest/dex/tokens/${contractAddress}`,
            { timeout: 2000 }
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

// ─── Public API (called by server.ts REST endpoint) ───────────────────────────

export async function getLiveTradeData(
    tokenId: string,
    tokens: LiveTradeToken[]
): Promise<LiveTradeData | null> {
    const id = tokenId.toLowerCase();

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
    const data = await fetchFromDexScreener(id, contractAddress);

    if (data) cache.set(id, { data, cachedAt: Date.now() });

    return data;
}