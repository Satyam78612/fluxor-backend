let fiatRatesCache: Record<string, number> = {
    USD: 1,
};

const FIAT_API_URL = "https://api.exchangerate-api.com/v4/latest/USD";

const fetchAndCacheFiatRates = async () => {
    try {
        console.log("🔄 Fetching live fiat rates from external API...");
        const response = await fetch(FIAT_API_URL);

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();

        if (data && data.rates) {
            fiatRatesCache = data.rates;
            console.log("✅ Fiat rates updated successfully.");
        }
    } catch (error) {
        console.error("❌ Failed to fetch fiat rates:", error);
    }
};

export const startFiatRatesService = () => {
    fetchAndCacheFiatRates();
    setInterval(fetchAndCacheFiatRates, 15 * 60 * 1000);
};

export const getFiatRates = () => {
    return fiatRatesCache;
};