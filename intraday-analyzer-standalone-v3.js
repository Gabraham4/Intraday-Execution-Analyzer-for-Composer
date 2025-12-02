#!/usr/bin/env node
/**
 * Intraday Execution Analyzer for Composer - V3
 *
 * IMPROVEMENTS OVER V2:
 * 1. Uses DAILY bars for indicator history + current intraday price for "today"
 *    (Matches how Composer actually calculates indicators)
 * 2. Properly handles weight-specified allocations (not just equal weight)
 * 3. Properly handles filter nodes (select top/bottom N)
 * 4. More accurate signal evaluation that matches real Composer behavior
 *
 * WHY THIS MATTERS:
 * - Composer's indicators (RSI, SMA, etc.) use DAILY closes
 * - But when you click "Run Now", it uses current price as "today's" value
 * - This is why signals can flip within minutes - the "today" portion changes
 *
 * Uses Yahoo Finance (free, no API key, limited to ~60 days intraday + 1 year daily)
 */

const https = require('https');
const readline = require('readline');

// ============================================================================
// CONFIG
// ============================================================================

const CONFIG = {
  TEST_TIMES: ['09:30', '09:45', '10:00', '10:30', '11:00', '12:00'],
  EOD_TIME: '15:45',
  BACKTEST_API: 'https://backtest-api.composer.trade/api/v1',
  FIRESTORE_BASE: 'https://firestore.googleapis.com/v1/projects/leverheads-278521/databases/(default)/documents/symphony',
  MAX_INTRADAY_DAYS: 59,
  MAX_DAILY_DAYS: 365  // For indicator calculation history
};

// ============================================================================
// UTILITIES
// ============================================================================

const rl = () => readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (r, q) => new Promise(res => r.question(q, a => res(a.trim())));
const sleep = ms => new Promise(r => setTimeout(r, ms));

function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 30000 }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse error')); }
      });
    }).on('error', reject).on('timeout', () => reject(new Error('Timeout')));
  });
}

// Normalize Composer ticker format to Yahoo Finance format
// EQUITIES::XLU//USD -> XLU
// CRYPTO::BTC//USD -> BTC-USD (Yahoo uses hyphen)
// BRK/B -> BRK-B (Yahoo uses hyphen for share classes)
// XLU -> XLU (no change)
function normalizeTicker(ticker) {
  if (!ticker) return ticker;

  let normalized = ticker;

  // Handle EQUITIES:: prefix
  if (normalized.startsWith('EQUITIES::')) {
    normalized = normalized.replace('EQUITIES::', '').replace('//USD', '');
  }

  // Handle CRYPTO:: prefix (Yahoo uses SYMBOL-USD format)
  if (normalized.startsWith('CRYPTO::')) {
    normalized = normalized.replace('CRYPTO::', '').replace('//USD', '-USD');
  }

  // Convert share class notation: BRK/B -> BRK-B (Yahoo uses hyphen)
  if (normalized.includes('/') && !normalized.includes('//')) {
    normalized = normalized.replace('/', '-');
  }

  return normalized;
}

async function getOOSDate(id) {
  try {
    const data = await fetch(`${CONFIG.FIRESTORE_BASE}/${id}`);
    const ts = data.fields?.last_semantic_update_at?.timestampValue;
    return ts ? ts.split('T')[0] : null;
  } catch { return null; }
}

async function getSymphony(id) {
  const meta = await fetch(`${CONFIG.BACKTEST_API}/public/symphonies/${id}`);
  const score = await fetch(`${CONFIG.BACKTEST_API}/public/symphonies/${id}/score`);
  return { score, name: meta.name || 'Unknown' };
}

// ============================================================================
// YAHOO FINANCE DATA FETCHING
// ============================================================================

