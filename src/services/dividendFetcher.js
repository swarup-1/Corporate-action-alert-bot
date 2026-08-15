const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');
const { createHttpClient, httpGet, httpsAgent } = require('../utils/httpClient');
const { matchesDebugSymbol } = require('../utils/debugSymbol');

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

const NSE_CA_HEADERS = {
  ...NSE_HEADERS,
  Referer: 'https://www.nseindia.com/companies-listing/corporate-filings-actions',
};

const BSE_DIVIDEND_PURPOSE = 'P9';
const BSE_ANN_CATEGORY = 'Corp. Action';
const BSE_ANN_SUBCATEGORY = 'Dividend';
const BSE_ANN_PAGE_SIZE = 50;
const BSE_ANN_MAX_PAGES = 20;
const BSE_ANN_CHUNK_DAYS = 30;
const BSE_DECLARED_LOOKBACK_DAYS = 180;

const cmpCache = new Map();
const PARALLEL = {
  cmpFallback: 12,
  yahooChunk: 40,
  yahooChunkBatch: 3,
  declared: 16,
};

const DECLARED_CACHE_FILE = path.join(__dirname, '../../.cache/bse-declared.json');
const DECLARED_CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

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

function isDividendAnnouncement(item) {
  const text = `${item.NEWSSUB || ''} ${item.HEADLINE || ''} ${item.SUBCATNAME || ''}`.toLowerCase();
  if (!text.includes('dividend')) return false;
  if (text.includes('tds') || text.includes('tax deduction') || text.includes('newspaper')) return false;
  return true;
}

function scripKey(code) {
  return String(code ?? '').replace(/^0+/, '').trim();
}

function parseDividendAmount(subject) {
  const s = (subject || '').toUpperCase().replace(/₹/g, 'RS ');
  const patterns = [
    /DIVIDEND\s+(?:OF\s+)?(?:RS|RE|INR)\.?\s*-?\s*([\d,]+\.?\d*)/,
    /(?:RS|RE|INR)\.?\s*-?\s*([\d,]+\.?\d*)\s*(?:\/-)?\s*PER\s*(?:EQUITY\s+)?(?:SHARE|UNIT)/,
    /(?:RS|RE|INR)\.?\s*-?\s*([\d,]+\.?\d*)/,
    /@\s*(?:RS|RE)\.?\s*-?\s*([\d,]+\.?\d*)/,
    /([\d,]+\.?\d*)\s*PER\s*(?:SHARE|EQUITY|UNIT)/,
  ];
  for (const pattern of patterns) {
    const match = s.match(pattern);
    if (match) {
      const val = parseFloat(match[1].replace(/,/g, ''));
      if (!Number.isNaN(val) && val > 0) return val;
    }
  }
  return 0;
}

const MONTHS = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

