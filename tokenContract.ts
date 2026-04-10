import { Router, Request, Response } from 'express';
import axios from 'axios';
import { getAddress } from 'ethers';
import { RedisClientType } from 'redis';

export interface TokenDeployment {
    address: string;
    chainId?: number;
}

export interface ContractToken {
    id: string;
    symbol: string;
    name: string;
    decimals?: number;
    logo?: string;
    deployments?: TokenDeployment[];
}

export interface TokenMetadata {
    chainId: number | null;
    contractAddress: string;
    name: string;
    symbol: string;
    decimals: number | null;
    price: number | null;
    changePercent: number | null;
    imageUrl: string | null;
    source: string;
}

const CHAIN_ID_TO_TRUSTWALLET: Record<number, string> = {
    1: 'ethereum',
    56: 'smartchain',
    137: 'polygon',
    10: 'optimism',
    42161: 'arbitrum',
    8453: 'base',
    43114: 'avalanchec',
    59144: 'linea',
    5000: 'mantle',
    101: 'solana',
};

const DEX_CHAIN_STRING_TO_ID: Record<string, number> = {
    ethereum: 1,
    bsc: 56,
    polygon: 137,
    optimism: 10,
    arbitrum: 42161,
    base: 8453,
    avalanche: 43114,
    solana: 101,
    mantle: 5000,
    monad: 143,
    hyperliquid: 999,
    plasma: 9745,
    sonic: 146,
    berachain: 80094,
};

function toChecksumAddress(address: string): string {
    if (!address || !address.startsWith('0x')) return address;
    try { return getAddress(address); } catch { return address; }
}

function getTrustWalletLogo(chainId: number | null, address: string): string | null {
    if (!chainId) return null;
    const chain = CHAIN_ID_TO_TRUSTWALLET[chainId];
    if (!chain) return null;
    return `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/${chain}/assets/${toChecksumAddress(address)}/logo.png`;
}

function extractFromPair(pair: any, inputAddress?: string): TokenMetadata {
    const isBase = inputAddress
        ? pair.baseToken.address.toLowerCase() === inputAddress.toLowerCase()
        : true;

    const token = isBase ? pair.baseToken : pair.quoteToken;
    const resolvedId = DEX_CHAIN_STRING_TO_ID[pair.chainId] ?? null;

    return {
        chainId: resolvedId,
        contractAddress: token.address,
        name: token.name,
        symbol: token.symbol,
        decimals: token.decimals ? parseInt(token.decimals) : null,
        price: pair.priceUsd ? parseFloat(pair.priceUsd) : null,
        changePercent: pair.priceChange?.h24 ? parseFloat(pair.priceChange.h24) : null,
        imageUrl: pair?.info?.imageUrl || getTrustWalletLogo(resolvedId, token.address),
        source: 'DexScreener',
    };
}

function pickBestPair(pairs: any[]): any {
    return pairs.sort(
        (a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)
    )[0];
}

function findInJsonByAddress(
    contractTokens: ContractToken[],
    address: string,
    allPrices: Record<string, any>
): TokenMetadata | null {
    const lower = address.toLowerCase();

    const match = contractTokens.find(t =>
        t.deployments?.some(d => d.address.toLowerCase() === lower)
    );

    if (!match) return null;

    const deployment = match.deployments?.find(d => d.address.toLowerCase() === lower);
    const resolvedChainId = deployment?.chainId ?? null;
    const priceInfo = allPrices[match.id] ?? {};

    return {
        chainId: resolvedChainId,
        contractAddress: address,
        name: match.name,
        symbol: match.symbol,
        decimals: match.decimals ?? null,
        price: priceInfo.usd ? parseFloat(priceInfo.usd) : null,
        changePercent: priceInfo.usd_24h_change ? parseFloat(priceInfo.usd_24h_change) : null,
        imageUrl: match.logo || (resolvedChainId ? getTrustWalletLogo(resolvedChainId, address) : null),
        source: 'LocalJSON',
    };
}