async function getIntradayData(ticker, days) {
  return new Promise((resolve, reject) => {
    const d = Math.min(days, CONFIG.MAX_INTRADAY_DAYS);
    const p1 = Math.floor((Date.now() - d * 86400000) / 1000);
    const p2 = Math.floor(Date.now() / 1000);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?period1=${p1}&period2=${p2}&interval=15m&includePrePost=false`;

    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 15000 }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (j.chart?.result?.[0]) {
            const r = j.chart.result[0];
            const ts = r.timestamp || [];
            const q = r.indicators?.quote?.[0] || {};
            const byDT = {};
            for (let i = 0; i < ts.length; i++) {
              if (!q.close?.[i]) continue;
              const dt = new Date(ts[i] * 1000);
              const d = dt.toISOString().split('T')[0];
              const t = dt.toTimeString().slice(0, 5);
              if (!byDT[d]) byDT[d] = {};
              byDT[d][t] = { open: q.open?.[i], high: q.high?.[i], low: q.low?.[i], close: q.close[i] };
            }
            resolve({ ticker, byDT });
          } else reject(new Error(j.chart?.error?.description || 'No data'));
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function getDailyData(ticker, days) {
  return new Promise((resolve, reject) => {
    const d = Math.min(days, CONFIG.MAX_DAILY_DAYS);
    const p1 = Math.floor((Date.now() - d * 86400000) / 1000);
    const p2 = Math.floor(Date.now() / 1000);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?period1=${p1}&period2=${p2}&interval=1d&includePrePost=false`;

    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 15000 }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (j.chart?.result?.[0]) {
            const r = j.chart.result[0];
            const ts = r.timestamp || [];
            const q = r.indicators?.quote?.[0] || {};
            const byDate = {};
            for (let i = 0; i < ts.length; i++) {
              if (!q.close?.[i]) continue;
              const dt = new Date(ts[i] * 1000);
              const d = dt.toISOString().split('T')[0];
              byDate[d] = {
                open: q.open?.[i],
                high: q.high?.[i],
                low: q.low?.[i],
                close: q.close[i]
              };
            }
            resolve({ ticker, byDate });
          } else reject(new Error(j.chart?.error?.description || 'No data'));
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// ============================================================================
// INDICATORS (using DAILY bars + current intraday as "today")
// ============================================================================

function rsi(prices, w = 14) {
  if (prices.length < w + 1) return null;
  const ch = prices.slice(1).map((p, i) => p - prices[i]).slice(-w);
  let g = 0, l = 0;
  for (const c of ch) { if (c > 0) g += c; else l += Math.abs(c); }
  const ag = g / w, al = l / w;
  return al === 0 ? 100 : 100 - (100 / (1 + ag / al));
}

function cumRet(prices, w) {
  if (prices.length < w) return null;
  const s = prices[prices.length - w], e = prices[prices.length - 1];
  return (e - s) / s;
}

function sma(prices, w) {
  if (prices.length < w) return null;
  return prices.slice(-w).reduce((a, b) => a + b, 0) / w;
}

function ema(prices, w) {
  if (prices.length < 1) return null;
  const k = 2 / (w + 1);
  let e = prices[0];
  for (let i = 1; i < prices.length; i++) e = prices[i] * k + e * (1 - k);
  return e;
}

function currentPrice(prices) {
  if (!prices || prices.length === 0) return null;
  return prices[prices.length - 1];
}

function maxDrawdown(prices, w) {
  if (!prices || prices.length < w) return null;
  const slice = prices.slice(-w);
  let peak = slice[0];
  let maxDD = 0;
  for (const p of slice) {
    if (p > peak) peak = p;
    const dd = (peak - p) / peak;
    if (dd > maxDD) maxDD = dd;
  }
  return -maxDD;
}

function stdDevReturn(prices, w) {
  if (!prices || prices.length < w + 1) return null;
  const slice = prices.slice(-(w + 1));
  const returns = [];
  for (let i = 1; i < slice.length; i++) {
    returns.push((slice[i] - slice[i-1]) / slice[i-1]);
  }
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length;
  return Math.sqrt(variance);
}

function stdDevPrice(prices, w) {
  if (!prices || prices.length < w) return null;
  const slice = prices.slice(-w);
  const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
  const variance = slice.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / slice.length;
  return Math.sqrt(variance);
}

function evalInd(fn, prices, w) {
  if (!prices || prices.length === 0) return null;
  switch (fn) {
    case 'relative-strength-index': return rsi(prices, w);
    case 'cumulative-return': return cumRet(prices, w);
    case 'moving-average-return':
    case 'moving-average-price': return sma(prices, w);
    case 'exponential-moving-average-price': return ema(prices, w);
    case 'current-price': return currentPrice(prices);
    case 'max-drawdown': return maxDrawdown(prices, w);
    case 'standard-deviation-return': return stdDevReturn(prices, w);
    case 'standard-deviation-price': return stdDevPrice(prices, w);
    default: return null;
  }
}

// ============================================================================
// PRICE HISTORY BUILDER (Daily closes + current intraday as "today")
// ============================================================================

/**
 * Builds price history for indicator calculation:
 * - Daily closes up to (but not including) the evaluation date
 * - Plus the current intraday price as "today's" value
 *
 * This matches how Composer actually evaluates indicators when you click "Run Now"
 */
function buildIndicatorPrices(ticker, dailyData, intradayData, evalDate, evalTime) {
  const prices = [];

  // 1. Add daily closes up to (not including) eval date
  if (dailyData[ticker]?.byDate) {
    const dates = Object.keys(dailyData[ticker].byDate).sort();
    for (const d of dates) {
      if (d >= evalDate) break;  // Stop before eval date
      prices.push(dailyData[ticker].byDate[d].close);
    }
  }

  // 2. Add current intraday price as "today's" value
  const currentPrice = getIntradayPrice(ticker, intradayData, evalDate, evalTime);
  if (currentPrice !== null) {
    prices.push(currentPrice);
  }

  return prices.length > 0 ? prices : null;
}

function getIntradayPrice(ticker, intradayData, date, time) {
  const dd = intradayData[ticker]?.byDT?.[date];
  if (!dd) return null;
  const times = Object.keys(dd).sort();
  let best = null;
  for (const t of times) {
    if (t <= time) best = dd[t]?.close;
  }
  return best;
}

// ============================================================================
// SYMPHONY ANALYSIS (with proper weights and filters)
// ============================================================================

function extractTickers(n, t = new Set()) {
  if (!n) return t;
  if (n.step === 'asset' && n.ticker) t.add(n.ticker);
  if (n['lhs-val'] && typeof n['lhs-val'] === 'string' && !n['lhs-val'].match(/^\d/)) t.add(n['lhs-val']);
  if (n['rhs-val'] && typeof n['rhs-val'] === 'string' && !n['rhs-val'].match(/^\d/) && !n['rhs-fixed-value?']) t.add(n['rhs-val']);
  if (n.children) n.children.forEach(c => extractTickers(c, t));
  return t;
}

function evalCond(c, dailyData, intradayData, date, time) {
  const lp = buildIndicatorPrices(c.lv, dailyData, intradayData, date, time);
  const lVal = evalInd(c.lf, lp, c.lw || 14);
  if (lVal === null) return null;

  let rVal;
  if (c.rf) {
    rVal = parseFloat(c.rv);
  } else {
    const rp = buildIndicatorPrices(c.rv, dailyData, intradayData, date, time);
    rVal = evalInd(c.rfn, rp, c.rw || 14);
    if (rVal === null) return null;
  }

  switch (c.cmp) {
    case 'gt': return lVal > rVal;
    case 'gte': return lVal >= rVal;
    case 'lt': return lVal < rVal;
    case 'lte': return lVal <= rVal;
    case 'eq': return Math.abs(lVal - rVal) < 0.0001;
    default: return null;
  }
}

/**
 * Returns array of {ticker, weight} objects
 * Handles: asset, if, filter, group, weight-equal, weight-specified, weight-inverse-vol
 */
function getAssetsWithWeights(node, dailyData, intradayData, date, time, parentWeight = 1.0) {
  if (!node) return [];

  const results = [];

  function walk(n, weight) {
    if (!n) return;

    // Asset node - terminal
    if (n.step === 'asset' && n.ticker) {
      const assetWeight = n.weight ? (n.weight.num / n.weight.den) : 1.0;
      results.push({ ticker: n.ticker, weight: weight * assetWeight });
      return;
    }

    // If node - evaluate condition
    if (n.step === 'if') {
      let cond = null, els = null;
      for (const ch of (n.children || [])) {
        if (ch['is-else-condition?']) els = ch;
        else cond = ch;
      }

      if (cond) {
        const c = {
          lf: cond['lhs-fn'], lv: cond['lhs-val'], lw: cond['lhs-fn-params']?.window || 14,
          cmp: cond.comparator, rv: cond['rhs-val'], rf: cond['rhs-fixed-value?'],
          rfn: cond['rhs-fn'], rw: cond['rhs-fn-params']?.window || 14
        };
        const r = evalCond(c, dailyData, intradayData, date, time);

        if (r === true && cond.children) {
          cond.children.forEach(child => walk(child, weight));
        } else if (r === false && els?.children) {
          els.children.forEach(child => walk(child, weight));
        }
      }
      return;
    }

    // Filter node - select top/bottom N by indicator
    if (n.step === 'filter') {
      const selectFn = n['select-fn'];  // 'top' or 'bottom'
      const selectN = n['select-n'] || 1;
      const sortFn = n['sort-by-fn'];
      const sortWindow = n['sort-by-fn-params']?.window || 14;

      // Evaluate indicator for each child asset
      const candidates = [];
      for (const child of (n.children || [])) {
        if (child.step === 'asset' && child.ticker) {
          const prices = buildIndicatorPrices(child.ticker, dailyData, intradayData, date, time);
          const val = evalInd(sortFn, prices, sortWindow);
          if (val !== null) {
            candidates.push({ ticker: child.ticker, value: val });
          }
        }
      }

      // Sort and select
      if (candidates.length > 0) {
        candidates.sort((a, b) => selectFn === 'top' ? b.value - a.value : a.value - b.value);
        const selected = candidates.slice(0, selectN);
        const childWeight = weight / selected.length;
        for (const s of selected) {
          results.push({ ticker: s.ticker, weight: childWeight });
        }
      }
      return;
    }

    // Weight-equal - distribute equally among children
    if (n.step === 'wt-cash-equal') {
      const children = n.children || [];
      const childWeight = weight / Math.max(children.length, 1);
      children.forEach(child => walk(child, childWeight));
      return;
    }

    // Weight-specified - use specified weights
    if (n.step === 'wt-cash-specified') {
      for (const child of (n.children || [])) {
        const childWeight = child.weight ? (child.weight.num / child.weight.den) : (1 / (n.children?.length || 1));
        walk(child, weight * childWeight);
      }
      return;
    }

    // Weight-inverse-vol - for simplicity, treat as equal (accurate would need vol calculation)
    if (n.step === 'wt-inverse-vol') {
      const children = n.children || [];
      const childWeight = weight / Math.max(children.length, 1);
      children.forEach(child => walk(child, childWeight));
      return;
    }

    // Group or other container - pass through
    if (n.step === 'group' || n.step === 'root') {
      (n.children || []).forEach(child => walk(child, weight));
      return;
    }

    // If-child (when reached directly) - walk its children
    if (n.step === 'if-child') {
      (n.children || []).forEach(child => walk(child, weight));
      return;
    }

    // Unknown node type - try to walk children
    if (n.children) {
      n.children.forEach(child => walk(child, weight));
    }
  }

  walk(node, parentWeight);

  // Consolidate duplicate tickers
  const consolidated = {};
  for (const r of results) {
    if (!consolidated[r.ticker]) consolidated[r.ticker] = 0;
    consolidated[r.ticker] += r.weight;
  }

  return Object.entries(consolidated).map(([ticker, weight]) => ({ ticker, weight }));
}

// For backward compatibility - returns just ticker list
function getAssets(node, dailyData, intradayData, date, time) {
  const withWeights = getAssetsWithWeights(node, dailyData, intradayData, date, time);
  return withWeights.map(x => x.ticker);
}

// ============================================================================
// DATA FETCHING (Parallel with concurrency limit)
// ============================================================================

const CONCURRENCY = 5; // Fetch 5 tickers at once

async function fetchAllData(tickers, intradayDays, dailyDays, quiet = false) {
  const intradayData = {};
  const dailyData = {};
  const errors = { intraday: [], daily: [] };

  // Helper to run with concurrency limit
  async function runWithConcurrency(items, fn) {
    const results = [];
    for (let i = 0; i < items.length; i += CONCURRENCY) {
      const batch = items.slice(i, i + CONCURRENCY);
      const batchResults = await Promise.all(batch.map(fn));
      results.push(...batchResults);
      if (i + CONCURRENCY < items.length) await sleep(100); // Small delay between batches
    }
    return results;
  }

  // Fetch intraday data in parallel
  if (!quiet) console.log(`  Fetching intraday data (${tickers.length} tickers, ${CONCURRENCY} parallel)...`);
  await runWithConcurrency(tickers, async (t) => {
    const normalizedTicker = normalizeTicker(t);
    try {
      intradayData[t] = await getIntradayData(normalizedTicker, intradayDays);
      if (!quiet) process.stdout.write('.');
    } catch (e) {
      errors.intraday.push(t);
    }
  });
  if (!quiet) {
    console.log(` done`);
    if (errors.intraday.length > 0) console.log(`    Skipped: ${errors.intraday.join(', ')}`);
  }

  // Fetch daily data in parallel
  if (!quiet) console.log(`  Fetching daily data (${tickers.length} tickers, ${CONCURRENCY} parallel)...`);
  await runWithConcurrency(tickers, async (t) => {
    const normalizedTicker = normalizeTicker(t);
    try {
      dailyData[t] = await getDailyData(normalizedTicker, dailyDays);
      if (!quiet) process.stdout.write('.');
    } catch (e) {
      errors.daily.push(t);
    }
  });
  if (!quiet) {
    console.log(` done`);
    if (errors.daily.length > 0) console.log(`    Skipped: ${errors.daily.join(', ')}`);
  }

  return { intradayData, dailyData };
}

function getTradingDays(intradayData) {
  const dates = new Set();
  for (const t of Object.keys(intradayData)) {
    for (const d of Object.keys(intradayData[t].byDT || {})) {
      dates.add(d);
    }
  }
  return Array.from(dates).sort();
}

// ============================================================================
// BACKTESTS (V3 - using proper indicator calculation and weights)
// ============================================================================

function runDualTimeBacktest(score, dailyData, intradayData, tradingDays, morningTime) {
  let equity = 100;
  const equityCurve = [100];
  let peak = 100;
  let maxDD = 0;
  let holdings = [];  // Array of {ticker, weight}

  for (let i = 0; i < tradingDays.length; i++) {
    const date = tradingDays[i];
    const prevDate = i > 0 ? tradingDays[i - 1] : null;

    const morningSelection = getAssetsWithWeights(score, dailyData, intradayData, date, morningTime);
    const eodSelection = getAssetsWithWeights(score, dailyData, intradayData, date, CONFIG.EOD_TIME);

    // LEG 1: Overnight - prev EOD holdings held until morning
    if (prevDate && holdings.length > 0) {
      let overnightReturn = 0;
      let totalWeight = 0;
      for (const h of holdings) {
        const prevEOD = getIntradayPrice(h.ticker, intradayData, prevDate, CONFIG.EOD_TIME);
        const morning = getIntradayPrice(h.ticker, intradayData, date, morningTime);
        if (prevEOD && morning) {
          overnightReturn += h.weight * (morning - prevEOD) / prevEOD;
          totalWeight += h.weight;
        }
      }
      if (totalWeight > 0) {
        equity *= (1 + overnightReturn);
      }
    }

    // Morning rebalance
    if (morningSelection.length > 0) {
      holdings = morningSelection;
    }

    // LEG 2: Intraday - morning holdings held until EOD
    if (holdings.length > 0) {
      let intradayReturn = 0;
      let totalWeight = 0;
      for (const h of holdings) {
        const morning = getIntradayPrice(h.ticker, intradayData, date, morningTime);
        const eod = getIntradayPrice(h.ticker, intradayData, date, CONFIG.EOD_TIME);
        if (morning && eod) {
          intradayReturn += h.weight * (eod - morning) / morning;
          totalWeight += h.weight;
        }
      }
      if (totalWeight > 0) {
        equity *= (1 + intradayReturn);
      }
    }

    // EOD rebalance
    if (eodSelection.length > 0) {
      holdings = eodSelection;
    }

    equityCurve.push(equity);
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak * 100;
    if (dd > maxDD) maxDD = dd;
  }

  return {
    cumReturn: equity - 100,
    maxDD,
    tradingDays: tradingDays.length,
    equityCurve
  };
}

function runEODOnlyBacktest(score, dailyData, intradayData, tradingDays) {
  let equity = 100;
  const equityCurve = [100];
  let peak = 100;
  let maxDD = 0;
  let holdings = [];

  for (let i = 0; i < tradingDays.length; i++) {
    const date = tradingDays[i];
    const prevDate = i > 0 ? tradingDays[i - 1] : null;

    const selection = getAssetsWithWeights(score, dailyData, intradayData, date, CONFIG.EOD_TIME);

    if (prevDate && holdings.length > 0) {
      let dayReturn = 0;
      let totalWeight = 0;
      for (const h of holdings) {
        const prevEOD = getIntradayPrice(h.ticker, intradayData, prevDate, CONFIG.EOD_TIME);
        const currEOD = getIntradayPrice(h.ticker, intradayData, date, CONFIG.EOD_TIME);
        if (prevEOD && currEOD) {
          dayReturn += h.weight * (currEOD - prevEOD) / prevEOD;
          totalWeight += h.weight;
        }
      }
      if (totalWeight > 0) {
        equity *= (1 + dayReturn);
      }
    }

    equityCurve.push(equity);
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak * 100;
    if (dd > maxDD) maxDD = dd;

    if (selection.length > 0) holdings = selection;
  }

  return {
    cumReturn: equity - 100,
    maxDD,
    tradingDays: tradingDays.length,
    equityCurve
  };
}

function runSingleTimeBacktest(score, dailyData, intradayData, tradingDays, tradeTime) {
  let equity = 100;
  const equityCurve = [100];
  let peak = 100;
  let maxDD = 0;
  let holdings = [];

  for (let i = 0; i < tradingDays.length; i++) {
    const date = tradingDays[i];
    const prevDate = i > 0 ? tradingDays[i - 1] : null;

    const selection = getAssetsWithWeights(score, dailyData, intradayData, date, tradeTime);

    if (prevDate && holdings.length > 0) {
      let dayReturn = 0;
      let totalWeight = 0;
      for (const h of holdings) {
        const prevPrice = getIntradayPrice(h.ticker, intradayData, prevDate, tradeTime);
        const currPrice = getIntradayPrice(h.ticker, intradayData, date, tradeTime);
        if (prevPrice && currPrice) {
          dayReturn += h.weight * (currPrice - prevPrice) / prevPrice;
          totalWeight += h.weight;
        }
      }
      if (totalWeight > 0) {
        equity *= (1 + dayReturn);
      }
    }

    equityCurve.push(equity);
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak * 100;
    if (dd > maxDD) maxDD = dd;

    if (selection.length > 0) holdings = selection;
  }

  return {
    cumReturn: equity - 100,
    maxDD,
    tradingDays: tradingDays.length,
    equityCurve
  };
}

// ============================================================================
// ANALYSIS FUNCTIONS
// ============================================================================

async function dualTimeAnalysis(ids, intradayDays, quiet = false) {
  const results = [];
  const dailyDays = Math.max(intradayDays + 60, 180);  // Need extra daily history for indicators

  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (!quiet) console.log(`\n[${i + 1}/${ids.length}] Analyzing ${id}...`);

    try {
      const { score, name } = await getSymphony(id);
      if (!quiet) console.log(`  Name: ${name}`);

      const tickers = Array.from(extractTickers(score));
      if (!quiet) console.log(`  Tickers: ${tickers.join(', ')}`);

      const { intradayData, dailyData } = await fetchAllData(tickers, intradayDays, dailyDays, quiet);

      if (Object.keys(intradayData).length === 0) {
        results.push({ id, name, error: 'No intraday data available' });
        continue;
      }

      const tradingDays = getTradingDays(intradayData);
      if (tradingDays.length < 5) {
        results.push({ id, name, error: 'Not enough trading days' });
        continue;
      }

      if (!quiet) console.log(`  Trading days: ${tradingDays.length} (${tradingDays[0]} to ${tradingDays[tradingDays.length-1]})`);

      const eodResult = runEODOnlyBacktest(score, dailyData, intradayData, tradingDays);

      const timeResults = {};
      let bestTime = null;
      let bestImprovement = -Infinity;

      for (const time of CONFIG.TEST_TIMES) {
        const dualResult = runDualTimeBacktest(score, dailyData, intradayData, tradingDays, time);
        const improvement = dualResult.cumReturn - eodResult.cumReturn;

        timeResults[time] = {
          cumReturn: dualResult.cumReturn,
          maxDD: dualResult.maxDD,
          improvement
        };

        if (improvement > bestImprovement) {
          bestImprovement = improvement;
          bestTime = time;
        }
      }

      results.push({
        id,
        name,
        tradingDays: eodResult.tradingDays,
        dateRange: `${tradingDays[0]} to ${tradingDays[tradingDays.length-1]}`,
        eod: {
          cumReturn: eodResult.cumReturn,
          maxDD: eodResult.maxDD
        },
        times: timeResults,
        bestTime,
        bestImprovement,
        recommendation: bestImprovement > 5 ? 'ADD_MORNING' :
                       bestImprovement < -5 ? 'STICK_EOD' : 'MARGINAL'
      });

    } catch (e) {
      results.push({ id, name: 'Error', error: e.message });
    }
  }

  return results;
}

async function singleTimeAnalysis(ids, intradayDays, quiet = false) {
  const results = [];
  const dailyDays = Math.max(intradayDays + 60, 180);

  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (!quiet) console.log(`\n[${i + 1}/${ids.length}] Analyzing ${id}...`);

    try {
      const { score, name } = await getSymphony(id);
      if (!quiet) console.log(`  Name: ${name}`);

      const tickers = Array.from(extractTickers(score));
      if (!quiet) console.log(`  Tickers: ${tickers.join(', ')}`);

      const { intradayData, dailyData } = await fetchAllData(tickers, intradayDays, dailyDays, quiet);

      if (Object.keys(intradayData).length === 0) {
        results.push({ id, name, error: 'No intraday data available' });
        continue;
      }

      const tradingDays = getTradingDays(intradayData);
      if (tradingDays.length < 5) {
        results.push({ id, name, error: 'Not enough trading days' });
        continue;
      }

      if (!quiet) console.log(`  Trading days: ${tradingDays.length} (${tradingDays[0]} to ${tradingDays[tradingDays.length-1]})`);

      const eodResult = runSingleTimeBacktest(score, dailyData, intradayData, tradingDays, CONFIG.EOD_TIME);

      const timeResults = {};
      let bestTime = CONFIG.EOD_TIME;
      let bestReturn = eodResult.cumReturn;

      for (const time of CONFIG.TEST_TIMES) {
        const result = runSingleTimeBacktest(score, dailyData, intradayData, tradingDays, time);
        const improvement = result.cumReturn - eodResult.cumReturn;

        timeResults[time] = {
          cumReturn: result.cumReturn,
          maxDD: result.maxDD,
          improvement
        };

        if (result.cumReturn > bestReturn) {
          bestReturn = result.cumReturn;
          bestTime = time;
        }
      }

      const bestImprovement = bestReturn - eodResult.cumReturn;

      results.push({
        id,
        name,
        tradingDays: eodResult.tradingDays,
        dateRange: `${tradingDays[0]} to ${tradingDays[tradingDays.length-1]}`,
        eod: {
          cumReturn: eodResult.cumReturn,
          maxDD: eodResult.maxDD
        },
        times: timeResults,
        bestTime,
        bestImprovement,
        recommendation: bestTime !== CONFIG.EOD_TIME && bestImprovement > 5 ? 'USE_MORNING' : 'KEEP_EOD'
      });

    } catch (e) {
      results.push({ id, name: 'Error', error: e.message });
    }
  }

  return results;
}

