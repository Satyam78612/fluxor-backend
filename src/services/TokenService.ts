import axios from 'axios';
import NodeCache from 'node-cache';
import { getAddress } from 'ethers';

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

    private readonly tokens = [
        { "symbol": "ETH", "coingeckoId": "ethereum" },
        { "symbol": "BNB", "coingeckoId": "binancecoin" },
        { "symbol": "SOL", "coingeckoId": "solana" },
        { "symbol": "HYPE", "coingeckoId": "hyperliquid" },
        { "symbol": "AVAX", "coingeckoId": "avalanche-2" },
        { "symbol": "OKB", "coingeckoId": "okb" },
        { "symbol": "MNT", "coingeckoId": "mantle" },
        { "symbol": "MATIC", "coingeckoId": "matic-network" },
        { "symbol": "XPL", "coingeckoId": "plasma" },
        { "symbol": "S", "coingeckoId": "sonic-3" },
        { "symbol": "BERA", "coingeckoId": "berachain-bera" },
        { "symbol": "MON", "coingeckoId": "monad" },
        { "symbol": "BTC", "coingeckoId": "bitcoin" },
        { "symbol": "XRP", "coingeckoId": "ripple" },
        { "symbol": "TRX", "coingeckoId": "tron" },
        { "symbol": "ADA", "coingeckoId": "cardano" },
        { "symbol": "DOT", "coingeckoId": "polkadot" },
        { "symbol": "NEAR", "coingeckoId": "near" },
        { "symbol": "ZEC", "coingeckoId": "zcash" },
        { "symbol": "CRO", "coingeckoId": "crypto-com-chain" },
        { "symbol": "DOGE", "coingeckoId": "dogecoin" },
        { "symbol": "TON", "coingeckoId": "the-open-network" },
        { "symbol": "GT", "coingeckoId": "gatechain-token" },
        { "symbol": "ATOM", "coingeckoId": "cosmos" },
        { "symbol": "WETH", "coingeckoId": "weth" },
        { "symbol": "USDE", "coingeckoId": "ethena-usde" },
        { "symbol": "USDS", "coingeckoId": "usds" },
        { "symbol": "USD1", "coingeckoId": "usd1-wlfi" },
        { "symbol": "PYUSD", "coingeckoId": "paypal-usd" },
        { "symbol": "USDTB", "coingeckoId": "usdtb" },
        { "symbol": "XAUT", "coingeckoId": "tether-gold" },
        { "symbol": "USDT", "coingeckoId": "tether" },
        { "symbol": "USDC", "coingeckoId": "usd-coin" },
        { "symbol": "LINK", "coingeckoId": "chainlink" },
        { "symbol": "SHIB", "coingeckoId": "shiba-inu" },
        { "symbol": "DAI", "coingeckoId": "dai" },
        { "symbol": "SUSDS", "coingeckoId": "susds" },
        { "symbol": "UNI", "coingeckoId": "uniswap" },
        { "symbol": "RAIN", "coingeckoId": "rain" },
        { "symbol": "M", "coingeckoId": "memecore" },
        { "symbol": "BGB", "coingeckoId": "bitget-token" },
        { "symbol": "AAVE", "coingeckoId": "aave" },
        { "symbol": "USDF", "coingeckoId": "falcon-finance" },
        { "symbol": "PEPE", "coingeckoId": "pepe" },
        { "symbol": "ASTER", "coingeckoId": "aster-2" },
        { "symbol": "NIGHT", "coingeckoId": "midnight-3" },
        { "symbol": "ENA", "coingeckoId": "ethena" },
        { "symbol": "PAXG", "coingeckoId": "pax-gold" },
        { "symbol": "USDG", "coingeckoId": "global-dollar" },
        { "symbol": "SKY", "coingeckoId": "sky" },
        { "symbol": "SYRUPUSDC", "coingeckoId": "syrupusdc" },
        { "symbol": "RLUSD", "coingeckoId": "ripple-usd" },
        { "symbol": "WLD", "coingeckoId": "worldcoin-wld" },
        { "symbol": "ONDO", "coingeckoId": "ondo-finance" },
        { "symbol": "ARB", "coingeckoId": "arbitrum" },
        { "symbol": "PUMP", "coingeckoId": "pump-fun" },
        { "symbol": "QNT", "coingeckoId": "quant-network" },
        { "symbol": "TRUMP", "coingeckoId": "official-trump" },
        { "symbol": "USDD", "coingeckoId": "usdd" },
        { "symbol": "BONK", "coingeckoId": "bonk" },
        { "symbol": "RENDER", "coingeckoId": "render-token" },
        { "symbol": "USDAI", "coingeckoId": "usdai" },
        { "symbol": "SYRUPUSDT", "coingeckoId": "syrupusdt" },
        { "symbol": "MORPHO", "coingeckoId": "morpho" },
        { "symbol": "CAKE", "coingeckoId": "pancakeswap-token" },
        { "symbol": "JUP", "coingeckoId": "jupiter-exchange-solana" },
        { "symbol": "PENGU", "coingeckoId": "pudgy-penguins" },
        { "symbol": "CRV", "coingeckoId": "curve-dao-token" },
        { "symbol": "USD0", "coingeckoId": "usual-usd" },
        { "symbol": "OP", "coingeckoId": "optimism" },
        { "symbol": "FDUSD", "coingeckoId": "first-digital-usd" },
        { "symbol": "LDO", "coingeckoId": "lido-dao" },
        { "symbol": "GHO", "coingeckoId": "gho" },
        { "symbol": "TUSD", "coingeckoId": "true-usd" },
        { "symbol": "INJ", "coingeckoId": "injective-protocol" },
        { "symbol": "ETHFI", "coingeckoId": "ether-fi" },
        { "symbol": "SPX", "coingeckoId": "spx6900" },
        { "symbol": "VIRTUAL", "coingeckoId": "virtual-protocol" },
        { "symbol": "AERO", "coingeckoId": "aerodrome-finance" },
        { "symbol": "STRK", "coingeckoId": "starknet" },
        { "symbol": "2Z", "coingeckoId": "doublezero" },
        { "symbol": "TEL", "coingeckoId": "telcoin" },
        { "symbol": "BTT", "coingeckoId": "bittorrent" },
        { "symbol": "FLOKI", "coingeckoId": "floki" },
        { "symbol": "GRT", "coingeckoId": "the-graph" },
        { "symbol": "SYRUP", "coingeckoId": "syrup" },
        { "symbol": "TWT", "coingeckoId": "trust-wallet-token" },
        { "symbol": "EURC", "coingeckoId": "euro-coin" },
        { "symbol": "OHM", "coingeckoId": "olympus" },
        { "symbol": "USR", "coingeckoId": "resolv-usr" },
        { "symbol": "MERL", "coingeckoId": "merlin-chain" },
        { "symbol": "PYTH", "coingeckoId": "pyth-network" },
        { "symbol": "GNO", "coingeckoId": "gnosis" },
        { "symbol": "BAT", "coingeckoId": "basic-attention-token" },
        { "symbol": "H", "coingeckoId": "humanity" },
        { "symbol": "PENDLE", "coingeckoId": "pendle" },
        { "symbol": "SAND", "coingeckoId": "the-sandbox" },
        { "symbol": "HNT", "coingeckoId": "helium" },
        { "symbol": "WIF", "coingeckoId": "dogwifcoin" },
        { "symbol": "FARTCOIN", "coingeckoId": "fartcoin" },
        { "symbol": "GALA", "coingeckoId": "gala" },
        { "symbol": "ZK", "coingeckoId": "zksync" },
        { "symbol": "ZRO", "coingeckoId": "layerzero" },
        { "symbol": "COMP", "coingeckoId": "compound-governance-token" },
        { "symbol": "RAY", "coingeckoId": "raydium" },
        { "symbol": "MANA", "coingeckoId": "decentraland" },
        { "symbol": "REAL", "coingeckoId": "reallink" },
        { "symbol": "USDA", "coingeckoId": "usda-2" },
        { "symbol": "AUSD", "coingeckoId": "agora-dollar" },
        { "symbol": "0G", "coingeckoId": "zero-gravity" },
        { "symbol": "GLM", "coingeckoId": "golem" },
        { "symbol": "FF", "coingeckoId": "falcon-finance-ff" },
        { "symbol": "EIGEN", "coingeckoId": "eigenlayer" },
        { "symbol": "1INCH", "coingeckoId": "1inch" },
        { "symbol": "KMNO", "coingeckoId": "kamino" },
        { "symbol": "FLUID", "coingeckoId": "instadapp" },
        { "symbol": "IMX", "coingeckoId": "immutable-x" },
        { "symbol": "BARD", "coingeckoId": "lombard-protocol" },
        { "symbol": "W", "coingeckoId": "wormhole" },
        { "symbol": "TRAC", "coingeckoId": "origintrail" },
        { "symbol": "ZORA", "coingeckoId": "zora" },
        { "symbol": "USDF", "coingeckoId": "astherus-usdf" },
        { "symbol": "JTO", "coingeckoId": "jito-governance-token" },
        { "symbol": "KOGE", "coingeckoId": "bnb48-club-token" },
        { "symbol": "ZEN", "coingeckoId": "zencash" },
        { "symbol": "SFP", "coingeckoId": "safepal" },
        { "symbol": "ORDER", "coingeckoId": "orderly-network" },
        { "symbol": "OCEAN", "coingeckoId": "ocean-protocol" },
        { "symbol": "AVICI", "coingeckoId": "avici" },
        { "symbol": "DEP", "coingeckoId": "deapcoin" }
    ];

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
            const ids = this.tokens.map(t => t.coingeckoId).filter(id => id).join(',');
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

            this.tokens.forEach(t => {
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