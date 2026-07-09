const crypto = require('crypto');
const https = require('https');
const { createHttpClient, httpGet, httpsAgent } = require('../utils/httpClient');
const { matchesDebugSymbol } = require('../utils/debugSymbol');

const CA_KEYWORDS = [
  'dividend', 'bonus', 'stock split', 'split', 'buy back', 'buyback',
  'rights issue', 'rights', 'amalgamation', 'merger', 'demerger',
  'book closure', 'corporate action', 'agm', 'egm',
];

const BSE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  Referer: 'https://www.bseindia.com/',
  Accept: 'application/json',
};

const NSE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  Accept: '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: 'https://www.nseindia.com/',
  Connection: 'keep-alive',
};

const NSE_ANN_HEADERS = {
  ...NSE_HEADERS,
  Referer: 'https://www.nseindia.com/companies-listing/corporate-filings-announcements',
};

const cmpCache = new Map();
const PARALLEL = {
  cmp: 30,
  bseAnnPages: 5,
  bseAnnPageBatch: 4,
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function formatDate(d, fmt) {
  const pad = (n) => String(n).padStart(2, '0');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  if (fmt === 'dd-mm-yyyy') {
    return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()}`;
  }
  if (fmt === 'yyyymmdd') {
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  }
  if (fmt === 'dd-mmm-yyyy') {
    return `${pad(d.getDate())}-${months[d.getMonth()]}-${d.getFullYear()}`;
  }
  return d.toISOString();
}

function announcementWindow(lookbackDays) {
  const end = new Date();
  end.setHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setDate(start.getDate() - Math.max(lookbackDays - 1, 0));
  return { start, end };
}

function isCorporateActionText(text) {
  const t = (text || '').toLowerCase();
  return CA_KEYWORDS.some((k) => t.includes(k));
}

function isDividendAnnouncement(item) {
  const text = `${item.NEWSSUB || ''} ${item.HEADLINE || ''} ${item.SUBCATNAME || ''}`.toLowerCase();
  return (
    text.includes('board approves dividend')
    || text.includes('recommend') && text.includes('dividend')
    || text.includes('declaration of dividend')
    || text.includes('declared dividend')
  );
}

function classifyAction(text) {
  const t = (text || '').toLowerCase();
  if (t.includes('dividend')) return 'dividend';
  if (t.includes('bonus')) return 'bonus';
  if (t.includes('split')) return 'split';
  if (t.includes('buy back') || t.includes('buyback')) return 'buyback';
  if (t.includes('rights')) return 'rights';
  if (t.includes('merger') || t.includes('amalgamation') || t.includes('demerger')) return 'merger';
  if (t.includes('agm')) return 'agm';
  if (t.includes('egm')) return 'egm';
  if (t.includes('book closure')) return 'book_closure';
  return 'other';
}

function parseDividendAmount(subject) {
  const s = (subject || '').toUpperCase();
  const patterns = [
    /RS\.?\s*-?\s*([\d,]+\.?\d*)/,
    /INR\.?\s*-?\s*([\d,]+\.?\d*)/,
    /₹\s*([\d,]+\.?\d*)/,
    /@\s*RS\.?\s*([\d,]+\.?\d*)/,
    /([\d,]+\.?\d*)\s*PER\s*(?:SHARE|EQUITY)/,
    /DIVIDEND\s*(?:OF\s*)?RS\.?\s*([\d,]+\.?\d*)/,
  ];
  for (const pattern of patterns) {
    const match = s.match(pattern);
    if (match) {
      const val = parseFloat(match[1].replace(/,/g, ''));
      if (!Number.isNaN(val)) return val;
    }
  }
  return 0;
}

function makeDedupKey(item) {
  const raw = `${item.exchange}|${item.symbol.toUpperCase()}|${item.actionType}|${item.exDate || ''}|${item.dividend}|${item.rawSubject}`;
  const digest = crypto.createHash('md5').update(raw).digest('hex').slice(0, 12);
  return `${item.symbol.toUpperCase()}_${digest}`;
}

async function createNseSession(forAnnouncements = false) {
  const client = createHttpClient({
    headers: forAnnouncements ? NSE_ANN_HEADERS : NSE_HEADERS,
    timeout: 30000,
    withCredentials: true,
  });
  const warmupUrl = forAnnouncements
    ? 'https://www.nseindia.com/companies-listing/corporate-filings-announcements'
    : 'https://www.nseindia.com';
  try {
    await client.get(warmupUrl);
    await sleep(200);
  } catch {
    // continue — some requests still work
  }
  return client;
}

async function fetchNseCorporateActions(client, start, end) {
  try {
    const fd = formatDate(start, 'dd-mm-yyyy');
    const td = formatDate(end, 'dd-mm-yyyy');
    const url = `https://www.nseindia.com/api/corporates-corporateActions?index=equities&from_date=${fd}&to_date=${td}`;
    const { data } = await client.get(url, { headers: NSE_HEADERS });
    const items = Array.isArray(data) ? data : data?.data || [];

    const debugRaw = items.filter((item) =>
      matchesDebugSymbol(item.symbol, item.sm_name || item.subject),
    );

    const bySymbol = {};
    for (const item of items) {
      const sym = (item.symbol || '').toUpperCase();
      if (sym) {
        if (!bySymbol[sym]) bySymbol[sym] = [];
        bySymbol[sym].push(item);
      }
    }
    return bySymbol;
  } catch (err) {
    console.error('NSE corporate-actions error:', err.message);
    return {};
  }
}