// ============================================================================
// OUTPUT FORMATTING
// ============================================================================

function printDualTimeResults(results) {
  console.log(`\n${'═'.repeat(100)}`);
  console.log('  DUAL TRADE TIME ANALYSIS RESULTS (V3 - Daily Indicators + Intraday Execution)');
  console.log('  Question: "If I trade at BOTH morning AND 3:45pm, what is my cumulative return?"');
  console.log(`${'═'.repeat(100)}\n`);

  for (const r of results) {
    if (r.error) {
      console.log(`${r.name || r.id}: ERROR - ${r.error}\n`);
      continue;
    }

    console.log(`${'─'.repeat(100)}`);
    console.log(`STRATEGY: ${r.name}`);
    console.log(`ID: ${r.id}`);
    console.log(`Trading Days: ${r.tradingDays} | Date Range: ${r.dateRange}`);
    console.log(`${'─'.repeat(100)}`);

    console.log(`\n  EOD-ONLY (3:45pm only):  Return: ${r.eod.cumReturn >= 0 ? '+' : ''}${r.eod.cumReturn.toFixed(1)}%  |  Max DD: ${r.eod.maxDD.toFixed(1)}%\n`);

    console.log('  DUAL-TIME RESULTS (Morning + 3:45pm):');
    console.log('  ┌─────────┬─────────────────┬─────────────────┬─────────────────┐');
    console.log('  │  Time   │  Cum Return     │  Max Drawdown   │  vs EOD-Only    │');
    console.log('  ├─────────┼─────────────────┼─────────────────┼─────────────────┤');

    for (const time of CONFIG.TEST_TIMES) {
      const t = r.times[time];
      const ret = `${t.cumReturn >= 0 ? '+' : ''}${t.cumReturn.toFixed(1)}%`;
      const dd = `${t.maxDD.toFixed(1)}%`;
      const imp = `${t.improvement >= 0 ? '+' : ''}${t.improvement.toFixed(1)}%`;
      const marker = time === r.bestTime ? ' <-- BEST' : '';
      console.log(`  │  ${time}  │  ${ret.padStart(12)}  │  ${dd.padStart(12)}  │  ${imp.padStart(12)}  │${marker}`);
    }

    console.log('  └─────────┴─────────────────┴─────────────────┴─────────────────┘\n');

    if (r.recommendation === 'ADD_MORNING') {
      console.log(`  RECOMMENDATION: Consider adding "Run Now" at ${r.bestTime} (+${r.bestImprovement.toFixed(1)}% improvement)`);
    } else if (r.recommendation === 'STICK_EOD') {
      console.log(`  RECOMMENDATION: Stick with EOD-only - dual-time shows worse results`);
    } else {
      console.log(`  RECOMMENDATION: Marginal difference - EOD-only is simpler`);
    }
    console.log('');
  }

  // Summary
  if (results.filter(r => !r.error).length > 1) {
    console.log(`\n${'═'.repeat(100)}`);
    console.log('  SUMMARY');
    console.log(`${'═'.repeat(100)}\n`);

    console.log('  ┌────────────────────────────────────────┬───────┬───────────┬───────────┬─────────────┐');
    console.log('  │ Strategy                               │ Days  │ EOD-Only  │ Best Dual │ Improvement │');
    console.log('  ├────────────────────────────────────────┼───────┼───────────┼───────────┼─────────────┤');

    for (const r of results) {
      if (r.error) continue;
      const name = r.name.length > 38 ? r.name.substring(0, 35) + '...' : r.name;
      const eod = `${r.eod.cumReturn >= 0 ? '+' : ''}${r.eod.cumReturn.toFixed(0)}%`;
      const best = `${r.times[r.bestTime].cumReturn >= 0 ? '+' : ''}${r.times[r.bestTime].cumReturn.toFixed(0)}%`;
      const imp = `${r.bestImprovement >= 0 ? '+' : ''}${r.bestImprovement.toFixed(0)}%`;
      console.log(`  │ ${name.padEnd(38)} │ ${String(r.tradingDays).padStart(5)} │ ${eod.padStart(9)} │ ${best.padStart(9)} │ ${imp.padStart(11)} │`);
    }

    console.log('  └────────────────────────────────────────┴───────┴───────────┴───────────┴─────────────┘\n');

    const addMorning = results.filter(r => r.recommendation === 'ADD_MORNING').length;
    const stickEOD = results.filter(r => r.recommendation === 'STICK_EOD').length;
    const marginal = results.filter(r => r.recommendation === 'MARGINAL').length;

    console.log(`  Total: ${addMorning} should ADD MORNING | ${stickEOD} should STICK WITH EOD | ${marginal} MARGINAL\n`);
  }
}

