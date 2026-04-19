const axios = require('axios');
async function test() {
  try {
    console.log("Fetching quote...");
    const quoteRes = await axios.get('https://quote-api.jup.ag/v6/quote', {
      params: {
        inputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        outputMint: 'So11111111111111111111111111111111111111112',
        amount: '20000000',
        slippageBps: 200
      }
    });
    console.log("Success! Route:", quoteRes.data.routePlan.length);
  } catch (err) {
    console.log("Error:", err?.response?.data || err.message);
  }
}
test();
