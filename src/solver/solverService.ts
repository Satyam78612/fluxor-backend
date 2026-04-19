import { RedisClientType } from 'redis';
import { verifyBalance } from './balanceService';
import { getBestQuote, QuoteResult } from './aggregatorService';
import axios from 'axios';

const ALCHEMY_KEY = "fBdrczCsu-Z1-MTC8Obj2";

async function fetchFallbackDecimals(chainId: number, contractAddress: string): Promise<number> {
    try {
        if (chainId === 101) {
            // Solana uses getTokenSupply RPC method
            const res = await axios.post(`https://solana-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`, {
                jsonrpc: "2.0",
                id: 1,
                method: "getTokenSupply",
                params: [contractAddress]
            });
            return res.data?.result?.value?.decimals || 9; // Fallback to 9 for SOL
        } else {
            // EVM Networks mapping for Alchemy
            const networkMap: Record<number, string> = {
                1: 'eth-mainnet',
                137: 'polygon-mainnet',
                42161: 'arb-mainnet',
                10: 'opt-mainnet',
                8453: 'base-mainnet',
                56: 'bnb-mainnet',
                43114: 'avax-mainnet'
            };
            const network = networkMap[chainId] || 'eth-mainnet';
            const res = await axios.post(`https://${network}.g.alchemy.com/v2/${ALCHEMY_KEY}`, {
                id: 1,
                jsonrpc: "2.0",
                method: "alchemy_getTokenMetadata",
                params: [contractAddress]
            });
            return res.data?.result?.decimals || 18; // Fallback to 18 for EVM
        }
    } catch (e) {
        console.error('[Alchemy Fallback] Failed to fetch decimals for', contractAddress);
        return chainId === 101 ? 9 : 18;
    }
}

export interface SolverIntent {
    userAddress: string;
    intentType: 'BUY' | 'SELL';
    amountInStablecoin?: number;      // BUY
    targetTokenId?: string;           // BUY (If in tokens.json)
    targetChainId?: number;           // BUY (If fetching from DexScreener custom fallback)
    targetContractAddress?: string;   // BUY (If fetching from DexScreener custom fallback)
    targetDecimals?: number;          // BUY (Fallback if custom)

    targetStablecoin?: string;        // SELL
    totalAmountToSell?: number;       // SELL
    sourceAssets?: Array<{ chainId: number; tokenSymbol: string; contractAddress: string; decimals: number; amount: number }>; // SELL

    slippagePercentage: number;
    fundingSources?: Array<{ chainId: number; tokenSymbol: string; contractAddress: string; decimals: number }>; // BUY
}

// Dynamically fetch stablecoin deployment from JSON
function getStablecoinAddress(chainId: number, isUSDT: boolean, contractTokens: any[]): { address: string, decimals: number } | null {
    const tokenId = isUSDT ? "tether" : "usd-coin";
    const token = contractTokens.find(t => t.id === tokenId);
    if (!token || !token.deployments) return null;

    const deployment = token.deployments.find((d: any) => d.chainId === chainId);
    if (!deployment) return null;

    return { address: deployment.address, decimals: deployment.decimals || token.decimals || (isUSDT ? 6 : 6) };
}

export async function processSolverIntent(
    intent: SolverIntent,
    redisClient: RedisClientType,
    contractTokens: any[] // From tokens.json
) {
    if (intent.intentType === 'BUY') {
        return processBuyIntent(intent, redisClient, contractTokens);
    } else if (intent.intentType === 'SELL') {
        return processSellIntent(intent, redisClient, contractTokens);
    }
    throw new Error('Unsupported intentType');
}

