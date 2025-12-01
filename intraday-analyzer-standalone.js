#!/usr/bin/env node
/**
 * Intraday Execution Analyzer for Composer
 *
 * Standalone single-file tool to analyze if executing strategies earlier
 * in the day (via "Run Now") improves returns vs 3:45 PM auto-rebalance.
 *
 * No dependencies - just Node.js 14+
 *
 * Usage:
 *   node intraday-analyzer-standalone.js                    # Interactive menu
 *   node intraday-analyzer-standalone.js full <id>          # Full analysis
 *   node intraday-analyzer-standalone.js flip <id> [days]   # Flip frequency
 *   node intraday-analyzer-standalone.js impact <id> [days] # Return impact
 *   node intraday-analyzer-standalone.js check <id>         # Today's signals
 *   node intraday-analyzer-standalone.js batch <id1> <id2>  # Multiple symphonies
 *
 * How to find Symphony ID:
 *   https://app.composer.trade/symphony/VfLXEvcG8VXvw52N8g9l/details
 *                                        ^^^^^^^^^^^^^^^^^^^^ this part
 */

const https = require('https');
const readline = require('readline');

// ============================================================================
// CONFIG
// ============================================================================

const CONFIG = {
  TEST_TIMES: ['09:30', '09:45', '10:00', '10:30', '11:00', '12:00'],
  EOD_TIME: '15:45',  // Composer executes ~3:51 PM, 15:45 is closest with 15m intervals
  BACKTEST_API: 'https://backtest-api.composer.trade/api/v1',
  FIRESTORE_BASE: 'https://firestore.googleapis.com/v1/projects/leverheads-278521/databases/(default)/documents/symphony',
  MAX_DAYS: 59
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

async function getIntraday(ticker, days) {
  return new Promise((resolve, reject) => {
    const d = Math.min(days, CONFIG.MAX_DAYS);
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
              byDT[d][t] = { close: q.close[i] };
            }
            resolve({ ticker, byDT });
          } else reject(new Error(j.chart?.error?.description || 'No data'));
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// ============================================================================
// INDICATORS
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
  return -maxDD; // Return as negative (e.g., -0.20 for 20% drawdown)
}

function stdDevReturn(prices, w) {
  if (!prices || prices.length < w + 1) return null;
  // Calculate returns over the window
  const slice = prices.slice(-(w + 1));
  const returns = [];
  for (let i = 1; i < slice.length; i++) {
    returns.push((slice[i] - slice[i-1]) / slice[i-1]);
  }
  // Calculate standard deviation
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
    default:
      console.warn(`  ⚠ Unknown indicator: ${fn}`);
      return null;
  }
}

// ============================================================================
// SYMPHONY ANALYSIS
// ============================================================================

function extractTickers(n, t = new Set()) {
  if (!n) return t;
  if (n.step === 'asset' && n.ticker) t.add(n.ticker);
  if (n['lhs-val'] && typeof n['lhs-val'] === 'string' && !n['lhs-val'].match(/^\d/)) t.add(n['lhs-val']);
  if (n['rhs-val'] && typeof n['rhs-val'] === 'string' && !n['rhs-val'].match(/^\d/) && !n['rhs-fixed-value?']) t.add(n['rhs-val']);
  if (n.children) n.children.forEach(c => extractTickers(c, t));
  return t;
}

function getPrices(data, date, time) {
  if (!data?.byDT) return null;
  const prices = [];
  for (const d of Object.keys(data.byDT).sort()) {
    if (d > date) break;
    for (const t of Object.keys(data.byDT[d]).sort()) {
      if (d === date && t > time) break;
      prices.push(data.byDT[d][t].close);
    }
  }
  return prices.length > 0 ? prices : null;
}