async function fetchNseAnnouncements(client, start, end) {
  try {
    const fd = formatDate(start, 'dd-mm-yyyy');
    const td = formatDate(end, 'dd-mm-yyyy');
    const url = `https://www.nseindia.com/api/corporate-announcements?index=equities&from_date=${fd}&to_date=${td}`;
    const { data } = await client.get(url, { headers: NSE_ANN_HEADERS });
    const items = Array.isArray(data) ? data : data?.data || [];

    const debugRaw = items.filter((item) =>
      matchesDebugSymbol(item.symbol, item.sm_name || item.desc || item.subject),
    );

    const results = [];
    for (const item of items) {
      const desc = item.desc || item.subject || '';
      if (!isCorporateActionText(desc)) continue;
      const symbol = item.symbol || '';
      const actionType = classifyAction(desc);
      results.push({
        exchange: 'NSE',
        symbol,
        company: item.sm_name || symbol,
        actionType,
        dividend: actionType === 'dividend' ? parseDividendAmount(desc) : 0,
        exDate: '',
        recordDate: '',
        announcedAt: item.an_dt || item.sort_date || '',
        rawSubject: desc,
        source: 'announcement',
        scripCode: null,
      });
    }
    return results;
  } catch (err) {
    console.error('NSE announcements error:', err.message);
    return [];
  }
}

function enrichNseFromCalendar(announcements, calendarBySymbol) {
  for (const ann of announcements) {
    if (ann.actionType !== 'dividend') continue;
    const entries = calendarBySymbol[ann.symbol.toUpperCase()] || [];
    for (const entry of entries) {
      const subject = entry.subject || '';
      if (!subject.toLowerCase().includes('dividend')) continue;
      const amt = parseDividendAmount(subject);
      if (amt > 0) ann.dividend = amt;
      ann.exDate = entry.exDate || ann.exDate;
      ann.recordDate = entry.recDate || ann.recordDate;
      if (!ann.rawSubject || subject.length > ann.rawSubject.length) {
        ann.rawSubject = subject;
      }
      break;
    }
  }
}

async function runInBatches(items, batchSize, fn, delayMs = 0) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
    if (delayMs > 0 && i + batchSize < items.length) {
      await sleep(delayMs);
    }
  }
  return results;
}

function httpGetNative(url, headers, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { agent: httpsAgent, headers }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('Request timeout'));
    });
  });
}

async function fetchBseAnnouncementPage(fromDate, page) {
  const url = `https://api.bseindia.com/BseIndiaAPI/api/AnnSubCategoryGetData/w?pageno=${page}&strCat=-1&strPrevDate=${fromDate}&strScrip=&strSearch=P&strType=C`;
  for (let attempt = 0; attempt <= 2; attempt += 1) {
    try {
      let data;
      try {
        ({ data } = await httpGet(url, { headers: BSE_HEADERS, timeout: 30000 }));
      } catch {
        data = await httpGetNative(url, BSE_HEADERS);
      }
      return Array.isArray(data?.Table) ? data.Table : [];
    } catch (err) {
      if (attempt === 2) throw err;
      await sleep(300 * (attempt + 1));
    }
  }
  return [];
}

