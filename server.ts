import dotenv from 'dotenv';
import express, { Request, Response } from 'express';
import axios from 'axios';
import { createClient } from 'redis';
import cors from 'cors';
import { getAddress } from 'ethers';

import { startPriceService } from './priceService';
import { startFiatRatesService, getFiatRates } from './fiatService';
import { startMarketMetricsService } from './marketMetricsService';

import { createTokenContractRouter, ContractToken } from './tokenContract';

import fs from 'fs';
import path from 'path';

dotenv.config();

const app = express();

const redisClient = createClient({
    url: process.env.REDIS_URL || 'redis://localhost:6379'
});

redisClient.on('error', (err) => console.error('[Redis] Client Error', err));

(async () => {
    await redisClient.connect();
    console.log('[Server] ✅ Connected to Redis');

    startPriceService(redisClient);
    startMarketMetricsService(redisClient);
    startFiatRatesService();
})();

app.use(cors());
app.use(express.json());

let contractTokens: ContractToken[] = [];
try {
    const tokensPath = path.join(process.cwd(), 'tokens.json');
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

function normalizeAddress(chainId: number, address: string): string {
    if (!address) return "";
    if (chainId === 101) return address.trim();
    try { return getAddress(address); } catch { return address.trim().toLowerCase(); }
}

async function fetchLivePrice(chainId: number, address: string): Promise<PriceData | null> {
    const cleanAddress = normalizeAddress(chainId, address);
    const AXIOS_TIMEOUT = 3000;

    const geckoNetworkMap: { [key: number]: string } = {
        1: 'eth', 56: 'bsc', 137: 'polygon_pos', 10: 'optimism',
        42161: 'arbitrum', 8453: 'base', 43114: 'avax', 101: 'solana',
        5000: 'mantle', 143: 'monad', 999: 'hyperliquid', 146: 'sonic', 80094: 'berachain'
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

app.get('/health', (_: Request, res: Response) => {
    res.json({ status: 'ok', uptime: process.uptime() });
});

app.get('/api/portfolio/prices', async (req: Request, res: Response) => {
    let prices: Record<string, any> = {};
    try {
        const pricesRaw = await redisClient.get("ALL_PRICES");
        if (pricesRaw) prices = JSON.parse(pricesRaw);
    } catch { /* Redis down or malformed — continue with empty prices */ }

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
    let fearAndGreed = null;
    let dominance = null;
    try {
        const fngRaw = await redisClient.get('FEAR_AND_GREED');
        const domRaw = await redisClient.get('DOMINANCE');
        if (fngRaw) fearAndGreed = JSON.parse(fngRaw);
        if (domRaw) dominance = JSON.parse(domRaw);
    } catch (error) {
        console.error("Metrics API Error:", error);
    }
    res.json({ fearAndGreed, dominance });
});

app.post('/api/portfolio/favorites', async (req: Request, res: Response) => {
    const { tokens } = req.body as { tokens: FavoriteRequestItem[] };
    if (!tokens || !Array.isArray(tokens)) return res.status(400).json({ error: "Invalid input" });

    const response: Record<string, any> = {};
    const missingTokens: (FavoriteRequestItem & { normAddr: string })[] = [];

    for (const t of tokens) {
        const normAddr = normalizeAddress(t.chainId, t.address);
        const cacheKey = `fav:${t.chainId}:${normAddr}`;

        try {
            const cachedValRaw = await redisClient.get(cacheKey);
            if (cachedValRaw) {
                response[t.address] = JSON.parse(cachedValRaw);
            } else {
                missingTokens.push({ ...t, normAddr });
            }
        } catch {
            missingTokens.push({ ...t, normAddr });
        }
    }

    if (missingTokens.length > 0) {
        const promises = missingTokens.map(async (t) => {
            const data = await fetchLivePrice(t.chainId, t.address);
            if (data) {
                response[t.address] = data;
                await redisClient.set(`fav:${t.chainId}:${t.normAddr}`, JSON.stringify(data), { EX: 60 });
            }
        });
        await Promise.all(promises);
    }
    res.json(response);
});

app.get('/api/search', async (req: Request, res: Response) => {
    const { address } = req.query;
    if (!address || typeof address !== 'string')
        return res.status(400).json({ error: 'Query is required' });

    const cleanQuery = address.trim().toLowerCase();
    const isContractAddress = cleanQuery.startsWith('0x') && cleanQuery.length === 42;

    const localMatches = contractTokens.filter(t =>
        t.id.toLowerCase() === cleanQuery ||
        t.symbol.toLowerCase() === cleanQuery ||
        t.name.toLowerCase().includes(cleanQuery) ||
        (t.deployments && t.deployments.some(d => d.address.toLowerCase() === cleanQuery))
    );

    if (localMatches.length > 0) {
        let allPrices: Record<string, any> = {};
        try {
            const pricesRaw = await redisClient.get("ALL_PRICES");
            if (pricesRaw) allPrices = JSON.parse(pricesRaw);
        } catch { /* continue with empty prices */ }

        const results = localMatches.map(match => {
            const priceInfo = allPrices[match.id] || {};
            return {
                source: 'BackendJSON',
                id: match.id,
                name: match.name,
                symbol: match.symbol,
                price: parseFloat(priceInfo.usd || '0'),
                changePercent: parseFloat(priceInfo.usd_24h_change || '0'),
                imageName: match.logo || "questionmark.circle",
            };
        });

        return res.json(results);
    }

    return res.status(404).json({
        error: 'Token not found in local list.',
        hint: isContractAddress
            ? 'Use GET /api/token/metadata?address=0x... for unknown contracts'
            : 'Use GET /api/token/search?query=... to search by name or symbol',
    });
});

app.get('/api/tokens', (req: Request, res: Response) => {
    try {
        res.json(contractTokens);
    } catch (error) {
        console.error("Failed to fetch all tokens:", error);
        res.status(500).json({ error: 'Failed to fetch tokens' });
    }
});

app.use('/api/token', createTokenContractRouter(redisClient as any, contractTokens));

app.get('/api/fiat-rates', (req, res) => {
    try {
        const rates = getFiatRates();
        res.json(rates);
    } catch (error) {
        console.error("Error serving fiat rates:", error);
        res.status(500).json({ error: "Failed to fetch fiat rates" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT as number, '0.0.0.0', () => console.log(`Fluxor Backend running on port ${PORT}`));