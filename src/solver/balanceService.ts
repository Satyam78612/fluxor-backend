import { RedisClientType } from 'redis';
import { query } from '../db/db';

// Unified Balance return type: Human amount read from cache or postgres
// "Since our background ingestion buffer guarantees Redis is up-to-date with exact human-readable numbers...
// the solver instantly verifies the exact sellable balance without needing any on-the-fly conversions."
export async function verifyBalance(
    redisClient: RedisClientType,
    userAddress: string,
    chainId: number,
    tokenAddress: string
): Promise<number | null> {
    const cleanAddress = userAddress.toLowerCase();
    const cleanToken = chainId === 101 ? tokenAddress : tokenAddress.toLowerCase(); // Solana isn't lowercase
    const cacheKey = `user:${cleanAddress}:balance:${cleanToken}:${chainId}`;

    try {
        const cachedStr = await redisClient.get(cacheKey);
        if (cachedStr) {
            console.log(`[Balance] ✅ Redis hit for ${cacheKey}`);
            return parseFloat(cachedStr); 
        }
    } catch (e) {
        console.warn(`[Balance] Redis fetch failed for ${cacheKey}`, e);
    }

    console.log(`[Balance] ⚠️ Redis miss for ${cacheKey}, falling back to Postgres`);
    try {
        const res = await query(
            `SELECT amount FROM user_balances WHERE wallet_address = $1 AND chain_id = $2 AND token_address = $3`,
            [cleanAddress, chainId, cleanToken]
        );

        if (res.rows && res.rows.length > 0) {
            const amount = parseFloat(res.rows[0].amount);
            try {
                // Rehydrate the cache "The Solver instantly rehydrates the Redis cache with this value for future speed"
                // The architecture specified TTL: None (or 24h), we'll do 24h
                await redisClient.set(cacheKey, amount.toString(), { EX: 86400 });
            } catch (e) { }
            return amount;
        } else {
            return 0; // The solver immediately rejects with Insufficient Funds if zero/missing
        }
    } catch (e) {
        console.error(`[Balance] PostgreSQL query failed for ${cleanAddress}`, e);
        return null;
    }
}