/** One bulk paginated fetch instead of per-scrip API calls */
async function buildBseAnnouncementDateMapBulk(endDate) {
  const from = new Date(endDate);
  from.setDate(from.getDate() - 120);
  const fromDate = formatDate(from, 'yyyymmdd');
  const map = new Map();

  const pageNums = Array.from({ length: PARALLEL.bseAnnPages }, (_, i) => i + 1);
  const pages = await runInBatches(pageNums, PARALLEL.bseAnnPageBatch, async (page) => {
    try {
      const items = await fetchBseAnnouncementPage(fromDate, page);
      return { page, items };
    } catch (err) {
      console.warn(`BSE announcement page ${page} failed:`, err.message);
      return { page, items: [] };
    }
  });

  for (const { items } of pages) {
    for (const item of items) {
      if (!isDividendAnnouncement(item)) continue;
      const scrip = item.SCRIP_CD;
      if (!scrip) continue;
      const dt = item.NEWS_DT || item.DissemDT || '';
      if (!dt) continue;
      const existing = map.get(scrip);
      if (!existing || new Date(dt) > new Date(existing)) {
        map.set(scrip, dt);
      }
    }
  }

  return map;
}

function enrichBseFromAnnouncements(bseItems, announcementDateMap) {
  for (const item of bseItems) {
    if (!item.scripCode) continue;
    const annDate = announcementDateMap.get(item.scripCode);
    if (annDate) {
      item.announcedAt = annDate;
    }
  }
}

async function fetchBseCorporateActionsRaw(start, end) {
  const fd = formatDate(start, 'yyyymmdd');
  const td = formatDate(end, 'yyyymmdd');
  const url = `https://api.bseindia.com/BseIndiaAPI/api/DefaultData/w?strdate=${fd}&enddate=${td}&ddlcategorys=&ddlindustrys=&scripcode=&type=C`;
  const { data } = await httpGet(url, {
    headers: BSE_HEADERS,
    timeout: 45000,
  });
  const items = Array.isArray(data) ? data : data?.Table || data?.data || [];

  const results = [];
  for (const item of items) {
    const subject = item.Purpose || item.Remarks || '';
    if (!isCorporateActionText(subject)) continue;
    const symbol = item.short_name || String(item.scrip_code || '');
    const exDate = item.Ex_date || item.exdate || '';
    results.push({
      exchange: 'BSE',
      symbol,
      company: item.long_name || item.LONG_NAME || symbol,
      actionType: classifyAction(subject),
      dividend: parseDividendAmount(subject),
      exDate,
      recordDate: item.RD_Date || '',
      announcedAt: '',
      rawSubject: subject,
      source: 'corporate_action',
      scripCode: item.scrip_code || null,
    });
  }
  return results;
}

async function getBseCmp(scripCode) {
  const cacheKey = `BSE:${scripCode}`;
  if (cmpCache.has(cacheKey)) return cmpCache.get(cacheKey);

  try {
    const url = `https://api.bseindia.com/BseIndiaAPI/api/getScripHeaderData/w?scripcode=${scripCode}&flag=0&Quotetype=EQ`;
    const { data } = await httpGet(url, {
      headers: BSE_HEADERS,
      timeout: 15000,
    });
    const price = Number(data?.Header?.LTP || data?.CurrRate?.LTP || 0);
    if (price > 0) {
      cmpCache.set(cacheKey, price);
      return price;
    }
  } catch {
    // fallback to Yahoo
  }
  return 0;
}

async function getNseCmp(symbol, nseClient) {
  const cacheKey = `NSE:${symbol}`;
  if (cmpCache.has(cacheKey)) return cmpCache.get(cacheKey);

  if (nseClient) {
    try {
      const url = `https://www.nseindia.com/api/quote-equity?symbol=${symbol}`;
      const { data } = await nseClient.get(url, {
        headers: { ...NSE_HEADERS, Referer: 'https://www.nseindia.com/get-quotes/equity' },
        timeout: 10000,
      });
      const price = Number(data?.priceInfo?.lastPrice || 0);
      if (price > 0) {
        cmpCache.set(cacheKey, price);
        return price;
      }
    } catch {
      // fallback to Yahoo
    }
  }
  return 0;
}

