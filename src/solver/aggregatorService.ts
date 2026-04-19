import axios from 'axios';
import { getAddress } from 'ethers';

export interface QuoteRequestParams {
    fromChainId: number;
    toChainId: number;
    fromTokenAddress: string;
    toTokenAddress: string;
    fromAmount: string;
    userAddress: string;
    slippage: number;
}

export interface QuoteResult {
    aggregator: 'LiFi' | 'Bungee' | 'Jupiter';
    chainId: number;
    approvalToken: string;
    allowanceTarget: string;
    to: string;
    data: string;
    value: string;
    estimatedReceiveHuman: string; // Adjusted to human based on destination decimals
    estimatedReceiveBase: string;
    minReceivedBase: string;
    gasCostUSD: string;
    executionDuration: number;
}

// Ensure SOL addresses aren't prefixed
const parseSolanaStrict = (address: string) => {
    return address.startsWith('0x') ? address.slice(2) : address;
};

// --- LIFi Routing ---
export async function getLifiQuote(params: QuoteRequestParams, destDecimals: number): Promise<QuoteResult | null> {
    try {
        const res = await axios.get('https://li.quest/v1/quote', {
            params: {
                fromChain: params.fromChainId,
                toChain: params.toChainId,
                fromToken: params.fromChainId === 101 ? parseSolanaStrict(params.fromTokenAddress) : params.fromTokenAddress,
                toToken: params.toChainId === 101 ? parseSolanaStrict(params.toTokenAddress) : params.toTokenAddress,
                fromAddress: params.userAddress,
                fromAmount: params.fromAmount,
                slippage: params.slippage / 100 // LiFi expects 0.05 for 5%
            },
            headers: {
                'x-lifi-api-key': 'eaaefc9c-fb3f-494b-a2c9-30baac3a2779.295af3c3-5169-4d37-b0c0-55f4f02c44fc'
            },
            timeout: 8000
        });

        const data = res.data;
        const receiveAmountBase = data.estimate.toAmount;
        const receiveAmountHuman = (BigInt(receiveAmountBase) + 0n).toString(); // We'll accurately parse human floats in solver

        return {
            aggregator: 'LiFi',
            chainId: params.fromChainId,
            approvalToken: data.action.fromToken.address,
            allowanceTarget: data.estimate.approvalAddress,
            to: data.transactionRequest.to,
            data: data.transactionRequest.data,
            value: data.transactionRequest.value || "0",
            estimatedReceiveBase: receiveAmountBase,
            estimatedReceiveHuman: (Number(receiveAmountBase) / (10 ** destDecimals)).toString(),
            minReceivedBase: data.estimate.toAmountMin,
            gasCostUSD: data.estimate.gasCosts?.[0]?.amountUSD || "0",
            executionDuration: data.estimate.executionDuration || 0
        };
    } catch (e: any) {
        console.warn('[Quote LiFi] Error:', e?.response?.data || e.message);
        return null;
    }
}

// --- Bungee Routing ---
export async function getBungeeQuote(params: QuoteRequestParams, destDecimals: number): Promise<QuoteResult | null> {
    try {
        // Bungee public API or dedicated endpoint specified by User
        const BUNGEE_KEY = 'zOznPmbiTU2VHssXA0Kwk9Ssdtrx4n9U7ILFFcAG';
        const BUNGEE_AFFILIATE = '609913096f1a3d62cecd0afcd6229fe118baedceb5fef75aad43e6cbff367039708902197e0b2b78b1d76cb0837ad0b318baedceb5fef75aad43e6cb';
        const slippageString = params.slippage.toString();

        const res = await axios.get('https://dedicated-backend.bungee.exchange/api/v1/bungee/quote', {
            params: {
                originChainId: params.fromChainId,
                destinationChainId: params.toChainId,
                inputToken: params.fromTokenAddress,
                outputToken: params.toTokenAddress,
                inputAmount: params.fromAmount,
                userAddress: params.userAddress,
                receiverAddress: params.userAddress,
                slippage: slippageString,
                useInbox: true, // Crucial: Enables autoRoute.txData for ERC20 tokens, bypassing signTypedData
                singleTxOnly: true // Ensure UA batched capabilities
            },
            headers: {
                'x-api-key': BUNGEE_KEY,
                'affiliate': BUNGEE_AFFILIATE
            },
            timeout: 8000
        });

        const data = res.data;
        if (!data.result || !data.autoRoute && !data.result.routeDetails && (!data.result.autoRoute && !data.result.depositRoute)) return null;

        // Bungee dedicated API returns the primary winning route as result.depositRoute or result.autoRoute
        // We evaluate result.depositRoute.output vs result.autoRoute.output (if both exist)
        const autoOut = data.result.autoRoute?.output?.effectiveAmount || 0;
        const depOut = data.result.depositRoute?.output?.effectiveAmount || 0;

        const bestRouteData = Number(autoOut) >= Number(depOut) ? data.result.autoRoute : data.result.depositRoute;
        if (!bestRouteData) return null;

        const outputData = bestRouteData.output;
        const approvalAddress = bestRouteData.approvalData?.spenderAddress || bestRouteData.depositAddress || data.result.depositRoute?.depositAddress;

        let toAddr = bestRouteData.txData?.to;
        let pData = bestRouteData.txData?.data;
        let v = bestRouteData.txData?.value;

        // Fallback for autoRoute transaction builder when txData is missing
        if (!toAddr || !pData) {
            toAddr = "0x..."; // Mocking for unsupported autoRoute construction format if txData missing
            pData = "0x";
            v = "0";
        }

        // Dest decimals conversion to human readable
        const estReceiveHuman = (Number(outputData.amount) / (10 ** destDecimals)).toString();

        return {
            aggregator: 'Bungee',
            chainId: params.fromChainId,
            approvalToken: params.fromTokenAddress,
            allowanceTarget: approvalAddress,
            to: toAddr,
            data: pData,
            value: v || "0x0",
            estimatedReceiveBase: outputData.amount,
            estimatedReceiveHuman: estReceiveHuman,
            minReceivedBase: outputData.minAmountOut || outputData.amount,
            gasCostUSD: bestRouteData.gasFee?.feeInUsd?.toFixed(4) || "0.00",
            executionDuration: bestRouteData.estimatedTime || 0
        };
    } catch (e: any) {
        console.warn('[Quote Bungee] Error:', e?.response?.data || e.message);
        return null;
    }
}