function printSingleTimeResults(results) {
  console.log(`\n${'═'.repeat(100)}`);
  console.log('  SINGLE TIME REPLACEMENT ANALYSIS RESULTS (V3 - Daily Indicators + Intraday Execution)');
  console.log('  Question: "If I REPLACE 3:45pm with a morning trade, would I do better?"');
  console.log(`${'═'.repeat(100)}\n`);

  for (const r of results) {
    if (r.error) {
      console.log(`${r.name || r.id}: ERROR - ${r.error}\n`);
      continue;
    }

    console.log(`${'─'.repeat(100)}`);
    console.log(`STRATEGY: ${r.name}`);
    console.log(`ID: ${r.id}`);
    console.log(`Trading Days: ${r.tradingDays} | Date Range: ${r.dateRange}`);
    console.log(`${'─'.repeat(100)}`);

    console.log(`\n  DEFAULT EOD (3:45pm):  Return: ${r.eod.cumReturn >= 0 ? '+' : ''}${r.eod.cumReturn.toFixed(1)}%  |  Max DD: ${r.eod.maxDD.toFixed(1)}%\n`);

    console.log('  ALTERNATIVE TIMES (Instead of 3:45pm):');
    console.log('  ┌─────────┬─────────────────┬─────────────────┬─────────────────┐');
    console.log('  │  Time   │  Cum Return     │  Max Drawdown   │  vs 3:45pm      │');
    console.log('  ├─────────┼─────────────────┼─────────────────┼─────────────────┤');

    for (const time of CONFIG.TEST_TIMES) {
      const t = r.times[time];
      const ret = `${t.cumReturn >= 0 ? '+' : ''}${t.cumReturn.toFixed(1)}%`;
      const dd = `${t.maxDD.toFixed(1)}%`;
      const imp = `${t.improvement >= 0 ? '+' : ''}${t.improvement.toFixed(1)}%`;
      const marker = time === r.bestTime && r.bestTime !== CONFIG.EOD_TIME ? ' <-- BEST' : '';
      console.log(`  │  ${time}  │  ${ret.padStart(12)}  │  ${dd.padStart(12)}  │  ${imp.padStart(12)}  │${marker}`);
    }

    console.log('  └─────────┴─────────────────┴─────────────────┴─────────────────┘\n');

    if (r.recommendation === 'USE_MORNING') {
      console.log(`  RECOMMENDATION: Consider switching to ${r.bestTime} (+${r.bestImprovement.toFixed(1)}% vs EOD)`);
    } else {
      console.log(`  RECOMMENDATION: Keep default 3:45pm EOD execution`);
    }
    console.log('');
  }

  if (results.filter(r => !r.error).length > 1) {
    console.log(`\n${'═'.repeat(100)}`);
    console.log('  SUMMARY');
    console.log(`${'═'.repeat(100)}\n`);

    const useMorning = results.filter(r => r.recommendation === 'USE_MORNING').length;
    const keepEOD = results.filter(r => r.recommendation === 'KEEP_EOD').length;

    console.log(`  Total: ${useMorning} could benefit from morning time | ${keepEOD} should keep EOD\n`);
  }
}