async function getYahooCmp(symbol, exchange) {
  const cacheKey = `YAHOO:${exchange}:${symbol}`;
  if (cmpCache.has(cacheKey)) return cmpCache.get(cacheKey);

  const suffix = exchange === 'NSE' ? '.NS' : '.BO';
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}${suffix}`;
    const { data } = await httpGet(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 10000,
    });
    const price = Number(data?.chart?.result?.[0]?.meta?.regularMarketPrice || 0);
    if (price > 0) {
      cmpCache.set(cacheKey, price);
      return price;
    }
  } catch {
    // ignore
  }
  return 0;
}

async function getCmp(item, nseClient) {
  const sym = String(item.symbol || '').trim().toUpperCase();
  if (!sym) return 0;

  // Yahoo is fastest — try first, fall back to exchange APIs
  const yahooPrice = await getYahooCmp(sym, item.exchange);
  if (yahooPrice > 0) return yahooPrice;

  if (item.exchange === 'BSE' && item.scripCode) {
    const bsePrice = await getBseCmp(item.scripCode);
    if (bsePrice > 0) return bsePrice;
  }

  if (item.exchange === 'NSE') {
    const nsePrice = await getNseCmp(sym, nseClient);
    if (nsePrice > 0) return nsePrice;
  }

  return 0;
}

function cmpLookupKey(item) {
  const sym = String(item.symbol || '').trim().toUpperCase();
  if (item.exchange === 'BSE' && item.scripCode) return `BSE:${item.scripCode}`;
  return `${item.exchange}:${sym}`;
}

async function prefetchCmps(dividends, nseClient) {
  const uniqueByKey = new Map();
  for (const item of dividends) {
    const key = cmpLookupKey(item);
    if (!uniqueByKey.has(key)) uniqueByKey.set(key, item);
  }

  const cmpByKey = new Map();
  await runInBatches([...uniqueByKey.values()], PARALLEL.cmp, async (item) => {
    const key = cmpLookupKey(item);
    const cmp = await getCmp(item, nseClient);
    cmpByKey.set(key, cmp);
  });

  return cmpByKey;
}

async function fetchDividendAlerts(config) {
  cmpCache.clear();
  const fetchStart = Date.now();

  const { start, end } = announcementWindow(config.lookbackDays);
  console.log(`Fetching dividends: ${formatDate(start, 'dd-mm-yyyy')} → ${formatDate(end, 'dd-mm-yyyy')}`);

  const nseClient = await createNseSession(true);
  const calEnd = new Date(end);
  calEnd.setDate(calEnd.getDate() + 120);

  const [nseAnn, calendar, bseAnnMap, bseRaw] = await Promise.all([
    fetchNseAnnouncements(nseClient, start, end),
    fetchNseCorporateActions(nseClient, end, calEnd),
    buildBseAnnouncementDateMapBulk(end),
    fetchBseCorporateActionsRaw(start, end),
  ]);

  enrichNseFromCalendar(nseAnn, calendar);
  enrichBseFromAnnouncements(bseRaw, bseAnnMap);
  const allItems = [...nseAnn, ...bseRaw];

  const dividends = allItems.filter((item) => item.actionType === 'dividend');
  const cmpByKey = await prefetchCmps(dividends, nseClient);

  const results = [];

  for (const item of dividends) {
    const cmp = cmpByKey.get(cmpLookupKey(item)) || 0;
    let yieldPct = 0;
    if (item.dividend > 0 && cmp > 0) {
      yieldPct = (item.dividend / cmp) * 100;
    }

    if (config.alertDividends && item.dividend > 0 && cmp > 0 && yieldPct < config.minPercentGain) {
      continue;
    }

    const record = {
      ...item,
      cmp,
      yield: Math.round(yieldPct * 100) / 100,
      dedupKey: makeDedupKey(item),
    };
    delete record.scripCode;
    results.push(record);
  }

  const elapsed = ((Date.now() - fetchStart) / 1000).toFixed(1);
  console.log(`Fetched ${results.length} dividend alert(s) in ${elapsed}s`);
  return results;
}

module.exports = {
  fetchDividendAlerts,
  makeDedupKey,
  announcementWindow,
};