function evalCond(c, all, date, time) {
  const lp = getPrices(all[c.lv], date, time);
  const lVal = evalInd(c.lf, lp, c.lw || 14);
  if (lVal === null) return null;

  let rVal;
  if (c.rf) {
    rVal = parseFloat(c.rv);
  } else {
    const rp = getPrices(all[c.rv], date, time);
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

function getAssets(node, all, date, time) {
  const sel = [];
  function walk(n) {
    if (!n) return;
    if (n.step === 'asset' && n.ticker) { sel.push(n.ticker); return; }
    if (n.step === 'if') {
      let cond = null, els = null;
      for (const ch of (n.children || [])) {
        if (ch['is-else-condition?']) els = ch; else cond = ch;
      }
      if (cond) {
        const c = {
          lf: cond['lhs-fn'], lv: cond['lhs-val'], lw: cond['lhs-fn-params']?.window || 14,
          cmp: cond.comparator, rv: cond['rhs-val'], rf: cond['rhs-fixed-value?'],
          rfn: cond['rhs-fn'], rw: cond['rhs-fn-params']?.window || 14
        };
        const r = evalCond(c, all, date, time);
        if (r === true && cond.children) cond.children.forEach(walk);
        else if (r === false && els?.children) els.children.forEach(walk);
      }
      return;
    }
    if (n.children) n.children.forEach(walk);
  }
  walk(node);
  return [...new Set(sel)];
}

function calcRet(ticker, data, date, from, to) {
  const dd = data?.byDT?.[date];
  if (!dd) return null;
  const times = Object.keys(dd).sort();
  let fb = null, tb = null;
  for (const t of times) {
    if (t <= from) fb = dd[t];
    if (t <= to) tb = dd[t];
  }
  if (!fb || !tb) return null;
  return (tb.close - fb.close) / fb.close;
}

// ============================================================================
// DATA FETCHING
// ============================================================================

async function fetchAllData(tickers, days) {
  const all = {};
  for (const t of tickers) {
    process.stdout.write(`  ${t}... `);
    try {
      all[t] = await getIntraday(t, days);
      console.log('OK');
    } catch (e) { console.log(`skip (${e.message})`); }
    await sleep(800);
  }
  return all;
}

function getTradingDays(all, days) {
  const dates = new Set();
  for (const t of Object.keys(all)) {
    for (const d of Object.keys(all[t].byDT)) dates.add(d);
  }
  return Array.from(dates).sort().slice(-Math.min(days, CONFIG.MAX_DAYS));
}

// ============================================================================
// ANALYSIS MODES
// ============================================================================

async function fullAnalysis(id, days) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log('  FULL INTRADAY ANALYSIS');
  console.log(`${'═'.repeat(60)}\n`);

  console.log(`Fetching symphony ${id}...`);
  const { score, name } = await getSymphony(id);
  console.log(`Name: ${name}\n`);

  const tickers = Array.from(extractTickers(score));
  console.log(`Tickers: ${tickers.join(', ')}\n`);

  console.log('Fetching intraday data...');
  const all = await fetchAllData(tickers, days);

  if (Object.keys(all).length === 0) {
    console.log('\nNo data available. Cannot analyze.');
    return;
  }

  const tradingDays = getTradingDays(all, days);
  console.log(`\nAnalyzing ${tradingDays.length} days...\n`);

  console.log(`${'─'.repeat(60)}`);
  console.log('| Time  | Flip % | Win % | Avg Advantage | Total Impact |');
  console.log('|-------|--------|-------|---------------|--------------|');

  let bestTime = null, bestAdv = -Infinity;

  for (const tt of CONFIG.TEST_TIMES) {
    let flips = 0, wins = 0, totAdv = 0, valid = 0;

    for (const date of tradingDays) {
      const early = getAssets(score, all, date, tt);
      const eod = getAssets(score, all, date, CONFIG.EOD_TIME);
      if (early.length === 0 || eod.length === 0) continue;
      valid++;

      if (JSON.stringify(early.sort()) !== JSON.stringify(eod.sort())) {
        flips++;
        let eRet = 0, oRet = 0, eCnt = 0, oCnt = 0;
        for (const t of early) {
          const r = calcRet(t, all[t], date, tt, CONFIG.EOD_TIME);
          if (r !== null) { eRet += r; eCnt++; }
        }
        for (const t of eod) {
          const r = calcRet(t, all[t], date, tt, CONFIG.EOD_TIME);
          if (r !== null) { oRet += r; oCnt++; }
        }
        if (eCnt > 0) eRet /= eCnt;
        if (oCnt > 0) oRet /= oCnt;
        const adv = eRet - oRet;
        totAdv += adv;
        if (adv > 0.001) wins++;
      }
    }

    const flipPct = valid > 0 ? (flips / valid * 100).toFixed(0) + '%' : 'N/A';
    const winPct = flips > 0 ? (wins / flips * 100).toFixed(0) + '%' : 'N/A';
    const avgAdv = flips > 0 ? totAdv / flips * 100 : 0;
    const totImp = totAdv * 100;

    console.log(`| ${tt} | ${flipPct.padStart(6)} | ${winPct.padStart(5)} | ${(avgAdv >= 0 ? '+' : '') + avgAdv.toFixed(2) + '%'.padStart(13)} | ${(totImp >= 0 ? '+' : '') + totImp.toFixed(1) + '%'.padStart(12)} |`);

    if (avgAdv > bestAdv && valid >= 5) { bestAdv = avgAdv; bestTime = tt; }
  }

  console.log(`${'─'.repeat(60)}\n`);

  console.log('RECOMMENDATION:');
  if (bestTime && bestAdv > 0.5) {
    console.log(`  ✅ Consider "Run Now" at ${bestTime} (avg +${bestAdv.toFixed(2)}% advantage)`);
  } else if (bestAdv < -0.5) {
    console.log('  ⚠️  Stick with EOD - early execution shows negative impact');
  } else {
    console.log('  📊 No significant timing edge - use default EOD');
  }
  console.log(`\nNote: Based on ${tradingDays.length} days (Yahoo limits to ~60 days)\n`);
}

async function flipAnalysis(id, days) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log('  SIGNAL FLIP ANALYZER');
  console.log(`${'═'.repeat(60)}\n`);

  console.log(`Fetching symphony ${id}...`);
  const { score, name } = await getSymphony(id);
  console.log(`Name: ${name}\n`);

  const tickers = Array.from(extractTickers(score));
  console.log('Fetching data...');
  const all = await fetchAllData(tickers, days);
  const tradingDays = getTradingDays(all, days);

  console.log(`\n| Time  | Valid | Flips | Flip Rate |`);
  console.log('|-------|-------|-------|-----------|');

  for (const tt of CONFIG.TEST_TIMES) {
    let flips = 0, valid = 0;
    for (const date of tradingDays) {
      const early = getAssets(score, all, date, tt);
      const eod = getAssets(score, all, date, CONFIG.EOD_TIME);
      if (early.length === 0 || eod.length === 0) continue;
      valid++;
      if (JSON.stringify(early.sort()) !== JSON.stringify(eod.sort())) flips++;
    }
    const rate = valid > 0 ? (flips / valid * 100).toFixed(0) + '%' : 'N/A';
    console.log(`| ${tt} | ${String(valid).padStart(5)} | ${String(flips).padStart(5)} | ${rate.padStart(9)} |`);
  }
  console.log('');
}

