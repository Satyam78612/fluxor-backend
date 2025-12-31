import { Request, Response } from 'express';
import { TokenService } from '../services/TokenService';

export const getPortfolioPrices = async (req: Request, res: Response) => {
    try {
        const service = TokenService.getInstance();
        const prices = await service.getPortfolioPrices();
        
        return res.json({
            data: prices,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        return res.status(500).json({ error: "Failed to fetch portfolio prices" });
    }
};