// ============================================================================
// SUB-ANALYSIS
// ============================================================================

async function flipAnalysis(id, intradayDays) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log('  SIGNAL FLIP FREQUENCY ANALYSIS (V3)');
  console.log(`${'═'.repeat(60)}\n`);

  console.log(`Fetching symphony ${id}...`);
  const { score, name } = await getSymphony(id);
  console.log(`Name: ${name}\n`);

  const tickers = Array.from(extractTickers(score));
  const dailyDays = Math.max(intradayDays + 60, 180);
  const { intradayData, dailyData } = await fetchAllData(tickers, intradayDays, dailyDays);
  const tradingDays = getTradingDays(intradayData);

  console.log(`\nAnalyzing ${tradingDays.length} trading days...\n`);
  console.log('  ┌─────────┬─────────┬─────────┬─────────────┐');
  console.log('  │  Time   │  Valid  │  Flips  │  Flip Rate  │');
  console.log('  ├─────────┼─────────┼─────────┼─────────────┤');

  for (const tt of CONFIG.TEST_TIMES) {
    let flips = 0, valid = 0;
    for (const date of tradingDays) {
      const early = getAssets(score, dailyData, intradayData, date, tt);
      const eod = getAssets(score, dailyData, intradayData, date, CONFIG.EOD_TIME);
      if (early.length === 0 || eod.length === 0) continue;
      valid++;
      if (JSON.stringify(early.sort()) !== JSON.stringify(eod.sort())) flips++;
    }
    const rate = valid > 0 ? (flips / valid * 100).toFixed(0) + '%' : 'N/A';
    console.log(`  │  ${tt}  │  ${String(valid).padStart(5)}  │  ${String(flips).padStart(5)}  │  ${rate.padStart(9)}  │`);
  }
  console.log('  └─────────┴─────────┴─────────┴─────────────┘\n');
}

