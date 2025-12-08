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
  TEST_TIMES: ['09:30', '09:45', '10:00', '10:30', '11:00', '12:00', '13:45'],
  EOD_TIME: '15:45',
  EOD_TIME_OPTIONS: ['15:45', '15:50', '15:55', '16:00'],
  INTRADAY_INTERVAL: '5m',  // 5-minute bars to support 15:50, 15:55 options
  BACKTEST_API: 'https://backtest-api.composer.trade/api/v1',
  FIRESTORE_BASE: 'https://firestore.googleapis.com/v1/projects/leverheads-278521/databases/(default)/documents/symphony',
  MAX_INTRADAY_DAYS: 59,
  MAX_DAILY_DAYS: 730,  // 2 years needed for Wilder RSI to stabilize properly
};

// ============================================================================
// DIAGNOSTICS - Track data issues for error reporting
// ============================================================================

let DIAGNOSTICS = {
  failedTickers: {},      // {ticker: {intraday: 'error msg', daily: 'error msg'}}
  nullConditions: [],     // [{condition: 'description', reason: 'why null', ticker: 'which ticker'}]
  reset() {
    this.failedTickers = {};
    this.nullConditions = [];
  }
};

// Memoization cache for getAssetsWithWeights - dramatically speeds up complex strategies
// Key: nodeId_date_time -> Value: array of {ticker, weight}
let MEMO_CACHE = new Map();
function clearMemoCache() {
  MEMO_CACHE.clear();
}

function recordTickerError(ticker, type, error) {
  if (!DIAGNOSTICS.failedTickers[ticker]) {
    DIAGNOSTICS.failedTickers[ticker] = {};
  }
  DIAGNOSTICS.failedTickers[ticker][type] = error;
}

function recordNullCondition(condition, reason, ticker) {
  // Only keep first 10 to avoid spam
  if (DIAGNOSTICS.nullConditions.length < 10) {
    DIAGNOSTICS.nullConditions.push({ condition, reason, ticker });
  }
}

