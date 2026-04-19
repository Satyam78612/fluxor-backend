import { Router, Request, Response } from 'express';
import { processSolverIntent } from '../solver/solverService';
import { RedisClientType } from 'redis';
import fs from 'fs';
import path from 'path';

export function createSolverRouter(redisClient: RedisClientType): Router {
    const router = Router();

    // Load tokens JSON at closure level to ensure it's available
    let contractTokens: any[] = [];
    try {
        const tokensPath = path.join(process.cwd(), 'tokens.json');
        contractTokens = JSON.parse(fs.readFileSync(tokensPath, 'utf8'));
    } catch (e) {
        console.error('[Solver Routes] Failed to load tokens.json for routing', e);
    }

    router.post('/quote', async (req: Request, res: Response) => {
        try {
            const intent = req.body;
            if (!intent || !intent.intentType || !intent.userAddress) {
                return res.status(400).json({ error: "Invalid intent format" });
            }

            const solverResult = await processSolverIntent(intent, redisClient, contractTokens);
            return res.json(solverResult);

        } catch (error: any) {
            console.error('[Solver Quote] Error:', error.message);
            return res.status(400).json({ error: error.message });
        }
    });

    router.post('/test-aggregators', async (req: Request, res: Response) => {
        try {
            const { getBestQuote } = require('../solver/aggregatorService');
            const quote = await getBestQuote({
                fromChainId: 56, // Solana
                toChainId: 56,   // Solana
                fromTokenAddress: '0x55d398326f99059fF775485246999027B3197955',
                toTokenAddress: '0x924fa68a0FC644485b8df8AbfA0A41C2e7744444',
                fromAmount: '100000000000000000000', // 20 USDC (6 decimals)
                userAddress: '0x59714dE56e030071Bf96c7f7Ce500c05476f2C88', // Your Solana Address!
                slippage: 2.0
            }, 18);
            return res.json({ success: true, quote: quote || 'No quote found. Check API keys.' });
        } catch (e: any) {
            return res.status(500).json({ error: e.message });
        }
    });

    return router;
}