async function dailyCheck(id) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log('  DAILY SIGNAL CHECK (V3)');
  console.log(`${'═'.repeat(60)}\n`);

  console.log(`Fetching symphony ${id}...`);
  const { score, name } = await getSymphony(id);
  console.log(`Name: ${name}\n`);

  const tickers = Array.from(extractTickers(score));
  const { intradayData, dailyData } = await fetchAllData(tickers, 5, 180);

  const dates = getTradingDays(intradayData);
  const latestDate = dates[dates.length - 1] || new Date().toISOString().split('T')[0];

  console.log(`Signals for ${latestDate}:\n`);

  let prevAssets = null;
  for (const tt of [...CONFIG.TEST_TIMES, CONFIG.EOD_TIME]) {
    const assetsWithWeights = getAssetsWithWeights(score, dailyData, intradayData, latestDate, tt);
    const assetStr = assetsWithWeights.length > 0
      ? assetsWithWeights.map(a => `${a.ticker}(${(a.weight*100).toFixed(0)}%)`).join(', ')
      : '(no signal)';
    const assetTickers = assetsWithWeights.map(a => a.ticker).sort();
    const changed = prevAssets && JSON.stringify(assetTickers) !== JSON.stringify(prevAssets);
    const marker = changed ? ' <-- CHANGED' : '';
    console.log(`  ${tt}: ${assetStr}${marker}`);
    prevAssets = assetTickers;
  }
  console.log('');
}

