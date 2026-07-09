const express = require('express');
const Dividend = require('../models/Dividend');
const { fetchDividendAlerts } = require('../services/dividendFetcher');
const { isDbConnected } = require('../config/db');
const { toDividendResponse } = require('../utils/formatDividend');

const router = express.Router();

const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS) || 7;
const MIN_PERCENT_GAIN = Number(process.env.MIN_PERCENT_GAIN) || 0;
const MEMORY_CACHE_MS = 5 * 60 * 1000;

let memoryCache = null;
let memoryCacheAt = 0;

async function loadFromExchanges() {
  return fetchDividendAlerts({
    lookbackDays: LOOKBACK_DAYS,
    minPercentGain: MIN_PERCENT_GAIN,
    alertDividends: true,
  });
}


router.get('/', async (req, res) => {
  try {
    const refresh = req.query.refresh === 'true';
    const dbReady = isDbConnected();

    if (dbReady) {
      let dividends = await Dividend.find().sort({ announcedAt: -1, createdAt: -1 });

      if (refresh || dividends.length === 0) {
        const fetched = await loadFromExchanges();

        for (const item of fetched) {
          await Dividend.findOneAndUpdate(
            { dedupKey: item.dedupKey },
            {
              dedupKey: item.dedupKey,
              exchange: item.exchange,
              symbol: item.symbol,
              company: item.company,
              dividend: item.dividend,
              cmp: item.cmp,
              yield: item.yield,
              announcedAt: item.announcedAt,
              exDate: item.exDate,
              recordDate: item.recordDate,
              rawSubject: item.rawSubject,
              source: item.source,
              actionType: item.actionType,
            },
            { upsert: true, new: true },
          );
        }
        dividends = await Dividend.find().sort({ announcedAt: -1, createdAt: -1 });
      }

      return res.json(dividends.map((d) => toDividendResponse(d)));
    }

    const now = Date.now();
    if (!refresh && memoryCache && now - memoryCacheAt < MEMORY_CACHE_MS) {
      return res.json(memoryCache);
    }

    console.warn('MongoDB unavailable — serving live dividend data (not persisted)');
    const fetched = await loadFromExchanges();
    memoryCache = fetched.map((item) => toDividendResponse(item));
    memoryCacheAt = now;
    return res.json(memoryCache);
  } catch (err) {
    console.error('Dividends error:', err);
    res.status(500).json({ message: 'Failed to fetch dividends' });
  }
});

module.exports = router;
