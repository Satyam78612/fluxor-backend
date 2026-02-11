import dotenv from 'dotenv';
import express, { Request, Response } from 'express';
import axios from 'axios';
import { createClient } from 'redis';
import cors from 'cors';
import { getAddress } from 'ethers';

import { startPriceService } from './priceService';
import contractTokensRaw from './tokens.json';

dotenv.config();

const app = express();

// Redis Client Setup
const redisClient = createClient({
    url: process.env.REDIS_URL || 'redis://localhost:6379'
});

redisClient.on('error', (err) => console.error('[Redis] Client Error', err));

(async () => {
    await redisClient.connect();
    console.log('[Server] ✅ Connected to Redis');
    
    // Pass the connected client to your price service
    startPriceService(redisClient);
})();

app.use(cors());
app.use(express.json());

// --- Types & Interfaces ---

interface TokenDeployment {
    address: string;
    chainId?: number;
}

interface ContractToken {
    id: string;
    symbol: string;
    name: string;
    logo?: string;
    deployments?: TokenDeployment[];
}

// Cast import to typed array
const contractTokens = contractTokensRaw as ContractToken[];

interface PriceData {
    price: number;
    change24h: number;
    source: string;
}

interface FavoriteRequestItem {
    chainId: number;
    address: string;
}

interface SearchResult {
    source?: string;
    chainId?: number;
    contractAddress?: string;
    id?: string;
    name: string;
    symbol: string;
    price: number;
    changePercent: number;
    imageName: string;
}

// --- Helper Functions ---

function normalizeAddress(chainId: number, address: string): string {
    if (!address) return "";
    if (chainId === 101) return address.trim();
    try { return getAddress(address); } catch { return address.trim().toLowerCase(); }
}

function toChecksumAddress(address: string): string {
    if (!address || !address.startsWith('0x')) return address;
    try { return getAddress(address); } catch (error) { return address; }
}

const chainNameMap: { [key: number]: string } = {
    1: 'ethereum', 56: 'smartchain', 137: 'polygon', 10: 'optimism',
    42161: 'arbitrum', 8453: 'base', 43114: 'avalanchec', 101: 'solana',
    5000: 'mantle', 59144: 'linea', 143: 'monad', 999: 'hyperliquid',
    196: 'xlayer', 4200: 'merlin', 9745: 'plasma', 146: 'sonic', 80094: 'berachain'
};

function mapChainId(chainInput: string | number): number {
    if (!chainInput) return 0;
    if (typeof chainInput === 'number') return chainInput;
    const chainString = String(chainInput).toLowerCase().replace(/[_\-]/g, ' ').trim();
    const map: { [key: string]: number } = {
        'eth': 1, 'ethereum': 1, 'bsc': 56, 'bnb': 56, 'bnbchain': 56,
        'binance smart chain': 56, 'bnb smart chain': 56, 'sol': 101, 'solana': 101,
        'base': 8453, 'arbitrum': 42161, 'optimism': 10, 'polygon': 137,
        'pos': 137, 'polygon pos': 137, 'avax': 43114, 'avalanche': 43114,
        'mantle': 5000, 'monad': 143, 'hyperliquid': 999, 'x layer': 196,
        'xlayer': 196, 'merlin': 4200, 'plasma': 9745, 'linea': 59144,
        'sonic': 146, 'berachain': 80094
    };
    return map[chainString] || 0;
}