function findInJsonByName(
    contractTokens: ContractToken[],
    query: string,
    allPrices: Record<string, any>
): TokenMetadata[] {
    const lower = query.toLowerCase();

    const matches = contractTokens.filter(t =>
        t.id.toLowerCase() === lower ||
        t.symbol.toLowerCase() === lower ||
        t.name.toLowerCase().includes(lower)
    );

    matches.sort((a, b) => {
        const aExact = a.symbol.toLowerCase() === lower || a.id.toLowerCase() === lower;
        const bExact = b.symbol.toLowerCase() === lower || b.id.toLowerCase() === lower;
        if (aExact !== bExact) return aExact ? -1 : 1;
        return 0;
    });

    return matches.slice(0, 10).map(match => {
        const deployment = match.deployments?.[0];
        const resolvedChainId = deployment?.chainId ?? null;
        const priceInfo = allPrices[match.id] ?? {};

        return {
            chainId: resolvedChainId,
            contractAddress: deployment?.address ?? '',
            name: match.name,
            symbol: match.symbol,
            decimals: match.decimals ?? null,
            price: priceInfo.usd ? parseFloat(priceInfo.usd) : null,
            changePercent: priceInfo.usd_24h_change ? parseFloat(priceInfo.usd_24h_change) : null,
            imageUrl: match.logo || (resolvedChainId ? getTrustWalletLogo(resolvedChainId, deployment?.address ?? '') : null),
            source: 'LocalJSON',
        };
    });
}

async function fetchByContractAddress(address: string): Promise<TokenMetadata | null> {
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            const res = await axios.get(
                `https://api.dexscreener.com/latest/dex/tokens/${address}`,
                { timeout: 6000 }
            );

            if (res.status === 429 || res.headers['content-type']?.includes('text/html')) {
                console.warn('[tokenContract] ⚠️ DexScreener rate limited');
                return null;
            }

            let pairs: any[] = res.data?.pairs;

            if (!pairs?.length) {
                const res2 = await axios.get(
                    `https://api.dexscreener.com/latest/dex/search`,
                    { params: { q: address }, timeout: 6000 }
                );

                if (res2.status === 429 || res2.headers['content-type']?.includes('text/html')) {
                    console.warn('[tokenContract] ⚠️ DexScreener rate limited');
                    return null;
                }

                pairs = res2.data?.pairs;
            }

            if (!pairs?.length) {
                if (attempt < 2) continue;
                return null;
            }

            const matchingPairs = pairs.filter(p =>
                p.baseToken?.address?.toLowerCase() === address.toLowerCase()
            );

            const supportedPairs = (matchingPairs.length > 0 ? matchingPairs : pairs).filter(p =>
                DEX_CHAIN_STRING_TO_ID[p.chainId] !== undefined
            );

            if (!supportedPairs.length) {
                if (attempt < 2) continue;
                return null;
            }

            const best = pickBestPair(supportedPairs);
            return extractFromPair(best, address);

        } catch (err) {
            if (attempt < 2) continue;
            console.error('[tokenContract] DexScreener contract search error:', err);
            return null;
        }
    }
    return null;
}

const MIN_VOLUME_USD = 100_000;

async function fetchByName(query: string): Promise<TokenMetadata[]> {
    try {
        const res = await axios.get(
            `https://api.dexscreener.com/latest/dex/search`,
            { params: { q: query }, timeout: 6000 }
        );

        if (res.status === 429 || res.headers['content-type']?.includes('text/html')) {
            console.warn('[tokenContract] ⚠️ DexScreener rate limited');
            return [];
        }

        const pairs: any[] = res.data?.pairs;
        if (!pairs?.length) return [];


        const qualifiedPairs = pairs.filter(p => (p.volume?.h24 ?? 0) >= MIN_VOLUME_USD);
        if (!qualifiedPairs.length) return [];


        const seen = new Set<string>();
        const deduped: any[] = [];
        for (const pair of qualifiedPairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))) {
            const key = pair.baseToken.address.toLowerCase();
            if (!seen.has(key)) {
                seen.add(key);
                deduped.push(pair);
            }
        }

        return deduped.slice(0, 10).map(pair => extractFromPair(pair));

    } catch (err) {
        console.error('[tokenContract] DexScreener name search error:', err);
        return [];
    }
}

