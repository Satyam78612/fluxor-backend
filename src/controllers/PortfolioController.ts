import { Request, Response } from 'express';
import { TokenService } from '../services/TokenService';

export const getPortfolioPrices = async (req: Request, res: Response) => {
    try {
        const service = TokenService.getInstance();
        const prices = await service.getPortfolioPrices();
        
        return res.json(prices);
        
    } catch (error) {
        return res.status(500).json({ error: "Failed to fetch portfolio prices" });
    }
};