async function impactAnalysis(id, days) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log('  RETURN IMPACT ANALYZER');
  console.log(`${'═'.repeat(60)}\n`);

  console.log(`Fetching symphony ${id}...`);
  const { score, name } = await getSymphony(id);
  console.log(`Name: ${name}\n`);

  const tickers = Array.from(extractTickers(score));
  console.log('Fetching data...');
  const all = await fetchAllData(tickers, days);
  const tradingDays = getTradingDays(all, days);

  console.log(`\n| Time  | Flips | Wins | Avg Impact | Total |`);
  console.log('|-------|-------|------|------------|-------|');

  for (const tt of CONFIG.TEST_TIMES) {
    let flips = 0, wins = 0, totAdv = 0;
    for (const date of tradingDays) {
      const early = getAssets(score, all, date, tt);
      const eod = getAssets(score, all, date, CONFIG.EOD_TIME);
      if (early.length === 0 || eod.length === 0) continue;

      if (JSON.stringify(early.sort()) !== JSON.stringify(eod.sort())) {
        flips++;
        let eRet = 0, oRet = 0, eCnt = 0, oCnt = 0;
        for (const t of early) {
          const r = calcRet(t, all[t], date, tt, CONFIG.EOD_TIME);
          if (r !== null) { eRet += r; eCnt++; }
        }
        for (const t of eod) {
          const r = calcRet(t, all[t], date, tt, CONFIG.EOD_TIME);
          if (r !== null) { oRet += r; oCnt++; }
        }
        if (eCnt > 0) eRet /= eCnt;
        if (oCnt > 0) oRet /= oCnt;
        const adv = eRet - oRet;
        totAdv += adv;
        if (adv > 0.001) wins++;
      }
    }
    const avgAdv = flips > 0 ? totAdv / flips * 100 : 0;
    console.log(`| ${tt} | ${String(flips).padStart(5)} | ${String(wins).padStart(4)} | ${(avgAdv >= 0 ? '+' : '') + avgAdv.toFixed(2).padStart(9)}% | ${(totAdv * 100 >= 0 ? '+' : '') + (totAdv * 100).toFixed(1).padStart(4)}% |`);
  }
  console.log('');
}