export async function resolveTokenByContract(
    address: string,
    contractTokens: ContractToken[],
    redisClient: RedisClientType,
): Promise<TokenMetadata | null> {

    const cacheKey = `token_meta:address:${address.toLowerCase()}`;

    let allPrices: Record<string, any> = {};
    try {
        const pricesRaw = await redisClient.get('ALL_PRICES');
        if (pricesRaw) allPrices = JSON.parse(pricesRaw);
    } catch { /* non-fatal */ }

    const jsonResult = findInJsonByAddress(contractTokens, address, allPrices);
    if (jsonResult) {
        console.log(`[tokenContract] ✅ [1/3] LocalJSON hit → ${address}`);
        return jsonResult;
    }

    try {
        const cached = await redisClient.get(cacheKey);
        if (cached) {
            console.log(`[tokenContract] ✅ [2/3] Redis cache hit → ${address}`);
            return JSON.parse(cached);
        }
    } catch { /* non-fatal */ }

    console.log(`[tokenContract] 🔍 [3/3] DexScreener contract search → ${address}`);
    const result = await fetchByContractAddress(address);

    if (result && !result.imageUrl) {
        result.imageUrl = getTrustWalletLogo(result.chainId, address);
    }

    if (result) {
        try {
            await redisClient.set(cacheKey, JSON.stringify(result), { EX: 600 });
        } catch { /* non-fatal */ }
    }

    return result;
}

export async function resolveTokenByName(
    query: string,
    contractTokens: ContractToken[],
    redisClient: RedisClientType,
): Promise<TokenMetadata[]> {

    const cacheKey = `token_meta:name:${query.toLowerCase()}`;

    let allPrices: Record<string, any> = {};
    try {
        const pricesRaw = await redisClient.get('ALL_PRICES');
        if (pricesRaw) allPrices = JSON.parse(pricesRaw);
    } catch { /* non-fatal */ }

    const jsonResults = findInJsonByName(contractTokens, query, allPrices);
    if (jsonResults.length > 0) {
        console.log(`[tokenContract] ✅ [1/3] LocalJSON hit → "${query}" (${jsonResults.length} matches)`);
        return jsonResults;
    }

    try {
        const cached = await redisClient.get(cacheKey);
        if (cached) {
            console.log(`[tokenContract] ✅ [2/3] Redis cache hit → "${query}"`);
            return JSON.parse(cached);
        }
    } catch { /* non-fatal */ }

    console.log(`[tokenContract] 🔍 [3/3] DexScreener name search → "${query}"`);
    const results = await fetchByName(query);
    if (!results.length) return [];
    try {
        await redisClient.set(cacheKey, JSON.stringify(results), { EX: 300 });
    } catch { /* non-fatal */ }

    return results;
}

export function createTokenContractRouter(
    redisClient: RedisClientType,
    contractTokens: ContractToken[],
): Router {
    const router = Router();

    router.get('/metadata', async (req: Request, res: Response) => {
        const { address } = req.query;

        if (!address || typeof address !== 'string') {
            return res.status(400).json({ error: '`address` query param is required' });
        }

        const result = await resolveTokenByContract(
            address.trim(),
            contractTokens,
            redisClient as any,
        );

        if (!result) {
            return res.status(404).json({
                error: 'Token not found.',
            });
        }

        res.json(result);
    });

    router.get('/search', async (req: Request, res: Response) => {
        const { query } = req.query;

        if (!query || typeof query !== 'string') {
            return res.status(400).json({ error: '`query` param is required' });
        }

        const results = await resolveTokenByName(
            query.trim(),
            contractTokens,
            redisClient as any,
        );

        if (!results.length) {
            return res.status(404).json({ error: 'No tokens found.' });
        }

        res.json(results);
    });

    return router;
}