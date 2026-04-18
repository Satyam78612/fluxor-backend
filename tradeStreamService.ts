import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json()); // Essential for parsing Helius JSON payloads

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' } // Configure this to match your React Native app's needs
});

// Define the exact base token for Solana
// Convert to lowercase for easy comparison
const BASE_TOKENS = [
    'So11111111111111111111111111111111111111112' // WSOL (Solana)
].map(addr => addr.toLowerCase());

/**
 * -------------------------------------------------------------
 * SOLANA WEBHOOK HANDLER (HELIUS)
 * -------------------------------------------------------------
 */
app.post('/webhook/helius', (req, res) => {
    // 1. THE THROTTLE: Check if anyone actually has the app open right now.
    // io.engine.clientsCount returns the number of active mobile app users connected.
    if (io.engine.clientsCount === 0) {
        // Drop the payload immediately to save server CPU and memory.
        return res.status(200).send('OK'); 
    }

    const transactions = req.body;

    try {
        transactions.forEach((tx: any) => {
            // Helius nicely parses the transaction type
            if (tx.type === 'SWAP') {
                const nativeTransfers = tx.nativeTransfers || [];
                const tokenTransfers = tx.tokenTransfers || [];

                let solAmount = 0;
                let customAmount = 0;
                let type = 'Unknown';
                let customTokenMint = '';

                // Extract SOL amount (Base)
                if (nativeTransfers.length > 0) {
                    solAmount = nativeTransfers[0].amount / 1e9; // Convert lamports to SOL
                }

                // Extract Custom Token Amount
                if (tokenTransfers.length > 0) {
                    // Find the non-WSOL transfer
                    const customTx = tokenTransfers.find((t: any) => !BASE_TOKENS.includes(t.mint.toLowerCase()));
                    if (customTx) {
                        customAmount = customTx.tokenAmount;
                        customTokenMint = customTx.mint;
                    }
                }

                if (solAmount > 0 && customAmount > 0) {
                    // Determine Type: Did the user send SOL (Buy) or receive SOL (Sell)?
                    // Helius identifies the signer in tokenTransfers via `userAccount`
                    const userSentSol = nativeTransfers.some((n: any) => n.fromUserAccount === tx.feePayer);
                    type = userSentSol ? 'Buy' : 'Sell';

                    const priceRatio = solAmount / customAmount;

                    const tradeData = {
                        chain: 'Solana',
                        type: type,
                        amount: customAmount,
                        price: priceRatio,
                        tokenAddress: customTokenMint
                    };

                    // Push instantly to React Native clients
                    io.emit('liveTrade', tradeData);
                }
            }
        });
    } catch (error) {
        console.error("Error processing Helius webhook:", error);
    }

    res.status(200).send('OK');
});

// Start the socket server
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`Live Trade Stream Service running on port ${PORT}`);
});