async function processBuyIntent(intent: SolverIntent, redisClient: RedisClientType, contractTokens: any[]) {
    const { userAddress, amountInStablecoin, targetTokenId, fundingSources, slippagePercentage } = intent;
    if (!amountInStablecoin || !targetTokenId || !fundingSources) throw new Error('Missing BUY parameters');

    // 1. Combine Balances from Redis
    let totalStableBalance = 0;
    for (const source of fundingSources) {
        const balance = await verifyBalance(redisClient, userAddress, source.chainId, source.contractAddress);
        if (balance) totalStableBalance += balance;
    }

    if (totalStableBalance < amountInStablecoin) {
        throw new Error('Insufficient Funds');
    }

    let deployments: any[] = [];
    let fallbackDecimals = 18;

    // A. Check if the frontend provided a strict DexScreener custom target
    if (intent.targetChainId && intent.targetContractAddress) {
        deployments = [{
            chainId: intent.targetChainId,
            address: intent.targetContractAddress
        }];
        fallbackDecimals = intent.targetDecimals || await fetchFallbackDecimals(intent.targetChainId, intent.targetContractAddress);
    }
    // B. Check local JSON registry
    else if (targetTokenId) {
        const targetToken = contractTokens.find(t => t.id === targetTokenId);
        if (!targetToken) throw new Error('Target token not found in registry');

        deployments = targetToken.deployments || [];
        if (deployments.length === 0) throw new Error('Target token has no deployments');

        const ethDeployment = deployments.find((d: any) => d.chainId === 1);

        if (deployments.length === 1 && ethDeployment) {
            deployments = [ethDeployment];
        } else {
            const altDeployments = deployments.filter((d: any) => d.chainId !== 1).slice(0, ethDeployment ? 2 : 3);
            deployments = ethDeployment ? [ethDeployment, ...altDeployments] : altDeployments;
        }
        fallbackDecimals = targetToken.decimals || 18;
    } else {
        throw new Error('Must provide either targetTokenId or both targetChainId and targetContractAddress');
    }

    const quotes: QuoteResult[] = [];

    // 3. Parallel Query Aggregators for each deployment
    await Promise.all(deployments.map(async (deployment: any) => {
        const chainId = deployment.chainId;
        const stable = getStablecoinAddress(chainId, false, contractTokens) || getStablecoinAddress(chainId, true, contractTokens);
        if (!stable) return; // Skip if no stablecoin on this chain

        const fromAmountBase = BigInt(amountInStablecoin * (10 ** stable.decimals)).toString();

        const quote = await getBestQuote({
            fromChainId: chainId,
            toChainId: chainId,
            fromTokenAddress: stable.address,
            toTokenAddress: deployment.address,
            fromAmount: fromAmountBase,
            userAddress: userAddress,
            slippage: slippagePercentage
        }, fallbackDecimals);

        if (quote) quotes.push(quote);
    }));

    if (quotes.length === 0) {
        throw new Error('No routes found across selected chains');
    }

    // Determine same-chain vs cross-chain
    // Same-chain means the target deployment chain matches ONE of the funding source chains
    const sameChainQuotes = quotes.filter(q => fundingSources.some(fs => fs.chainId === q.chainId));
    const crossChainQuotes = quotes.filter(q => !fundingSources.some(fs => fs.chainId === q.chainId));

    const bestSameChain = sameChainQuotes.sort((a, b) => Number(b.estimatedReceiveHuman) - Number(a.estimatedReceiveHuman))[0];
    const bestCrossChain = crossChainQuotes.sort((a, b) => Number(b.estimatedReceiveHuman) - Number(a.estimatedReceiveHuman))[0];

    let preEthSelectedQuote = bestSameChain; // Default baseline

    if (bestCrossChain && bestSameChain) {
        // Apply 0.1% Cross-chain vs Same-chain logic
        const crossNet = Number(bestCrossChain.estimatedReceiveHuman);
        const sameNet = Number(bestSameChain.estimatedReceiveHuman);
        if (crossNet >= sameNet * 1.001) {
            preEthSelectedQuote = bestCrossChain;
        } else {
            preEthSelectedQuote = bestSameChain;
        }
    } else if (bestCrossChain) {
        preEthSelectedQuote = bestCrossChain;
    } else if (bestSameChain) {
        preEthSelectedQuote = bestSameChain;
    }

    // Lastly, the 1% Ethereum Logic Rule
    // If Ethereum was an option and provides at least 1% more net value than the best alternative
    let selectedQuote = preEthSelectedQuote;
    const ethQuote = quotes.find(q => q.chainId === 1);

    if (ethQuote && preEthSelectedQuote.chainId !== 1) {
        const ethNet = Number(ethQuote.estimatedReceiveHuman) - (Number(ethQuote.gasCostUSD) * 0.001);
        const altNet = Number(preEthSelectedQuote.estimatedReceiveHuman) - (Number(preEthSelectedQuote.gasCostUSD) * 0.001);

        if (ethNet >= altNet * 1.01) {
            selectedQuote = ethQuote;
        }
    } else if (ethQuote && preEthSelectedQuote.chainId === 1 && quotes.length > 1) {
        // If pre-selected was Ethereum, verify it actually beats alternative by 1%
        const bestAltQuote = quotes.filter(q => q.chainId !== 1).sort((a, b) => Number(b.estimatedReceiveHuman) - Number(a.estimatedReceiveHuman))[0];
        if (bestAltQuote) {
            const ethNet = Number(ethQuote.estimatedReceiveHuman) - (Number(ethQuote.gasCostUSD) * 0.001);
            const altNet = Number(bestAltQuote.estimatedReceiveHuman) - (Number(bestAltQuote.gasCostUSD) * 0.001);

            if (ethNet < altNet * 1.01) {
                selectedQuote = bestAltQuote; // Fall back to alt if 1% threshold is missed
            }
        }
    }

    // 5. Construct matching Frontend UI Return
    return {
        chainId: selectedQuote.chainId,
        approvalToken: selectedQuote.approvalToken,
        allowanceTarget: selectedQuote.allowanceTarget,
        amountInHuman: amountInStablecoin.toString(),
        to: selectedQuote.to,
        data: selectedQuote.data,
        value: selectedQuote.value,
        uiData: {
            estimatedReceive: Number(selectedQuote.estimatedReceiveHuman).toFixed(5),
            estimatedReceiveUSD: "...", // Add if price tracking exists
            minReceived: Number(selectedQuote.minReceivedBase).toString() // Not formatted exactly
        }
    };
}

