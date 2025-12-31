require('dotenv').config();
const express = require('express');
const axios = require('axios');
const NodeCache = require('node-cache');
const cors = require('cors');
const { getAddress } = require('ethers'); 

const app = express();
const cache = new NodeCache({ stdTTL: 60 }); 

app.use(cors()); 
app.use(express.json());

function toChecksumAddress(address) {
    if (!address || !address.startsWith('0x')) return address;
    try {
        return getAddress(address); 
    } catch (error) {
        return address;
    }
}

function mapChainId(chainInput) {
    if (!chainInput) return 0;
    if (typeof chainInput === 'number') return chainInput;

    const chainString = String(chainInput)
        .toLowerCase()
        .replace(/[_\-]/g, ' ') 
        .trim();
    
    const map = {
        'eth': 1, 'ethereum': 1,
        'bsc': 56, 'bnb': 56, 'bnbchain': 56, 'binance smart chain': 56, 'bnb smart chain': 56,
        'sol': 101, 'solana': 101,
        'base': 8453,
        'arbitrum': 42161,
        'optimism': 10,
        'polygon': 137, 'pos': 137, 'polygon pos': 137,
        'avax': 43114, 'avalanche': 43114,
        'mantle': 5000,
        'monad': 143,
        'hyperliquid': 999,
        'x layer': 196, 'xlayer': 196, 
        'merlin': 4200,
        'plasma': 9745,
        'linea': 59144,
        'sonic': 146,
        'berachain': 80094
    };
    
    return map[chainString] || 0; 
}

const chainNameMap = {
    1: 'ethereum',
    56: 'smartchain',
    137: 'polygon',
    10: 'optimism',
    42161: 'arbitrum',
    8453: 'base',
    43114: 'avalanchec',
    101: 'solana'
};

app.get('/api/search', async (req, res) => {
    const { address } = req.query;

    if (!address) {
        return res.status(400).json({ error: 'Address is required' });
    }

    const cleanAddress = address.trim().startsWith('0x') 
        ? address.trim().toLowerCase() 
        : address.trim();

    const cachedData = cache.get(cleanAddress);
    if (cachedData) {
        console.log(`[CACHE HIT] Serving ${cleanAddress} from memory.`);
        return res.json(cachedData);
    }

    console.log(`[MISS] Fetching ${cleanAddress}...`);

    let logoUrl = "questionmark.circle";
    let tokenData = null;

    try {
        const searchUrl = `https://api.geckoterminal.com/api/v2/search/pools?query=${cleanAddress}`;
        const searchRes = await axios.get(searchUrl, { timeout: 5000 });
        const pool = searchRes.data.data?.[0];

        if (pool) {
            const networkId = pool.relationships.network.data.id;
            const attr = pool.attributes;
            let realSymbol = "UNK";

            try {
                const tokenUrl = `https://api.geckoterminal.com/api/v2/networks/${networkId}/tokens/${cleanAddress}`;
                const tokenRes = await axios.get(tokenUrl, { timeout: 3000 });
                const tokenInfo = tokenRes.data.data;
                
                if (tokenInfo.attributes.symbol) realSymbol = tokenInfo.attributes.symbol;
                if (tokenInfo.attributes.image_url && !tokenInfo.attributes.image_url.includes("missing")) {
                    logoUrl = tokenInfo.attributes.image_url;
                }
            } catch (err) {}

            const safePrice = parseFloat(attr.base_token_price_usd ?? attr.price_usd ?? 0);

            tokenData = {
                source: 'GeckoTerminal',
                chainId: mapChainId(networkId),
                contractAddress: cleanAddress,
                name: attr.name ? attr.name.split(' / ')[0] : "Unknown",
                symbol: realSymbol,
                price: safePrice,
                changePercent: parseFloat(attr.price_change_percentage?.h24 || 0),
                imageName: logoUrl 
            };
        }
    } catch (error) {
        console.log("Gecko Search failed...");
    }

    if (!tokenData || logoUrl === "questionmark.circle") {
        try {
            console.log("Checking DexScreener...");
            const dexUrl = `https://api.dexscreener.com/latest/dex/tokens/${cleanAddress}`;
            const dexRes = await axios.get(dexUrl, { timeout: 5000 });
            
            const pairs = dexRes.data.pairs || [];
            const bestPair = pairs.find(p => p.info && p.info.imageUrl); 
            const dataPair = bestPair || pairs[0];

            if (dataPair) {
                if (!tokenData) {
                    tokenData = {
                        source: 'DexScreener',
                        chainId: mapChainId(dataPair.chainId),
                        contractAddress: dataPair.baseToken.address,
                        name: dataPair.baseToken.name,
                        symbol: dataPair.baseToken.symbol,
                        price: parseFloat(dataPair.priceUsd || 0),
                        changePercent: dataPair.priceChange?.h24 || 0,
                        imageName: "questionmark.circle"
                    };
                }

                if (bestPair && bestPair.info && bestPair.info.imageUrl) {
                    tokenData.imageName = bestPair.info.imageUrl;
                    logoUrl = bestPair.info.imageUrl;
                }
            }
        } catch (dexErr) {
            console.log("DexScreener failed:", dexErr.message);
        }
    }

    if (tokenData && (tokenData.imageName === "questionmark.circle" || !tokenData.imageName)) {
        console.log("⚠️ No API Logo found. Trying Static Fallback...");
        const chainKey = chainNameMap[tokenData.chainId];
        
        if (chainKey) {
            const isEVM = cleanAddress.startsWith('0x');
            const finalAddr = isEVM ? toChecksumAddress(cleanAddress) : cleanAddress;
            
            tokenData.imageName = `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/${chainKey}/assets/${finalAddr}/logo.png`;
        }
    }

    if (tokenData) {
        cache.set(cleanAddress, tokenData);
        return res.json(tokenData);
    }

    return res.status(404).json({ error: 'Token not found' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Fluxor Backend running on port ${PORT}`));