async function dailyCheck(id) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log('  DAILY SIGNAL CHECK');
  console.log(`${'═'.repeat(60)}\n`);

  console.log(`Fetching symphony ${id}...`);
  const { score, name } = await getSymphony(id);
  console.log(`Name: ${name}\n`);

  const tickers = Array.from(extractTickers(score));
  console.log('Fetching current data...');
  const all = await fetchAllData(tickers, 5);

  const today = new Date().toISOString().split('T')[0];
  const dates = getTradingDays(all, 5);
  const latestDate = dates[dates.length - 1] || today;

  console.log(`\nSignals for ${latestDate}:\n`);

  for (const tt of [...CONFIG.TEST_TIMES, CONFIG.EOD_TIME]) {
    const assets = getAssets(score, all, latestDate, tt);
    console.log(`  ${tt}: ${assets.length > 0 ? assets.join(', ') : '(no signal)'}`);
  }

  const early = getAssets(score, all, latestDate, CONFIG.TEST_TIMES[0]);
  const eod = getAssets(score, all, latestDate, CONFIG.EOD_TIME);

  console.log('');
  if (JSON.stringify(early.sort()) !== JSON.stringify(eod.sort())) {
    console.log(`  ⚠️  Signals differ between ${CONFIG.TEST_TIMES[0]} and EOD!`);
  } else {
    console.log('  ✓ Signals consistent throughout day');
  }
  console.log('');
}

