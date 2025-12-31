import { Request, Response } from 'express';
import { TokenService } from '../services/TokenService';

export const searchToken = async (req: Request, res: Response) => {
    const address = req.query.address as string;

    if (!address) {
        return res.status(400).json({ error: 'Address is required' });
    }

    const service = TokenService.getInstance();
    const result = await service.searchToken(address);

    if (result) {
        return res.json(result);
    } else {
        return res.status(404).json({ error: 'Token not found' });
    }
};