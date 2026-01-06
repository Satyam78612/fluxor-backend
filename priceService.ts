import axios from 'axios';
import fs from 'fs';
import path from 'path';

const TOP_COIN_IDS: string[] = [
    "ethereum", "binancecoin", "solana", "hyperliquid", "avalanche-2", 
    "matic-network", "plasma", "sonic-3", "berachain-bera", "monad", 
    "bitcoin", "ripple", "polkadot", "near", "zcash", "dogecoin", 
    "the-open-network", "tether-gold", "tether", "usd-coin", 
    "chainlink", "uniswap", "ethena", "ondo-finance", "arbitrum",
    "aave", "sky", "worldcoin-wld", "succinct", "pancakeswap-token",
    "jupiter-exchange-solana", "pudgy-penguins", "optimism", "aerodrome-finance",
    "starknet", "syrup", "pendle", "layerzero", "raydium", "eigenlayer"
];

const INTERVAL_TOP_MS = 5 * 60 * 1000;   
const INTERVAL_REST_MS = 30 * 60 * 1000; 

const CG_BATCH_SIZE = 40; 
const CG_DELAY_MS = 3000; 

interface Token {
    id: string;
    symbol: string;
    name: string;
}

interface PriceData {
    usd: number;
    usd_24h_change: number;
    last_updated_at: number;
}

interface CoinGeckoResponse {
    [key: string]: {
        usd: number;
        usd_24h_change: number;
        last_updated_at: number;
    };
}

let JSON_TOKENS: Token[] = [];

try {
    const contractPath = path.join(__dirname, 'tokens.json');
    if (fs.existsSync(contractPath)) {
        JSON_TOKENS = JSON.parse(fs.readFileSync(contractPath, 'utf8')) as Token[];
        console.log(`[PriceService] ✅ Loaded ${JSON_TOKENS.length} tokens from tokens.json`);
    } else {
        console.warn("[PriceService] ⚠️ tokens.json not found.");
    }
} catch (error: any) {
    console.error("[PriceService] Failed to load JSON:", error.message);
}

async function fetchCoinGeckoBatch(ids: string[]): Promise<Record<string, PriceData>> {
    const results: Record<string, PriceData> = {};
    if (!ids || ids.length === 0) return results;

    try {
        const apiKey = process.env.COINGECKO_API_KEY;
        const headers: Record<string, string> = {};

        if (apiKey) {
            headers['x-cg-demo-api-key'] = apiKey; 
        }

        const { data } = await axios.get<CoinGeckoResponse>(
            `https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(',')}&vs_currencies=usd&include_24hr_change=true&include_last_updated_at=true`,
            { timeout: 5000, headers: headers }
        );

        ids.forEach(id => {
            if (data[id]) {
                results[id] = {
                    usd: data[id]?.usd ?? 0,
                    usd_24h_change: data[id]?.usd_24h_change ?? 0,
                    last_updated_at: data[id]?.last_updated_at ?? Math.floor(Date.now() / 1000)
                };
            }
        });

        return results;

    } catch (error: any) {
        if (error.response && error.response.status === 429) {
            console.warn("[PriceService] ⚠️ CoinGecko Rate Limit (429). Skipping batch.");
            return {};
        }
        console.error(`[PriceService] CoinGecko Error: ${error.message}`);
        return {};
    }
}

async function updateRedisCache(redis: any, newPrices: Record<string, PriceData>) {
    try {
        const currentRaw = await redis.get("ALL_PRICES");
        const current = currentRaw ? JSON.parse(currentRaw) : {};
        
        const updated = { ...current, ...newPrices };
        
        await redis.set("ALL_PRICES", JSON.stringify(updated));
        
        console.log(`[PriceService] 💾 Saved ${Object.keys(newPrices).length} prices to Redis.`);
    } catch (e) {
        console.error("[PriceService] ❌ Redis Save Failed:", e);
    }
}

let isTopRunning = false;
let isRestRunning = false;

async function updateTopPrices(redis: any) {
    if (isTopRunning) {
        console.log("[PriceService] ⚠️ Top update skipped (previous run still active).");
        return;
    }
    isTopRunning = true;

    try {
        console.log(`[${new Date().toISOString()}] 🚀 Updating TOP 40 Tokens...`);
        const prices = await fetchCoinGeckoBatch(TOP_COIN_IDS);
        if (Object.keys(prices).length > 0) {
            await updateRedisCache(redis, prices);
        }
    } finally {
        isTopRunning = false;
    }
}

async function updateRestPrices(redis: any) {
    if (isRestRunning) {
        console.log("[PriceService] ⚠️ Rest update skipped (previous run still active).");
        return;
    }
    isRestRunning = true;

    try {
        console.log(`[${new Date().toISOString()}] 🐢 Updating REST of tokens...`);

        const restIds = JSON_TOKENS
            .map(t => t.id)
            .filter(id => !TOP_COIN_IDS.includes(id));
        
        for (let i = 0; i < restIds.length; i += CG_BATCH_SIZE) {
            const batch = restIds.slice(i, i + CG_BATCH_SIZE);
            
            const prices = await fetchCoinGeckoBatch(batch);
            
            if (Object.keys(prices).length > 0) {
                await updateRedisCache(redis, prices);
            }

            if (i + CG_BATCH_SIZE < restIds.length) {
                await new Promise(r => setTimeout(r, CG_DELAY_MS));
            }
        }
        console.log(`[PriceService] ✅ Finished updating rest tokens.`);
    } finally {
        isRestRunning = false;
    }
}

let started = false;

export function startPriceService(redisClient: any): void {
    if (started) {
        console.log("[PriceService] ⚠️ Service already started. Ignoring duplicate call.");
        return;
    }
    started = true;
    
    console.log("[PriceService] ✅ Service Started (CoinGecko All + Redis).");

    updateTopPrices(redisClient).catch(e => console.error("Top Update Failed", e));
    updateRestPrices(redisClient).catch(e => console.error("Rest Update Failed", e));
    
    setInterval(() => {
        updateTopPrices(redisClient);
    }, INTERVAL_TOP_MS); 

    setInterval(() => {
        updateRestPrices(redisClient);
    }, INTERVAL_REST_MS); 
}