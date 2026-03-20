import { Request, Response } from 'express';
import axios from 'axios';
import { getAddress } from 'ethers';

// --- Search Specific Helpers ---

function toChecksumAddress(address: string): string {
    if (!address || !address.startsWith('0x')) return address;
    try { return getAddress(address); } catch (error) { return address; }
}

const chainNameMap: { [key: number]: string } = {
    1: 'ethereum', 56: 'smartchain', 137: 'polygon', 10: 'optimism',
    42161: 'arbitrum', 8453: 'base', 43114: 'avalanchec', 101: 'solana',
    5000: 'mantle', 143: 'monad', 999: 'hyperliquid',
    9745: 'plasma', 146: 'sonic', 80094: 'berachain'
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
        'mantle': 5000, 'monad': 143, 'hyperliquid': 999, 'plasma': 9745, 
        'sonic': 146, 'berachain': 80094
    };
    return map[chainString] || 0;
}

// --- Main Search Controller ---

export const searchTokenByContract = async (
    req: Request, 
    res: Response, 
    redisClient: any, 
    contractTokens: any[]
) => {
    const { address } = req.query;
    if (!address || typeof address !== 'string') return res.status(400).json({ error: 'Query is required' });

    const cleanQuery = address.trim().toLowerCase();

    // 1. Check Local Tokens.json
    const localMatch = contractTokens.find(t =>
        t.id.toLowerCase() === cleanQuery ||
        t.symbol.toLowerCase() === cleanQuery ||
        t.name.toLowerCase().includes(cleanQuery) ||
        (t.deployments && t.deployments.some((d: any) => d.address.toLowerCase() === cleanQuery))
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

    let tokenData: any = null;

    try {
        const [geckoRes, dexRes] = await Promise.allSettled([
            axios.get(`https://api.geckoterminal.com/api/v2/search/pools?query=${cleanQuery}`, { timeout: 4000 }),
            axios.get(`https://api.dexscreener.com/latest/dex/tokens/${cleanQuery}`, { timeout: 4000 })
        ]);

        // 3. PRIORITY 1: GeckoTerminal
        if (geckoRes.status === 'fulfilled' && geckoRes.value.data.data?.[0]) {
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

        // 4. FALLBACK: DexScreener (Only checked if GeckoTerminal found nothing)
        if (!tokenData && dexRes.status === 'fulfilled' && dexRes.value.data.pairs?.length > 0) {
            
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

    } catch (err) {
        console.error("Search failed", err);
    }

    // 5. Trust Wallet Logo Fallback
    if (tokenData && (tokenData.imageName === "questionmark.circle" || !tokenData.imageName)) {
        const chainKey = chainNameMap[tokenData.chainId || 0];
        if (chainKey && cleanQuery.startsWith('0x')) {
            tokenData.imageName = `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/${chainKey}/assets/${toChecksumAddress(cleanQuery)}/logo.png`;
        }
    }

    // 6. Return and Cache
    if (tokenData) {
        // Cache result in Redis for 10 minutes (600s)
        await redisClient.set(cleanQuery, JSON.stringify(tokenData), { EX: 600 });
        return res.json(tokenData);
    }
    
    res.status(404).json({ error: 'Token not found' });
};