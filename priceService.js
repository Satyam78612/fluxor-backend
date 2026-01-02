const axios = require('axios');
const fs = require('fs');
const path = require('path');

const TOP_COIN_IDS = [
    "ethereum", "binancecoin", "solana", "hyperliquid", "avalanche-2", 
    "matic-network", "plasma", "sonic-3", "berachain-bera", "monad", 
    "bitcoin", "ripple", "polkadot", "near", "zcash", "dogecoin", 
    "the-open-network", "tether-gold", "tether", "usd-coin", 
    "chainlink", "uniswap", "pepe", "ondo-finance", "arbitrum",
    "aave", "sky", "worldcoin-wld", "succinct", "pancakeswap-token",
    "jupiter-exchange-solana", "pudgy-penguins", "optimism", "aerodrome-finance",
    "starknet", "syrup", "pendle", "layerzero", "raydium", "eigenlayer"
];

const DS_BATCH_SIZE = 30;
const DS_DELAY_MS = 1000;
const INTERVAL_MS = 300 * 1000; 

let JSON_TOKENS = [];

try {
    const contractPath = path.join(__dirname, 'Contract.json');
    if (fs.existsSync(contractPath)) {
        JSON_TOKENS = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
        console.log(`[PriceService] ✅ Loaded ${JSON_TOKENS.length} tokens`);
    }
} catch (error) { console.error(`[PriceService] ❌ JSON Error: ${error.message}`); }

async function fetchCoinGeckoBatch(ids) {
    if (ids.length === 0) return {};
    try {
        const res = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
            params: { ids: ids.join(','), vs_currencies: 'usd', include_24hr_change: 'true' },
            timeout: 10000
        });
        return res.data;
    } catch (e) { return {}; }
}

async function fetchDexScreenerPrices(tokens) {
    const prices = {};
    for (let i = 0; i < tokens.length; i += DS_BATCH_SIZE) {
        const batch = tokens.slice(i, i + DS_BATCH_SIZE);
        const addresses = batch.map(t => t.address).filter(a => a && a.length > 10).join(',');
        if (!addresses) continue;

        try {
            const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${addresses}`, { timeout: 10000 });
            const pairs = res.data.pairs || [];
            
            batch.forEach(token => {
                const addr = token.address.toLowerCase();
                const tokenPairs = pairs.filter(p => 
                    p.baseToken.address?.toLowerCase() === addr || 
                    p.quoteToken.address?.toLowerCase() === addr
                );
                
                if (tokenPairs.length > 0) {
                    const bestPair = tokenPairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
                    
                    prices[token.id] = {
                        usd: parseFloat(bestPair.priceUsd || 0),
                        usd_24h_change: bestPair.priceChange?.h24 || 0
                    };
                }
            });
            if (i + DS_BATCH_SIZE < tokens.length) await new Promise(r => setTimeout(r, DS_DELAY_MS));
        } catch (err) { console.error(`[PriceService] DS Batch Error: ${err.message}`); }
    }
    return prices;
}

async function updatePrices(cache) {
    console.log(`[${new Date().toISOString()}] 🔄 Starting Hybrid Update...`);
    
    const cgPricesRaw = await fetchCoinGeckoBatch(TOP_COIN_IDS);
    const cgPrices = {};
    
    Object.keys(cgPricesRaw).forEach(id => {
        cgPrices[id] = { 
            usd: cgPricesRaw[id].usd, 
            usd_24h_change: cgPricesRaw[id].usd_24h_change 
        };
    });

    const dsTarget = JSON_TOKENS
        .filter(t => !TOP_COIN_IDS.includes(t.id))
        .map(t => ({ id: t.id, address: t.deployments?.[0]?.address || null }))
        .filter(t => t.address);
    const dsPrices = await fetchDexScreenerPrices(dsTarget);

    const allPrices = { ...(cache.get("ALL_PRICES") || {}), ...cgPrices, ...dsPrices };

    if (Object.keys(allPrices).length > 0) {
        cache.set("ALL_PRICES", allPrices, 360);
        console.log(`[PriceService] ✅ Cached ${Object.keys(allPrices).length} items by ID.`);
    }
}

let started = false;
function startPriceService(cache) {
    if (started) return;
    started = true;
    updatePrices(cache).catch(e => console.error("Initial update failed:", e));
    setInterval(() => updatePrices(cache), INTERVAL_MS);
    console.log("[PriceService] Started (Simple ID mode).");
}

module.exports = { startPriceService };