// ============================================================================
// DATE RANGE HELPER
// ============================================================================

async function askDateRange(r, symphonyId) {
  console.log('\nFetching OOS date...');
  const oos = await getOOSDate(symphonyId);

  let oosDays = null;
  if (oos) {
    oosDays = Math.floor((Date.now() - new Date(oos).getTime()) / 86400000);
    console.log(`  OOS Date: ${oos} (${oosDays} days ago)`);
  } else {
    console.log('  OOS date not available');
  }

  console.log(`
Date Range Options (Yahoo Finance - intraday limited to ~60 days):
  1. Maximum available (${CONFIG.MAX_INTRADAY_DAYS} days / ~40 trading days)
  2. Last 30 days (~20 trading days)
  3. Last 14 days (~10 trading days)${oosDays && oosDays <= CONFIG.MAX_INTRADAY_DAYS ? `
  4. From OOS date (${oosDays} days)` : ''}
  5. Custom number of days
`);

  const choice = await ask(r, 'Select [1]: ');

  switch (choice) {
    case '2': return 30;
    case '3': return 14;
    case '4':
      if (oosDays && oosDays <= CONFIG.MAX_INTRADAY_DAYS) return oosDays;
      console.log('OOS date too old, using max');
      return CONFIG.MAX_INTRADAY_DAYS;
    case '5':
      const custom = await ask(r, `Enter days (max ${CONFIG.MAX_INTRADAY_DAYS}): `);
      const d = parseInt(custom);
      if (d && d > 0) return Math.min(d, CONFIG.MAX_INTRADAY_DAYS);
      return 30;
    case '1':
    default:
      return CONFIG.MAX_INTRADAY_DAYS;
  }
}

// ============================================================================
// MENU
// ============================================================================