/** Turn NSE date strings into ISO so the dashboard can sort/filter/display them. */
function toIsoDateTime(value) {
  if (!value) return '';
  const s = String(value).trim();
  if (!s || s === '-') return '';

  const compact = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) {
    return `${compact[1]}-${compact[2]}-${compact[3]}T00:00:00+05:30`;
  }

  const isoLike = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (isoLike) {
    const time = `${isoLike[4] || '00'}:${isoLike[5] || '00'}:${isoLike[6] || '00'}`;
    return `${isoLike[1]}-${isoLike[2]}-${isoLike[3]}T${time}+05:30`;
  }

  const dMonY = s.match(/^(\d{1,2})[ -]([A-Za-z]{3,})[ -](\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (dMonY) {
    const month = MONTHS[dMonY[2].slice(0, 3).toLowerCase()];
    if (month) {
      const day = String(dMonY[1]).padStart(2, '0');
      const time = `${dMonY[4] || '00'}:${dMonY[5] || '00'}:${dMonY[6] || '00'}`;
      return `${dMonY[3]}-${month}-${day}T${time}+05:30`;
    }
  }

  const dmy = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (dmy) {
    const day = String(dmy[1]).padStart(2, '0');
    const month = String(dmy[2]).padStart(2, '0');
    const time = `${dmy[4] || '00'}:${dmy[5] || '00'}:${dmy[6] || '00'}`;
    return `${dmy[3]}-${month}-${day}T${time}+05:30`;
  }

  const parsed = new Date(s);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  return s;
}

function makeDedupKey(item) {
  const raw = `${item.exchange}|${item.symbol.toUpperCase()}|${item.actionType}|${item.exDate || ''}|${item.dividend}|${item.rawSubject}`;
  const digest = crypto.createHash('md5').update(raw).digest('hex').slice(0, 12);
  return `${item.symbol.toUpperCase()}_${digest}`;
}

async function createNseSession() {
  const client = createHttpClient({
    headers: NSE_CA_HEADERS,
    timeout: 30000,
    withCredentials: true,
  });
  try {
    await client.get('https://www.nseindia.com/companies-listing/corporate-filings-actions');
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
    const { data } = await client.get(url, { headers: NSE_CA_HEADERS });
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

/** NSE has no server-side dividend filter; keep only dividend rows from the CA calendar. */
function nseCalendarToDividends(calendarBySymbol) {
  const results = [];
  for (const entries of Object.values(calendarBySymbol)) {
    for (const entry of entries) {
      const subject = entry.subject || entry.caPurpose || entry.purpose || '';
      if (!String(subject).toLowerCase().includes('dividend')) continue;
      const symbol = String(entry.symbol || '').toUpperCase();
      if (!symbol) continue;
      results.push({
        exchange: 'NSE',
        symbol,
        company: entry.comp || entry.sm_name || symbol,
        actionType: 'dividend',
        dividend: parseDividendAmount(subject),
        exDate: toIsoDateTime(entry.exDate || entry.exDt || entry.ex_date || ''),
        recordDate: toIsoDateTime(entry.recDate || entry.recDt || entry.recordDate || ''),
        announcedAt: toIsoDateTime(entry.caBroadcastDate || ''),
        rawSubject: subject,
        source: 'corporate_action',
        scripCode: null,
      });
    }
  }
  return results;
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
    const req = https.get(url, {
      agent: httpsAgent,
      headers,
      insecureHTTPParser: true,
    }, (res) => {
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

function httpGetCurl(url, headers, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const args = ['-sS', '-L', '--max-time', String(Math.ceil(timeoutMs / 1000))];
    if (process.env.ALLOW_INSECURE_SSL === 'true') args.push('-k');
    for (const [key, value] of Object.entries(headers || {})) {
      args.push('-H', `${key}: ${value}`);
    }
    args.push(url);

    const child = spawn('curl', args);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `curl exited ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (err) {
        reject(err);
      }
    });
  });
}

/** BSE headers often break axios; native/curl with a loose parser is faster and more reliable. */
async function bseJsonGet(url, timeoutMs = 20000) {
  try {
    return await httpGetNative(url, BSE_HEADERS, timeoutMs);
  } catch (nativeErr) {
    try {
      return await httpGetCurl(url, BSE_HEADERS, timeoutMs);
    } catch (curlErr) {
      console.warn(`BSE request failed: ${nativeErr.message}`);
      throw nativeErr;
    }
  }
}

function readDeclaredCache() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DECLARED_CACHE_FILE, 'utf8'));
    const now = Date.now();
    const map = new Map();
    for (const [key, value] of Object.entries(parsed || {})) {
      if (value?.announcedAt && now - (value.savedAt || 0) < DECLARED_CACHE_TTL_MS) {
        map.set(key, value.announcedAt);
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

function writeDeclaredCache(map) {
  try {
    fs.mkdirSync(path.dirname(DECLARED_CACHE_FILE), { recursive: true });
    const obj = {};
    for (const [key, announcedAt] of map) {
      if (!announcedAt) continue;
      obj[key] = { announcedAt, savedAt: Date.now() };
    }
    fs.writeFileSync(DECLARED_CACHE_FILE, JSON.stringify(obj));
  } catch (err) {
    console.warn('Could not write declared-date cache:', err.message);
  }
}

function announcementDate(item) {
  return item?.NEWS_DT || item?.DissemDT || item?.News_submission_dt || '';
}

function dateChunks(fromDate, toDate, days) {
  const chunks = [];
  const cursor = new Date(fromDate);
  const end = new Date(toDate);
  while (cursor <= end) {
    const chunkEnd = new Date(cursor);
    chunkEnd.setDate(chunkEnd.getDate() + days - 1);
    if (chunkEnd > end) chunkEnd.setTime(end.getTime());
    chunks.push({ start: new Date(cursor), end: new Date(chunkEnd) });
    cursor.setTime(chunkEnd.getTime());
    cursor.setDate(cursor.getDate() + 1);
  }
  return chunks;
}

function bseDividendAnnouncementUrl(fromYmd, toYmd, pageNo) {
  return `https://api.bseindia.com/BseIndiaAPI/api/AnnSubCategoryGetData/w?pageno=${pageNo}`
    + `&strCat=${encodeURIComponent(BSE_ANN_CATEGORY)}`
    + `&subcategory=${encodeURIComponent(BSE_ANN_SUBCATEGORY)}`
    + `&strPrevDate=${fromYmd}&strToDate=${toYmd}&strSearch=P&strscrip=&strType=C`;
}

async function fetchBseDividendAnnouncementPages(fromDate, toDate) {
  const items = [];
  const chunks = dateChunks(fromDate, toDate, BSE_ANN_CHUNK_DAYS);

  await runInBatches(chunks, 4, async (chunk) => {
    const fd = formatDate(chunk.start, 'yyyymmdd');
    const td = formatDate(chunk.end, 'yyyymmdd');
    let total = Infinity;
    const chunkItems = [];
    for (let page = 1; page <= BSE_ANN_MAX_PAGES && (page - 1) * BSE_ANN_PAGE_SIZE < total; page += 1) {
      try {
        const data = await bseJsonGet(bseDividendAnnouncementUrl(fd, td, page), 20000);
        const table = Array.isArray(data?.Table) ? data.Table : [];
        const rowcnt = Number(data?.Table1?.[0]?.ROWCNT);
        if (Number.isFinite(rowcnt) && rowcnt >= 0) total = rowcnt;
        else if (!table.length) break;
        chunkItems.push(...table.filter(isDividendAnnouncement));
        if (!table.length || table.length < BSE_ANN_PAGE_SIZE) break;
      } catch (err) {
        console.warn(`BSE dividend announcements failed ${fd}–${td} page ${page}:`, err.message);
        break;
      }
    }
    items.push(...chunkItems);
  });

  return items;
}

function declaredMapFromAnnouncements(items) {
  const map = new Map();
  for (const item of items) {
    const key = scripKey(item.SCRIP_CD);
    if (!key) continue;
    const dt = toIsoDateTime(announcementDate(item));
    if (!dt) continue;
    const prev = map.get(key);
    if (!prev || new Date(dt).getTime() > new Date(prev).getTime()) {
      map.set(key, dt);
    }
  }
  return map;
}

async function fetchBseDeclaredDateForScrip(scripCode, fromDate) {
  const url = `https://api.bseindia.com/BseIndiaAPI/api/AnnSubCategoryGetData/w?pageno=1&strCat=${encodeURIComponent(BSE_ANN_CATEGORY)}&subcategory=${encodeURIComponent(BSE_ANN_SUBCATEGORY)}&strPrevDate=${fromDate}&strScrip=${scripCode}&strSearch=P&strType=C`;
  try {
    const data = await bseJsonGet(url, 12000);
    const items = Array.isArray(data?.Table) ? data.Table : [];
    const dividendAnns = items
      .filter(isDividendAnnouncement)
      .sort(
        (a, b) =>
          new Date(announcementDate(b) || 0).getTime()
          - new Date(announcementDate(a) || 0).getTime(),
      );
    if (!dividendAnns.length) return '';
    return announcementDate(dividendAnns[0]);
  } catch (err) {
    console.warn(`BSE declared-date lookup failed for ${scripCode}:`, err.message);
    return '';
  }
}

/** Fill BSE declared dates from dividend-only announcements, then cache/per-scrip leftovers. */
async function fillMissingBseDeclaredDates(bseItems, endDate, bulkAnns = null) {
  const cache = readDeclaredCache();
  for (const item of bseItems) {
    if (item.announcedAt || !item.scripCode) continue;
    const cached = cache.get(scripKey(item.scripCode));
    if (cached) item.announcedAt = cached;
  }

  const from = new Date(endDate);
  from.setDate(from.getDate() - BSE_DECLARED_LOOKBACK_DAYS);
  const fromDate = formatDate(from, 'yyyymmdd');

  const announcements = bulkAnns || await fetchBseDividendAnnouncementPages(from, endDate);
  const bulkMap = declaredMapFromAnnouncements(announcements);
  console.log(`BSE dividend announcements: ${announcements.length} filing(s), ${bulkMap.size} scrip(s)`);

  for (const item of bseItems) {
    if (item.announcedAt || !item.scripCode) continue;
    const dt = bulkMap.get(scripKey(item.scripCode));
    if (dt) {
      item.announcedAt = dt;
      cache.set(scripKey(item.scripCode), dt);
    }
  }

  const pending = [];
  const seen = new Set();
  for (const item of bseItems) {
    if (item.announcedAt || !item.scripCode) continue;
    const key = scripKey(item.scripCode);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    pending.push(item.scripCode);
  }

  if (pending.length && !announcements.length) {
    const leftover = pending.slice(0, 40);
    console.log(`Looking up leftover BSE declared dates for ${leftover.length} scrip(s)`);
    await runInBatches(leftover, PARALLEL.declared, async (scripCode) => {
      const dt = await fetchBseDeclaredDateForScrip(scripCode, fromDate);
      if (!dt) return;
      cache.set(scripKey(scripCode), toIsoDateTime(dt));
    });
  } else if (pending.length) {
    console.log(`No per-scrip lookup: ${pending.length} BSE row(s) still missing declared date`);
  }

  for (const item of bseItems) {
    if (item.announcedAt) continue;
    const cached = cache.get(scripKey(item.scripCode));
    if (cached) item.announcedAt = cached;
  }

  writeDeclaredCache(cache);
}

function indexBySymbol(items) {
  const map = new Map();
  for (const item of items) {
    const key = String(item.symbol || '').toUpperCase();
    if (!key) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

function bestCrossMatch(item, others) {
  if (!others.length) return null;
  const amt = Number(item.dividend) || 0;
  if (amt > 0) {
    const exact = others.find((other) => Math.abs((Number(other.dividend) || 0) - amt) <= 0.011);
    if (exact) return exact;
  } else {
    const withAmt = others.filter((other) => Number(other.dividend) > 0);
    if (withAmt.length === 1) return withAmt[0];
  }
  if (others.length === 1) return others[0];
  return null;
}

function fillEmpty(target, field, value) {
  if (target[field] || value === undefined || value === null || value === '') return;
  target[field] = value;
}

/** Dual-listed stocks: NSE usually has declared date, BSE usually has amount + ex-date. */
function crossFillExchanges(nseItems, bseItems) {
  const nseBySymbol = indexBySymbol(nseItems);
  const bseBySymbol = indexBySymbol(bseItems);

  for (const nse of nseItems) {
    const match = bestCrossMatch(nse, bseBySymbol.get(String(nse.symbol || '').toUpperCase()) || []);
    if (!match) continue;
    fillEmpty(nse, 'dividend', match.dividend > 0 ? match.dividend : '');
    fillEmpty(nse, 'exDate', toIsoDateTime(match.exDate));
    fillEmpty(nse, 'recordDate', toIsoDateTime(match.recordDate));
    fillEmpty(nse, 'announcedAt', match.announcedAt);
  }

  for (const bse of bseItems) {
    const match = bestCrossMatch(bse, nseBySymbol.get(String(bse.symbol || '').toUpperCase()) || []);
    if (!match) continue;
    fillEmpty(bse, 'announcedAt', match.announcedAt);
    fillEmpty(bse, 'dividend', match.dividend > 0 ? match.dividend : '');
    if (!bse.exDate && match.exDate) bse.exDate = toIsoDateTime(match.exDate);
    if (!bse.recordDate && match.recordDate) bse.recordDate = toIsoDateTime(match.recordDate);
  }
}

function mapBseCaRows(items) {
  const results = [];
  for (const item of items) {
    const subject = item.Purpose || item.Remarks || '';
    if (!String(subject).toLowerCase().includes('dividend')) continue;
    const symbol = item.short_name || String(item.scrip_code || '');
    results.push({
      exchange: 'BSE',
      symbol: String(symbol || '').toUpperCase(),
      company: item.long_name || item.LONG_NAME || symbol,
      actionType: 'dividend',
      dividend: parseDividendAmount(subject),
      exDate: toIsoDateTime(item.Ex_date || item.exdate || ''),
      recordDate: toIsoDateTime(item.RD_Date || ''),
      announcedAt: '',
      rawSubject: subject,
      source: 'corporate_action',
      scripCode: item.scrip_code || null,
    });
  }
  return results;
}

async function fetchBseCorporateActionsRaw(start, end) {
  const fd = formatDate(start, 'yyyymmdd');
  const td = formatDate(end, 'yyyymmdd');
  const dividendUrl =
    `https://api.bseindia.com/BseIndiaAPI/api/DefaultData/w?Fdate=${fd}&Purposecode=${BSE_DIVIDEND_PURPOSE}`
    + `&TDate=${td}&ddlcategorys=E&ddlindustrys=&scripcode=&segment=0&strSearch=S`;
  const fallbackUrl =
    `https://api.bseindia.com/BseIndiaAPI/api/DefaultData/w?strdate=${fd}&enddate=${td}`
    + `&ddlcategorys=&ddlindustrys=&scripcode=&type=C`;

  try {
    const data = await bseJsonGet(dividendUrl, 45000);
    const items = Array.isArray(data) ? data : data?.Table || data?.data || [];
    const results = mapBseCaRows(items);
    if (results.length) {
      console.log(`BSE dividend CA (P9): ${results.length} row(s)`);
      return results;
    }
    console.warn('BSE P9 returned no dividend rows; falling back to unfiltered CA feed');
  } catch (err) {
    console.warn('BSE dividend CA (P9) failed:', err.message);
  }

  try {
    const data = await bseJsonGet(fallbackUrl, 45000);
    const items = Array.isArray(data) ? data : data?.Table || data?.data || [];
    const results = mapBseCaRows(items);
    console.log(`BSE CA fallback: ${results.length} dividend row(s)`);
    return results;
  } catch (err) {
    console.error('BSE corporate-actions error:', err.message);
    return [];
  }
}

async function getBseCmp(scripCode) {
  const cacheKey = `BSE:${scripCode}`;
  if (cmpCache.has(cacheKey)) return cmpCache.get(cacheKey);

  try {
    const url = `https://api.bseindia.com/BseIndiaAPI/api/getScripHeaderData/w?scripcode=${scripCode}&flag=0&Quotetype=EQ`;
    const data = await bseJsonGet(url, 15000);
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

function yahooTicker(item) {
  const sym = String(item.symbol || '').trim().toUpperCase();
  if (!sym) return '';
  return `${sym}${item.exchange === 'NSE' ? '.NS' : '.BO'}`;
}

async function fetchYahooQuotes(tickers) {
  const prices = new Map();
  const unique = [...new Set(tickers.filter(Boolean))];
  if (!unique.length) return prices;

  const chunks = [];
  for (let i = 0; i < unique.length; i += PARALLEL.yahooChunk) {
    chunks.push(unique.slice(i, i + PARALLEL.yahooChunk));
  }

  await runInBatches(chunks, PARALLEL.yahooChunkBatch, async (chunk) => {
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?fields=regularMarketPrice,symbol&symbols=${encodeURIComponent(chunk.join(','))}`;
    try {
      const { data } = await httpGet(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
        timeout: 15000,
      });
      const rows = data?.quoteResponse?.result || [];
      for (const row of rows) {
        const price = Number(row.regularMarketPrice || 0);
        if (row.symbol && price > 0) prices.set(String(row.symbol).toUpperCase(), price);
      }
    } catch (err) {
      console.warn('Yahoo batch quote failed:', err.message);
    }
  });

  return prices;
}

async function prefetchCmps(dividends, nseClient) {
  const uniqueByKey = new Map();
  for (const item of dividends) {
    const key = cmpLookupKey(item);
    if (!uniqueByKey.has(key)) uniqueByKey.set(key, item);
  }

  const unique = [...uniqueByKey.values()];
  const yahooPrices = await fetchYahooQuotes(unique.map(yahooTicker));
  const cmpByKey = new Map();
  const missing = [];

  for (const item of unique) {
    const yahooPrice = yahooPrices.get(yahooTicker(item)) || 0;
    if (yahooPrice > 0) {
      cmpByKey.set(cmpLookupKey(item), yahooPrice);
      continue;
    }
    missing.push(item);
  }

  if (missing.length) {
    console.log(`CMP fallback for ${missing.length} symbol(s)`);
    await runInBatches(missing, PARALLEL.cmpFallback, async (item) => {
      cmpByKey.set(cmpLookupKey(item), await getCmp(item, nseClient));
    });
  }

  return cmpByKey;
}

function collapseAlerts(items) {
  const byKey = new Map();
  for (const item of items) {
    const subject = String(item.rawSubject || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const key = `${item.exchange}|${String(item.symbol || '').toUpperCase()}|${Number(item.dividend) || 0}|${item.exDate || ''}|${subject}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, item);
      continue;
    }
    const newer = new Date(item.announcedAt || 0).getTime() > new Date(existing.announcedAt || 0).getTime();
    if (newer) byKey.set(key, item);
  }
  return [...byKey.values()];
}

async function fetchDividendAlerts(config) {
  cmpCache.clear();
  const fetchStart = Date.now();

  const { start, end } = announcementWindow(config.lookbackDays);
  console.log(`Fetching dividends: ${formatDate(start, 'dd-mm-yyyy')} → ${formatDate(end, 'dd-mm-yyyy')}`);

  const nseClient = await createNseSession();
  const calEnd = new Date(end);
  calEnd.setDate(calEnd.getDate() + 120);
  const declaredFrom = new Date(end);
  declaredFrom.setDate(declaredFrom.getDate() - BSE_DECLARED_LOOKBACK_DAYS);

  const [calendar, bseRaw, bseDividendAnns] = await Promise.all([
    fetchNseCorporateActions(nseClient, start, calEnd).catch((err) => {
      console.error('NSE dividend calendar failed:', err.message);
      return {};
    }),
    fetchBseCorporateActionsRaw(start, calEnd),
    fetchBseDividendAnnouncementPages(declaredFrom, end).catch((err) => {
      console.error('BSE dividend announcements failed:', err.message);
      return [];
    }),
  ]);

  const nseItems = nseCalendarToDividends(calendar);
  console.log(`NSE dividend CA: ${nseItems.length} row(s)`);
  await fillMissingBseDeclaredDates(bseRaw, end, bseDividendAnns);
  crossFillExchanges(nseItems, bseRaw);
  const allItems = [...nseItems, ...bseRaw];

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
  const unique = collapseAlerts(results);
  console.log(`Fetched ${unique.length} dividend alert(s) in ${elapsed}s`);
  return unique;
}

module.exports = {
  fetchDividendAlerts,
  makeDedupKey,
  announcementWindow,
  parseDividendAmount,
  toIsoDateTime,
};
