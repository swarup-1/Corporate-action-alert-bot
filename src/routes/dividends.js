const express = require('express');
const Dividend = require('../models/Dividend');
const { fetchDividendAlerts } = require('../services/dividendFetcher');
const { isDbConnected } = require('../config/db');
const { toDividendResponse } = require('../utils/formatDividend');

const router = express.Router();

const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS) || 7;
const MIN_PERCENT_GAIN = Number(process.env.MIN_PERCENT_GAIN) || 0;
const MEMORY_CACHE_MS = 30 * 60 * 1000;

let memoryCache = null;
let memoryCacheAt = 0;
let scrapePromise = null;

async function loadFromExchanges() {
  if (scrapePromise) return scrapePromise;
  scrapePromise = fetchDividendAlerts({
    lookbackDays: LOOKBACK_DAYS,
    minPercentGain: MIN_PERCENT_GAIN,
    alertDividends: true,
  }).finally(() => {
    scrapePromise = null;
  });
  return scrapePromise;
}

function toInsertDoc(item) {
  return {
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
  };
}

function toApiList(items) {
  return items.map((item) => toDividendResponse(item));
}

async function replaceDatabase(fetched) {
  if (!fetched.length) {
    console.warn('Scrape returned 0 dividends — leaving existing DB records unchanged');
    return;
  }

  await Dividend.deleteMany({});
  await Dividend.insertMany(fetched.map(toInsertDoc), { ordered: false });
  console.log(`Replaced dividend collection with ${fetched.length} fresh row(s)`);
}

function storeMemory(fetched) {
  memoryCache = toApiList(fetched);
  memoryCacheAt = Date.now();
  return memoryCache;
}

router.get('/', async (req, res) => {
  try {
    const refresh = req.query.refresh === 'true';
    const dbReady = isDbConnected();

    if (dbReady) {
      if (!refresh) {
        const dividends = await Dividend.find().sort({ announcedAt: -1, createdAt: -1 });
        if (dividends.length > 0) {
          return res.json(toApiList(dividends));
        }
      }

      const fetched = await loadFromExchanges();
      await replaceDatabase(fetched);
      storeMemory(fetched);
      const dividends = await Dividend.find().sort({ announcedAt: -1, createdAt: -1 });
      return res.json(toApiList(dividends.length ? dividends : fetched));
    }

    if (!refresh && memoryCache && Date.now() - memoryCacheAt < MEMORY_CACHE_MS) {
      return res.json(memoryCache);
    }

    console.warn('MongoDB unavailable — serving live dividend data (not persisted)');
    const fetched = await loadFromExchanges();
    return res.json(storeMemory(fetched));
  } catch (err) {
    console.error('Dividends error:', err);
    res.status(500).json({ message: 'Failed to fetch dividends' });
  }
});

module.exports = router;
