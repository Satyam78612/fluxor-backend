import dotenv from 'dotenv';
import express, { Request, Response } from 'express';
import axios from 'axios';
import { createClient } from 'redis';
import cors from 'cors';
import { getAddress } from 'ethers';

import { startPriceService } from './priceService';
import { startMarketMetricsService } from './marketMetricsService';
import { searchTokenByContract } from './tokenContract'; 

import fs from 'fs';
import path from 'path';

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
    startMarketMetricsService(redisClient);
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

let contractTokens: ContractToken[] = [];
try {
    const tokensPath = path.join(__dirname, 'tokens.json'); // Note: Make sure to change __dirname to process.cwd() if Render gives you a missing file error again!
    const fileData = fs.readFileSync(tokensPath, 'utf8');
    contractTokens = JSON.parse(fileData) as ContractToken[];
    console.log(`[Server] ✅ Loaded ${contractTokens.length} tokens from JSON.`);
} catch (error) {
    console.error("[Server] ❌ Failed to load tokens.json:", error);
}

interface PriceData {
    price: number;
    change24h: number;
    source: string;
}

interface FavoriteRequestItem {
    chainId: number;
    address: string;
}

// --- Helper Functions ---

// Note: I kept normalizeAddress here because fetchLivePrice below still uses it!
function normalizeAddress(chainId: number, address: string): string {
    if (!address) return "";
    if (chainId === 101) return address.trim();
    try { return getAddress(address); } catch { return address.trim().toLowerCase(); }}

async function fetchLivePrice(chainId: number, address: string): Promise<PriceData | null> {
    const cleanAddress = normalizeAddress(chainId, address);
    const AXIOS_TIMEOUT = 3000;

    const geckoNetworkMap: { [key: number]: string } = {
        1: 'eth', 56: 'bsc', 137: 'polygon_pos', 10: 'optimism',
        42161: 'arbitrum', 8453: 'base', 43114: 'avax', 101: 'solana',
        5000: 'mantle', 59144: 'monad', 999: 'hyperliquid', 146: 'sonic', 
        80094: 'berachain'
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

app.get('/api/market/metrics', async (req: Request, res: Response) => {
    try {
        const fngRaw = await redisClient.get('FEAR_AND_GREED');
        const domRaw = await redisClient.get('DOMINANCE');

        res.json({
            fearAndGreed: fngRaw ? JSON.parse(fngRaw) : null,
            dominance: domRaw ? JSON.parse(domRaw) : null
        });
    } catch (error) {
        console.error("Metrics API Error:", error);
        res.status(500).json({ error: 'Failed to fetch market metrics' });
    }
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

app.get('/api/search', (req: Request, res: Response) => {
    searchTokenByContract(req, res, redisClient, contractTokens);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT as number, '0.0.0.0', () => console.log(`Fluxor Backend running on port ${PORT}`));