function printDiagnostics() {
  const failedCount = Object.keys(DIAGNOSTICS.failedTickers).length;
  const nullCount = DIAGNOSTICS.nullConditions.length;

  if (failedCount === 0 && nullCount === 0) return;

  console.log(`\n${'─'.repeat(80)}`);
  console.log('  DATA DIAGNOSTICS - Why some signals may be missing');
  console.log(`${'─'.repeat(80)}`);

  if (failedCount > 0) {
    console.log('\n  FAILED TICKER LOADS (Yahoo Finance):');
    for (const [ticker, errors] of Object.entries(DIAGNOSTICS.failedTickers)) {
      if (errors.intraday) {
        console.log(`    ✗ ${ticker} (intraday): ${errors.intraday}`);
      }
      if (errors.daily) {
        console.log(`    ✗ ${ticker} (daily): ${errors.daily}`);
      }
    }
  }

  if (nullCount > 0) {
    console.log('\n  CONDITIONS RETURNED NULL (missing data):');
    for (const nc of DIAGNOSTICS.nullConditions) {
      console.log(`    ✗ ${nc.condition}`);
      console.log(`      Reason: ${nc.reason}`);
    }
    if (DIAGNOSTICS.nullConditions.length >= 10) {
      console.log('    ... (showing first 10 only)');
    }
  }

  console.log(`\n  TIP: If a key ticker is missing, the strategy may not generate signals.`);
  console.log(`       Consider using Twelve Data script for better coverage.\n`);
}

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
    // Using 5-minute bars to support EOD times: 15:45, 15:50, 15:55
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?period1=${p1}&period2=${p2}&interval=${CONFIG.INTRADAY_INTERVAL}&includePrePost=false`;

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
    // IMPORTANT: includeAdjustedClose=true to get dividend-adjusted prices
    // This is critical for ETFs like BIL that pay monthly dividends
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?period1=${p1}&period2=${p2}&interval=1d&includePrePost=false&includeAdjustedClose=true`;

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
            // Use adjusted close for indicators (handles dividends/splits correctly)
            const adjclose = r.indicators?.adjclose?.[0]?.adjclose || [];
            const byDate = {};
            for (let i = 0; i < ts.length; i++) {
              // Prefer adjusted close, fall back to regular close
              const closePrice = adjclose[i] || q.close?.[i];
              if (!closePrice) continue;
              const dt = new Date(ts[i] * 1000);
              const d = dt.toISOString().split('T')[0];
              byDate[d] = {
                open: q.open?.[i],
                high: q.high?.[i],
                low: q.low?.[i],
                close: closePrice  // Using adjusted close for accurate RSI/MAR calculations
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

// WILDER'S RSI - DO NOT CHANGE - See RSI_CALCULATION_METHOD.md
// Confirmed: https://www.composer.trade/learn/what-is-relative-strength-index-rsi
function rsi(prices, w = 14) {
  if (prices.length < w + 1) return null;

  // Calculate all price changes
  const changes = [];
  for (let i = 1; i < prices.length; i++) {
    changes.push(prices[i] - prices[i-1]);
  }

  // First average: simple average of first w changes
  let avgGain = 0, avgLoss = 0;
  for (let i = 0; i < w; i++) {
    if (changes[i] > 0) avgGain += changes[i];
    else avgLoss += Math.abs(changes[i]);
  }
  avgGain /= w;
  avgLoss /= w;

  // Subsequent averages: Wilder's smoothing
  // Formula: newAvg = ((prevAvg * (w-1)) + currentValue) / w
  for (let i = w; i < changes.length; i++) {
    const change = changes[i];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;

    avgGain = ((avgGain * (w - 1)) + gain) / w;
    avgLoss = ((avgLoss * (w - 1)) + loss) / w;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function cumRet(prices, w) {
  // Cumulative return: (price_today / price_w_bars_ago) - 1
  // Uses lookback = w (same as movingAverageReturn)
  if (prices.length < w + 1) return null;
  const s = prices[prices.length - 1 - w], e = prices[prices.length - 1];
  return (e - s) / s;
}

function sma(prices, w) {
  if (prices.length < w) return null;
  return prices.slice(-w).reduce((a, b) => a + b, 0) / w;
}

function movingAverageReturn(prices, w) {
  // VERIFIED: Composer uses "arithmetic mean of daily returns"
  //
  // Empirical test (2025-12-08):
  //   Symphony: IF MAR(LABU, 5) > 0 THEN TQQQ ELSE SQQQ
  //   Cumulative formula: -0.10% → FALSE → SQQQ
  //   Avg daily formula:  +0.14% → TRUE  → TQQQ
  //   Composer showed: TQQQ ✓
  //
  // Formula: sum(daily_returns) / window
  // where daily_return[i] = (price[i] - price[i-1]) / price[i-1]

  if (prices.length < w + 1) return null;

  let sumReturns = 0;
  for (let i = prices.length - w; i < prices.length; i++) {
    sumReturns += (prices[i] - prices[i - 1]) / prices[i - 1];
  }
  return sumReturns / w;
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
  return maxDD; // Positive value: smaller = better drawdown (for "bottom 1" filters)
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
    case 'moving-average-return': return movingAverageReturn(prices, w);
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
 * - Daily closes up to (not including) eval date
 * - Plus current intraday price as "today's" value
 * This simulates what you'd see clicking "Run Now" at any given time
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
  const currentPrice = getIntradayPrice(ticker, intradayData, evalDate, evalTime, dailyData);
  if (currentPrice !== null) {
    prices.push(currentPrice);
  }

  return prices.length > 0 ? prices : null;
}

function getIntradayPrice(ticker, intradayData, date, time, dailyData = null) {
  // Special case: 16:00 uses daily close (official market close)
  if (time === '16:00' && dailyData) {
    const dailyClose = dailyData[ticker]?.byDate?.[date]?.close;
    if (dailyClose) return dailyClose;
    // Fall back to last intraday bar if daily not available
  }

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
  // Validate ticker looks like a real ticker: starts with letter, contains only letters/numbers/slash
  const isValidTicker = (v) => typeof v === 'string' && /^[A-Z][A-Z0-9\/]*$/.test(v);
  if (n['lhs-val'] && isValidTicker(n['lhs-val'])) t.add(n['lhs-val']);
  if (n['rhs-val'] && isValidTicker(n['rhs-val']) && !n['rhs-fixed-value?']) t.add(n['rhs-val']);
  if (n.children) n.children.forEach(c => extractTickers(c, t));
  return t;
}

function evalCond(c, dailyData, intradayData, date, time, recordDiag = false) {
  const lp = buildIndicatorPrices(c.lv, dailyData, intradayData, date, time);
  const lVal = evalInd(c.lf, lp, c.lw || 14);
  if (lVal === null) {
    if (recordDiag) {
      const condDesc = `${c.lv}.${c.lf}(${c.lw || 14}) ${c.cmp} ${c.rf ? c.rv : c.rv + '.' + c.rfn}`;
      const reason = !lp ? `No price data for ${c.lv}` : `Insufficient history for ${c.lf}(${c.lw || 14}) - have ${lp.length} bars`;
      recordNullCondition(condDesc, reason, c.lv);
    }
    return null;
  }

  let rVal;
  if (c.rf) {
    rVal = parseFloat(c.rv);
  } else {
    const rp = buildIndicatorPrices(c.rv, dailyData, intradayData, date, time);
    rVal = evalInd(c.rfn, rp, c.rw || 14);
    if (rVal === null) {
      if (recordDiag) {
        const condDesc = `${c.lv}.${c.lf}(${c.lw || 14}) ${c.cmp} ${c.rv}.${c.rfn}(${c.rw || 14})`;
        const reason = !rp ? `No price data for ${c.rv}` : `Insufficient history for ${c.rfn}(${c.rw || 14})`;
        recordNullCondition(condDesc, reason, c.rv);
      }
      return null;
    }
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
 * @param recordDiag - if true, records null conditions for diagnostics (use on first call only)
 * @param filterOverrides - optional array of {forcedWinner, amongCandidates} to override specific filter decisions
 */
function getAssetsWithWeights(node, dailyData, intradayData, date, time, parentWeight = 1.0, recordDiag = false, filterOverrides = null) {
  if (!node) return [];

  // Memoization: check cache for non-override, non-diagnostic calls at weight 1.0
  const useCache = !filterOverrides && !recordDiag && parentWeight === 1.0 && node.id;
  if (useCache) {
    const cacheKey = `${node.id}_${date}_${time}`;
    const cached = MEMO_CACHE.get(cacheKey);
    if (cached) return cached;
  }

  const results = [];

  function walk(n, weight) {
    if (!n) return;

    // Asset node - terminal
    // NOTE: Don't multiply by asset's own weight here - parent nodes (wt-cash-specified)
    // already applied the weight when calling walk(child, weight * childWeight)
    if (n.step === 'asset' && n.ticker) {
      results.push({ ticker: n.ticker, weight });
      return;
    }

    // Empty node - skip (represents "do nothing / cash" in Composer)
    if (n.step === 'empty') {
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
        // Handle both formats: lhs-fn-params.window (new) and lhs-window-days (legacy string)
        const lhsWindow = cond['lhs-fn-params']?.window || parseInt(cond['lhs-window-days']) || 14;
        const rhsWindow = cond['rhs-fn-params']?.window || parseInt(cond['rhs-window-days']) || 14;
        const c = {
          lf: cond['lhs-fn'], lv: cond['lhs-val'], lw: lhsWindow,
          cmp: cond.comparator, rv: cond['rhs-val'], rf: cond['rhs-fixed-value?'],
          rfn: cond['rhs-fn'], rw: rhsWindow
        };
        const r = evalCond(c, dailyData, intradayData, date, time, recordDiag);

        if (r === true && cond.children) {
          // Distribute weight equally among children of the true branch
          const childWeight = weight / Math.max(cond.children.length, 1);
          cond.children.forEach(child => walk(child, childWeight));
        } else if ((r === false || r === null) && els?.children) {
          // Fall through to ELSE on false OR null (can't evaluate)
          // This matches Composer behavior - every IF has an ELSE fallback
          // Distribute weight equally among children of the else branch
          const childWeight = weight / Math.max(els.children.length, 1);
          els.children.forEach(child => walk(child, childWeight));
        }
      }
      return;
    }

    // Filter node - select top/bottom N by indicator
    if (n.step === 'filter') {
      const selectFn = n['select-fn'];  // 'top' or 'bottom'
      const selectN = parseInt(n['select-n']) || 1;
      const sortFn = n['sort-by-fn'];
      // Handle both formats: sort-by-fn-params.window (new) and sort-by-window-days (legacy string)
      const sortWindow = n['sort-by-fn-params']?.window || parseInt(n['sort-by-window-days']) || 14;

      // Helper to get ticker name for a child (for override matching)
      function getChildTicker(child) {
        if (child.step === 'asset' && child.ticker) return child.ticker;
        // For groups, recursively get the holdings and return first ticker or group name
        const holdings = getAssetsWithWeights(child, dailyData, intradayData, date, time, 1.0, false, filterOverrides);
        if (holdings.length === 1) return holdings[0].ticker;
        if (holdings.length > 1) return holdings.map(h => h.ticker).sort().join(',');
        return null;
      }

      // FIXED: Evaluate what a subtree would ACTUALLY hold, then calculate indicator on those holdings
      function getSubtreeIndicatorValue(child) {
        if (child.step === 'asset' && child.ticker) {
          // Direct asset - use its indicator value
          const prices = buildIndicatorPrices(child.ticker, dailyData, intradayData, date, time);
          return evalInd(sortFn, prices, sortWindow);
        }

        // For groups/other nodes, first evaluate what they would actually hold
        // by running the full logic (IF/ELSE, nested filters, etc.)
        const subtreeHoldings = getAssetsWithWeights(child, dailyData, intradayData, date, time, 1.0, false, filterOverrides);

        if (subtreeHoldings.length === 0) return null;

        // Calculate weighted average indicator value across actual holdings
        let weightedSum = 0, totalWeight = 0;
        for (const holding of subtreeHoldings) {
          const prices = buildIndicatorPrices(holding.ticker, dailyData, intradayData, date, time);
          const val = evalInd(sortFn, prices, sortWindow);
          if (val !== null) {
            weightedSum += val * holding.weight;
            totalWeight += holding.weight;
          }
        }
        return totalWeight > 0 ? weightedSum / totalWeight : null;
      }

      // Evaluate indicator for each filter child (asset, group, or any other node)
      const candidates = [];
      for (let i = 0; i < (n.children || []).length; i++) {
        const child = n.children[i];
        const val = getSubtreeIndicatorValue(child);
        // Only get ticker if we need it for override matching (expensive recursive call)
        const ticker = filterOverrides ? getChildTicker(child) : null;
        if (val !== null) {
          candidates.push({ childIndex: i, child, value: val, ticker });
        }
      }

      // Check if there's an override for this filter
      let selected;
      if (filterOverrides && selectN === 1 && candidates.length >= 2) {
        const candidateTickers = candidates.map(c => c.ticker).filter(Boolean);

        // Helper to normalize ticker format for matching
        // Handles: "TQQQ", "Group(A,B,C)", "A,B,C" all treated as comparable
        const normalizeTicker = (t) => {
          if (!t) return '';
          // Extract tickers from "Group(A,B,C)" format
          const groupMatch = t.match(/^Group\(([^)]+)\)$/);
          if (groupMatch) {
            return groupMatch[1].split(',').sort().join(',');
          }
          // Already comma-separated or single ticker
          return t.split(',').sort().join(',');
        };

        const normalizedCandidates = candidateTickers.map(normalizeTicker);

        // Build current filter's sortFn identifier for matching
        // Use formatFnName to match the format from walkWithConditions (e.g., "MAR(10)" not "moving-average-return(10)")
        const currentFilterSortFn = `${formatFnName(sortFn)}(${sortWindow})`;

        const override = filterOverrides.find(ov => {
          // If override specifies sortFn, it must match this filter's sortFn
          if (ov.sortFn && ov.sortFn !== currentFilterSortFn) {
            return false;  // This override is for a different filter
          }

          const normalizedForcedWinner = normalizeTicker(ov.forcedWinner);
          const normalizedAmong = ov.amongCandidates.map(normalizeTicker);

          // Check if forced winner exists in candidates (normalized comparison)
          const forcedExists = normalizedCandidates.some(nc => nc === normalizedForcedWinner);

          // Check if all override candidates exist in filter candidates
          const allExist = normalizedAmong.every(na =>
            normalizedCandidates.some(nc => nc === na)
          );

          return forcedExists && allExist;
        });

        if (override) {
          // Use the forced winner - find by normalized match
          const normalizedForcedWinner = normalizeTicker(override.forcedWinner);
          const forcedCandidate = candidates.find(c =>
            normalizeTicker(c.ticker) === normalizedForcedWinner
          );
          if (forcedCandidate) {
            selected = [forcedCandidate];
          }
        }
      }

      // If no override applied, use normal selection
      if (!selected && candidates.length > 0) {
        candidates.sort((a, b) => selectFn === 'top' ? b.value - a.value : a.value - b.value);
        selected = candidates.slice(0, selectN);
      }

      // Walk selected children
      if (selected && selected.length > 0) {
        const childWeight = weight / selected.length;
        for (const s of selected) {
          walk(s.child, childWeight);
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
      // Helper to parse weight - handles string and number formats
      const parseWeight = (w) => {
        if (!w) return null;
        const num = typeof w.num === 'string' ? parseFloat(w.num) : w.num;
        const den = typeof w.den === 'string' ? parseFloat(w.den) : w.den;
        return num / den;
      };

      const children = n.children || [];

      // Use weights exactly as specified in the symphony data
      // IMPORTANT: Skip 0% weight children - they contribute nothing
      for (const child of children) {
        const childWeight = parseWeight(child.weight) ?? (1 / children.length);
        if (childWeight === 0) continue; // Skip 0% weight branches
        walk(child, weight * childWeight);
      }
      return;
    }

    // Weight-inverse-vol - weight by inverse volatility
    if (n.step === 'wt-inverse-vol') {
      const children = n.children || [];
      if (children.length === 0) return;

      // Get window from node (default 20 days)
      const volWindow = n['window-days'] || 20;

      // Helper to get volatility for a subtree (average if multiple assets)
      function getSubtreeVolatility(child) {
        const childAssets = [];
        function collectAssets(node) {
          if (!node) return;
          if (node.step === 'asset' && node.ticker) {
            childAssets.push(node.ticker);
          } else if (node.children) {
            node.children.forEach(c => collectAssets(c));
          }
        }
        collectAssets(child);

        if (childAssets.length === 0) return null;

        // Calculate average volatility across all assets in subtree
        let sum = 0, count = 0;
        for (const ticker of childAssets) {
          const prices = buildIndicatorPrices(ticker, dailyData, intradayData, date, time);
          const vol = evalInd('standard-deviation-return', prices, volWindow);
          if (vol !== null && vol > 0) {
            sum += vol;
            count++;
          }
        }
        return count > 0 ? sum / count : null;
      }

      // Calculate volatility for each child
      const childVols = children.map(child => ({
        child,
        vol: getSubtreeVolatility(child)
      }));

      // Calculate inverse volatility weights
      const validChildren = childVols.filter(cv => cv.vol !== null && cv.vol > 0);

      if (validChildren.length === 0) {
        // Fallback to equal weighting if no valid volatilities
        const childWeight = weight / children.length;
        children.forEach(child => walk(child, childWeight));
        return;
      }

      // For children with invalid volatility, use average of valid volatilities as fallback
      // This ensures all branches get SOME weight instead of being skipped entirely
      const avgVol = validChildren.reduce((acc, cv) => acc + cv.vol, 0) / validChildren.length;
      const effectiveVols = childVols.map(cv => ({
        child: cv.child,
        vol: (cv.vol !== null && cv.vol > 0) ? cv.vol : avgVol
      }));

      // Sum of inverses for normalization (now includes all children)
      const invSum = effectiveVols.reduce((acc, cv) => acc + (1 / cv.vol), 0);

      // Walk each child with inverse-vol weighted allocation
      for (const cv of effectiveVols) {
        const invWeight = (1 / cv.vol) / invSum;
        walk(cv.child, weight * invWeight);
      }
      return;
    }

    // Group or other container - pass through
    if (n.step === 'group' || n.step === 'root') {
      (n.children || []).forEach(child => walk(child, weight));
      return;
    }

    // If-child (when reached directly) - distribute equally among children
    // In Composer, multiple children in an if-child branch are implicitly weight-equal
    if (n.step === 'if-child') {
      const children = n.children || [];
      const childWeight = weight / Math.max(children.length, 1);
      children.forEach(child => walk(child, childWeight));
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

  const finalResult = Object.entries(consolidated).map(([ticker, weight]) => ({ ticker, weight }));

  // Store in cache for future calls
  if (useCache) {
    const cacheKey = `${node.id}_${date}_${time}`;
    MEMO_CACHE.set(cacheKey, finalResult);
  }

  return finalResult;
}

// For backward compatibility - returns just ticker list
function getAssets(node, dailyData, intradayData, date, time) {
  const withWeights = getAssetsWithWeights(node, dailyData, intradayData, date, time);
  return withWeights.map(x => x.ticker);
}

// ============================================================================
// VERBOSE INDICATOR EVALUATION (for Indicator Validation Mode)
// ============================================================================

/**
 * Format indicator function name for display
 */
function formatFnName(fn) {
  const names = {
    'relative-strength-index': 'RSI',
    'cumulative-return': 'CumRet',
    'moving-average-return': 'MAR',
    'moving-average-price': 'SMA',
    'exponential-moving-average-price': 'EMA',
    'current-price': 'Price',
    'max-drawdown': 'MaxDD',
    'standard-deviation-return': 'StdDevRet',
    'standard-deviation-price': 'StdDevPrice'
  };
  return names[fn] || fn;
}

/**
 * Format comparator for display
 */
function formatCmp(cmp) {
  const symbols = { 'gt': '>', 'gte': '>=', 'lt': '<', 'lte': '<=', 'eq': '==' };
  return symbols[cmp] || cmp;
}

/**
 * Verbose condition evaluation - returns object with all details
 */
function evalCondVerbose(c, dailyData, intradayData, date, time) {
  const lp = buildIndicatorPrices(c.lv, dailyData, intradayData, date, time);
  const lVal = evalInd(c.lf, lp, c.lw || 14);

  const result = {
    lhsTicker: c.lv,
    lhsFn: c.lf,
    lhsWindow: c.lw || 14,
    lhsValue: lVal,
    lhsDataPoints: lp ? lp.length : 0,
    comparator: c.cmp,
    rhsIsFixed: c.rf,
    rhsTicker: c.rf ? null : c.rv,
    rhsFn: c.rf ? null : c.rfn,
    rhsWindow: c.rf ? null : (c.rw || 14),
    rhsValue: null,
    rhsDataPoints: null,
    evalResult: null
  };

  if (lVal === null) {
    return result;
  }

  if (c.rf) {
    result.rhsValue = parseFloat(c.rv);
  } else {
    const rp = buildIndicatorPrices(c.rv, dailyData, intradayData, date, time);
    result.rhsValue = evalInd(c.rfn, rp, c.rw || 14);
    result.rhsDataPoints = rp ? rp.length : 0;
    if (result.rhsValue === null) {
      return result;
    }
  }

  switch (c.cmp) {
    case 'gt': result.evalResult = lVal > result.rhsValue; break;
    case 'gte': result.evalResult = lVal >= result.rhsValue; break;
    case 'lt': result.evalResult = lVal < result.rhsValue; break;
    case 'lte': result.evalResult = lVal <= result.rhsValue; break;
    case 'eq': result.evalResult = Math.abs(lVal - result.rhsValue) < 0.0001; break;
    default: result.evalResult = null;
  }

  return result;
}

/**
 * Verbose walk through symphony tree - prints each decision point
 */
function walkVerbose(node, dailyData, intradayData, date, time, indent = 0) {
  if (!node) return [];

  const prefix = '  '.repeat(indent);
  const results = [];

  function walk(n, weight, depth) {
    const pad = '  '.repeat(depth);

    if (n.step === 'asset' && n.ticker) {
      results.push({ ticker: n.ticker, weight });
      return;
    }

    if (n.step === 'empty') {
      console.log(`${pad}⬜ EMPTY (cash/skip)`);
      return;
    }

    if (n.step === 'if') {
      let cond = null, els = null;
      for (const ch of (n.children || [])) {
        if (ch['is-else-condition?']) els = ch;
        else cond = ch;
      }

      if (cond) {
        const lhsWindow = cond['lhs-fn-params']?.window || parseInt(cond['lhs-window-days']) || 14;
        const rhsWindow = cond['rhs-fn-params']?.window || parseInt(cond['rhs-window-days']) || 14;
        const c = {
          lf: cond['lhs-fn'], lv: cond['lhs-val'], lw: lhsWindow,
          cmp: cond.comparator, rv: cond['rhs-val'], rf: cond['rhs-fixed-value?'],
          rfn: cond['rhs-fn'], rw: rhsWindow
        };

        const v = evalCondVerbose(c, dailyData, intradayData, date, time);

        // Format LHS
        const lhsFmt = `${v.lhsTicker}.${formatFnName(v.lhsFn)}(${v.lhsWindow})`;
        const lhsValFmt = v.lhsValue !== null ? v.lhsValue.toFixed(4) : 'NULL';

        // Format RHS
        let rhsFmt, rhsValFmt;
        if (v.rhsIsFixed) {
          rhsFmt = `${v.rhsValue}`;
          rhsValFmt = v.rhsValue.toFixed(4);
        } else {
          rhsFmt = `${v.rhsTicker}.${formatFnName(v.rhsFn)}(${v.rhsWindow})`;
          rhsValFmt = v.rhsValue !== null ? v.rhsValue.toFixed(4) : 'NULL';
        }

        const cmpFmt = formatCmp(v.comparator);
        const resultEmoji = v.evalResult === true ? '✅ TRUE' : v.evalResult === false ? '❌ FALSE' : '⚠️  NULL';

        console.log(`${pad}┌─ IF ${lhsFmt} ${cmpFmt} ${rhsFmt}`);
        console.log(`${pad}│     LHS: ${lhsValFmt} (${v.lhsDataPoints} data points)`);
        if (!v.rhsIsFixed) {
          console.log(`${pad}│     RHS: ${rhsValFmt} (${v.rhsDataPoints} data points)`);
        }
        console.log(`${pad}│     Result: ${lhsValFmt} ${cmpFmt} ${rhsValFmt} → ${resultEmoji}`);

        if (v.evalResult === true && cond.children) {
          console.log(`${pad}├─ THEN:`);
          const childWeight = weight / Math.max(cond.children.length, 1);
          cond.children.forEach(child => walk(child, childWeight, depth + 1));
        } else if ((v.evalResult === false || v.evalResult === null) && els?.children) {
          console.log(`${pad}├─ ELSE:`);
          const childWeight = weight / Math.max(els.children.length, 1);
          els.children.forEach(child => walk(child, childWeight, depth + 1));
        }
        console.log(`${pad}└─`);
      }
      return;
    }

    if (n.step === 'filter') {
      const selectFn = n['select-fn'];
      const selectN = parseInt(n['select-n']) || 1;
      const sortFn = n['sort-by-fn'];
      const sortWindow = n['sort-by-fn-params']?.window || parseInt(n['sort-by-window-days']) || 14;

      console.log(`${pad}┌─ FILTER: Select ${selectFn.toUpperCase()} ${selectN} by ${formatFnName(sortFn)}(${sortWindow})`);

      // Helper to get indicator value for subtree
      function getSubtreeValue(child) {
        if (child.step === 'asset' && child.ticker) {
          const prices = buildIndicatorPrices(child.ticker, dailyData, intradayData, date, time);
          return { ticker: child.ticker, value: evalInd(sortFn, prices, sortWindow), dataPoints: prices ? prices.length : 0 };
        }
        const holdings = getAssetsWithWeights(child, dailyData, intradayData, date, time, 1.0);
        if (holdings.length === 0) return { ticker: '(empty)', value: null, dataPoints: 0 };

        let weightedSum = 0, totalWeight = 0;
        const tickers = [];
        for (const h of holdings) {
          tickers.push(h.ticker);
          const prices = buildIndicatorPrices(h.ticker, dailyData, intradayData, date, time);
          const val = evalInd(sortFn, prices, sortWindow);
          if (val !== null) {
            weightedSum += val * h.weight;
            totalWeight += h.weight;
          }
        }
        return {
          ticker: tickers.length === 1 ? tickers[0] : `Group(${tickers.join(',')})`,
          value: totalWeight > 0 ? weightedSum / totalWeight : null,
          dataPoints: '-'
        };
      }

      // Evaluate all candidates
      const candidates = [];
      console.log(`${pad}│  Candidates:`);
      for (let i = 0; i < (n.children || []).length; i++) {
        const child = n.children[i];
        const cv = getSubtreeValue(child);
        candidates.push({ idx: i, child, ...cv });
        const valFmt = cv.value !== null ? cv.value.toFixed(4) : 'NULL';
        console.log(`${pad}│    ${i + 1}. ${cv.ticker}: ${formatFnName(sortFn)}(${sortWindow}) = ${valFmt}`);
      }

      // Sort and select
      const validCandidates = candidates.filter(c => c.value !== null);
      validCandidates.sort((a, b) => selectFn === 'top' ? b.value - a.value : a.value - b.value);
      const selected = validCandidates.slice(0, selectN);

      console.log(`${pad}│  Selected (${selectFn} ${selectN}):`);
      for (const s of selected) {
        console.log(`${pad}│    ✓ ${s.ticker}: ${s.value.toFixed(4)}`);
      }

      const childWeight = weight / Math.max(selected.length, 1);
      for (const s of selected) {
        walk(s.child, childWeight, depth + 1);
      }

      console.log(`${pad}└─`);
      return;
    }

    if (n.step === 'wt-cash-equal') {
      console.log(`${pad}┌─ WEIGHT EQUAL (${(n.children || []).length} children, ${(weight * 100 / (n.children || []).length).toFixed(1)}% each)`);
      const children = n.children || [];
      const childWeight = weight / Math.max(children.length, 1);
      children.forEach((child, i) => {
        console.log(`${pad}│  Child ${i + 1}:`);
        walk(child, childWeight, depth + 1);
      });
      console.log(`${pad}└─`);
      return;
    }

    if (n.step === 'wt-cash-specified') {
      const parseWeight = (w) => {
        if (!w) return null;
        const num = typeof w.num === 'string' ? parseFloat(w.num) : w.num;
        const den = typeof w.den === 'string' ? parseFloat(w.den) : w.den;
        return num / den;
      };
      const children = n.children || [];
      console.log(`${pad}┌─ WEIGHT SPECIFIED`);
      for (const child of children) {
        const childWeight = parseWeight(child.weight) ?? (1 / children.length);
        if (childWeight === 0) {
          console.log(`${pad}│  0.0% (SKIPPED):`);
          continue; // Skip 0% weight branches
        }
        console.log(`${pad}│  ${(childWeight * 100).toFixed(1)}%:`);
        walk(child, weight * childWeight, depth + 1);
      }
      console.log(`${pad}└─`);
      return;
    }

    if (n.step === 'wt-inverse-vol') {
      const volWindow = n['window-days'] || 20;
      console.log(`${pad}┌─ WEIGHT INVERSE VOLATILITY (${volWindow}d)`);

      // Calculate vols
      const childVols = [];
      for (const child of (n.children || [])) {
        const tickers = [];
        function collect(node) {
          if (node?.step === 'asset' && node.ticker) tickers.push(node.ticker);
          else if (node?.children) node.children.forEach(c => collect(c));
        }
        collect(child);

        let sum = 0, count = 0;
        for (const t of tickers) {
          const prices = buildIndicatorPrices(t, dailyData, intradayData, date, time);
          const vol = evalInd('standard-deviation-return', prices, volWindow);
          if (vol !== null && vol > 0) { sum += vol; count++; }
        }
        const avgVol = count > 0 ? sum / count : null;
        childVols.push({ child, vol: avgVol, tickers });
      }

      const validVols = childVols.filter(cv => cv.vol !== null && cv.vol > 0);
      const invSum = validVols.reduce((acc, cv) => acc + (1 / cv.vol), 0);

      for (const cv of childVols) {
        const tickerStr = cv.tickers.length === 1 ? cv.tickers[0] : `Group(${cv.tickers.join(',')})`;
        const volStr = cv.vol !== null ? (cv.vol * 100).toFixed(2) + '%' : 'NULL';
        const wtStr = cv.vol !== null && cv.vol > 0 ? ((1 / cv.vol) / invSum * 100).toFixed(1) + '%' : '0%';
        console.log(`${pad}│  ${tickerStr}: vol=${volStr} → weight=${wtStr}`);
        if (cv.vol !== null && cv.vol > 0) {
          const invWeight = (1 / cv.vol) / invSum;
          walk(cv.child, weight * invWeight, depth + 1);
        }
      }
      console.log(`${pad}└─`);
      return;
    }

    if (n.step === 'group') {
      const groupName = n.name || 'Unnamed Group';
      console.log(`${pad}┌─ GROUP: "${groupName}"`);
      (n.children || []).forEach(child => walk(child, weight, depth + 1));
      console.log(`${pad}└─`);
      return;
    }

    if (n.step === 'root') {
      console.log(`${pad}┌─ ROOT`);
      (n.children || []).forEach(child => walk(child, weight, depth + 1));
      console.log(`${pad}└─`);
      return;
    }

    if (n.step === 'if-child') {
      (n.children || []).forEach(child => walk(child, weight, depth));
      return;
    }

    // Unknown - try to walk children
    console.log(`${pad}? Unknown step: ${n.step}`);
    if (n.children) {
      n.children.forEach(child => walk(child, weight, depth + 1));
    }
  }

  walk(node, 1.0, indent);

  // Consolidate results
  const consolidated = {};
  for (const r of results) {
    if (!consolidated[r.ticker]) consolidated[r.ticker] = 0;
    consolidated[r.ticker] += r.weight;
  }

  return Object.entries(consolidated).map(([ticker, weight]) => ({ ticker, weight }));
}

// ============================================================================
// DATA FETCHING (Parallel with concurrency limit)
// ============================================================================

const CONCURRENCY = 20; // Bumped from 12 - Yahoo handles it fine

async function fetchAllData(tickers, intradayDays, dailyDays, quiet = false, skipIntraday = false) {
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

  // Fetch BOTH intraday and daily data simultaneously per ticker
  if (!quiet) {
    if (skipIntraday) {
      console.log(`  Fetching daily data (${tickers.length} tickers, ${CONCURRENCY} parallel)...`);
    } else {
      console.log(`  Fetching intraday + daily data (${tickers.length} tickers, ${CONCURRENCY} parallel)...`);
    }
  }

  await runWithConcurrency(tickers, async (t) => {
    const normalizedTicker = normalizeTicker(t);

    // Fetch both intraday and daily in parallel for this ticker
    const promises = [];

    if (!skipIntraday) {
      promises.push(
        getIntradayData(normalizedTicker, intradayDays)
          .then(data => { intradayData[t] = data; return { type: 'intraday', success: true }; })
          .catch(e => {
            errors.intraday.push(t);
            const errMsg = e.message || 'Unknown error';
            if (errMsg.includes('15m data not available')) {
              recordTickerError(t, 'intraday', '15min data not available from Yahoo');
            } else if (errMsg.includes('No data')) {
              recordTickerError(t, 'intraday', 'Ticker not found or delisted');
            } else {
              recordTickerError(t, 'intraday', errMsg.substring(0, 50));
            }
            return { type: 'intraday', success: false };
          })
      );
    }

    promises.push(
      getDailyData(normalizedTicker, dailyDays)
        .then(data => { dailyData[t] = data; return { type: 'daily', success: true }; })
        .catch(e => {
          errors.daily.push(t);
          const errMsg = e.message || 'Unknown error';
          if (errMsg.includes('No data')) {
            recordTickerError(t, 'daily', 'Ticker not found or delisted');
          } else {
            recordTickerError(t, 'daily', errMsg.substring(0, 50));
          }
          return { type: 'daily', success: false };
        })
    );

    await Promise.all(promises);
    if (!quiet) process.stdout.write('.');
  });

  if (!quiet) {
    console.log(` done`);
    if (errors.intraday.length > 0) console.log(`    Skipped intraday: ${errors.intraday.join(', ')}`);
    if (errors.daily.length > 0) console.log(`    Skipped daily: ${errors.daily.join(', ')}`);
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

function getTradingDaysFromDaily(dailyData) {
  const dates = new Set();
  for (const t of Object.keys(dailyData)) {
    for (const d of Object.keys(dailyData[t].byDate || {})) {
      dates.add(d);
    }
  }
  return Array.from(dates).sort();
}

function getPreviousTradingDay(date, tradingDays) {
  const idx = tradingDays.indexOf(date);
  if (idx > 0) return tradingDays[idx - 1];
  return 'prior day';
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
        const prevEOD = getIntradayPrice(h.ticker, intradayData, prevDate, CONFIG.EOD_TIME, dailyData);
        const morning = getIntradayPrice(h.ticker, intradayData, date, morningTime, dailyData);
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
        const morning = getIntradayPrice(h.ticker, intradayData, date, morningTime, dailyData);
        const eod = getIntradayPrice(h.ticker, intradayData, date, CONFIG.EOD_TIME, dailyData);
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
        const prevEOD = getIntradayPrice(h.ticker, intradayData, prevDate, CONFIG.EOD_TIME, dailyData);
        const currEOD = getIntradayPrice(h.ticker, intradayData, date, CONFIG.EOD_TIME, dailyData);
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
        const prevPrice = getIntradayPrice(h.ticker, intradayData, prevDate, tradeTime, dailyData);
        const currPrice = getIntradayPrice(h.ticker, intradayData, date, tradeTime, dailyData);
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
  const dailyDays = Math.max(intradayDays + 60, 365);  // Need 365 days for SMA(200), cumret(252) etc

  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    DIAGNOSTICS.reset();  // Reset diagnostics for each strategy
    clearMemoCache();     // Clear memoization cache for each strategy
    if (!quiet) console.log(`\n[${i + 1}/${ids.length}] Analyzing ${id}...`);

    try {
      const { score, name } = await getSymphony(id);
      if (!quiet) console.log(`  Name: ${name}`);

      const tickers = Array.from(extractTickers(score));
      if (!quiet) console.log(`  Tickers: ${tickers.join(', ')}`);

      const { intradayData, dailyData } = await fetchAllData(tickers, intradayDays, dailyDays, quiet);

      if (Object.keys(intradayData).length === 0) {
        results.push({ id, name, error: 'No intraday data available' });
        printDiagnostics();
        continue;
      }

      const tradingDays = getTradingDays(intradayData);
      if (tradingDays.length < 5) {
        results.push({ id, name, error: 'Not enough trading days' });
        continue;
      }

      if (!quiet) console.log(`  Trading days: ${tradingDays.length} (${tradingDays[0]} to ${tradingDays[tradingDays.length-1]})`);

      // Do a diagnostic run on the last day to capture null conditions
      const lastDay = tradingDays[tradingDays.length - 1];
      getAssetsWithWeights(score, dailyData, intradayData, lastDay, CONFIG.EOD_TIME, 1.0, true);

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

      // Check for no trades (0% return and 0% drawdown)
      const noTrades = Math.abs(eodResult.cumReturn) < 0.01 && Math.abs(eodResult.maxDD) < 0.01;
      if (noTrades && !quiet) {
        console.log(`  ⚠️  NO TRADES DETECTED - Strategy returned 0% with 0% drawdown`);
        printDiagnostics();
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
  const dailyDays = Math.max(intradayDays + 60, 365);

  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    DIAGNOSTICS.reset();  // Reset diagnostics for each strategy
    clearMemoCache();     // Clear memoization cache for each strategy
    if (!quiet) console.log(`\n[${i + 1}/${ids.length}] Analyzing ${id}...`);

    try {
      const { score, name } = await getSymphony(id);
      if (!quiet) console.log(`  Name: ${name}`);

      const tickers = Array.from(extractTickers(score));
      if (!quiet) console.log(`  Tickers: ${tickers.join(', ')}`);

      const { intradayData, dailyData } = await fetchAllData(tickers, intradayDays, dailyDays, quiet);

      if (Object.keys(intradayData).length === 0) {
        results.push({ id, name, error: 'No intraday data available' });
        printDiagnostics();
        continue;
      }

      const tradingDays = getTradingDays(intradayData);
      if (tradingDays.length < 5) {
        results.push({ id, name, error: 'Not enough trading days' });
        continue;
      }

      if (!quiet) console.log(`  Trading days: ${tradingDays.length} (${tradingDays[0]} to ${tradingDays[tradingDays.length-1]})`);

      // Do a diagnostic run on the last day to capture null conditions
      const lastDay = tradingDays[tradingDays.length - 1];
      getAssetsWithWeights(score, dailyData, intradayData, lastDay, CONFIG.EOD_TIME, 1.0, true);

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

      // Check for no trades (0% return and 0% drawdown)
      const noTrades = Math.abs(eodResult.cumReturn) < 0.01 && Math.abs(eodResult.maxDD) < 0.01;
      if (noTrades && !quiet) {
        console.log(`  ⚠️  NO TRADES DETECTED - Strategy returned 0% with 0% drawdown`);
        printDiagnostics();
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
  console.log(`  Question: "If I trade at BOTH morning AND ${CONFIG.EOD_TIME} EOD, what is my cumulative return?"`);
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

    console.log(`\n  DUAL-TIME RESULTS (Morning + ${CONFIG.EOD_TIME} EOD):`);
    console.log('  ┌─────────┬─────────────────┬─────────────────┬─────────────────┐');
    console.log('  │  Time   │  Cum Return     │  Max Drawdown   │  vs EOD-Only    │');
    console.log('  ├─────────┼─────────────────┼─────────────────┼─────────────────┤');

    // EOD baseline row first
    const eodRet = `${r.eod.cumReturn >= 0 ? '+' : ''}${r.eod.cumReturn.toFixed(1)}%`;
    const eodDD = `${r.eod.maxDD.toFixed(1)}%`;
    console.log(`  │  ${CONFIG.EOD_TIME}  │  ${eodRet.padStart(12)}  │  ${eodDD.padStart(12)}  │    (baseline)   │ ◀ EOD-ONLY`);
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

  clearMemoCache();  // Clear memoization cache for fresh analysis
  console.log(`Fetching symphony ${id}...`);
  const { score, name } = await getSymphony(id);
  console.log(`Name: ${name}\n`);

  const tickers = Array.from(extractTickers(score));
  const dailyDays = Math.max(intradayDays + 60, 365);
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

async function dailyCheck(id, r) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log('  HOLDINGS CHECK BY TIME (V3)');
  console.log(`${'═'.repeat(60)}\n`);

  // Ask for date FIRST, before fetching data
  const today = new Date().toISOString().split('T')[0];
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

  console.log('  Date Options:');
  console.log(`    1. Today / Most recent trading day`);
  console.log(`    2. Yesterday / Previous trading day`);
  console.log('    3. Enter custom date (YYYY-MM-DD)');
  console.log('    4. Show last 10 trading days (requires data fetch)\n');

  const dateChoice = await ask(r, '  Select [1]: ');

  let requestedDate = today;
  let needsDateList = false;

  if (dateChoice === '2') {
    requestedDate = yesterday;
  } else if (dateChoice === '3') {
    requestedDate = await ask(r, '  Enter date (YYYY-MM-DD): ');
  } else if (dateChoice === '4') {
    needsDateList = true;
  }

  // Now fetch the data
  console.log(`\nFetching symphony ${id}...`);
  const { score, name } = await getSymphony(id);
  console.log(`Name: ${name}\n`);

  const tickers = Array.from(extractTickers(score));
  // Need 365+ days for indicators like MA(200), cumRet(252)
  const { intradayData, dailyData } = await fetchAllData(tickers, CONFIG.MAX_INTRADAY_DAYS, 400);

  const tradingDays = getTradingDays(intradayData);
  if (tradingDays.length === 0) {
    console.log('  No trading days available in data.\n');
    return;
  }

  const latestDate = tradingDays[tradingDays.length - 1];

  // Handle date selection after data is loaded
  let selectedDate;

  if (needsDateList) {
    // Show last 10 trading days
    const recentDays = tradingDays.slice(-10).reverse();
    console.log('\n  Recent trading days:');
    recentDays.forEach((d, i) => {
      const dayName = new Date(d + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short' });
      console.log(`    ${i + 1}. ${d} (${dayName})`);
    });
    const dayChoice = await ask(r, '\n  Select [1]: ');
    const idx = parseInt(dayChoice) - 1;
    selectedDate = (idx >= 0 && idx < recentDays.length) ? recentDays[idx] : latestDate;
  } else {
    // Find the requested date or nearest trading day
    if (tradingDays.includes(requestedDate)) {
      selectedDate = requestedDate;
    } else {
      // Find closest trading day
      const closest = tradingDays.reduce((prev, curr) => {
        return Math.abs(new Date(curr) - new Date(requestedDate)) < Math.abs(new Date(prev) - new Date(requestedDate)) ? curr : prev;
      });
      if (requestedDate !== today && requestedDate !== yesterday) {
        console.log(`  Note: ${requestedDate} not in data, using nearest: ${closest}`);
      }
      selectedDate = closest;
    }
  }

  const dayName = new Date(selectedDate + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  HOLDINGS FOR: ${selectedDate} (${dayName})`);
  console.log(`  EOD Time: ${CONFIG.EOD_TIME}`);
  console.log(`${'─'.repeat(60)}\n`);

  let prevAssets = null;
  for (const tt of [...CONFIG.TEST_TIMES, CONFIG.EOD_TIME]) {
    const assetsWithWeights = getAssetsWithWeights(score, dailyData, intradayData, selectedDate, tt);
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

/**
 * Collect all conditions evaluated during tree walk (silent mode)
 * Returns array of condition evaluations with their results
 */
function collectConditions(node, dailyData, intradayData, date, time, path = []) {
  if (!node) return [];

  const conditions = [];

  function walk(n, currentPath) {
    if (!n) return;

    if (n.step === 'if') {
      let cond = null, els = null;
      for (const ch of (n.children || [])) {
        if (ch['is-else-condition?']) els = ch;
        else cond = ch;
      }

      if (cond) {
        const lhsWindow = cond['lhs-fn-params']?.window || parseInt(cond['lhs-window-days']) || 14;
        const rhsWindow = cond['rhs-fn-params']?.window || parseInt(cond['rhs-window-days']) || 14;
        const c = {
          lf: cond['lhs-fn'], lv: cond['lhs-val'], lw: lhsWindow,
          cmp: cond.comparator, rv: cond['rhs-val'], rf: cond['rhs-fixed-value?'],
          rfn: cond['rhs-fn'], rw: rhsWindow
        };

        const v = evalCondVerbose(c, dailyData, intradayData, date, time);

        // Calculate margin (how close to flipping)
        let margin = null;
        if (v.lhsValue !== null && v.rhsValue !== null) {
          const diff = v.lhsValue - v.rhsValue;
          const base = Math.abs(v.rhsValue) > 0.0001 ? Math.abs(v.rhsValue) : 1;
          margin = (diff / base) * 100; // percentage difference
        }

        conditions.push({
          path: currentPath.join(' > '),
          condition: formatConditionString(v),
          lhsValue: v.lhsValue,
          rhsValue: v.rhsValue,
          result: v.evalResult,
          margin,
          branchTaken: v.evalResult === true ? 'THEN' : 'ELSE'
        });

        // Continue walking the taken branch
        if (v.evalResult === true && cond.children) {
          cond.children.forEach((child, i) => walk(child, [...currentPath, `THEN[${i}]`]));
        } else if ((v.evalResult === false || v.evalResult === null) && els?.children) {
          els.children.forEach((child, i) => walk(child, [...currentPath, `ELSE[${i}]`]));
        }
      }
      return;
    }

    if (n.step === 'filter') {
      const selectFn = n['select-fn'];
      const selectN = parseInt(n['select-n']) || 1;
      const sortFn = n['sort-by-fn'];
      const sortWindow = n['sort-by-fn-params']?.window || parseInt(n['sort-by-window-days']) || 14;

      // Get candidates - keep track of original nodes for later recursion
      const candidates = [];
      for (const child of (n.children || [])) {
        if (child.step === 'asset' && child.ticker) {
          const prices = buildIndicatorPrices(child.ticker, dailyData, intradayData, date, time);
          candidates.push({ ticker: child.ticker, value: evalInd(sortFn, prices, sortWindow), node: child });
        } else {
          const holdings = getAssetsWithWeights(child, dailyData, intradayData, date, time, 1.0);
          if (holdings.length > 0) {
            let weightedSum = 0, totalWeight = 0;
            for (const h of holdings) {
              const prices = buildIndicatorPrices(h.ticker, dailyData, intradayData, date, time);
              const val = evalInd(sortFn, prices, sortWindow);
              if (val !== null) { weightedSum += val * h.weight; totalWeight += h.weight; }
            }
            const ticker = holdings.length === 1 ? holdings[0].ticker : `Group(${holdings.map(h => h.ticker).join(',')})`;
            candidates.push({ ticker, value: totalWeight > 0 ? weightedSum / totalWeight : null, node: child });
          }
        }
      }

      const validCandidates = candidates.filter(c => c.value !== null);
      validCandidates.sort((a, b) => selectFn === 'top' ? b.value - a.value : a.value - b.value);
      const selected = validCandidates.slice(0, selectN);

      // Calculate margin between winner and runner-up (how close the decision was)
      let filterMargin = null;
      let absoluteDiff = null;
      let runnerUp = null;
      if (validCandidates.length >= 2 && selectN === 1) {
        const winner = validCandidates[0];
        runnerUp = validCandidates[1];
        absoluteDiff = Math.abs(winner.value - runnerUp.value);
        const base = Math.max(Math.abs(winner.value), 0.0001);
        filterMargin = (absoluteDiff / base) * 100;
      }

      conditions.push({
        path: currentPath.join(' > '),
        condition: `FILTER ${selectFn.toUpperCase()} ${selectN} by ${formatFnName(sortFn)}(${sortWindow})`,
        sortFn: `${formatFnName(sortFn)}(${sortWindow})`,  // e.g., "MAR(10)", "RSI(10)" - used for override matching
        candidates: candidates.map(c => ({ ticker: c.ticker, value: c.value })),
        selected: selected.map(s => s.ticker),
        runnerUp: runnerUp ? runnerUp.ticker : null,
        filterMargin,
        absoluteDiff,
        isFilter: true
      });

      // IMPORTANT: Walk into the SELECTED children to capture nested conditions
      for (const sel of selected) {
        if (sel.node && sel.node.step !== 'asset') {
          walk(sel.node, [...currentPath, `SELECTED(${sel.ticker})`]);
        }
      }

      return;
    }

    // Walk children for other node types
    if (n.step === 'group') {
      const groupName = n.name || 'Group';
      (n.children || []).forEach((child, i) => walk(child, [...currentPath, groupName]));
    } else if (n.children) {
      (n.children || []).forEach((child, i) => walk(child, currentPath));
    }
  }

  walk(node, path);
  return conditions;
}

function formatConditionString(v) {
  const lhsFmt = `${v.lhsTicker}.${formatFnName(v.lhsFn)}(${v.lhsWindow})`;
  const rhsFmt = v.rhsIsFixed ? `${v.rhsValue}` : `${v.rhsTicker}.${formatFnName(v.rhsFn)}(${v.rhsWindow})`;
  return `${lhsFmt} ${formatCmp(v.comparator)} ${rhsFmt}`;
}

/**
 * Fetch Composer's expected holdings for a given date via public backtest API
 */
async function fetchComposerHoldings(symphonyId, date) {
  return new Promise((resolve) => {
    const postData = JSON.stringify({
      start_date: date,
      end_date: date,
      include_daily_values: false,
      capital: 10000,
      slippage_percent: 0.0001,
      apply_reg_fee: true,
      apply_taf_fee: true
    });

    const options = {
      hostname: 'backtest-api.composer.trade',
      port: 443,
      path: `/api/v2/public/symphonies/${symphonyId}/backtest`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0'
      },
      timeout: 30000
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          try {
            const errData = JSON.parse(data);
            resolve({ success: false, error: `HTTP ${res.statusCode}: ${errData.message || errData.error || data.substring(0, 100)}` });
          } catch {
            resolve({ success: false, error: `HTTP ${res.statusCode}: ${data.substring(0, 100)}` });
          }
          return;
        }

        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch (parseErr) {
          resolve({ success: false, error: `JSON parse error: ${data.substring(0, 200)}` });
          return;
        }

        // Handle nested result structure (MCP-style response)
        if (parsed.result) {
          parsed = parsed.result;
        }

        // Extract tickers from last_market_days_holdings (v2 API) or last_market_days_shares (v1/MCP)
        const holdingsData = parsed.last_market_days_holdings || parsed.last_market_days_shares;
        if (holdingsData) {
          const holdings = Object.entries(holdingsData)
            .filter(([ticker, shares]) => shares > 0 && ticker !== '$USD') // Exclude cash
            .map(([ticker, shares]) => ({ ticker, shares }));
          resolve({
            success: true,
            holdings,
            tickers: holdings.map(h => h.ticker).sort(),
            date: parsed.last_market_day || date
          });
          return;
        }

        resolve({ success: false, error: `No holdings data. Response keys: ${Object.keys(parsed).join(', ')}` });
      });
    });

    req.on('error', (e) => {
      resolve({ success: false, error: `Request error: ${e.message}` });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ success: false, error: 'Request timeout' });
    });

    req.write(postData);
    req.end();
  });
}

async function indicatorValidationMode(id, r) {
  console.log('\n  VALIDATION MODE - Compare holdings against Composer\n');

  clearMemoCache();  // Clear memoization cache for fresh analysis

  // Fetch symphony
  console.log(`  Fetching symphony ${id}...`);
  const { score, name } = await getSymphony(id);
  console.log(`  ${name}\n`);

  // Ask for date (simple)
  const today = new Date().toISOString().split('T')[0];
  console.log('  Date? [Enter=today, or YYYY-MM-DD]: ');
  const dateInput = await ask(r, '  > ');
  const requestedDate = dateInput.trim() || today;

  // Fetch daily data
  const tickers = Array.from(extractTickers(score));
  const { intradayData, dailyData } = await fetchAllData(tickers, 0, 400, false, true);

  const tradingDays = getTradingDaysFromDaily(dailyData);
  if (tradingDays.length === 0) {
    console.log('  No trading days available.\n');
    return;
  }

  const selectedDate = tradingDays.includes(requestedDate) ? requestedDate : tradingDays[tradingDays.length - 1];
  if (selectedDate !== requestedDate) {
    console.log(`  Using nearest trading day: ${selectedDate}`);
  }

  // Calculate our holdings
  const allHoldings = getAssetsWithWeights(score, dailyData, intradayData, selectedDate, '16:00');
  const holdings = allHoldings.filter(h => h.weight >= 0.001);
  const ourTickers = holdings.map(h => h.ticker).sort();

  // Fetch Composer holdings
  const composerResult = await fetchComposerHoldings(id, selectedDate);

  console.log(`\n  ══════════════════════════════════════════════════════════════`);
  console.log(`  ${selectedDate} HOLDINGS COMPARISON`);
  console.log(`  ══════════════════════════════════════════════════════════════\n`);

  // Show side by side
  console.log(`  COMPOSER: ${composerResult.success ? composerResult.tickers.join(', ') : `(error: ${composerResult.error})`}`);
  console.log(`  OURS:     ${ourTickers.length > 0 ? ourTickers.join(', ') : '(none)'}\n`);

  if (!composerResult.success) {
    console.log('  Cannot compare - Composer fetch failed.\n');
    return;
  }

  const expectedTickers = composerResult.tickers;
  const ourSet = new Set(ourTickers);
  const expectedSet = new Set(expectedTickers);

  const missing = expectedTickers.filter(t => !ourSet.has(t));
  const extra = ourTickers.filter(t => !expectedSet.has(t));

  // Collect all decision conditions for analysis
  const conditions = collectConditions(score, dailyData, intradayData, selectedDate, '16:00', ['ROOT']);

  if (missing.length === 0 && extra.length === 0) {
    console.log('  ✅ MATCH - Holdings are identical\n');
  } else {
    console.log('  ❌ MISMATCH');
    if (missing.length > 0) console.log(`     Missing: ${missing.join(', ')}`);
    if (extra.length > 0) console.log(`     Extra:   ${extra.join(', ')}`);
    console.log('');

    // Identify borderline decisions
    // Use both percentage margin AND absolute difference for small indicator values
    // Data sources (Yahoo vs Xignite) typically differ by 0.1-0.5% on prices
    // This ripples through indicators, so realistic "flippable" thresholds are tight
    const borderlineFilters = conditions.filter(c => {
      if (!c.isFilter || c.filterMargin === null) return false;
      // Percentage-based: less than 3% margin between candidates
      if (c.filterMargin < 3) return true;
      // Absolute-based: for indicators with small values (like MAR of -0.02),
      // an absolute diff of 0.01 (1 percentage point) could flip with data noise
      if (c.absoluteDiff !== null && c.absoluteDiff < 0.01) return true;
      return false;
    });
    const borderlineConditions = conditions.filter(c =>
      !c.isFilter && c.margin !== null && Math.abs(c.margin) < 10
    );
    const nullConds = conditions.filter(c => !c.isFilter && (c.lhsValue === null || c.rhsValue === null));

    // Check if any borderline filter directly explains the mismatch
    const suspectFilters = borderlineFilters.filter(bf => {
      const winner = bf.selected[0];
      const loser = bf.runnerUp;
      return (extra.includes(winner) && missing.includes(loser)) ||
             (missing.includes(winner) && extra.includes(loser));
    });

    // Verify suspect filters by actually flipping the decision and checking if holdings match
    const confirmedCauses = [];
    for (const sf of suspectFilters) {
      const winner = sf.selected[0];
      const loser = sf.runnerUp;

      // Create override to force the runner-up to win
      const override = [{
        forcedWinner: loser,
        amongCandidates: [winner, loser]
      }];

      // Re-evaluate holdings with this override
      const flippedHoldings = getAssetsWithWeights(score, dailyData, intradayData, selectedDate, '16:00', 1.0, false, override);
      const flippedTickers = flippedHoldings.filter(h => h.weight >= 0.001).map(h => h.ticker).sort();

      // Check if flipped holdings match Composer
      const flippedMatches = JSON.stringify(flippedTickers) === JSON.stringify(expectedTickers);

      if (flippedMatches) {
        confirmedCauses.push({ filter: sf, winner, loser });
      }
    }

    if (confirmedCauses.length > 0) {
      console.log('  ✓ CONFIRMED CAUSE: Flipping these borderline decisions produces matching holdings:\n');
      for (const { filter: sf, winner, loser } of confirmedCauses) {
        const winnerVal = sf.candidates.find(c => c.ticker === winner)?.value;
        const loserVal = sf.candidates.find(c => c.ticker === loser)?.value;
        console.log(`     ${sf.condition}`);
        console.log(`       Our pick:      ${winner} = ${winnerVal?.toFixed(4)}`);
        console.log(`       Composer pick: ${loser} = ${loserVal?.toFixed(4)}`);
        console.log(`       Margin: ${sf.filterMargin.toFixed(2)}% - Data source difference flipped this decision`);
        console.log('');
      }
    } else if (suspectFilters.length > 0) {
      // Suspect filters exist but flipping doesn't produce a match - something else is wrong
      console.log('  ⚠️  BORDERLINE FILTERS FOUND (but flipping alone does not fix mismatch):\n');
      for (const sf of suspectFilters) {
        const winner = sf.selected[0];
        const loser = sf.runnerUp;
        const winnerVal = sf.candidates.find(c => c.ticker === winner)?.value;
        const loserVal = sf.candidates.find(c => c.ticker === loser)?.value;
        console.log(`     ${sf.condition}`);
        console.log(`       ${winner}=${winnerVal?.toFixed(4)} vs ${loser}=${loserVal?.toFixed(4)} (margin: ${sf.filterMargin.toFixed(1)}%)`);
      }
      console.log('     Note: Other factors may also be contributing to the mismatch.\n');
    } else if (borderlineFilters.length > 0 || borderlineConditions.length > 0) {
      console.log('  ⚠️  BORDERLINE DECISIONS (within 10% - may flip with different data):\n');
      for (const bf of borderlineFilters) {
        const winner = bf.selected[0];
        const loser = bf.runnerUp;
        const winnerVal = bf.candidates.find(c => c.ticker === winner)?.value;
        const loserVal = bf.candidates.find(c => c.ticker === loser)?.value;
        console.log(`     FILTER: ${bf.condition}`);
        console.log(`       ${winner}=${winnerVal?.toFixed(4)} vs ${loser}=${loserVal?.toFixed(4)} (margin: ${bf.filterMargin.toFixed(1)}%)`);
      }
      for (const bc of borderlineConditions) {
        console.log(`     IF: ${bc.condition}`);
        console.log(`       LHS=${bc.lhsValue?.toFixed(4)} vs RHS=${bc.rhsValue?.toFixed(4)} (margin: ${Math.abs(bc.margin).toFixed(1)}%)`);
      }
      console.log('');
    } else if (nullConds.length > 0) {
      console.log('  REASON: Insufficient data (some indicators returned NULL)');
      console.log('');
    }

    // ALWAYS run sensitivity test when there's a mismatch and no confirmed cause
    // This helps find which filter decisions would need to change
    console.log('  Running automatic sensitivity test...\n');

    // AUTOMATIC SENSITIVITY TEST
    // Try forcing different filter winners to see what adjustment would fix the mismatch
    const filterConditions = conditions.filter(c => c.isFilter && c.candidates && c.candidates.length > 1);

    if (filterConditions.length > 0) {
      console.log('  SENSITIVITY TEST: Trying different filter outcomes...');
      console.log(`     Found ${filterConditions.length} filters to test:\n`);

      // Debug: Show what filters we're testing
      for (const fc of filterConditions) {
        const candidateList = fc.candidates.map(c => c.ticker).join(', ');
        console.log(`     - ${fc.condition}`);
        console.log(`       Candidates: [${candidateList}]`);
        console.log(`       Selected: ${fc.selected?.[0] || 'none'}\n`);
      }

      console.log(`     Expected holdings: [${expectedTickers.join(', ')}]\n`);

      const fixes = [];
      let testCount = 0;
      for (const fc of filterConditions) {
        const currentWinner = fc.selected[0];
        const otherCandidates = fc.candidates.filter(c => c.ticker !== currentWinner);

        for (const alt of otherCandidates) {
          // Create override to force this alternative candidate to win
          // Include sortFn to uniquely identify this specific filter
          const override = [{
            forcedWinner: alt.ticker,
            amongCandidates: fc.candidates.map(c => c.ticker),
            sortFn: fc.sortFn  // e.g., "MAR(10)", "RSI(10)", "StdDevRet(10)"
          }];

          // Re-evaluate holdings with this override
          const testHoldings = getAssetsWithWeights(score, dailyData, intradayData, selectedDate, '16:00', 1.0, false, override);
          const testTickers = testHoldings.filter(h => h.weight >= 0.001).map(h => h.ticker).sort();

          testCount++;
          // Show first few test results for debugging
          if (testCount <= 3) {
            console.log(`     Test ${testCount}: Force ${alt.ticker} to win in ${fc.condition.slice(0, 30)}...`);
            console.log(`       Result: [${testTickers.join(', ')}]`);
            console.log(`       Match: ${JSON.stringify(testTickers) === JSON.stringify(expectedTickers) ? 'YES' : 'NO'}\n`);
          }

          // Check if this produces matching holdings
          if (JSON.stringify(testTickers) === JSON.stringify(expectedTickers)) {
            const winnerVal = fc.candidates.find(c => c.ticker === currentWinner)?.value;
            const altVal = alt.value;
            const diff = winnerVal - altVal;
            const pctAdjust = winnerVal !== 0 ? ((altVal - winnerVal) / Math.abs(winnerVal) * 100) : 0;

            fixes.push({
              condition: fc.condition,
              currentWinner,
              winnerVal,
              neededWinner: alt.ticker,
              neededVal: altVal,
              diff,
              pctAdjust,
              margin: fc.filterMargin
            });
          }
        }
      }

      if (fixes.length > 0) {
        console.log('  ✓ FOUND FIX: Adjusting these filter outcomes produces matching holdings:\n');
        for (const fix of fixes) {
          console.log(`     ${fix.condition}`);
          console.log(`       Our pick:      ${fix.currentWinner} = ${fix.winnerVal?.toFixed(6)}`);
          console.log(`       Needed pick:   ${fix.neededWinner} = ${fix.neededVal?.toFixed(6)}`);
          const direction = fix.pctAdjust > 0 ? 'increase' : 'decrease';
          console.log(`       Fix: ${direction} ${fix.currentWinner} indicator by ~${Math.abs(fix.pctAdjust).toFixed(1)}%`);
          console.log(`            OR ${fix.pctAdjust > 0 ? 'decrease' : 'increase'} ${fix.neededWinner} indicator by ~${Math.abs(fix.pctAdjust).toFixed(1)}%`);
          console.log(`       Margin was: ${fix.margin?.toFixed(1)}% (data source diff: Yahoo vs Xignite)\n`);
        }
      } else {
        // Try combinations of 2 filter overrides
        console.log('     Single filter flips don\'t fix it, trying combinations of 2...\n');

        let foundCombo = false;
        outer: for (let i = 0; i < filterConditions.length && !foundCombo; i++) {
          for (let j = i + 1; j < filterConditions.length && !foundCombo; j++) {
            const fc1 = filterConditions[i];
            const fc2 = filterConditions[j];

            for (const alt1 of fc1.candidates.filter(c => c.ticker !== fc1.selected[0])) {
              for (const alt2 of fc2.candidates.filter(c => c.ticker !== fc2.selected[0])) {
                const override = [
                  { forcedWinner: alt1.ticker, amongCandidates: fc1.candidates.map(c => c.ticker) },
                  { forcedWinner: alt2.ticker, amongCandidates: fc2.candidates.map(c => c.ticker) }
                ];

                const testHoldings = getAssetsWithWeights(score, dailyData, intradayData, selectedDate, '16:00', 1.0, false, override);
                const testTickers = testHoldings.filter(h => h.weight >= 0.001).map(h => h.ticker).sort();

                if (JSON.stringify(testTickers) === JSON.stringify(expectedTickers)) {
                  console.log('  ✓ FOUND FIX (combination of 2 filters):\n');
                  console.log(`     1. ${fc1.condition}`);
                  console.log(`        Change: ${fc1.selected[0]} → ${alt1.ticker}`);
                  console.log(`     2. ${fc2.condition}`);
                  console.log(`        Change: ${fc2.selected[0]} → ${alt2.ticker}\n`);
                  foundCombo = true;
                  break;
                }
              }
            }
          }
        }

        if (!foundCombo) {
          console.log('     No simple filter adjustments found that fix the mismatch.');
          console.log('     This may be due to IF/ELSE condition differences or other logic.\n');
        }
      }
    } else {
      console.log('  No filter decisions found to test.\n');
    }
  }

  // Show borderline warnings even on match (helps predict future mismatches)
  const allBorderline = conditions.filter(c =>
    (c.isFilter && c.filterMargin !== null && c.filterMargin < 5) ||
    (!c.isFilter && c.margin !== null && Math.abs(c.margin) < 5)
  );
  if (allBorderline.length > 0 && missing.length === 0 && extra.length === 0) {
    console.log('  ⚠️  WARNING: Close decisions that could flip with slight price differences:\n');
    for (const b of allBorderline) {
      if (b.isFilter) {
        console.log(`     FILTER: ${b.selected[0]} vs ${b.runnerUp} (margin: ${b.filterMargin.toFixed(1)}%)`);
      } else {
        console.log(`     IF: ${b.condition} (margin: ${Math.abs(b.margin).toFixed(1)}%)`);
      }
    }
    console.log('');
  }

  // Offer verbose option only if there's a mismatch or user wants details
  const showMore = await ask(r, '  Show details? [y/N]: ');
  if (showMore.toLowerCase() === 'y') {
    console.log('\n  OUR HOLDINGS WITH WEIGHTS:');
    for (const h of holdings.sort((a, b) => b.weight - a.weight)) {
      console.log(`    ${h.ticker.padEnd(8)} ${(h.weight * 100).toFixed(1)}%`);
    }

    const choice = await ask(r, '\n  Show decision tree trace? [y/N]: ');
    if (choice.toLowerCase() === 'y') {
      console.log('\n  DECISION TREE TRACE:\n');
      walkVerbose(score, dailyData, intradayData, selectedDate, '16:00');
    }
  }

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

     INTRADAY EXECUTION ANALYZER FOR COMPOSER  v1.3

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
     "Should I trade at BOTH morning AND Composer auto-EOD (${CONFIG.EOD_TIME})?"
     Simulates using "Run Now" in morning + letting Composer auto-trade EOD.

  2. SINGLE TIME REPLACEMENT ANALYSIS
     "Should I REPLACE ${CONFIG.EOD_TIME} with a different time?"
     Simulates trading ONLY at a different time, skipping EOD entirely.

${'─'.repeat(70)}
  SIGNAL SUB-ANALYSIS:
${'─'.repeat(70)}

  3. Signal Flip Frequency  - How often do signals differ morning vs EOD?
  4. Holdings Check by Date - What holdings at each time on a given day?

${'─'.repeat(70)}
  DEBUGGING:
${'─'.repeat(70)}

  6. Indicator Validation   - Debug indicator values vs Composer (trace mode)

${'─'.repeat(70)}
  SETTINGS:
${'─'.repeat(70)}

  7. Change EOD Time        - Currently: ${CONFIG.EOD_TIME} ${CONFIG.EOD_TIME === '16:00' ? '(Market Close)' : '(Intraday)'}

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
          if (id) await dailyCheck(id, r);
          break;
        }

        case '6': {
          const id = await ask(r, 'Symphony ID: ');
          if (id) await indicatorValidationMode(id, r);
          break;
        }

        case '7': {
          console.log('\n  EOD TIME SETTINGS');
          console.log('  ─────────────────────────────────────────────────────');
          console.log('  Composer executes trades between 3:45-4:00 PM ET.\n');
          console.log('  Options:');
          CONFIG.EOD_TIME_OPTIONS.forEach((t, i) => {
            const current = t === CONFIG.EOD_TIME ? ' ◀ CURRENT' : '';
            const desc = t === '15:45' ? '(Composer starts executing)' :
                        t === '15:50' ? '(Mid-execution window)' :
                        t === '15:55' ? '(Near end of window)' :
                        t === '16:00' ? '(Official market close)' : '';
            console.log(`    ${i + 1}. ${t} ${desc}${current}`);
          });
          console.log('');
          const eodChoice = await ask(r, '  Select EOD time [1-4]: ');
          const idx = parseInt(eodChoice) - 1;
          if (idx >= 0 && idx < CONFIG.EOD_TIME_OPTIONS.length) {
            CONFIG.EOD_TIME = CONFIG.EOD_TIME_OPTIONS[idx];
            console.log(`\n  ✓ EOD time set to ${CONFIG.EOD_TIME}`);
          } else {
            console.log('\n  No change made.');
          }
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

  // Filter out flags from args
  const filteredArgs = args.filter(a => !a.startsWith('--'));

  if (filteredArgs.length === 0) {
    await menu();
    return;
  }

  const cmd = filteredArgs[0].toLowerCase();
  const ids = filteredArgs.slice(1).filter(a => !a.startsWith('-'));

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

      case 'validate':
        if (ids.length === 0) {
          console.log('Usage: node script.js validate <symphony_id>');
          return;
        }
        await indicatorValidationMode(ids[0], rl());
        break;

      case 'help':
      case '-h':
      case '--help':
        console.log(`
Intraday Execution Analyzer for Composer v1.3

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
  node script.js validate <id>         Indicator validation mode (debug)

Analysis Types:
  DUAL:   "Should I trade at BOTH morning AND 3:45pm?"
  SINGLE: "Should I REPLACE 3:45pm with a different time?"

Debugging:
  VALIDATE: Trace through each IF/FILTER decision with indicator values
            Export to JSON for comparison with Composer
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
