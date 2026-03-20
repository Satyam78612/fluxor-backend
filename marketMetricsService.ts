import axios from 'axios';

const INTERVAL_5_MINS = 5 * 60 * 1000;

export function startMarketMetricsService(redisClient: any) {
    const fetchFearAndGreed = async () => {
        try {
            const response = await axios.get("https://api.alternative.me/fng/?limit=1", { timeout: 5000 });
            const data = response.data;

            if (data.data && data.data.length > 0) {
                const fngData = data.data[0];

                const payload = {
                    value: fngData.value,
                    value_classification: fngData.value_classification,
                    timestamp: fngData.timestamp
                };

                // Save to Redis
                await redisClient.set('FEAR_AND_GREED', JSON.stringify(payload));
                console.log(`[MarketMetrics] ✅ Fear/Greed Updated: ${fngData.value} (${fngData.value_classification})`);
            }
        } catch (error: any) {
            console.error("[MarketMetrics] ⚠️ Fear/Greed Error:", error.message);
        }
    };

    const fetchDominance = async () => {
        try {
            const response = await axios.get("https://pro-api.coinmarketcap.com/v1/global-metrics/quotes/latest", {
                headers: {
                    "X-CMC_PRO_API_KEY": "4b380165876b4ec18e100af29717b1e4"
                },
                timeout: 5000
            });

            const json = response.data;
            if (json.data) {
                const payload = {
                    btc_dominance: json.data.btc_dominance,
                    eth_dominance: json.data.eth_dominance
                };

                // Save to Redis
                await redisClient.set('DOMINANCE', JSON.stringify(payload));
                console.log(`[MarketMetrics] ✅ Dominance Updated: BTC ${json.data.btc_dominance.toFixed(2)}% | ETH ${json.data.eth_dominance.toFixed(2)}%`);
            }
        } catch (error: any) {
            console.error("[MarketMetrics] ⚠️ Dominance Error:", error.message);
        }
    };

    const scheduleDailyFetch = () => {
        const now = new Date();
        const target = new Date();

        target.setUTCHours(0, 1, 0, 0);

        if (now.getTime() > target.getTime()) {
            target.setUTCDate(target.getUTCDate() + 1);
        }

        const delay = target.getTime() - now.getTime();

        console.log(`[MarketMetrics] ⏰ Next scheduled daily fetch set for 5:31 AM IST (in ${Math.round(delay / 60000)} minutes).`);

        setTimeout(() => {
            console.log('[MarketMetrics] ⏰ Running scheduled 5:31 AM IST fetch...');
            fetchFearAndGreed();
            fetchDominance();
            scheduleDailyFetch();
        }, delay);
    };

    console.log('[MarketMetrics] ✅ Background Service Started');

    // 1. Exact daily fetch at 5:31 AM IST
    scheduleDailyFetch();

    // 2. Continual 5-minute fetch loop
    setInterval(() => {
        fetchFearAndGreed();
        fetchDominance();
    }, INTERVAL_5_MINS);

    // 3. Initial fetch immediately on server startup
    fetchFearAndGreed();
    fetchDominance();
}