async function batchAnalysis(ids) {
  console.log(`\n${'═'.repeat(70)}`);
  console.log('  BATCH ANALYSIS');
  console.log(`${'═'.repeat(70)}\n`);
  console.log(`Analyzing ${ids.length} symphonies...\n`);

  const results = [];

  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    process.stdout.write(`[${i + 1}/${ids.length}] ${id}... `);

    try {
      const { score, name } = await getSymphony(id);
      const tickers = Array.from(extractTickers(score));
      const all = await fetchAllData(tickers, 30);
      const tradingDays = getTradingDays(all, 30);

      let bestTime = 'EOD', bestAdv = 0;

      for (const tt of CONFIG.TEST_TIMES) {
        let flips = 0, totAdv = 0, valid = 0;
        for (const date of tradingDays) {
          const early = getAssets(score, all, date, tt);
          const eod = getAssets(score, all, date, CONFIG.EOD_TIME);
          if (early.length === 0 || eod.length === 0) continue;
          valid++;
          if (JSON.stringify(early.sort()) !== JSON.stringify(eod.sort())) {
            flips++;
            let eRet = 0, oRet = 0, eCnt = 0, oCnt = 0;
            for (const t of early) {
              const r = calcRet(t, all[t], date, tt, CONFIG.EOD_TIME);
              if (r !== null) { eRet += r; eCnt++; }
            }
            for (const t of eod) {
              const r = calcRet(t, all[t], date, tt, CONFIG.EOD_TIME);
              if (r !== null) { oRet += r; oCnt++; }
            }
            if (eCnt > 0) eRet /= eCnt;
            if (oCnt > 0) oRet /= oCnt;
            totAdv += eRet - oRet;
          }
        }
        const avgAdv = flips > 0 ? totAdv / flips * 100 : 0;
        if (avgAdv > bestAdv) { bestAdv = avgAdv; bestTime = tt; }
      }

      results.push({ id, name, bestTime, bestAdv });
      console.log(`OK (${name.substring(0, 25)})`);
    } catch (e) {
      results.push({ id, name: 'Error', error: e.message });
      console.log(`FAIL`);
    }
    await sleep(1000);
  }

  console.log(`\n${'─'.repeat(70)}`);
  console.log('| Symphony                         | Best Time | Advantage |');
  console.log('|----------------------------------|-----------|-----------|');

  for (const r of results) {
    if (r.error) {
      console.log(`| ${r.id.padEnd(32)} | ERROR     |           |`);
    } else {
      const n = r.name.length > 32 ? r.name.substring(0, 29) + '...' : r.name;
      const adv = r.bestAdv > 0 ? '+' + r.bestAdv.toFixed(1) + '%' : r.bestAdv.toFixed(1) + '%';
      console.log(`| ${n.padEnd(32)} | ${r.bestTime.padEnd(9)} | ${adv.padStart(9)} |`);
    }
  }
  console.log(`${'─'.repeat(70)}\n`);
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
Date Range Options (Yahoo Finance limits intraday to ~60 days):
  1. Maximum available (${CONFIG.MAX_DAYS} days / ~40 trading days)
  2. Last 30 days (~20 trading days)
  3. Last 14 days (~10 trading days)${oosDays && oosDays <= CONFIG.MAX_DAYS ? `
  4. From OOS date (${oosDays} days)` : ''}
  5. Custom number of days
`);

  const choice = await ask(r, 'Select [1]: ');

  switch (choice) {
    case '2': return 30;
    case '3': return 14;
    case '4':
      if (oosDays && oosDays <= CONFIG.MAX_DAYS) return oosDays;
      console.log('OOS date too old, using max');
      return CONFIG.MAX_DAYS;
    case '5':
      const custom = await ask(r, `Enter days (max ${CONFIG.MAX_DAYS}): `);
      const d = parseInt(custom);
      if (d && d > 0) return Math.min(d, CONFIG.MAX_DAYS);
      return 30;
    case '1':
    default:
      return CONFIG.MAX_DAYS;
  }
}

// ============================================================================
// MENU
// ============================================================================

async function menu() {
  const r = rl();

  console.log(`
${'═'.repeat(60)}

     ██╗███╗   ██╗████████╗██████╗  █████╗ ██████╗  █████╗ ██╗   ██╗
     ██║████╗  ██║╚══██╔══╝██╔══██╗██╔══██╗██╔══██╗██╔══██╗╚██╗ ██╔╝
     ██║██╔██╗ ██║   ██║   ██████╔╝███████║██║  ██║███████║ ╚████╔╝
     ██║██║╚██╗██║   ██║   ██╔══██╗██╔══██║██║  ██║██╔══██║  ╚██╔╝
     ██║██║ ╚████║   ██║   ██║  ██║██║  ██║██████╔╝██║  ██║   ██║
     ╚═╝╚═╝  ╚═══╝   ╚═╝   ╚═╝  ╚═╝╚═╝  ╚═╝╚═════╝ ╚═╝  ╚═╝   ╚═╝

        INTRADAY EXECUTION ANALYZER FOR COMPOSER

