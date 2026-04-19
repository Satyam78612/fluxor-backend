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
    time: number; // unix ms
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
    trades: TradeRow[];
    updatedAt: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const REDIS_TTL_SEC = 10;                 // 10-second Redis cache
const MEM_TTL_MS = 10_000;            // in-memory fallback TTL
const BIRDEYE_KEY = process.env.BIRDEYE_API_KEY || '472c8e1b4ccb4ef2842054a24c344687';
const CODEX_KEY = process.env.CODEX_API_KEY || '2e51751dfc0d0809729f049301940a5350bf7ca2';

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

// Internal chain string → Codex networkId
const CODEX_NETWORKS: Record<string, number> = {
    ethereum: 1,
    bsc: 56, // BNB Chain
    avalanche: 43114,
    polygon: 137,
    berachain: 80094,
    hyperevm: 999,
    plasma: 9745,
    monad: 143,
    base: 8453,
    arbitrum: 42161,
    optimism: 10,
    mantle: 5000,
    solana: 1399811149
};

// Reverse map: numeric chainId → internal chain string
const CHAINID_TO_NAME: Record<number, string> = {
    1: 'ethereum',
    56: 'bsc',
    137: 'polygon',
    42161: 'arbitrum',
    10: 'optimism',
    8453: 'base',
    43114: 'avalanche',
    5000: 'mantle',
    80094: 'berachain',
    999: 'hyperevm',
    9745: 'plasma',
    143: 'monad',
    101: 'solana'
};

// ─── In-memory fallback cache (if Redis unavailable) ─────────────────────────

const memCache = new Map<string, { data: LiveTradeData; cachedAt: number }>();

// ─── Address + chain resolver ─────────────────────────────────────────────────

export function resolveAddressForToken(
    tokenId: string,
    tokens: LiveTradeToken[]
): { address: string; chain: string } | null {
    const token = tokens.find(t => t.id.toLowerCase() === tokenId.toLowerCase());
    if (!token) return null;

    // Native tokens (SOL, ETH, etc.)
    if (token.native_identifier) {
        const addr = token.native_identifier;
        const isSolana = !addr.startsWith('0x');
        if (isSolana) return { address: addr, chain: 'solana' };

        // EVM native — determine chain from token id
        const nativeChains: Record<string, string> = {
            'ethereum': 'ethereum', 'binancecoin': 'bsc', 'avalanche-2': 'avalanche',
            'matic-network': 'polygon', 'the-open-network': 'ethereum',
        };
        return { address: addr, chain: nativeChains[token.id] ?? 'ethereum' };
    }

    // Contract tokens — pick deployment with highest liquidity
    if (token.deployments?.length) {
        const best = [...token.deployments].sort(
            (a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0)
        )[0];
        const chain = CHAINID_TO_NAME[best.chainId ?? 1] ?? 'ethereum';
        return { address: best.address, chain };
    }

    return null;
}

// ─── Birdeye (Solana + multi-chain) ──────────────────────────────────────────
// Endpoint: GET /defi/v3/token/txs
// Best for Solana; also supports EVM as a fallback

async function fetchBirdeye(address: string, chain: string): Promise<TradeRow[]> {
    try {
        const xChain = BIRDEYE_CHAINS[chain] ?? 'solana';

        const res = await axios.get('https://public-api.birdeye.so/defi/v3/token/txs', {
            params: { address, tx_type: 'swap', limit: 20, sort_type: 'desc' },
            headers: { 'X-API-KEY': BIRDEYE_KEY, 'x-chain': xChain },
            timeout: 7000,
        });

        const items: any[] = res.data?.data?.items ?? [];
        if (!items.length) return [];

        return items
            .map(tx => {
                const isBuy = tx.side === 'buy';
                const side = isBuy ? tx.to : tx.from;

                // Price usually works fine as it's just 'price'
                const price = side?.price ?? side?.nearestPrice ?? 0;

                // FIX: Use snake_case to match Birdeye's JSON
                const amount = Math.abs(side?.ui_amount ?? side?.ui_change_amount ?? 0);

                return {
                    price,
                    amount,
                    side: isBuy ? 'buy' as const : 'sell' as const,
                    time: (tx.blockUnixTime ?? 0) * 1000,
                };
            })
            .filter(t => t.price > 0 || t.amount > 0);

    } catch (err: any) {
        console.warn(`[LiveTrade] Birdeye ${chain} error: ${err.message}`);
        return [];
    }
}

// ─── Codex (EVM primary) ─────────────────────────────────────────────────────
// Endpoint: POST https://graph.codex.io/graphql  → GetTokenEvents

// ─── Codex (EVM primary) ─────────────────────────────────────────────────────
// Endpoint: POST https://graph.codex.io/graphql  → GetTokenEvents

const CODEX_QUERY = `
query GetTokenEvents($address: String!, $networkId: Int!) {
    getTokenEvents(
        query: { address: $address, networkId: $networkId }
        limit: 20
        direction: DESC
    ) {
        items {
            eventDisplayType
            timestamp
            transactionHash
            data {
                ... on SwapEventData {
                    priceUsd
                    priceUsdTotal
                }
            }
        }
    }
}`;

