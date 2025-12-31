import { Router } from 'express';
import { searchToken } from '../controllers/SearchController';
import { getPortfolioPrices } from '../controllers/PortfolioController';

const router = Router();
router.get('/search', searchToken);

router.get('/portfolio/prices', getPortfolioPrices);

export default router;