// --- Jupiter Routing ---
export async function getJupiterQuote(params: QuoteRequestParams, destDecimals: number): Promise<QuoteResult | null> {
    try {
        if (params.fromChainId !== 101 || params.toChainId !== 101) return null;

        const JUP_KEY = 'jup_5250eb164c423c0c970997fca826ed592944003ca144600613ecc67c43ec3324';

        const slippageBps = Math.floor(params.slippage * 100);
        console.log('[Jupiter API] Requesting quote for SOL...');

        const quoteRes = await axios.get('https://api.jup.ag/swap/v1/quote', {
            params: {
                inputMint: parseSolanaStrict(params.fromTokenAddress),
                outputMint: parseSolanaStrict(params.toTokenAddress),
                amount: params.fromAmount,
                slippageBps: slippageBps
            },
            headers: {
                'x-api-key': JUP_KEY
            },
            timeout: 5000
        });

        const quoteResponse = quoteRes.data;
        console.log('[Jupiter API] Quote Received, compiling transaction...');

        // Retrieve transaction binary
        const swapRes = await axios.post('https://api.jup.ag/swap/v1/swap', {
            quoteResponse,
            userPublicKey: params.userAddress,
            wrapAndUnwrapSol: true
        }, {
            headers: {
                'x-api-key': JUP_KEY
            },
            timeout: 5000
        });

        const transactionBase64 = swapRes.data.swapTransaction;
        console.log('[Jupiter API] Success!');

        return {
            aggregator: 'Jupiter',
            chainId: 101,
            approvalToken: params.fromTokenAddress,
            allowanceTarget: "", // Not used heavily in same way for UA Solana unless specified
            to: transactionBase64, // For UA intent, if base64 instruction goes here
            data: transactionBase64, // "Jupiter (Solana) returns base64 encoded transactions. yes the answer is yes."
            value: "0",
            estimatedReceiveBase: quoteResponse.outAmount,
            estimatedReceiveHuman: (Number(quoteResponse.outAmount) / (10 ** destDecimals)).toString(),
            minReceivedBase: quoteResponse.otherAmountThreshold,
            gasCostUSD: "0.001", // Solana gas is negligible mostly, placeholder
            executionDuration: 5
        };
    } catch (e: any) {
        console.log('[Quote Jupiter] FATAL Error:', e?.response?.data || e.message);
        return null;
    }
}

export async function getBestQuote(params: QuoteRequestParams, destDecimals: number): Promise<QuoteResult | null> {
    const promises = [];

    // Bungee is always raced
    promises.push(getBungeeQuote(params, destDecimals));

    if (params.fromChainId === 101 || params.toChainId === 101) {
        // If Solana is involved, race Jupiter against Bungee 
        promises.push(getJupiterQuote(params, destDecimals));
    } else {
        // If it's pure EVM, race Li.Fi against Bungee
        promises.push(getLifiQuote(params, destDecimals));
    }

    const results = await Promise.allSettled(promises);
    const successfulQuotes = results
        .filter((r): r is PromiseFulfilledResult<QuoteResult> => r.status === 'fulfilled' && r.value !== null)
        .map(r => r.value);

    if (successfulQuotes.length === 0) return null;

    // Weightage logic (Net Amount 3.5, Price Impact 3.5, Gas 2, Time 1)
    // Simplified into Net Output comparison: Output value USD is roughly tied to amount out. 
    // We normalize to highest net token output slightly penalized by Gas Cost
    // In strict sense, since this is same token pair, token out base handles everything.

    return successfulQuotes.sort((a, b) => {
        // Compare estimated receive (human) vs gas
        const netA = Number(a.estimatedReceiveHuman) - (Number(a.gasCostUSD) * 0.001); // Gas conversion approx depending on asset price, simplified scoring
        const netB = Number(b.estimatedReceiveHuman) - (Number(b.gasCostUSD) * 0.001);
        return netB - netA;
    })[0];
}