async function menu() {
  const r = rl();

  console.log(`
${'═'.repeat(70)}

     ██╗███╗   ██╗████████╗██████╗  █████╗ ██████╗  █████╗ ██╗   ██╗
     ██║████╗  ██║╚══██╔══╝██╔══██╗██╔══██╗██╔══██╗██╔══██╗╚██╗ ██╔╝
     ██║██╔██╗ ██║   ██║   ██████╔╝███████║██║  ██║███████║ ╚████╔╝
     ██║██║╚██╗██║   ██║   ██╔══██╗██╔══██║██║  ██║██╔══██║  ╚██╔╝
     ██║██║ ╚████║   ██║   ██║  ██║██║  ██║██████╔╝██║  ██║   ██║
     ╚═╝╚═╝  ╚═══╝   ╚═╝   ╚═╝  ╚═╝╚═╝  ╚═╝╚═════╝ ╚═╝  ╚═╝   ╚═╝

     INTRADAY EXECUTION ANALYZER FOR COMPOSER  v3.0

     IMPROVEMENTS IN V3:
     • Daily bars for indicator calculation (matches Composer)
     • Current intraday price as "today's" value
     • Proper weight-specified handling
     • Proper filter node handling

${'═'.repeat(70)}
`);

  let running = true;
  while (running) {
    console.log(`
${'─'.repeat(70)}
  MAIN ANALYSIS OPTIONS:
${'─'.repeat(70)}

  1. DUAL TRADE TIME ANALYSIS
     "Should I trade at BOTH morning AND 3:45pm?"
     Simulates using "Run Now" in morning + letting Composer auto-trade EOD.

  2. SINGLE TIME REPLACEMENT ANALYSIS
     "Should I REPLACE 3:45pm with a different time?"
     Simulates trading ONLY at a different time, skipping EOD entirely.

${'─'.repeat(70)}
  SIGNAL SUB-ANALYSIS:
${'─'.repeat(70)}

  3. Signal Flip Frequency  - How often do signals differ morning vs EOD?
  4. Daily Signal Check     - What would be selected at each time TODAY?

${'─'.repeat(70)}
  q. Quit
`);

    const choice = await ask(r, 'Select: ');

    try {
      switch (choice) {
        case '1': {
          console.log('\nDUAL TRADE TIME ANALYSIS');
          console.log('Enter symphony ID(s). For multiple, separate with commas or spaces.\n');
          const input = await ask(r, 'Symphony ID(s): ');
          const ids = input.split(/[,\s]+/).filter(Boolean);

          if (ids.length === 0) break;

          const days = await askDateRange(r, ids[0]);
          const results = await dualTimeAnalysis(ids, days);
          printDualTimeResults(results);
          break;
        }

        case '2': {
          console.log('\nSINGLE TIME REPLACEMENT ANALYSIS');
          console.log('Enter symphony ID(s). For multiple, separate with commas or spaces.\n');
          const input = await ask(r, 'Symphony ID(s): ');
          const ids = input.split(/[,\s]+/).filter(Boolean);

          if (ids.length === 0) break;

          const days = await askDateRange(r, ids[0]);
          const results = await singleTimeAnalysis(ids, days);
          printSingleTimeResults(results);
          break;
        }

        case '3': {
          const id = await ask(r, 'Symphony ID: ');
          if (id) {
            const days = await askDateRange(r, id);
            await flipAnalysis(id, days);
          }
          break;
        }

        case '4': {
          const id = await ask(r, 'Symphony ID: ');
          if (id) await dailyCheck(id);
          break;
        }

        case 'q':
        case '':
          running = false;
          console.log('\nGoodbye!\n');
          break;

        default:
          console.log('Unknown option');
      }
    } catch (e) {
      console.log(`Error: ${e.message}`);
    }

    if (running && choice && !['q', ''].includes(choice)) {
      await ask(r, '\nPress Enter to continue...');
    }
  }

  r.close();
}

// ============================================================================
// CLI
// ============================================================================

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    await menu();
    return;
  }

  const cmd = args[0].toLowerCase();
  const ids = args.slice(1).filter(a => !a.startsWith('-'));

  try {
    switch (cmd) {
      case 'dual':
        if (ids.length === 0) {
          console.log('Usage: node script.js dual <symphony_id> [id2] [id3]...');
          return;
        }
        const dualResults = await dualTimeAnalysis(ids, CONFIG.MAX_INTRADAY_DAYS);
        printDualTimeResults(dualResults);
        break;

      case 'single':
        if (ids.length === 0) {
          console.log('Usage: node script.js single <symphony_id> [id2] [id3]...');
          return;
        }
        const singleResults = await singleTimeAnalysis(ids, CONFIG.MAX_INTRADAY_DAYS);
        printSingleTimeResults(singleResults);
        break;

      case 'flip':
        if (ids.length === 0) {
          console.log('Usage: node script.js flip <symphony_id>');
          return;
        }
        await flipAnalysis(ids[0], CONFIG.MAX_INTRADAY_DAYS);
        break;

      case 'check':
        if (ids.length === 0) {
          console.log('Usage: node script.js check <symphony_id>');
          return;
        }
        await dailyCheck(ids[0]);
        break;

      case 'help':
      case '-h':
      case '--help':
        console.log(`
Intraday Execution Analyzer for Composer v3.0

V3 IMPROVEMENTS:
  • Uses DAILY bars for indicator history (matches Composer)
  • Uses current intraday price as "today's" value in indicators
  • Properly handles weight-specified allocations
  • Properly handles filter nodes (select top/bottom N)

Usage:
  node script.js                       Interactive menu
  node script.js dual <id> [id2]...    Dual trade time analysis (morning + EOD)
  node script.js single <id> [id2]...  Single time replacement analysis
  node script.js flip <id>             Signal flip frequency
  node script.js check <id>            Today's signal check

Analysis Types:
  DUAL:   "Should I trade at BOTH morning AND 3:45pm?"
  SINGLE: "Should I REPLACE 3:45pm with a different time?"
`);
        break;

      default:
        await menu();
    }
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}

main();
