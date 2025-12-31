const axios = require('axios');

// --- 1. CONFIGURATION ---
const TRACKED_TOKEN_IDS = [
    "ethereum", "binancecoin", "solana", "hyperliquid", "avalanche-2", "okb", "mantle",
    "matic-network", "plasma", "sonic-3", "berachain-bera", "monad", "bitcoin", "ripple",
    "tron", "cardano", "polkadot", "near", "zcash", "crypto-com-chain", "dogecoin",
    "the-open-network", "gatechain-token", "cosmos", "weth", "ethena-usde", "usds",
    "usd1-wlfi", "paypal-usd", "usdtb", "tether-gold", "tether", "usd-coin", "chainlink",
    "shiba-inu", "dai", "susds", "uniswap", "rain", "memecore", "bitget-token", "aave",
    "falcon-finance", "pepe", "aster-2", "midnight-3", "ethena", "pax-gold", "global-dollar",
    "sky", "syrupusdc", "ripple-usd", "worldcoin-wld", "ondo-finance", "arbitrum", "pump-fun",
    "quant-network", "official-trump", "usdd", "bonk", "render-token", "usdai", "syrupusdt",
    "morpho", "pancakeswap-token", "jupiter-exchange-solana", "pudgy-penguins", "curve-dao-token",
    "usual-usd", "optimism", "first-digital-usd", "lido-dao", "gho", "true-usd", "injective-protocol",
    "ether-fi", "spx6900", "virtual-protocol", "aerodrome-finance", "starknet", "doublezero",
    "telcoin", "bittorrent", "floki", "the-graph", "syrup", "trust-wallet-token", "euro-coin",
    "olympus", "resolv-usr", "merlin-chain", "pyth-network", "gnosis", "basic-attention-token",
    "humanity", "pendle", "the-sandbox", "helium", "dogwifcoin", "fartcoin", "gala", "zksync",
    "layerzero", "compound-governance-token", "raydium", "decentraland", "reallink", "usda-2",
    "agora-dollar", "zero-gravity", "golem", "falcon-finance-ff", "eigenlayer", "1inch", "kamino",
    "instadapp", "immutable-x", "lombard-protocol", "wormhole", "origintrail", "zora", "astherus-usdf",
    "jito-governance-token", "bnb48-club-token", "zencash", "safepal", "orderly-network",
    "ocean-protocol", "avici", "deapcoin"
];

// --- 2. FETCHING LOGIC ---

async function fetchCoinGeckoPrices(ids) {
    try {
        // ✅ ADDED: Fake User-Agent to prevent 403 Forbidden / blocking
        const config = {
            params: {
                ids: ids.join(','),
                vs_currencies: 'usd',
                include_24hr_change: 'true'
            },
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Accept': 'application/json'
            },
            timeout: 5000
        };

        const response = await axios.get('https://api.coingecko.com/api/v3/simple/price', config);
        return response.data;
    } catch (error) {
        // Log the EXACT error code to see if it's 429 (Rate Limit) or 403 (Block)
        const status = error.response ? error.response.status : 'Unknown';
        console.error(`[PriceService] API Error (${status}): ${error.message}`);
        return {};
    }
}

async function updatePrices(cache) {
    console.log(`[${new Date().toISOString()}] Updating prices...`);
    
    const chunkSize = 50;
    const chunks = [];
    for (let i = 0; i < TRACKED_TOKEN_IDS.length; i += chunkSize) {
        chunks.push(TRACKED_TOKEN_IDS.slice(i, i + chunkSize));
    }

    let allPrices = {};

    for (const chunk of chunks) {
        const result = await fetchCoinGeckoPrices(chunk);
        allPrices = { ...allPrices, ...result };
        
        await new Promise(resolve => setTimeout(resolve, 500)); // Increased delay slightly
    }

    const missing = TRACKED_TOKEN_IDS.filter(id => !allPrices[id]);
    if (missing.length > 0) {
        console.warn(`[PriceService] ⚠️ Warning: No price data found for: ${missing.join(', ')}`);
    }

    if (Object.keys(allPrices).length > 0) {
        cache.set("ALL_PRICES", allPrices, 120); // 120s TTL for safety
        console.log(`[PriceService] Cached ${Object.keys(allPrices).length} prices.`);
    } else {
        console.error("[PriceService] ❌ CRITICAL: No prices fetched. Cache is empty.");
    }
}

// --- 3. EXPORT WITH SAFETY CHECKS ---

let started = false;

function startPriceService(cache) {
    if (started) {
        console.log("[PriceService] Already running. Skipping start.");
        return;
    }
    started = true;

    updatePrices(cache).catch(e => console.error("[PriceService] Initial update failed:", e));
    
    setInterval(async () => {
        try {
            await updatePrices(cache);
        } catch (e) {
            console.error('[PriceService] Background update error:', e);
        }
    }, 60 * 1000);
    
    console.log("[PriceService] Background job started.");
}

module.exports = { startPriceService };