async function fetchLivePrice(chainId: number, address: string): Promise<PriceData | null> {
    const cleanAddress = normalizeAddress(chainId, address);
    const AXIOS_TIMEOUT = 3000;

    const geckoNetworkMap: { [key: number]: string } = {
        1: 'eth', 56: 'bsc', 137: 'polygon_pos', 10: 'optimism',
        42161: 'arbitrum', 8453: 'base', 43114: 'avax', 101: 'solana',
        5000: 'mantle', 59144: 'linea', 196: 'x-layer', 4200: 'merlin-chain',
        143: 'monad', 999: 'hyperliquid', 146: 'sonic', 80094: 'berachain'
    };
    const network = geckoNetworkMap[chainId];

    const geckoPromise = network ? axios.get(
        `https://api.geckoterminal.com/api/v2/networks/${network}/tokens/${cleanAddress}`,
        { timeout: AXIOS_TIMEOUT }
    ).then(res => ({ source: 'gecko', data: res.data, error: false })).catch(() => ({ error: true, data: null }))
    : Promise.resolve({ error: true, data: null });

    const dexPromise = axios.get(
        `https://api.dexscreener.com/latest/dex/tokens/${cleanAddress}`,
        { timeout: AXIOS_TIMEOUT }
    ).then(res => ({ source: 'dex', data: res.data, error: false })).catch(() => ({ error: true, data: null }));

    const [geckoResult, dexResult] = await Promise.all([geckoPromise, dexPromise]);

    if (!geckoResult.error && geckoResult.data?.data) {
        const attrs = geckoResult.data.data.attributes;
        return {
            price: parseFloat(attrs.price_usd || '0'),
            change24h: parseFloat(attrs.price_change_percentage?.h24 || '0'),
            source: 'GeckoTerminal'
        };
    }

    if (!dexResult.error && dexResult.data?.pairs?.length > 0) {
        const pairs = dexResult.data.pairs.sort((a: any, b: any) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
        const bestPair = pairs[0];
        return {
            price: parseFloat(bestPair.priceUsd || '0'),
            change24h: bestPair.priceChange?.h24 || 0,
            source: 'DexScreener'
        };
    }
    return null;
}

// --- Routes ---

app.get('/health', (_: Request, res: Response) => {
    res.json({ status: 'ok', uptime: process.uptime() });
});

app.get('/api/portfolio/prices', async (req: Request, res: Response) => {
    // Redis: Get string, parse to JSON
    const pricesRaw = await redisClient.get("ALL_PRICES");
    const prices = pricesRaw ? JSON.parse(pricesRaw) : {};
    
    const { ids } = req.query;
    if (ids && typeof ids === 'string') {
        const requestedIds = ids.split(',').map(i => i.trim().toLowerCase());
        const filtered: Record<string, any> = {};
        requestedIds.forEach(id => { if (prices[id]) filtered[id] = prices[id]; });
        return res.json(filtered);
    }
    res.json(prices);
});

app.post('/api/portfolio/favorites', async (req: Request, res: Response) => {
    const { tokens } = req.body as { tokens: FavoriteRequestItem[] };
    if (!tokens || !Array.isArray(tokens)) return res.status(400).json({ error: "Invalid input" });

    const response: Record<string, any> = {};
    const missingTokens: (FavoriteRequestItem & { normAddr: string })[] = [];

    for (const t of tokens) {
        const normAddr = normalizeAddress(t.chainId, t.address);
        const cacheKey = `fav:${t.chainId}:${normAddr}`;
        
        // Redis check
        const cachedValRaw = await redisClient.get(cacheKey);

        if (cachedValRaw) {
            response[t.address] = JSON.parse(cachedValRaw);
        } else {
            missingTokens.push({ ...t, normAddr });
        }
    }

    if (missingTokens.length > 0) {
        const promises = missingTokens.map(async (t) => {
            const data = await fetchLivePrice(t.chainId, t.address);
            if (data) {
                response[t.address] = data;
                // Redis set with Expiry (60s)
                await redisClient.set(`fav:${t.chainId}:${t.normAddr}`, JSON.stringify(data), { EX: 60 }); 
            }
        });
        await Promise.all(promises);
    }
    res.json(response);
});

app.get('/api/search', async (req: Request, res: Response) => {
    const { address } = req.query;
    if (!address || typeof address !== 'string') return res.status(400).json({ error: 'Query is required' });

    const cleanQuery = address.trim().toLowerCase();

    // 1. Check Local Tokens.json
    const localMatch = contractTokens.find(t =>
        t.id.toLowerCase() === cleanQuery ||
        t.symbol.toLowerCase() === cleanQuery ||
        t.name.toLowerCase().includes(cleanQuery) ||
        (t.deployments && t.deployments.some(d => d.address.toLowerCase() === cleanQuery))
    );

    if (localMatch) {
        const pricesRaw = await redisClient.get("ALL_PRICES");
        const allPrices = pricesRaw ? JSON.parse(pricesRaw) : {};
        const priceInfo = allPrices[localMatch.id] || {};

        return res.json({
            source: 'BackendJSON',
            id: localMatch.id,
            name: localMatch.name,
            symbol: localMatch.symbol,
            price: parseFloat(priceInfo.usd || '0'),
            changePercent: parseFloat(priceInfo.usd_24h_change || '0'),
            imageName: localMatch.logo || "questionmark.circle"
        });
    }

    // 2. Check Redis Cache for Search Query
    const cachedDataRaw = await redisClient.get(cleanQuery);
    if (cachedDataRaw) return res.json(JSON.parse(cachedDataRaw));

    let tokenData: SearchResult | null = null;

    try {
        const [geckoRes, dexRes] = await Promise.allSettled([
            axios.get(`https://api.geckoterminal.com/api/v2/search/pools?query=${cleanQuery}`, { timeout: 4000 }),
            axios.get(`https://api.dexscreener.com/latest/dex/tokens/${cleanQuery}`, { timeout: 4000 })
        ]);

        if (dexRes.status === 'fulfilled' && dexRes.value.data.pairs?.length > 0) {
            const bestPair = dexRes.value.data.pairs.sort((a: any, b: any) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
            tokenData = {
                source: 'DexScreener',
                chainId: mapChainId(bestPair.chainId),
                contractAddress: bestPair.baseToken.address,
                name: bestPair.baseToken.name,
                symbol: bestPair.baseToken.symbol,
                price: parseFloat(bestPair.priceUsd || '0'),
                changePercent: parseFloat(bestPair.priceChange?.h24 || 0),
                imageName: bestPair?.info?.imageUrl || "questionmark.circle"
            };
        }

        if (!tokenData && geckoRes.status === 'fulfilled' && geckoRes.value.data.data?.[0]) {
            const pool = geckoRes.value.data.data[0];
            const attr = pool.attributes;
            tokenData = {
                source: 'GeckoTerminal',
                chainId: mapChainId(pool.relationships.network.data.id),
                contractAddress: cleanQuery,
                name: attr.name?.split(' / ')[0] || "Unknown",
                symbol: attr.base_token_symbol || "UNK",
                price: parseFloat(attr.base_token_price_usd || '0'),
                changePercent: parseFloat(attr.price_change_percentage?.h24 || 0),
                imageName: "questionmark.circle"
            };
        }
    } catch (err) {
        console.error("Search failed", err);
    }

    if (tokenData && (tokenData.imageName === "questionmark.circle" || !tokenData.imageName)) {
        const chainKey = chainNameMap[tokenData.chainId || 0];
        if (chainKey && cleanQuery.startsWith('0x')) {
            tokenData.imageName = `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/${chainKey}/assets/${toChecksumAddress(cleanQuery)}/logo.png`;
        }
    }

    if (tokenData) {
        // Cache result in Redis for 600s
        await redisClient.set(cleanQuery, JSON.stringify(tokenData), { EX: 600 });
        return res.json(tokenData);
    }
    res.status(404).json({ error: 'Token not found' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Fluxor Backend running on port ${PORT}`));