${'═'.repeat(60)}
`);

  let running = true;
  while (running) {
    console.log(`
  1. Full Analysis      - Complete analysis with recommendation
  2. Signal Flip        - How often do early signals differ?
  3. Return Impact      - What's the return difference?
  4. Daily Check        - Should I "Run Now" today?
  5. Batch Analysis     - Analyze multiple symphonies
  q. Quit
`);

    const choice = await ask(r, 'Select: ');

    try {
      switch (choice) {
        case '1': {
          const id = await ask(r, 'Symphony ID: ');
          if (id) {
            const days = await askDateRange(r, id);
            await fullAnalysis(id, days);
          }
          break;
        }
        case '2': {
          const id = await ask(r, 'Symphony ID: ');
          if (id) {
            const days = await askDateRange(r, id);
            await flipAnalysis(id, days);
          }
          break;
        }
        case '3': {
          const id = await ask(r, 'Symphony ID: ');
          if (id) {
            const days = await askDateRange(r, id);
            await impactAnalysis(id, days);
          }
          break;
        }
        case '4': {
          const id = await ask(r, 'Symphony ID: ');
          if (id) await dailyCheck(id);
          break;
        }
        case '5': {
          const ids = await ask(r, 'Symphony IDs (comma-separated): ');
          if (ids) await batchAnalysis(ids.split(/[,\s]+/).filter(Boolean));
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
  const id = args[1];
  const days = parseInt(args[2]) || 30;

  try {
    switch (cmd) {
      case 'full':
        if (!id) { console.log('Usage: node script.js full <symphony_id>'); return; }
        const oos = await getOOSDate(id);
        let d = days;
        if (oos && !args[2]) {
          const dd = Math.floor((Date.now() - new Date(oos).getTime()) / 86400000);
          if (dd <= CONFIG.MAX_DAYS && dd >= 14) { d = dd; console.log(`Using OOS: ${d} days`); }
        }
        await fullAnalysis(id, d);
        break;
      case 'flip':
        if (!id) { console.log('Usage: node script.js flip <symphony_id> [days]'); return; }
        await flipAnalysis(id, days);
        break;
      case 'impact':
        if (!id) { console.log('Usage: node script.js impact <symphony_id> [days]'); return; }
        await impactAnalysis(id, days);
        break;
      case 'check':
        if (!id) { console.log('Usage: node script.js check <symphony_id>'); return; }
        await dailyCheck(id);
        break;
      case 'batch':
        const ids = args.slice(1).filter(a => !a.startsWith('-'));
        if (ids.length === 0) { console.log('Usage: node script.js batch <id1> <id2> ...'); return; }
        await batchAnalysis(ids);
        break;
      case 'help':
      case '-h':
      case '--help':
        console.log(`
Intraday Execution Analyzer for Composer

Usage:
  node script.js                      Interactive menu (with date options)
  node script.js full <id> [days]     Full analysis
  node script.js flip <id> [days]     Signal flip frequency
  node script.js impact <id> [days]   Return impact analysis
  node script.js check <id>           Today's signal check
  node script.js batch <id1> <id2>    Batch analysis

Date Range:
  Yahoo Finance limits intraday data to ~60 calendar days (~40 trading days).
  Interactive menu offers: Max (60), 30 days, 14 days, OOS date, or custom.
  CLI defaults to 30 days if not specified, or OOS date if available.

Find Symphony ID in URL:
  https://app.composer.trade/symphony/VfLXEvcG8VXvw52N8g9l/details
                                       ^^^^^^^^^^^^^^^^^^^^ this part
`);
        break;
      default:
        // Assume it's a symphony ID for quick full analysis
        const oosD = await getOOSDate(cmd);
        let dd = 30;
        if (oosD) {
          const ddd = Math.floor((Date.now() - new Date(oosD).getTime()) / 86400000);
          if (ddd <= CONFIG.MAX_DAYS && ddd >= 14) { dd = ddd; console.log(`Using OOS: ${dd} days`); }
        }
        await fullAnalysis(cmd, dd);
    }
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}

main();