async function processSellIntent(intent: SolverIntent, redisClient: RedisClientType, contractTokens: any[]) {
    const { userAddress, targetStablecoin, totalAmountToSell, sourceAssets, slippagePercentage } = intent;
    if (!targetStablecoin || !sourceAssets) throw new Error('Missing SELL parameters');

    const swaps: any[] = [];
    let totalEstimatedReceiveBase = 0;

    // Iterate over exactly where user's token lives!
    // "Our solver will pick the best quote based on the weightage system...
    // from Arbitrum Aave to Arbitrum USDC"
    await Promise.all(sourceAssets.map(async (asset) => {
        // 1. Real-time balance check bypassing Alchemy
        const verifiedBalance = await verifyBalance(redisClient, userAddress, asset.chainId, asset.contractAddress);
        if (verifiedBalance === null || verifiedBalance < asset.amount) {
            throw new Error(`Insufficient funds for ${asset.tokenSymbol} on chain ${asset.chainId}`);
        }

        const stable = getStablecoinAddress(asset.chainId, targetStablecoin === 'USDT', contractTokens);
        if (!stable) return;

        const fromAmountBase = BigInt(asset.amount * (10 ** asset.decimals)).toString();

        const quote = await getBestQuote({
            fromChainId: asset.chainId,
            toChainId: asset.chainId,
            fromTokenAddress: asset.contractAddress,
            toTokenAddress: stable.address,
            fromAmount: fromAmountBase,
            userAddress: userAddress,
            slippage: slippagePercentage
        }, stable.decimals); // We want stable decimals for output formatting

        if (quote) {
            swaps.push({
                chainId: quote.chainId,
                approvalToken: quote.approvalToken,
                allowanceTarget: quote.allowanceTarget,
                amountInHuman: asset.amount.toString(),
                tokenDecimals: asset.decimals,
                to: quote.to,
                data: quote.data,
                value: quote.value
            });
            totalEstimatedReceiveBase += Number(quote.estimatedReceiveHuman);
        }
    }));

    if (swaps.length === 0) throw new Error("Could not construct sell paths");

    return {
        uiData: {
            totalEstimatedReceive: totalEstimatedReceiveBase.toFixed(2),
            totalMinReceived: (totalEstimatedReceiveBase * (1 - (slippagePercentage / 100))).toFixed(2),
            tokensBeingSold: `${totalAmountToSell} items`
        },
        swaps
    };
}
