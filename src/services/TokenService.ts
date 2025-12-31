import axios from 'axios';
import NodeCache from 'node-cache';
import { getAddress } from 'ethers';
import fs from 'fs';
import path from 'path';

export interface TokenData {
    source: string;
    chainId: number;
    contractAddress: string;
    name: string;
    symbol: string;
    price: number;
    changePercent: number;
    imageName: string;
}

export class TokenService {
    private static instance: TokenService;
    private cache: NodeCache;

    private chainNameMap: Record<number, string> = {
        1: 'ethereum',
        56: 'smartchain',
        137: 'polygon',
        10: 'optimism',
        42161: 'arbitrum',
        8453: 'base',
        43114: 'avalanchec',
        101: 'solana'
    };

    private constructor() {
        this.cache = new NodeCache({ stdTTL: 60 }); 
    }

    public static getInstance(): TokenService {
        if (!TokenService.instance) {
            TokenService.instance = new TokenService();
        }
        return TokenService.instance;
    }

    private toChecksumAddress(address: string): string {
        if (!address || !address.startsWith('0x')) return address;
        try {
            return getAddress(address);
        } catch (error) {
            return address;
        }
    }

    private mapChainId(chainInput: string | number): number {
        if (!chainInput) return 0;
        if (typeof chainInput === 'number') return chainInput;

        const chainString = String(chainInput).toLowerCase().replace(/[_\-]/g, ' ').trim();
        const map: Record<string, number> = {
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

    public async searchToken(address: string): Promise<TokenData | null> {
        const cleanAddress = address.trim().startsWith('0x') 
            ? address.trim().toLowerCase() 
            : address.trim();

        const cached = this.cache.get<TokenData>(cleanAddress);
        if (cached) {
            console.log(`[CACHE HIT] Serving ${cleanAddress}`);
            return cached;
        }

        console.log(`[MISS] Fetching ${cleanAddress}...`);
        let tokenData: TokenData | null = null;
        let logoUrl = "questionmark.circle";

        try {
            const searchRes = await axios.get(`https://api.geckoterminal.com/api/v2/search/pools?query=${cleanAddress}`, { timeout: 5000 });
            const pool = searchRes.data.data?.[0];

            if (pool) {
                const networkId = pool.relationships.network.data.id;
                const attr = pool.attributes;
                
                try {
                    const tokenUrl = `https://api.geckoterminal.com/api/v2/networks/${networkId}/tokens/${cleanAddress}`;
                    const tokenRes = await axios.get(tokenUrl, { timeout: 3000 });
                    const info = tokenRes.data.data.attributes;
                    if (info.image_url && !info.image_url.includes("missing")) {
                        logoUrl = info.image_url;
                    }
                } catch (e) { }

                tokenData = {
                    source: 'GeckoTerminal',
                    chainId: this.mapChainId(networkId),
                    contractAddress: cleanAddress,
                    name: attr.name.split(' / ')[0],
                    symbol: "UNK", 
                    price: parseFloat(attr.base_token_price_usd || attr.price_usd || "0"),
                    changePercent: parseFloat(attr.price_change_percentage?.h24 || "0"),
                    imageName: logoUrl
                };
            }
        } catch (error) {
            console.log("Gecko Search failed.");
        }

        if (!tokenData || logoUrl === "questionmark.circle") {
            try {
                const dexRes = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${cleanAddress}`, { timeout: 5000 });
                const pairs = dexRes.data.pairs || [];
                const bestPair = pairs.find((p: any) => p.info?.imageUrl) || pairs[0];

                if (bestPair) {
                    tokenData = {
                        source: 'DexScreener',
                        chainId: this.mapChainId(bestPair.chainId),
                        contractAddress: bestPair.baseToken.address,
                        name: bestPair.baseToken.name,
                        symbol: bestPair.baseToken.symbol,
                        price: parseFloat(bestPair.priceUsd || "0"),
                        changePercent: bestPair.priceChange?.h24 || 0,
                        imageName: bestPair.info?.imageUrl || logoUrl
                    };
                }
            } catch (err) {
                console.log("DexScreener failed.");
            }
        }

        if (tokenData && (tokenData.imageName === "questionmark.circle" || !tokenData.imageName)) {
            const chainKey = this.chainNameMap[tokenData.chainId];
            if (chainKey) {
                const isEVM = cleanAddress.startsWith('0x');
                const finalAddr = isEVM ? this.toChecksumAddress(cleanAddress) : cleanAddress;
                tokenData.imageName = `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/${chainKey}/assets/${finalAddr}/logo.png`;
            }
        }

        if (tokenData) {
            this.cache.set(cleanAddress, tokenData);
        }

        return tokenData;
    }

    public async getPortfolioPrices(): Promise<Record<string, { usd: number, usd_24h_change: number }>> {
        const cacheKey = "portfolio_prices";
        const cached = this.cache.get<any>(cacheKey);
        if (cached) return cached;

        try {
            const filePath = path.join(__dirname, '../config/tokens.json');
            if (!fs.existsSync(filePath)) return {};

            const fileData = fs.readFileSync(filePath, 'utf-8');
            const tokens = JSON.parse(fileData);

            const ids = tokens.map((t: any) => t.coingeckoId).filter((id: string) => id).join(',');
            if (!ids) return {};

            const apiKey = process.env.COINGECKO_API_KEY;
            const options: any = {
                timeout: 5000,
                headers: { 'accept': 'application/json' }
            };

            if (apiKey) {
                options.headers['x-cg-demo-api-key'] = apiKey;
            }

            const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`;
            
            const { data } = await axios.get(url, options);

            const prices: Record<string, { usd: number, usd_24h_change: number }> = {};
            
            tokens.forEach((t: any) => {
                const coinData = data[t.coingeckoId];
                if (coinData) {
                    prices[t.coingeckoId] = {
                        usd: coinData.usd,
                        usd_24h_change: coinData.usd_24h_change || 0
                    };
                }
            });

            this.cache.set(cacheKey, prices, 60);
            return prices;

        } catch (error) {
            console.error("Portfolio Fetch Failed:", error);
            return {};
        }
    }
}