async function fetchCodex(address: string, chain: string): Promise<TradeRow[]> {
    const networkId = CODEX_NETWORKS[chain];
    if (!networkId) return [];

    try {
        const res = await axios.post(
            'https://graph.codex.io/graphql',
            { query: CODEX_QUERY, variables: { address, networkId } },
            {
                headers: {
                    'Authorization': CODEX_KEY,
                    'Content-Type': 'application/json',
                },
                timeout: 7000,
            }
        );

        const items: any[] = res.data?.data?.getTokenEvents?.items ?? [];
        if (!items.length) return [];

        return items
            .map(item => {
                // Safely extract the data object
                const swapData = item.data || {};

                // 1. Determine Buy or Sell
                const isBuy = swapData.type === 'buy' || item.eventDisplayType === 'Buy';

                // 2. FIX: Check both the root (item) and the child (swapData) for the values
                const rawPrice = item.priceUsd || swapData.priceUsd || '0';
                const rawTotal = item.token0ValueUsd || item.token1ValueUsd || swapData.priceUsdTotal || '0';

                const priceUsd = parseFloat(rawPrice);
                const priceUsdTotal = parseFloat(rawTotal);

                // 3. Calculate Token Amount mathematically
                const amount = priceUsd > 0 && priceUsdTotal > 0 ? priceUsdTotal / priceUsd : 0;

                return {
                    price: priceUsd,
                    amount: amount,
                    side: isBuy ? 'buy' as const : 'sell' as const,
                    time: (item.timestamp ?? 0) * 1000,
                };
            })
            .filter(t => t.price > 0 && t.amount > 0);

    } catch (err: any) {
        console.warn(`[LiveTrade] Codex ${chain} error: ${err.message}`);
        return [];
    }
}

// ─── Gateway: Birdeye + Codex in parallel (EVM), Birdeye only (Solana) ───────

async function fetchTrades(address: string, chain: string): Promise<TradeRow[]> {
    if (chain === 'solana') {
        // Birdeye is the definitive Solana source
        return fetchBirdeye(address, 'solana');
    }

    // EVM: fire both in parallel — first non-empty result wins
    const [birdeyeResult, codexResult] = await Promise.all([
        fetchBirdeye(address, chain),
        fetchCodex(address, chain),
    ]);

    // Prefer whichever returned more trades (usually Codex for EVM)
    if (codexResult.length >= birdeyeResult.length && codexResult.length > 0) {
        console.log(`[LiveTrade] Using Codex (${codexResult.length} trades) for ${chain}`);
        return codexResult;
    }
    if (birdeyeResult.length > 0) {
        console.log(`[LiveTrade] Using Birdeye (${birdeyeResult.length} trades) for ${chain}`);
        return birdeyeResult;
    }

    console.warn(`[LiveTrade] Both Birdeye and Codex returned 0 trades for ${address} on ${chain}`);
    return [];
}

// ─── Redis helpers ────────────────────────────────────────────────────────────

function redisKey(tokenId: string) {
    return `live_trade:${tokenId.toLowerCase()}`;
}

async function getCached(redisClient: any, tokenId: string): Promise<LiveTradeData | null> {
    // 1. Try Redis
    if (redisClient) {
        try {
            const raw = await redisClient.get(redisKey(tokenId));
            if (raw) {
                console.log(`[LiveTrade] ⚡ Redis hit → "${tokenId}"`);
                return JSON.parse(raw);
            }
        } catch { /* Redis down — fall through to memory */ }
    }
    // 2. Fallback in-memory
    const mem = memCache.get(tokenId);
    if (mem && Date.now() - mem.cachedAt < MEM_TTL_MS) {
        console.log(`[LiveTrade] ⚡ Memory hit → "${tokenId}"`);
        return mem.data;
    }
    return null;
}

async function setCached(redisClient: any, tokenId: string, data: LiveTradeData) {
    // 1. Redis with 10-second TTL
    if (redisClient) {
        try {
            await redisClient.set(redisKey(tokenId), JSON.stringify(data), { EX: REDIS_TTL_SEC });
        } catch { /* non-fatal */ }
    }
    // 2. Always set in-memory too
    memCache.set(tokenId, { data, cachedAt: Date.now() });
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function getLiveTradeData(
    tokenId: string,
    tokens: LiveTradeToken[],
    redisClient?: any,
): Promise<LiveTradeData | null> {
    const id = tokenId.toLowerCase();

    // 1. Cache check (Redis → memory)
    const cached = await getCached(redisClient, id);
    if (cached) return cached;

    // 2. Resolve address + chain from tokens.json
    const resolved = resolveAddressForToken(id, tokens);
    if (!resolved) {
        console.warn(`[LiveTrade] No address for "${id}"`);
        return null;
    }

    const { address, chain } = resolved;
    console.log(`[LiveTrade] Fetching "${id}" → ${address} (${chain})`);

    // 3. Fetch trades via gateway
    const trades = await fetchTrades(address, chain);

    // 4. Build response — metrics default to 0 (panel only renders trades)
    const data: LiveTradeData = {
        tokenId: id,
        contractAddress: address,
        chain,
        price: trades[0]?.price ?? 0,
        priceChange5m: 0,
        priceChange1h: 0,
        priceChange24h: 0,
        volume5m: 0,
        volume1h: 0,
        volume24h: 0,
        liquidityUsd: 0,
        buys5m: 0, sells5m: 0,
        buys1h: 0, sells1h: 0,
        buys24h: trades.filter(t => t.side === 'buy').length,
        sells24h: trades.filter(t => t.side === 'sell').length,
        trades,
        updatedAt: Date.now(),
    };

    // 5. Cache it for 10 seconds
    await setCached(redisClient, id, data);

    return data;
}