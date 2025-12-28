require('dotenv').config();
const express = require('express');
const axios = require('axios');
const NodeCache = require('node-cache');
const cors = require('cors');

const app = express();
const cache = new NodeCache({ stdTTL: 60 }); // Cache expires in 60 seconds

app.use(cors()); // Allow your iOS app to hit this
app.use(express.json());

// ---------------------------------------------------------
// HELPER: Normalize Chain IDs
// ---------------------------------------------------------
function mapChainId(chainString) {
    if (!chainString) return 0;
    const map = {
        'eth': 1, 'ethereum': 1,
        'bsc': 56, 'bnbchain': 56, 'binance-smart-chain': 56,
        'sol': 101, 'solana': 101,
        'base': 8453,
        'arbitrum': 42161,
        'optimism': 10,
        'polygon': 137, 'pos': 137,
        'avax': 43114, 'avalanche': 43114
    };
    return map[chainString.toLowerCase()] || 0; 
}

// ---------------------------------------------------------
// LOGIC: Smart Search with Fallback
// ---------------------------------------------------------
app.get('/api/search', async (req, res) => {
    const { address } = req.query;

    if (!address) {
        return res.status(400).json({ error: 'Address is required' });
    }

    const cleanAddress = address.trim();

    // 1. CHECK CACHE
    const cachedData = cache.get(cleanAddress);
    if (cachedData) {
        console.log(`[CACHE HIT] Serving ${cleanAddress} from memory.`);
        return res.json(cachedData);
    }

    console.log(`[MISS] Fetching ${cleanAddress}...`);

    // 2. TRY GECKOTERMINAL
    try {
        const geckoUrl = `https://api.geckoterminal.com/api/v2/search/pools?query=${cleanAddress}`;
        const geckoRes = await axios.get(geckoUrl);
        const pool = geckoRes.data.data?.[0];

        if (pool) {
            const attr = pool.attributes;
            const tokenData = {
                source: 'GeckoTerminal',
                chainId: mapChainId(pool.relationships.network.data.id),
                contractAddress: cleanAddress,
                name: attr.name.split(' / ')[0] || "Unknown",
                symbol: "UNK", // Gecko doesn't always give clean symbols in search
                price: parseFloat(attr.base_token_price_usd || 0),
                changePercent: parseFloat(attr.price_change_percentage?.h24 || 0),
                imageName: "questionmark.circle" 
            };

            cache.set(cleanAddress, tokenData);
            return res.json(tokenData);
        }
    } catch (error) {
        console.log("Gecko failed, switching to DexScreener...");
    }

    // 3. FALLBACK: DEXSCREENER
    try {
        const dexUrl = `https://api.dexscreener.com/latest/dex/tokens/${cleanAddress}`;
        const dexRes = await axios.get(dexUrl);
        const pair = dexRes.data.pairs?.[0];

        if (pair) {
            const tokenData = {
                source: 'DexScreener',
                chainId: mapChainId(pair.chainId),
                contractAddress: pair.baseToken.address,
                name: pair.baseToken.name,
                symbol: pair.baseToken.symbol,
                price: parseFloat(pair.priceUsd || 0),
                changePercent: pair.priceChange?.h24 || 0,
                imageName: "questionmark.circle"
            };

            cache.set(cleanAddress, tokenData);
            return res.json(tokenData);
        }
    } catch (error) {
        console.log("DexScreener failed:", error.message);
    }

    return res.status(404).json({ error: 'Token not found' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Fluxor Backend running on port ${PORT}`));