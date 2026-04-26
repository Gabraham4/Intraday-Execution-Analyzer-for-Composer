#!/usr/bin/env node
/**
 * Intraday Execution Analyzer for Composer - v2.0 (Alpaca Edition)
 *
 * Data Sources:
 *   PRIMARY: Alpaca Markets API (free paper account, 7+ years of 5-min bars)
 *   FALLBACK: Yahoo Finance (no API key needed, limited to ~60 days intraday)
 *
 * Architecture:
 *   - Alpaca provides extended intraday history (up to 730 days of 5-min bars)
 *   - Yahoo Finance used as fallback when Alpaca keys are not configured
 *   - Per-ticker fallback: if Alpaca fails for a ticker, Yahoo is tried automatically
 *   - Debug-compare mode: fetch from both sources, report price discrepancies
 *
 * Based on v1.3 (Yahoo-only). All indicator calculations, evaluation logic,
 * backtest functions, and analysis routines are unchanged.
 *
 * Config: API keys encrypted with AES-256-GCM in analyzer-config.enc (gitignored)
 * Setup: node intraday-analyzer-alpaca-v2.0.js config
 */

const https = require('https');
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

// ============================================================================
// CONFIG
// ============================================================================

// In a pkg binary, __dirname is a read-only snapshot. Write data next to the executable instead.
const APP_DIR = process.pkg ? path.dirname(process.execPath) : __dirname;

const CONFIG_FILE = path.join(APP_DIR, 'analyzer-config.enc');
const CONFIG_FILE_LEGACY = path.join(APP_DIR, 'analyzer-config.json');

const CONFIG = {
  TEST_TIMES: ['09:30', '09:35', '09:45', '10:00', '10:30', '11:00', '12:00', '13:00', '13:45'],
  EOD_TIME: '16:00',
  EOD_TIME_OPTIONS: ['15:45', '15:50', '15:55', '16:00', '16:00a'],
  INTRADAY_INTERVAL: '5m',       // 5-minute bars for Yahoo
  ALPACA_TIMEFRAME: '15Min',     // Default: 15Min (fast). Use --5min for 5Min, --1min for 1Min (max precision)
  BACKTEST_API: 'https://backtest-api.composer.trade/api/v1',
  FIRESTORE_BASE: 'https://firestore.googleapis.com/v1/projects/leverheads-278521/databases/(default)/documents/symphony',
  ALPACA_DATA_API: 'https://data.alpaca.markets/v2',
  MAX_INTRADAY_DAYS_ALPACA: 1100, // ~3 years of intraday data via Alpaca (5yr rolling cap, 2016 floor)
  MAX_INTRADAY_DAYS_YAHOO: 59,    // Yahoo limit
  MAX_INTRADAY_DAYS: 59,          // Set dynamically based on data source
  MAX_DAILY_DAYS: 1600,           // ~6.4 years: intraday window (up to 1100 days) + Wilder RSI warmup (~500 days)
  alpaca: null,                   // Loaded from config file at startup
  composer: null,                 // Loaded from config file at startup
  dataSource: 'hybrid',           // 'hybrid' (Alpaca intraday + Yahoo daily) | 'alpaca' | 'yahoo' | 'auto'
  debugCompare: false,            // --debug-compare flag
  debugInverseVol: false,         // --debug-invvol flag
  walkforward: false,             // --walkforward flag (Tier 1: consistency check)
  wfWindowSize: 21,               // Walk-forward window size (~1 month)
  wfStepSize: 21,                 // Walk-forward step size (non-overlapping)
  oosWalkforward: false,          // --oos-wf flag (Tier 2: true out-of-sample)
  oosTrainWindowSize: 63,         // OOS training window (~3 months)
  oosStepSize: 21,                // OOS test window size (~1 month)
  wfMaxCandidates: 10,            // Max candidate times for WF testing (both tiers)
  composerBaseline: false,        // Use Composer's actual backtest holdings as EOD baseline
  executionThreshold: null,       // Min allocation change to trigger intraday execution (e.g., 0.05 = 5%). Matches n8n's 5% skip rule. null = always execute.
  takeProfitThreshold: null,      // Min portfolio gain since prev EOD to trigger intraday execution (e.g., 0.01 = 1%). Only execute Run Now on "green" days. null = disabled.
  minReliability: 25,             // Min holdings reliability score (0-100) to proceed with backtests. Below this = skip strategy. 0 = always run.
  dateStart: null,                // Custom backtest start date (YYYY-MM-DD) or null for all
  dateEnd: null,                  // Custom backtest end date (YYYY-MM-DD) or null for all
};

// ============================================================================
// CONFIG FILE MANAGEMENT (AES-256-GCM encrypted)
// ============================================================================

function deriveEncryptionKey() {
  // Use stable hardware UUID (macOS IOPlatformUUID) instead of hostname,
  // which can change with DHCP/cable modem swaps
  let machineId;
  try {
    machineId = require('child_process')
      .execSync('ioreg -rd1 -c IOPlatformExpertDevice | awk -F\\" \'/IOPlatformUUID/{print $4}\'', { timeout: 3000 })
      .toString().trim();
  } catch (e) {
    machineId = '';
  }
  // Fallback to hostname if UUID unavailable (non-macOS)
  const material = (machineId || os.hostname()) + os.userInfo().username + 'intraday-analyzer-salt';
  return crypto.createHash('sha256').update(material).digest();
}

function encryptConfig(data) {
  const key = deriveEncryptionKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const json = JSON.stringify(data);
  let encrypted = cipher.update(json, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return JSON.stringify({ v: 1, iv: iv.toString('hex'), tag, data: encrypted });
}

function decryptConfig(fileContent) {
  const { iv, tag, data } = JSON.parse(fileContent);
  const key = deriveEncryptionKey();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  let decrypted = decipher.update(data, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return JSON.parse(decrypted);
}

function loadConfigFromFile() {
  // Try encrypted file first
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      return decryptConfig(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch (e) {
      // Corrupted or wrong machine — fall through
    }
  }
  // Auto-migrate from legacy plaintext config
  if (fs.existsSync(CONFIG_FILE_LEGACY)) {
    try {
      const legacy = JSON.parse(fs.readFileSync(CONFIG_FILE_LEGACY, 'utf8'));
      // Save as encrypted
      fs.writeFileSync(CONFIG_FILE, encryptConfig(legacy), 'utf8');
      // Remove plaintext file
      fs.unlinkSync(CONFIG_FILE_LEGACY);
      return legacy;
    } catch (e) { /* ignore */ }
  }
  return {};
}

function loadConfig() {
  const fileConfig = loadConfigFromFile();

  // Priority: env vars > new field name > legacy field name (pre-rename migration)
  const apiKey = process.env.ALPACA_API_KEY || fileConfig.alpacaApiKey || fileConfig.apiKey || null;
  const apiSecret = process.env.ALPACA_API_SECRET || fileConfig.alpacaApiSecret || fileConfig.apiSecret || null;
  const dataSource = process.env.DATA_SOURCE || fileConfig.dataSource || 'hybrid';
  const composerKeyId = process.env.COMPOSER_KEY_ID || fileConfig.composerKeyId || null;
  const composerSecret = process.env.COMPOSER_SECRET || fileConfig.composerSecret || null;

  return { apiKey, apiSecret, dataSource, composerKeyId, composerSecret };
}

function saveConfig(config) {
  // Read existing encrypted file first to preserve all fields
  let existing = {};
  try {
    existing = loadConfigFromFile();
  } catch (e) { /* ignore */ }

  const data = {
    ...existing,
    alpacaApiKey: config.apiKey ?? existing.alpacaApiKey ?? '',
    alpacaApiSecret: config.apiSecret ?? existing.alpacaApiSecret ?? '',
    dataSource: config.dataSource || existing.dataSource || 'hybrid',
    composerKeyId: config.composerKeyId ?? existing.composerKeyId ?? '',
    composerSecret: config.composerSecret ?? existing.composerSecret ?? '',
  };
  fs.writeFileSync(CONFIG_FILE, encryptConfig(data), 'utf8');
}

function hasAlpacaKeys() {
  return !!(CONFIG.alpaca?.apiKey && CONFIG.alpaca?.apiSecret);
}

function hasComposerKeys() {
  return !!(CONFIG.composer?.keyId && CONFIG.composer?.secret);
}

// Load config at startup
(function initConfig() {
  const cfg = loadConfig();
  CONFIG.alpaca = cfg;
  CONFIG.composer = { keyId: cfg.composerKeyId, secret: cfg.composerSecret };
  // Migrate 'auto' → 'hybrid': Alpaca IEX daily data has stale prices for low-volume ETFs
  // (e.g., XNTK shows 212.42 when actual close is 220.12). Hybrid uses Yahoo daily (accurate)
  // + Alpaca intraday (extended history). Use --source=alpaca to override if needed.
  CONFIG.dataSource = cfg.dataSource === 'auto' ? 'hybrid' : cfg.dataSource;

  if (hasAlpacaKeys()) {
    CONFIG.MAX_INTRADAY_DAYS = CONFIG.MAX_INTRADAY_DAYS_ALPACA;
  } else {
    CONFIG.MAX_INTRADAY_DAYS = CONFIG.MAX_INTRADAY_DAYS_YAHOO;
  }

  // --5min flag: use 5-minute bars for maximum precision (3x slower)
  if (process.argv.includes('--5min')) {
    CONFIG.ALPACA_TIMEFRAME = '5Min';
  }
  // --1min flag: use 1-minute bars for minute-level precision (15x slower than 15Min)
  if (process.argv.includes('--1min')) {
    CONFIG.ALPACA_TIMEFRAME = '1Min';
  }
})();

// ============================================================================
// ALPACA RATE LIMITER (200 requests/minute for free tier)
// ============================================================================

class AlpacaRateLimiter {
  constructor(maxPerMinute = 200) {
    this.maxPerMinute = maxPerMinute;
    this.requests = [];  // timestamps of recent requests
  }

  async waitIfNeeded() {
    const now = Date.now();
    // Remove requests older than 60 seconds
    this.requests = this.requests.filter(t => now - t < 60000);

    if (this.requests.length >= this.maxPerMinute - 5) {  // 5-request safety buffer
      const oldest = this.requests[0];
      const waitTime = Math.max(1000, 60000 - (now - oldest) + 1000);
      console.log(`    Rate limit approaching (${this.requests.length}/${this.maxPerMinute}). Waiting ${Math.ceil(waitTime / 1000)}s...`);
      await new Promise(r => setTimeout(r, waitTime));
      this.requests = this.requests.filter(t => Date.now() - t < 60000);
    }

    this.requests.push(Date.now());
  }
}

const alpacaRateLimiter = new AlpacaRateLimiter(200);

// ============================================================================
// DIAGNOSTICS - Track data issues for error reporting
// ============================================================================

// Track tickers with split issues (for split detection / Yahoo fallback)
let SPLIT_WARNINGS = [];

let DIAGNOSTICS = {
  failedTickers: {},      // {ticker: {intraday: 'error msg', daily: 'error msg'}}
  nullConditions: [],     // [{condition: 'description', reason: 'why null', ticker: 'which ticker'}]
  reset() {
    this.failedTickers = {};
    this.nullConditions = [];
    SPLIT_WARNINGS = [];
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
  const splitCount = SPLIT_WARNINGS.length;

  if (failedCount === 0 && nullCount === 0 && splitCount === 0) return;

  console.log(`\n${'─'.repeat(80)}`);
  console.log('  DATA DIAGNOSTICS - Why some signals may be missing');
  console.log(`${'─'.repeat(80)}`);

  if (splitCount > 0) {
    console.log('\n  SPLIT ADJUSTMENT ISSUES DETECTED:');
    for (const warn of SPLIT_WARNINGS) {
      console.log(`    ${warn.ticker}: ${warn.action}`);
      for (const issue of warn.issues) {
        console.log(`      - ${issue.date}: ${issue.from} -> ${issue.to} (${issue.change}, likely ${issue.likelySplit} split)`);
      }
    }
  }

  if (failedCount > 0) {
    const source = hasAlpacaKeys() ? 'Alpaca + Yahoo' : 'Yahoo Finance';
    console.log(`\n  FAILED TICKER LOADS (${source}):`);
    for (const [ticker, errors] of Object.entries(DIAGNOSTICS.failedTickers)) {
      if (errors.intraday) {
        console.log(`    ${ticker} (intraday): ${errors.intraday}`);
      }
      if (errors.daily) {
        console.log(`    ${ticker} (daily): ${errors.daily}`);
      }
    }
  }

  if (nullCount > 0) {
    console.log('\n  CONDITIONS RETURNED NULL (missing data):');
    for (const nc of DIAGNOSTICS.nullConditions) {
      console.log(`    ${nc.condition}`);
      console.log(`      Reason: ${nc.reason}`);
    }
    if (DIAGNOSTICS.nullConditions.length >= 10) {
      console.log('    ... (showing first 10 only)');
    }
  }

  console.log(`\n  TIP: If a key ticker is missing, the strategy may not generate signals.\n`);
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

// Normalize Composer ticker format for Yahoo Finance
// EQUITIES::XLU//USD -> XLU
// CRYPTO::BTC//USD -> BTC-USD (Yahoo uses hyphen)
// BRK/B -> BRK-B (Yahoo uses hyphen for share classes)
// XLU -> XLU (no change)
function normalizeTickerYahoo(ticker) {
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

// Normalize ticker for Alpaca API
// Handles both raw Composer format AND pre-Yahoo-normalized format:
//   EQUITIES::XLU//USD -> XLU     |  XLU -> XLU
//   CRYPTO::BTC//USD -> BTC/USD   |  BTC-USD -> BTC/USD
//   BRK/B -> BRK.B               |  BRK-B -> BRK.B
function normalizeTickerAlpaca(ticker) {
  if (!ticker) return ticker;

  let normalized = ticker;

  if (normalized.startsWith('EQUITIES::')) {
    normalized = normalized.replace('EQUITIES::', '').replace('//USD', '');
  }

  if (normalized.startsWith('CRYPTO::')) {
    normalized = normalized.replace('CRYPTO::', '').replace('//', '/');
  }

  // Handle Yahoo-normalized crypto: BTC-USD -> BTC/USD (Alpaca uses slash)
  if (normalized.endsWith('-USD')) {
    normalized = normalized.replace('-USD', '/USD');
  }

  // BRK/B -> BRK.B (but not crypto which has slash like BTC/USD)
  if (normalized.includes('/') && !normalized.includes('USD')) {
    normalized = normalized.replace('/', '.');
  }

  // Handle Yahoo-normalized share classes: BRK-B -> BRK.B
  // Only match single letter after hyphen (share class), not crypto like BTC-USD (already handled)
  if (normalized.includes('-') && /^[A-Z]+-[A-Z]$/.test(normalized)) {
    normalized = normalized.replace('-', '.');
  }

  return normalized;
}

// Default normalization (for non-data-source-specific uses like Composer API)
function normalizeTicker(ticker) {
  return normalizeTickerYahoo(ticker);
}

// Normalize all ticker references in the score tree after fetching from Composer API.
// This strips EQUITIES::TICKER//USD → TICKER, CRYPTO::BTC//USD → BTC-USD, etc.
// so all downstream code works with clean ticker names.
function normalizeScoreTreeTickers(node) {
  if (!node) return node;
  if (node.ticker) node.ticker = normalizeTicker(node.ticker);
  if (node['lhs-val'] && typeof node['lhs-val'] === 'string' && (node['lhs-val'].includes('::') || node['lhs-val'].includes('//')))
    node['lhs-val'] = normalizeTicker(node['lhs-val']);
  if (node['rhs-val'] && typeof node['rhs-val'] === 'string' && !node['rhs-fixed-value?'] && (node['rhs-val'].includes('::') || node['rhs-val'].includes('//')))
    node['rhs-val'] = normalizeTicker(node['rhs-val']);
  // Normalize tickers in compound conditions
  if (node.condition && node.condition.conditions) {
    for (const sub of node.condition.conditions) {
      if (sub.lhs && sub.lhs.ticker) {
        sub.lhs.ticker = sub.lhs.ticker.replace(/^(EQUITIES|CRYPTO)::/, '').replace(/\/\/USD$/, '');
      }
      if (sub.rhs && sub.rhs.ticker) {
        sub.rhs.ticker = sub.rhs.ticker.replace(/^(EQUITIES|CRYPTO)::/, '').replace(/\/\/USD$/, '');
      }
    }
  }
  if (node.children) node.children.forEach(c => normalizeScoreTreeTickers(c));
  return node;
}

/**
 * Check if an if-child node has a compound condition (ANY/ALL)
 */
function isCompoundCondition(node) {
  return node.condition && node.condition['condition-type'] === 'compound';
}

/**
 * Compound condition nodes may have a top-level lhs-fn/lhs-val condition that is
 * separate from (and not duplicated in) the condition.conditions[] array.
 * This function evaluates that top-level condition if it exists and is not already
 * the first sub-condition. Returns the result, or undefined if no extra condition.
 *
 * Composer format: the if-child node has both:
 *   - Top-level: lhs-fn, lhs-val, comparator, rhs-val (a regular condition)
 *   - condition: { operator, conditions: [...] } (compound sub-conditions)
 * The top-level condition acts as an additional sub of the compound operator.
 */
function evalCompoundTopLevelCondition(cond, dailyData, intradayData, date, time, recordDiag) {
  // Only applies if compound AND has a valid top-level condition
  if (!cond['lhs-fn'] || !cond['lhs-val']) return undefined;

  // Check if the top-level is already duplicated as the first sub-condition
  const subs = cond.condition?.conditions;
  if (subs && subs.length > 0) {
    const sub0 = subs[0];
    if (sub0.lhs) {
      let sub0Ticker = sub0.lhs.ticker;
      if (sub0Ticker === '%' && sub0.tickers?.length) sub0Ticker = sub0.tickers[0];
      const sub0Fn = sub0.lhs.fn;
      const sub0Cmp = sub0.comparator;
      if (sub0Fn === cond['lhs-fn'] && sub0Ticker === cond['lhs-val'] && sub0Cmp === cond.comparator) {
        return undefined; // Already duplicated in subs
      }
    }
  }

  const lhsWindow = cond['lhs-fn-params']?.window || parseInt(cond['lhs-window-days']) || 14;
  const rhsWindow = cond['rhs-fn-params']?.window || parseInt(cond['rhs-window-days']) || 14;
  const c = {
    lf: cond['lhs-fn'], lv: cond['lhs-val'], lw: lhsWindow,
    cmp: cond.comparator, rv: cond['rhs-val'], rf: cond['rhs-fixed-value?'],
    rfn: cond['rhs-fn'], rw: rhsWindow
  };
  return evalCond(c, dailyData, intradayData, date, time, recordDiag);
}

/**
 * Convert a binary sub-condition from the new structured format to the compact
 * format that evalCond() expects. This allows reusing evalCond() without modification.
 *
 * Input (binary sub-condition):
 *   { "condition-type": "binary", "lhs": { "fn": "relative-strength-index", "params": { "window": 10 }, "ticker": "QQQ" }, "comparator": "gt", "rhs": { "constant": 83 } }
 *
 * Output (compact object for evalCond):
 *   { lf: "relative-strength-index", lv: "QQQ", lw: 10, cmp: "gt", rv: "83", rf: true }
 */
function flattenCompoundSubCondition(binaryCond) {
  // Guard: if this is a nested compound (ANY/ALL inside ANY/ALL), return null
  // Callers must handle nested compounds recursively
  if (!binaryCond.lhs || binaryCond['condition-type'] === 'compound') {
    return null;
  }
  const lhsWindow = binaryCond.lhs.params?.window || 14;
  // Resolve '%' template placeholder: actual ticker is in tickers[] array
  let lhsTicker = binaryCond.lhs.ticker;
  if (lhsTicker === '%' && binaryCond.tickers && binaryCond.tickers.length > 0) {
    lhsTicker = binaryCond.tickers[0];
  }
  const compact = {
    lf: binaryCond.lhs.fn,
    lv: lhsTicker,
    lw: lhsWindow,
    cmp: binaryCond.comparator,
  };
  // RHS: constant (fixed value) or dynamic (fn-based)
  if (binaryCond.rhs.constant !== undefined) {
    compact.rf = true;
    compact.rv = String(binaryCond.rhs.constant);
  } else if (binaryCond.rhs.fn) {
    compact.rf = false;
    compact.rfn = binaryCond.rhs.fn;
    // Resolve '%' template placeholder for RHS ticker too
    let rhsTicker = binaryCond.rhs.ticker;
    if (rhsTicker === '%' && binaryCond.tickers && binaryCond.tickers.length > 0) {
      rhsTicker = binaryCond.tickers[0];
    }
    compact.rv = rhsTicker;
    compact.rw = binaryCond.rhs.params?.window || 14;
  }
  return compact;
}

/**
 * Recursively evaluate a compound sub-condition, handling nested compounds (ANY of ALLs, etc.)
 */
function evalCompoundSubRecursive(sub, dailyData, intradayData, date, time, recordDiag) {
  if (sub['condition-type'] === 'compound' || (sub.operator && sub.conditions)) {
    // Nested compound — recurse
    const nestedOp = sub.operator;
    const nestedResults = sub.conditions.map(nested =>
      evalCompoundSubRecursive(nested, dailyData, intradayData, date, time, recordDiag)
    );
    // Three-valued logic: short-circuit before considering nulls
    // ANY: TRUE if any sub is TRUE (regardless of nulls); null only if no TRUE and some null
    // ALL: FALSE if any sub is FALSE (regardless of nulls); null only if no FALSE and some null
    const hasNull = nestedResults.some(s => s === null);
    if (nestedOp === 'any') {
      if (nestedResults.some(s => s === true)) return true;
      return hasNull ? null : false;
    } else { // 'all'
      if (nestedResults.some(s => s === false)) return false;
      return hasNull ? null : true;
    }
  }
  // Binary sub-condition
  const c = flattenCompoundSubCondition(sub);
  if (!c) return null;
  const result = evalCond(c, dailyData, intradayData, date, time, recordDiag);
  // Debug: log every compound sub-condition evaluation
  if (process.env.DEBUG_COMPOUND === '1') {
    const lp = buildIndicatorPrices(c.lv, dailyData, intradayData, date, time);
    const lVal = lp ? evalInd(c.lf, lp, c.lw || 14) : null;
    const rVal = c.rf ? parseFloat(c.rv) : '?';
    console.error(`  COMPOUND_SUB ${date} ${c.lv}.${c.lf}(${c.lw})=${lVal !== null ? lVal.toFixed(2) : 'null'} ${c.cmp} ${rVal} → ${result} [${lp ? lp.length + ' prices' : 'no data'}]`);
  }
  return result;
}

/**
 * Convert a binary sub-condition to the flat node format used by evalCondVerbose().
 * Also used for collectConditions() which reads flat node fields.
 */
function flattenCompoundToLegacy(binaryCond) {
  // Guard: nested compound conditions don't have lhs/rhs
  if (!binaryCond.lhs || binaryCond['condition-type'] === 'compound') {
    return null;
  }
  // Resolve '%' template placeholder: actual ticker is in tickers[] array
  let lhsTicker = binaryCond.lhs.ticker;
  if (lhsTicker === '%' && binaryCond.tickers && binaryCond.tickers.length > 0) {
    lhsTicker = binaryCond.tickers[0];
  }
  const flat = {
    'lhs-fn': binaryCond.lhs.fn,
    'lhs-val': lhsTicker,
    'comparator': binaryCond.comparator,
  };
  if (binaryCond.lhs.params) {
    flat['lhs-fn-params'] = { window: binaryCond.lhs.params.window || 14 };
  }
  if (binaryCond.rhs.constant !== undefined) {
    flat['rhs-fixed-value?'] = true;
    flat['rhs-val'] = String(binaryCond.rhs.constant);
  } else if (binaryCond.rhs.fn) {
    flat['rhs-fixed-value?'] = false;
    flat['rhs-fn'] = binaryCond.rhs.fn;
    // Resolve '%' template placeholder for RHS ticker too
    let rhsTicker = binaryCond.rhs.ticker;
    if (rhsTicker === '%' && binaryCond.tickers && binaryCond.tickers.length > 0) {
      rhsTicker = binaryCond.tickers[0];
    }
    flat['rhs-val'] = rhsTicker;
    if (binaryCond.rhs.params) {
      flat['rhs-fn-params'] = { window: binaryCond.rhs.params.window || 14 };
    }
  }
  return flat;
}

/**
 * Extract all tickers from a compound condition's sub-conditions
 */
function extractCompoundTickers(condition) {
  const tickers = new Set();
  if (condition && condition.conditions) {
    for (const sub of condition.conditions) {
      // Recurse into nested compound conditions
      if (sub['condition-type'] === 'compound' || (sub.operator && sub.conditions)) {
        for (const t of extractCompoundTickers(sub)) tickers.add(t);
      } else {
        // Resolve '%' template placeholder: actual ticker is in tickers[] array
        let lhsTicker = sub.lhs?.ticker;
        if (lhsTicker === '%' && sub.tickers && sub.tickers.length > 0) {
          lhsTicker = sub.tickers[0];
        }
        let rhsTicker = sub.rhs?.ticker;
        if (rhsTicker === '%' && sub.tickers && sub.tickers.length > 0) {
          rhsTicker = sub.tickers[0];
        }
        if (lhsTicker && lhsTicker !== '%') tickers.add(lhsTicker);
        if (rhsTicker && rhsTicker !== '%') tickers.add(rhsTicker);
      }
    }
  }
  return tickers;
}

async function getOOSDate(id) {
  try {
    const data = await fetch(`${CONFIG.FIRESTORE_BASE}/${id}`);
    const ts = data.fields?.last_semantic_update_at?.timestampValue;
    return ts ? ts.split('T')[0] : null;
  } catch { return null; }
}

const _symphonyCache = {};

async function getSymphony(id) {
  if (_symphonyCache[id]) return _symphonyCache[id];

  function extractRebalanceConfig(meta) {
    // Composer API: rebalance="none" + rebalance-corridor-width=0.01 means threshold-based (1%)
    // Missing fields = daily rebalancing (always rebalance)
    if (meta['rebalance'] === 'none' && meta['rebalance-corridor-width']) {
      return { type: 'threshold', threshold: meta['rebalance-corridor-width'] };
    }
    return { type: 'daily', threshold: null };
  }

  // Try public endpoint first (works for shared/public strategies, no auth needed)
  try {
    const meta = await fetch(`${CONFIG.BACKTEST_API}/public/symphonies/${id}`);
    if (meta && meta.name && !meta.errors) {
      const score = await fetch(`${CONFIG.BACKTEST_API}/public/symphonies/${id}/score`);
      if (score && !score.errors) {
        normalizeScoreTreeTickers(score);
        const rebalanceConfig = extractRebalanceConfig(meta);
        const result = { score, name: meta.name, rebalanceConfig };
        _symphonyCache[id] = result;
        return result;
      }
    }
  } catch { /* public endpoint failed, try authenticated */ }

  // Fallback: authenticated endpoint (required for private/portfolio strategies)
  if (hasComposerKeys()) {
    try {
      const meta = await composerAuthRequest(`${CONFIG.BACKTEST_API}/symphonies/${id}`);
      const score = await composerAuthRequest(`${CONFIG.BACKTEST_API}/symphonies/${id}/score`);
      if (meta.errors || score.errors) {
        const errMsg = (meta.errors || score.errors)[0]?.title || 'Symphony not found';
        throw new Error(errMsg);
      }
      normalizeScoreTreeTickers(score);
      const rebalanceConfig = extractRebalanceConfig(meta);
      const result = { score, name: meta.name || 'Unknown', rebalanceConfig };
      _symphonyCache[id] = result;
      return result;
    } catch (e) {
      throw new Error(`Failed to fetch symphony ${id}: ${e.message}`);
    }
  }

  throw new Error(`Symphony ${id} not found (public API returned 404, no Composer keys for authenticated access)`);
}

function loadLocalSymphony(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Local symphony file not found: ${filePath}`);
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    throw new Error(`Failed to parse local symphony JSON at ${filePath}: ${e.message}`);
  }
  if (!raw || raw.step !== 'root') {
    throw new Error(`Local symphony at ${filePath} is missing root node (expected step:"root")`);
  }
  normalizeScoreTreeTickers(raw);
  // Mirror getSymphony's rebalanceConfig inference: root node carries
  // `rebalance` and optionally `rebalance-corridor-width`.
  const rebalanceConfig =
    raw.rebalance === 'none' && raw['rebalance-corridor-width']
      ? { type: 'threshold', threshold: raw['rebalance-corridor-width'] }
      : { type: 'daily', threshold: null };
  return {
    score: raw,
    name: raw.name || path.basename(filePath, path.extname(filePath)),
    rebalanceConfig,
  };
}

// ============================================================================
// COMPOSER PORTFOLIO/WATCHLIST API
// ============================================================================

// Session cache so we don't re-fetch on every menu interaction
const _composerCache = { portfolio: null, watchlist: null, drafts: null, accountUUID: null, accounts: null, symphonyToAccount: null };

function composerAuthRequest(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'x-api-key-id': CONFIG.composer.keyId,
        'Authorization': `Bearer ${CONFIG.composer.secret}`,
        'Content-Type': 'application/json',
        'x-origin': 'public-api',
      },
      timeout: 30000,
    };
    https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Composer API JSON parse error: ${data.slice(0, 200)}`)); }
      });
    }).on('error', reject).on('timeout', () => reject(new Error('Composer API timeout'))).end();
  });
}

async function getComposerPortfolio() {
  if (_composerCache.portfolio) return _composerCache.portfolio;

  const accounts = await getAllAccounts();
  const merged = [];
  const seen = new Map(); // id → index in merged (for dedupe across accounts)
  const symToAcct = {};   // id → {uuid, type} (for live-holdings routing)

  for (const acct of accounts) {
    let portfolioData;
    try {
      portfolioData = await composerAuthRequest(
        `https://api.composer.trade/api/v0.1/portfolio/accounts/${acct.uuid}/symphony-stats-meta`
      );
    } catch (e) {
      console.warn(`  Warning: failed to fetch portfolio for ${acct.type} (${acct.uuid.slice(0,8)}): ${e.message}`);
      continue;
    }
    const symphonies = portfolioData.symphonies || [];
    for (const s of symphonies) {
      const id = s.id || s.symphony_id;
      if (!id) continue;
      const value = s.value != null ? parseFloat(s.value) : null;
      if (seen.has(id)) {
        // Same symphony deployed in both accounts — sum values, append account types
        const idx = seen.get(id);
        if (value != null) merged[idx].value = (merged[idx].value || 0) + value;
        if (!merged[idx].accountType.includes(acct.type)) {
          merged[idx].accountType += ' + ' + acct.type;
        }
      } else {
        seen.set(id, merged.length);
        merged.push({
          id,
          name: s.name || 'Unnamed',
          value,
          accountType: acct.type,
          accountUuid: acct.uuid,
        });
        symToAcct[id] = { uuid: acct.uuid, type: acct.type };
      }
    }
  }

  _composerCache.portfolio = merged;
  _composerCache.symphonyToAccount = symToAcct;
  return _composerCache.portfolio;
}

async function getComposerWatchlist() {
  if (_composerCache.watchlist) return _composerCache.watchlist;

  const data = await composerAuthRequest('https://backtest-api.composer.trade/api/v1/watchlist');
  const symphonies = data.symphonies || [];
  _composerCache.watchlist = symphonies.map(s => ({
    id: s.id || s.symphony_id,
    name: s.name || 'Unnamed',
    sharpe: s.sharpe_ratio != null ? parseFloat(s.sharpe_ratio) : null,
  }));
  return _composerCache.watchlist;
}

async function getComposerDrafts() {
  if (_composerCache.drafts) return _composerCache.drafts;

  const data = await composerAuthRequest('https://backtest-api.composer.trade/api/v1/user/symphonies');
  const symphonies = (data.symphonies || data || []).filter(s => s.is_draft === true);
  _composerCache.drafts = symphonies.map(s => ({
    id: s.id || s.symphony_id,
    name: s.name || 'Unnamed',
  }));
  return _composerCache.drafts;
}

// ============================================================================
// COMPOSER LIVE DATA API (stagehand-api)
// ============================================================================

function composerAuthPost(url, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const postData = JSON.stringify(body);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'x-api-key-id': CONFIG.composer.keyId,
        'Authorization': `Bearer ${CONFIG.composer.secret}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        'x-origin': 'public-api',
      },
      timeout: 30000,
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Composer API JSON parse error: ${data.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => reject(new Error('Composer API timeout')));
    req.write(postData);
    req.end();
  });
}

async function getAllAccounts() {
  if (_composerCache.accounts) return _composerCache.accounts;
  const accountsData = await composerAuthRequest('https://stagehand-api.composer.trade/api/v1/accounts/list');
  const raw = accountsData.accounts || accountsData;
  if (!raw || raw.length === 0) throw new Error('No Composer accounts found');
  _composerCache.accounts = raw.map(a => ({
    uuid: a.account_uuid || a.uuid || a.id,
    type: a.account_type || 'UNKNOWN',
  })).filter(a => a.uuid);
  return _composerCache.accounts;
}

async function getAccountUUID() {
  // Backward-compat: returns first account's UUID. Prefer getAllAccounts() for multi-account flows.
  if (_composerCache.accountUUID) return _composerCache.accountUUID;
  const accounts = await getAllAccounts();
  _composerCache.accountUUID = accounts[0].uuid;
  return _composerCache.accountUUID;
}

async function _findAccountForSymphony(symphonyId) {
  // Use cached portfolio map if available, otherwise probe each account
  if (_composerCache.symphonyToAccount && _composerCache.symphonyToAccount[symphonyId]) {
    return _composerCache.symphonyToAccount[symphonyId].uuid;
  }
  // Force a portfolio fetch (which populates symphonyToAccount) before falling back
  await getComposerPortfolio();
  if (_composerCache.symphonyToAccount && _composerCache.symphonyToAccount[symphonyId]) {
    return _composerCache.symphonyToAccount[symphonyId].uuid;
  }
  // Last resort — first account (matches old behavior)
  return getAccountUUID();
}

async function getLiveSymphonyHoldings(symphonyId) {
  const uuid = await _findAccountForSymphony(symphonyId);
  return composerAuthRequest(
    `https://stagehand-api.composer.trade/api/v1/portfolio/accounts/${uuid}/symphonies/${symphonyId}/holdings`
  );
}

async function getPortfolioTotalStats() {
  // Sum aggregable fields across all accounts (portfolio_value, total_cash, etc.)
  const accounts = await getAllAccounts();
  const merged = {};
  const sumKeys = ['portfolio_value', 'total_cash', 'total_unallocated_cash', 'pending_deploys_cash', 'net_deposits'];
  for (const acct of accounts) {
    let stats;
    try {
      stats = await composerAuthRequest(
        `https://stagehand-api.composer.trade/api/v1/portfolio/accounts/${acct.uuid}/total-stats`
      );
    } catch { continue; }
    for (const k of sumKeys) {
      const v = stats[k] != null ? parseFloat(stats[k]) : null;
      if (v != null && !isNaN(v)) merged[k] = (merged[k] != null ? merged[k] : 0) + v;
    }
    // Pass-through non-summable fields from first account that has them
    for (const k of Object.keys(stats)) {
      if (!sumKeys.includes(k) && merged[k] === undefined) merged[k] = stats[k];
    }
  }
  return merged;
}

async function getAllHoldingStats() {
  // Concatenate holding-stats arrays across all accounts
  const accounts = await getAllAccounts();
  const out = [];
  for (const acct of accounts) {
    let data;
    try {
      data = await composerAuthRequest(
        `https://stagehand-api.composer.trade/api/v1/portfolio/accounts/${acct.uuid}/holding-stats`
      );
    } catch { continue; }
    const arr = Array.isArray(data) ? data : (data.holdings || data.holding_stats || []);
    for (const row of arr) out.push({ ...row, accountType: acct.type, accountUuid: acct.uuid });
  }
  return out;
}

async function getPublicQuotes(tickers) {
  // Free endpoint — no auth needed, but Composer returns qualified ticker names
  return composerAuthPost(
    'https://stagehand-api.composer.trade/api/v1/public/quotes',
    { tickers }
  );
}

function normalizeQuoteTicker(qualifiedTicker) {
  // EQUITIES::SPY//USD → SPY, CRYPTO::BTC//USD → BTC
  return qualifiedTicker.replace(/^(EQUITIES|CRYPTO)::/i, '').replace(/\/\/USD$/i, '');
}

// ============================================================================
// STRATEGY PICKER
// ============================================================================

function parseSelectionInput(input, maxIndex) {
  const selections = new Set();
  const parts = input.split(',').map(s => s.trim()).filter(Boolean);
  for (const part of parts) {
    if (part.includes('-')) {
      const [startStr, endStr] = part.split('-').map(s => s.trim());
      const start = parseInt(startStr, 10);
      const end = parseInt(endStr, 10);
      if (!isNaN(start) && !isNaN(end)) {
        for (let i = Math.min(start, end); i <= Math.max(start, end); i++) {
          if (i >= 1 && i <= maxIndex) selections.add(i);
        }
      }
    } else {
      const n = parseInt(part, 10);
      if (!isNaN(n) && n >= 1 && n <= maxIndex) selections.add(n);
    }
  }
  return [...selections].sort((a, b) => a - b);
}

async function askSymphonyIds(r, label) {
  if (!hasComposerKeys()) {
    // Fallback to manual entry
    console.log(`\nEnter symphony ID(s). For multiple, separate with commas or spaces.\n`);
    const input = await ask(r, 'Symphony ID(s): ');
    return input.split(/[,\s]+/).filter(Boolean);
  }

  console.log(`
  Select strategy source:
    1. From Portfolio
    2. From Watchlist
    3. Enter ID(s) manually
`);
  const sourceChoice = await ask(r, '  Select [1-3]: ');

  if (sourceChoice === '3') {
    console.log('');
    const input = await ask(r, 'Symphony ID(s): ');
    return input.split(/[,\s]+/).filter(Boolean);
  }

  let strategies;
  try {
    if (sourceChoice === '1') {
      console.log('\n  Fetching portfolio...');
      strategies = await getComposerPortfolio();
    } else if (sourceChoice === '2') {
      console.log('\n  Fetching watchlist...');
      strategies = await getComposerWatchlist();
    } else {
      return [];
    }
  } catch (e) {
    console.log(`\n  Error fetching from Composer: ${e.message}`);
    console.log('  Falling back to manual entry.\n');
    const input = await ask(r, 'Symphony ID(s): ');
    return input.split(/[,\s]+/).filter(Boolean);
  }

  if (strategies.length === 0) {
    console.log('\n  No strategies found.');
    return [];
  }

  // Display numbered list
  const isPortfolio = sourceChoice === '1';
  const header = isPortfolio ? 'YOUR PORTFOLIO' : 'YOUR WATCHLIST';
  console.log(`\n  ${header} (${strategies.length} strategies):`);
  console.log(`  ${'─'.repeat(60)}`);

  // Sort: portfolio by value desc, watchlist by name
  const sorted = [...strategies];
  if (isPortfolio) {
    sorted.sort((a, b) => (b.value || 0) - (a.value || 0));
  } else {
    sorted.sort((a, b) => a.name.localeCompare(b.name));
  }

  const maxNameLen = Math.min(45, Math.max(...sorted.map(s => s.name.length)));
  sorted.forEach((s, i) => {
    const num = String(i + 1).padStart(3);
    const name = s.name.length > 45 ? s.name.slice(0, 42) + '...' : s.name.padEnd(maxNameLen);
    const detail = isPortfolio
      ? (s.value != null ? `$${s.value.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}` : '')
      : (s.sharpe != null ? `Sharpe: ${s.sharpe.toFixed(2)}` : '');
    console.log(`  ${num}. ${name}  ${detail}`);
  });

  console.log(`\n    a. Select ALL`);
  console.log(`\n  Enter numbers (comma-separated, ranges like 1-5, or 'a' for all):`);
  const sel = await ask(r, '  Select: ');

  if (sel.toLowerCase() === 'a') {
    return sorted.map(s => s.id);
  }

  const indices = parseSelectionInput(sel, sorted.length);
  if (indices.length === 0) {
    console.log('  No valid selection.');
    return [];
  }

  const selected = indices.map(i => sorted[i - 1]);
  console.log(`\n  Selected ${selected.length} strategy(s):`);
  selected.forEach(s => console.log(`    - ${s.name}`));

  return selected.map(s => s.id);
}

// ============================================================================
// SPLIT DETECTION (from TwelveData version - useful for validating any source)
// ============================================================================

function detectSplitIssues(byDate) {
  const dates = Object.keys(byDate).sort();
  const issues = [];

  for (let i = 1; i < dates.length; i++) {
    const prevClose = byDate[dates[i-1]]?.close;
    const currClose = byDate[dates[i]]?.close;

    if (prevClose && currClose) {
      const change = Math.abs((currClose - prevClose) / prevClose);
      if (change > 0.35) {
        issues.push({
          date: dates[i],
          from: prevClose.toFixed(2),
          to: currClose.toFixed(2),
          change: (change * 100).toFixed(1) + '%',
          likelySplit: change > 0.45 && change < 0.55 ? '2:1' :
                       change > 0.30 && change < 0.36 ? '3:2' :
                       change > 0.65 && change < 0.70 ? '3:1' : 'unknown'
        });
      }
    }
  }
  return issues;
}

// ============================================================================
// YAHOO FINANCE DATA FETCHING
// ============================================================================

async function getYahooIntradayData(ticker, days) {
  return new Promise((resolve, reject) => {
    const d = Math.min(days, CONFIG.MAX_INTRADAY_DAYS_YAHOO);
    const p1 = Math.floor((Date.now() - d * 86400000) / 1000);
    const p2 = Math.floor(Date.now() / 1000);
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
              const { date: d, time: t } = utcToEastern(dt.toISOString());
              if (!byDT[d]) byDT[d] = {};
              byDT[d][t] = { open: q.open?.[i], high: q.high?.[i], low: q.low?.[i], close: q.close[i] };
            }
            resolve({ ticker, byDT, source: 'yahoo' });
          } else reject(new Error(j.chart?.error?.description || 'No data'));
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function getYahooDailyData(ticker, days) {
  return new Promise((resolve, reject) => {
    const d = Math.min(days, CONFIG.MAX_DAILY_DAYS);
    const p1 = Math.floor((Date.now() - d * 86400000) / 1000);
    const p2 = Math.floor(Date.now() / 1000);
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
            const adjclose = r.indicators?.adjclose?.[0]?.adjclose || [];
            const byDate = {};
            for (let i = 0; i < ts.length; i++) {
              const closePrice = adjclose[i] || q.close?.[i];
              if (!closePrice) continue;
              const dt = new Date(ts[i] * 1000);
              const d = dt.toISOString().split('T')[0];
              byDate[d] = {
                open: q.open?.[i],
                high: q.high?.[i],
                low: q.low?.[i],
                close: closePrice
              };
            }
            resolve({ ticker, byDate, source: 'yahoo' });
          } else reject(new Error(j.chart?.error?.description || 'No data'));
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// ============================================================================
// ALPACA MARKETS DATA FETCHING
// ============================================================================

// Generic HTTPS request helper for Alpaca API (supports GET with auth headers)
function alpacaRequest(urlStr) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'GET',
      headers: {
        'APCA-API-KEY-ID': CONFIG.alpaca.apiKey,
        'APCA-API-SECRET-KEY': CONFIG.alpaca.apiSecret,
        'Accept': 'application/json',
      },
      timeout: 60000,
    };

    https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) {
            reject(new Error(parsed.message || `HTTP ${res.statusCode}`));
          } else {
            resolve(parsed);
          }
        } catch (e) { reject(new Error('JSON parse error')); }
      });
    }).on('error', reject).on('timeout', () => reject(new Error('Timeout'))).end();
  });
}

// Convert UTC ISO timestamp to US/Eastern date and time strings
function utcToEastern(isoStr) {
  const dt = new Date(isoStr);
  // Use Intl to get proper Eastern time (handles DST)
  const eastern = dt.toLocaleString('en-US', { timeZone: 'America/New_York' });
  const parts = new Date(eastern);
  const year = parts.getFullYear();
  const month = String(parts.getMonth() + 1).padStart(2, '0');
  const day = String(parts.getDate()).padStart(2, '0');
  const hours = String(parts.getHours()).padStart(2, '0');
  const minutes = String(parts.getMinutes()).padStart(2, '0');
  return {
    date: `${year}-${month}-${day}`,
    time: `${hours}:${minutes}`,
  };
}

// Fetch intraday (5-min) bars from Alpaca for multiple tickers
// Alpaca supports comma-separated symbols in a single request
const ALPACA_BATCH_SIZE = 20;

async function getAlpacaIntradayData(tickers, days) {
  const results = {};
  const errors = [];

  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);
  const startISO = startDate.toISOString().split('.')[0] + 'Z';
  const endISO = new Date().toISOString().split('.')[0] + 'Z';

  // Process in batches of ALPACA_BATCH_SIZE
  for (let i = 0; i < tickers.length; i += ALPACA_BATCH_SIZE) {
    const batch = tickers.slice(i, i + ALPACA_BATCH_SIZE);
    const symbolList = batch.join(',');

    try {
      let allBars = {};  // {SYMBOL: [bars...]}
      let pageToken = null;

      // Paginate through all results (max 10000 bars per page)
      do {
        await alpacaRateLimiter.waitIfNeeded();

        let url = `${CONFIG.ALPACA_DATA_API}/stocks/bars?symbols=${symbolList}&timeframe=${CONFIG.ALPACA_TIMEFRAME}&start=${startISO}&end=${endISO}&limit=10000&adjustment=all&feed=iex&sort=asc`;
        if (pageToken) url += `&page_token=${pageToken}`;

        const response = await alpacaRequest(url);

        // Accumulate bars per symbol
        if (response.bars) {
          for (const [symbol, bars] of Object.entries(response.bars)) {
            if (!allBars[symbol]) allBars[symbol] = [];
            allBars[symbol].push(...bars);
          }
        }

        pageToken = response.next_page_token || null;
      } while (pageToken);

      // Convert bars to internal format
      for (const ticker of batch) {
        const bars = allBars[ticker];
        if (!bars || bars.length === 0) {
          errors.push({ ticker, error: 'No data returned from Alpaca' });
          continue;
        }

        const byDT = {};
        for (const bar of bars) {
          const { date, time } = utcToEastern(bar.t);
          if (!byDT[date]) byDT[date] = {};
          byDT[date][time] = {
            open: bar.o,
            high: bar.h,
            low: bar.l,
            close: bar.c,
          };
        }

        if (Object.keys(byDT).length > 0) {
          results[ticker] = { ticker, byDT, source: 'alpaca' };
        } else {
          errors.push({ ticker, error: 'No data in date range' });
        }
      }
    } catch (e) {
      for (const ticker of batch) {
        errors.push({ ticker, error: e.message || 'Alpaca batch request failed' });
      }
    }
  }

  return { results, errors };
}

// Fetch daily bars from Alpaca for multiple tickers
async function getAlpacaDailyData(tickers, days) {
  const results = {};
  const errors = [];

  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);
  const startISO = startDate.toISOString().split('T')[0];
  const endISO = new Date().toISOString().split('T')[0];

  for (let i = 0; i < tickers.length; i += ALPACA_BATCH_SIZE) {
    const batch = tickers.slice(i, i + ALPACA_BATCH_SIZE);
    const symbolList = batch.join(',');

    try {
      let allBars = {};
      let pageToken = null;

      do {
        await alpacaRateLimiter.waitIfNeeded();

        let url = `${CONFIG.ALPACA_DATA_API}/stocks/bars?symbols=${symbolList}&timeframe=1Day&start=${startISO}&end=${endISO}&limit=10000&adjustment=all&feed=iex&sort=asc`;
        if (pageToken) url += `&page_token=${pageToken}`;

        const response = await alpacaRequest(url);

        if (response.bars) {
          for (const [symbol, bars] of Object.entries(response.bars)) {
            if (!allBars[symbol]) allBars[symbol] = [];
            allBars[symbol].push(...bars);
          }
        }

        pageToken = response.next_page_token || null;
      } while (pageToken);

      for (const ticker of batch) {
        const bars = allBars[ticker];
        if (!bars || bars.length === 0) {
          errors.push({ ticker, error: 'No daily data from Alpaca' });
          continue;
        }

        const byDate = {};
        for (const bar of bars) {
          const dateStr = bar.t.split('T')[0];
          byDate[dateStr] = {
            open: bar.o,
            high: bar.h,
            low: bar.l,
            close: bar.c,
          };
        }

        // Check for split issues and fall back to Yahoo if needed
        const splitIssues = detectSplitIssues(byDate);
        if (splitIssues.length > 0) {
          SPLIT_WARNINGS.push({
            ticker,
            issues: splitIssues,
            action: 'Falling back to Yahoo Finance for properly adjusted daily data'
          });
          try {
            const yahooTicker = normalizeTickerYahoo(ticker);
            const yahooResult = await getYahooDailyData(yahooTicker, days);
            results[ticker] = { ...yahooResult, ticker };
            continue;
          } catch (yahooErr) {
            SPLIT_WARNINGS[SPLIT_WARNINGS.length - 1].action =
              `Yahoo fallback failed (${yahooErr.message}), using Alpaca data with known split issues`;
          }
        }

        if (Object.keys(byDate).length > 0) {
          results[ticker] = { ticker, byDate, source: 'alpaca' };
        } else {
          errors.push({ ticker, error: 'No daily data in date range' });
        }
      }
    } catch (e) {
      for (const ticker of batch) {
        errors.push({ ticker, error: e.message || 'Alpaca daily batch failed' });
      }
    }
  }

  return { results, errors };
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
  // Composer multiplies by 100 (returns percentage form: -12 for -12%, not -0.12)
  if (prices.length < w + 1) return null;
  const s = prices[prices.length - 1 - w], e = prices[prices.length - 1];
  return ((e - s) / s) * 100;
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
  return (sumReturns / w) * 100;  // Composer returns percentage form
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
  return maxDD * 100; // Composer uses POSITIVE percentage for MaxDD in filter sorting: 5.0 means 5% drawdown
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
  return Math.sqrt(variance) * 100;  // Composer returns percentage form
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

// Pre-sorted keys cache — avoids re-sorting Object.keys() on every call.
// These are populated once per analysis run, then reused ~100k times.
const _sortedKeysCache = { daily: {}, intraday: {} };

function getSortedDailyDates(ticker, dailyData) {
  if (_sortedKeysCache.daily[ticker]) return _sortedKeysCache.daily[ticker];
  const byDate = dailyData[ticker]?.byDate;
  if (!byDate) return null;
  const sorted = Object.keys(byDate).sort();
  _sortedKeysCache.daily[ticker] = sorted;
  return sorted;
}

function getSortedIntradayTimes(ticker, date, intradayData) {
  const key = ticker + '_' + date;
  if (_sortedKeysCache.intraday[key]) return _sortedKeysCache.intraday[key];
  const dd = intradayData[ticker]?.byDT?.[date];
  if (!dd) return null;
  const sorted = Object.keys(dd).sort();
  _sortedKeysCache.intraday[key] = sorted;
  return sorted;
}

function clearSortedKeysCache() {
  _sortedKeysCache.daily = {};
  _sortedKeysCache.intraday = {};
  _dailyCloseArrayCache = {};
}

// Pre-built daily close arrays per ticker — built once, sliced by date index.
// Avoids rebuilding the same array ~90,000 times per strategy.
let _dailyCloseArrayCache = {};

function getDailyCloseArray(ticker, dailyData) {
  if (_dailyCloseArrayCache[ticker]) return _dailyCloseArrayCache[ticker];
  const dates = getSortedDailyDates(ticker, dailyData);
  if (!dates) return null;
  const byDate = dailyData[ticker].byDate;
  const closes = new Array(dates.length);
  for (let i = 0; i < dates.length; i++) {
    closes[i] = byDate[dates[i]].close;
  }
  _dailyCloseArrayCache[ticker] = { dates, closes };
  return _dailyCloseArrayCache[ticker];
}

/**
 * Builds price history for indicator calculation:
 * - Daily closes up to (not including) eval date
 * - Plus current intraday price as "today's" value
 * This simulates what you'd see clicking "Run Now" at any given time
 */
function buildIndicatorPrices(ticker, dailyData, intradayData, evalDate, evalTime) {
  // 1. Get pre-built daily close array, find cutoff via binary search
  const cache = getDailyCloseArray(ticker, dailyData);
  let prices;
  if (cache) {
    const { dates, closes } = cache;
    // Binary search for first date >= evalDate
    let lo = 0, hi = dates.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (dates[mid] < evalDate) lo = mid + 1;
      else hi = mid;
    }
    prices = lo > 0 ? closes.slice(0, lo) : [];
  } else {
    prices = [];
  }

  // 2. Add current intraday price as "today's" value
  const currentPrice = getIntradayPrice(ticker, intradayData, evalDate, evalTime, dailyData);
  if (currentPrice !== null) {
    prices.push(currentPrice);
  }

  return prices.length > 0 ? prices : null;
}

// Cache for reverse-split adjustment factors: key = "ticker_date" -> ratio (daily/intraday)
const SPLIT_ADJ_CACHE = new Map();

function getSplitAdjustment(ticker, date, intradayData, dailyData) {
  if (!dailyData) return 1;
  const key = `${ticker}_${date}`;
  if (SPLIT_ADJ_CACHE.has(key)) return SPLIT_ADJ_CACHE.get(key);

  let adj = 1;
  const dailyClose = dailyData[ticker]?.byDate?.[date]?.close;
  const dd = intradayData[ticker]?.byDT?.[date];
  if (dailyClose && dd) {
    // Compare daily close to last intraday bar close to detect split mismatch.
    // Reverse splits (e.g., 1:10, 1:20) cause the intraday cache to have pre-split
    // prices while Yahoo daily data has post-split adjusted prices.
    const times = Object.keys(dd).sort();
    const lastBar = times.length > 0 ? (dd[times[times.length - 1]]?.close ?? dd[times[times.length - 1]]?.open) : null;
    if (lastBar && lastBar > 0) {
      const ratio = dailyClose / lastBar;
      // If ratio > 3x or < 0.33x, this is a reverse/forward split mismatch
      if (ratio > 3 || ratio < 0.33) {
        adj = ratio;
      }
    }
  }
  SPLIT_ADJ_CACHE.set(key, adj);
  return adj;
}

function getIntradayPrice(ticker, intradayData, date, time, dailyData = null) {
  // Special case: 16:00 uses Yahoo daily close (official market close)
  if (time === '16:00' && dailyData) {
    const dailyClose = dailyData[ticker]?.byDate?.[date]?.close;
    if (dailyClose) return dailyClose;
  }

  // Special case: 16:00a uses Alpaca's last intraday bar CLOSE as the market close.
  // The close of the 15:45 bar (in 15-min mode) IS the ~16:00 price.
  // This provides a same-source alternative to Yahoo daily close for comparison.
  if (time === '16:00a') {
    const dd = intradayData[ticker]?.byDT?.[date];
    if (dd) {
      const times = Object.keys(dd).sort();
      // Find last bar and use its close
      for (let i = times.length - 1; i >= 0; i--) {
        const barClose = dd[times[i]]?.close;
        if (barClose) return barClose;
      }
    }
    // Fallback to daily close if no intraday data
    if (dailyData) {
      const dailyClose = dailyData[ticker]?.byDate?.[date]?.close;
      if (dailyClose) return dailyClose;
    }
    return null;
  }

  const dd = intradayData[ticker]?.byDT?.[date];
  if (!dd || Object.keys(dd).length === 0) {
    // No intraday data at all for this date — fall back to daily close for ANY time.
    // This prevents the return chain from breaking on days where Alpaca has gaps
    // (e.g., 2025-03-10, 2026-03-03) or market holidays not in Alpaca's calendar.
    // For 3x leveraged ETFs, skipping even one day can distort cumulative returns
    // by 10-15% due to missed large moves.
    if (dailyData) {
      const dailyClose = dailyData[ticker]?.byDate?.[date]?.close;
      if (dailyClose) return dailyClose;
    }
    return null;
  }
  // Use bar OPEN (not close) because bar timestamps are the START of the period.
  // The open of bar at time T is the price AT time T, regardless of bar interval.
  // Using close would shift the effective time forward by the bar duration
  // (5 min for 5-min bars, 15 min for 15-min bars), causing inconsistent results
  // across timeframes and a small lookahead bias.
  const times = getSortedIntradayTimes(ticker, date, intradayData);
  let best = null, bestTime = null;
  for (let i = 0; i < times.length; i++) {
    if (times[i] <= time) { best = dd[times[i]]?.open ?? dd[times[i]]?.close; bestTime = times[i]; }
    else break;  // times are sorted, no need to check further
  }

  // Staleness fallback: if the nearest bar is far from the requested time,
  // use the daily close instead. This handles:
  //   - EOD times on days with missing late bars (illiquid ETFs)
  //   - Early-close days (Christmas Eve, etc.) where bars stop at 10:15 or 13:00
  //     but we need a price at 14:00+ — the daily close is far more accurate
  //     than a hours-old intraday bar.
  // Fallback rule: gap-based, not clock-hour-based. The previous "time >= '15:45'"
  // rule conflated "near EOD" with "no exact-bar match" and made minute-level
  // late-day analysis impossible (any time past 15:45 collapsed to daily close
  // when bestTime didn't equal time). Now: fall back only when no bar exists
  // within the timeframe's natural resolution. With 1Min bars, asking for 15:53
  // on a normal trading day finds the 15:53 bar and returns it; only on
  // early-close days (no late bars at all) does the gap exceed threshold.
  if (bestTime !== time && dailyData) {
    const [bH, bM] = (bestTime || '00:00').split(':').map(Number);
    const [tH, tM] = time.split(':').map(Number);
    const gapMinutes = (tH * 60 + tM) - (bH * 60 + bM);
    // Per-timeframe staleness threshold: ~3x bar duration for normal-precision
    // matching, with a hard 120-min ceiling for early-close detection.
    const tfMinutes = CONFIG.ALPACA_TIMEFRAME === '1Min' ? 1
                    : CONFIG.ALPACA_TIMEFRAME === '5Min' ? 5
                    : 15;
    const maxGap = Math.max(tfMinutes * 3, 30); // generous near-bar tolerance, 30-min minimum
    if (gapMinutes > maxGap || gapMinutes > 120) {
      const dailyClose = dailyData[ticker]?.byDate?.[date]?.close;
      if (dailyClose) return dailyClose;
    }
  }

  // Adjust for reverse/forward splits: intraday cache may have unadjusted prices
  // while daily data has adjusted prices. Detect by comparing daily open to first
  // intraday bar; if ratio > 3x, apply correction to align price scales.
  if (best !== null && dailyData) {
    const adj = getSplitAdjustment(ticker, date, intradayData, dailyData);
    if (adj !== 1) best *= adj;
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
  const isValidTicker = (v) => typeof v === 'string' && /^[A-Z][A-Z0-9\/\-\.]*$/.test(v);
  if (n['lhs-val'] && isValidTicker(n['lhs-val'])) t.add(n['lhs-val']);
  if (n['rhs-val'] && isValidTicker(n['rhs-val']) && !n['rhs-fixed-value?']) t.add(n['rhs-val']);
  // Extract tickers from compound conditions
  if (isCompoundCondition(n)) {
    for (const ticker of extractCompoundTickers(n.condition)) {
      t.add(ticker);
    }
  }
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
        let r;
        if (isCompoundCondition(cond)) {
          // Evaluate compound condition (ANY/ALL) — supports nested compounds
          const { operator, conditions } = cond.condition;
          const subResults = conditions.map(sub =>
            evalCompoundSubRecursive(sub, dailyData, intradayData, date, time, recordDiag)
          );
          // Three-valued logic: short-circuit before considering nulls
          // ANY: TRUE if any sub is TRUE (regardless of nulls); null only if no TRUE and some null
          // ALL: FALSE if any sub is FALSE (regardless of nulls); null only if no FALSE and some null
          const hasNull = subResults.some(s => s === null);
          if (operator === 'any') {
            if (subResults.some(s => s === true)) r = true;
            else r = hasNull ? null : false;
          } else { // 'all'
            if (subResults.some(s => s === false)) r = false;
            else r = hasNull ? null : true;
          }
        } else {
          // Handle both formats: lhs-fn-params.window (new) and lhs-window-days (legacy string)
          const lhsWindow = cond['lhs-fn-params']?.window || parseInt(cond['lhs-window-days']) || 14;
          const rhsWindow = cond['rhs-fn-params']?.window || parseInt(cond['rhs-window-days']) || 14;
          const c = {
            lf: cond['lhs-fn'], lv: cond['lhs-val'], lw: lhsWindow,
            cmp: cond.comparator, rv: cond['rhs-val'], rf: cond['rhs-fixed-value?'],
            rfn: cond['rhs-fn'], rw: rhsWindow
          };
          r = evalCond(c, dailyData, intradayData, date, time, recordDiag);
        }

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

      // Evaluate indicator value for a filter child.
      // For direct assets: straightforward indicator on price history.
      // For subtrees (groups, conditionals): build a synthetic portfolio return series
      // by re-evaluating holdings for each historical day, matching Composer/Rainboy behavior.
      function getSubtreeIndicatorValue(child) {
        if (child.step === 'asset' && child.ticker) {
          // Direct asset - use its indicator value
          const prices = buildIndicatorPrices(child.ticker, dailyData, intradayData, date, time);
          return evalInd(sortFn, prices, sortWindow);
        }

        // Composer throws IllegalStateException for price-based indicators on non-asset children.
        // These can ONLY be evaluated on direct assets.
        const priceBasedFns = ['moving-average-price', 'exponential-moving-average-price',
                                'current-price', 'standard-deviation-price'];
        if (priceBasedFns.includes(sortFn)) {
          return null;  // Skip this candidate - matches Composer behavior
        }

        // For return-based indicators on subtrees (groups, conditionals):
        // Build a synthetic portfolio by re-evaluating what the subtree held on each
        // historical day, computing daily portfolio returns, then running the indicator
        // on that return series. This matches Rainboy/Composer behavior exactly.

        // Get sorted trading days from dailyData (union of all tickers' dates for robustness)
        const dateSet = new Set();
        for (const ticker of Object.keys(dailyData)) {
          if (dailyData[ticker]?.byDate) {
            for (const d of Object.keys(dailyData[ticker].byDate)) dateSet.add(d);
          }
        }
        const tradingDays = dateSet.size > 0 ? [...dateSet].sort() : null;
        if (!tradingDays || tradingDays.length === 0) return null;

        // We need sortWindow trading days of history BEFORE the eval date,
        // plus extra days for RSI warmup (RSI needs window+1 prices = window+1 returns)
        // For RSI, we need more history to seed Wilder's smoothing properly
        const rsiExtra = sortFn === 'relative-strength-index' ? sortWindow : 0;
        const needDays = sortWindow + rsiExtra + 1; // +1 for the eval date itself

        // Find trading days up to and including eval date
        const daysUpToEval = tradingDays.filter(d => d <= date);
        if (daysUpToEval.length < needDays + 1) return null; // Not enough history

        // Take the last needDays+1 days (we need pairs for daily returns)
        const windowDays = daysUpToEval.slice(-(needDays + 1));

        // Build synthetic price series from daily portfolio returns
        // For each day, evaluate what the subtree holds, compute weighted daily return
        let syntheticPrice = 1.0;
        const syntheticPrices = [];

        for (let i = 0; i < windowDays.length; i++) {
          const d = windowDays[i];
          syntheticPrices.push(syntheticPrice);

          if (i < windowDays.length - 1) {
            const nextD = windowDays[i + 1];

            // Evaluate subtree holdings at EOD on this day
            const holdings = getAssetsWithWeights(child, dailyData, intradayData, d, '16:00', 1.0, false, null);

            if (holdings.length === 0) {
              // No holdings = no return (cash-like)
              // syntheticPrice stays the same
            } else {
              // Compute weighted portfolio return for this day→next day
              // For the eval date, use intraday price at evalTime to avoid lookahead
              let portfolioReturn = 0;
              for (const h of holdings) {
                const todayClose = dailyData[h.ticker]?.byDate?.[d]?.close;
                const nextClose = nextD === date
                  ? getIntradayPrice(h.ticker, intradayData, nextD, time, dailyData)
                  : dailyData[h.ticker]?.byDate?.[nextD]?.close;
                if (todayClose && nextClose && todayClose > 0) {
                  portfolioReturn += h.weight * ((nextClose - todayClose) / todayClose);
                }
              }
              syntheticPrice *= (1 + portfolioReturn);
            }
          }
        }
        // Add final price point (the eval date)
        // Already added in loop above as the last iteration

        if (syntheticPrices.length < 2) return null;

        // Now compute the indicator on the synthetic price series
        return evalInd(sortFn, syntheticPrices, sortWindow);
      }

      // Evaluate indicator for each filter child (asset, group, or any other node)
      const candidates = [];
      for (let i = 0; i < (n.children || []).length; i++) {
        const child = n.children[i];
        // For debug: always get ticker name
        const debugTicker = CONFIG.debugFilter ? getChildTicker(child) : null;
        const val = getSubtreeIndicatorValue(child);
        // Only get ticker if we need it for override matching (expensive recursive call)
        const ticker = filterOverrides ? getChildTicker(child) : debugTicker;
        if (CONFIG.debugFilter) {
          console.log(`    FILTER[${i}] -> ${debugTicker || '?'}: ${sortFn}(${sortWindow}) = ${val !== null ? val.toFixed(4) : 'NULL'}`);
        }
        if (val !== null) {
          candidates.push({ childIndex: i, child, value: val, ticker: ticker || debugTicker });
        }
      }
      if (CONFIG.debugFilter) {
        candidates.sort((a, b) => selectFn === 'top' ? b.value - a.value : a.value - b.value);
        const sel = candidates.slice(0, selectN);
        console.log(`    FILTER: ${selectFn} ${selectN} -> selected: ${sel.map(s => `${s.ticker || '?'}(${s.value.toFixed(4)})`).join(', ')}`);
        // Re-sort for actual selection below
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
      const volWindow = parseInt(n['window-days']) || 20;

      // Helper to get volatility for a subtree by evaluating its CURRENT holdings
      // (not all possible tickers - Composer resolves conditions first, then uses
      // the selected asset's volatility for inverse-vol weighting)
      function getSubtreeVolatility(child) {
        // Evaluate the subtree to get currently selected holdings
        const holdings = getAssetsWithWeights(child, dailyData, intradayData, date, time, 1.0, false, filterOverrides);

        if (holdings.length === 0) return null;

        // Calculate weighted average volatility across actual current holdings
        let sum = 0, count = 0;
        for (const h of holdings) {
          const prices = buildIndicatorPrices(h.ticker, dailyData, intradayData, date, time);
          const vol = evalInd('standard-deviation-return', prices, volWindow);
          if (vol !== null && vol > 0) {
            sum += vol * h.weight;
            count += h.weight;
          }
        }
        return count > 0 ? sum / count : null;
      }

      // Calculate volatility for each child
      const childVols = children.map(child => {
        const vol = getSubtreeVolatility(child);
        return { child, vol };
      });

      // Debug: log inverse-vol computation
      if (CONFIG.debugInverseVol) {
        for (let ci = 0; ci < childVols.length; ci++) {
          const cv = childVols[ci];
          const holdings = getAssetsWithWeights(cv.child, dailyData, intradayData, date, time, 1.0, false, filterOverrides);
          const holdStr = holdings.map(h => {
            const p = buildIndicatorPrices(h.ticker, dailyData, intradayData, date, time);
            const v = p ? evalInd('standard-deviation-return', p, volWindow) : null;
            const nullCount = p ? p.filter(x => x == null || isNaN(x)).length : -1;
            const lastFive = p ? p.slice(-5).map(x => typeof x === 'number' ? x.toFixed(2) : String(x)).join(',') : '';
            return `${h.ticker}(w=${(h.weight*100).toFixed(0)}%,prices=${p?.length || 0},nulls=${nullCount},vol=${v === null ? 'null' : (isNaN(v) ? 'NaN' : v.toFixed(4))},last5=[${lastFive}])`;
          }).join(' ');
          console.log(`    INV-VOL child[${ci}]: vol=${cv.vol?.toFixed(6) || 'null'} window=${volWindow} | ${holdStr}`);
        }
      }

      // Composer behavior: if ANY child has non-finite vol (zero/null, e.g. cash/BIL),
      // ONLY keep those non-finite children and merge them equally.
      // This matches Composer Java: Weighting.getHoldings() filters to !Double.isFinite children.
      const validChildren = childVols.filter(cv => cv.vol !== null && cv.vol > 0 && isFinite(1 / cv.vol));
      const nonFiniteChildren = childVols.filter(cv => !cv.vol || cv.vol <= 0 || !isFinite(1 / cv.vol));

      if (nonFiniteChildren.length > 0) {
        if (CONFIG.debugInverseVol) {
          console.log(`    INV-VOL: ${nonFiniteChildren.length} non-finite children -> equal weight fallback`);
        }
        // Composer: only keep non-finite children, merge equally
        const childWeight = weight / nonFiniteChildren.length;
        for (const cv of nonFiniteChildren) {
          walk(cv.child, childWeight);
        }
        return;
      }

      if (validChildren.length === 0) {
        // Fallback to equal weighting if no children at all
        const childWeight = weight / children.length;
        children.forEach(child => walk(child, childWeight));
        return;
      }

      // Normal case: all children have valid volatility
      const invSum = validChildren.reduce((acc, cv) => acc + (1 / cv.vol), 0);

      if (CONFIG.debugInverseVol) {
        for (const cv of validChildren) {
          const invWeight = (1 / cv.vol) / invSum;
          console.log(`    INV-VOL: vol=${cv.vol.toFixed(6)} -> invWeight=${(invWeight*100).toFixed(1)}%`);
        }
      }

      for (const cv of validChildren) {
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

  // Filter out negligible weights (< 0.1%) — matches Composer's tdvm_weights threshold.
  // Strategies like Gobi use wt-cash-specified with 99.9%/0.1% splits where the 0.1% "tag"
  // ticker is just a marker, not a real holding.
  const finalResult = Object.entries(consolidated)
    .filter(([, weight]) => weight > 0.001)
    .map(([ticker, weight]) => ({ ticker, weight }));

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
        let combinedResult;
        if (isCompoundCondition(cond)) {
          // Evaluate compound condition (ANY/ALL) with verbose output
          const { operator, conditions } = cond.condition;
          const opLabel = operator === 'any' ? 'ANY (OR)' : 'ALL (AND)';
          console.log(`${pad}┌─ IF [${opLabel}] compound condition (${conditions.length} sub-conditions):`);

          const subResults = [];
          for (let si = 0; si < conditions.length; si++) {
            const sub = conditions[si];
            // Handle nested compound conditions (ANY of ALLs, etc.)
            if (sub['condition-type'] === 'compound' || (sub.operator && sub.conditions)) {
              const nestedOp = sub.operator;
              const nestedLabel = nestedOp === 'any' ? 'ANY' : 'ALL';
              console.log(`${pad}│  [${si + 1}] Nested [${nestedLabel}] (${sub.conditions.length} sub-conditions):`);
              const nestedResult = evalCompoundSubRecursive(sub, dailyData, intradayData, date, time, false);
              const nestedEmoji = nestedResult === true ? 'TRUE' : nestedResult === false ? 'FALSE' : 'NULL';
              console.log(`${pad}│      => ${nestedEmoji}`);
              subResults.push(nestedResult);
              continue;
            }
            const flatSub = flattenCompoundSubCondition(sub);
            if (!flatSub) { subResults.push(null); continue; }
            const v = evalCondVerbose(flatSub, dailyData, intradayData, date, time);

            const lhsFmt = `${v.lhsTicker}.${formatFnName(v.lhsFn)}(${v.lhsWindow})`;
            const lhsValFmt = v.lhsValue !== null ? v.lhsValue.toFixed(4) : 'NULL';
            let rhsFmt, rhsValFmt;
            if (v.rhsIsFixed) {
              rhsFmt = `${v.rhsValue}`;
              rhsValFmt = v.rhsValue.toFixed(4);
            } else {
              rhsFmt = `${v.rhsTicker}.${formatFnName(v.rhsFn)}(${v.rhsWindow})`;
              rhsValFmt = v.rhsValue !== null ? v.rhsValue.toFixed(4) : 'NULL';
            }
            const cmpFmt = formatCmp(v.comparator);
            const subEmoji = v.evalResult === true ? 'TRUE' : v.evalResult === false ? 'FALSE' : 'NULL';

            console.log(`${pad}│  [${si + 1}] ${lhsFmt} ${cmpFmt} ${rhsFmt}`);
            console.log(`${pad}│      ${lhsValFmt} ${cmpFmt} ${rhsValFmt} => ${subEmoji}`);
            subResults.push(v.evalResult);
          }

          // Three-valued logic: short-circuit before considering nulls
          const hasNull = subResults.some(s => s === null);
          if (operator === 'any') {
            if (subResults.some(s => s === true)) combinedResult = true;
            else combinedResult = hasNull ? null : false;
          } else { // 'all'
            if (subResults.some(s => s === false)) combinedResult = false;
            else combinedResult = hasNull ? null : true;
          }
          const resultEmoji = combinedResult === true ? 'TRUE' : combinedResult === false ? 'FALSE' : 'NULL';
          console.log(`${pad}│     Combined [${opLabel}]: ${resultEmoji}`);
        } else {
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
          const resultEmoji = v.evalResult === true ? 'TRUE' : v.evalResult === false ? 'FALSE' : 'NULL';

          console.log(`${pad}┌─ IF ${lhsFmt} ${cmpFmt} ${rhsFmt}`);
          console.log(`${pad}│     LHS: ${lhsValFmt} (${v.lhsDataPoints} data points)`);
          if (!v.rhsIsFixed) {
            console.log(`${pad}│     RHS: ${rhsValFmt} (${v.rhsDataPoints} data points)`);
          }
          console.log(`${pad}│     Result: ${lhsValFmt} ${cmpFmt} ${rhsValFmt} => ${resultEmoji}`);
          combinedResult = v.evalResult;
        }

        if (combinedResult === true && cond.children) {
          console.log(`${pad}├─ THEN:`);
          const childWeight = weight / Math.max(cond.children.length, 1);
          cond.children.forEach(child => walk(child, childWeight, depth + 1));
        } else if ((combinedResult === false || combinedResult === null) && els?.children) {
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

      // Composer behavior: if ANY child has non-finite vol, ONLY keep those children
      const validVols = childVols.filter(cv => cv.vol !== null && cv.vol > 0 && isFinite(1 / cv.vol));
      const nonFiniteVols = childVols.filter(cv => !cv.vol || cv.vol <= 0 || !isFinite(1 / cv.vol));

      if (nonFiniteVols.length > 0) {
        // Composer: only keep non-finite children, merge equally
        const childWeight = weight / nonFiniteVols.length;
        for (const cv of childVols) {
          const tickerStr = cv.tickers.length === 1 ? cv.tickers[0] : `Group(${cv.tickers.join(',')})`;
          const volStr = cv.vol !== null ? cv.vol.toFixed(2) + '%' : 'NULL';
          const isNonFinite = !cv.vol || cv.vol <= 0 || !isFinite(1 / cv.vol);
          const wtStr = isNonFinite ? (100 / nonFiniteVols.length).toFixed(1) + '%' : '0% (finite vol, excluded)';
          console.log(`${pad}│  ${tickerStr}: vol=${volStr} → weight=${wtStr}`);
          if (isNonFinite) {
            walk(cv.child, childWeight, depth + 1);
          }
        }
        console.log(`${pad}└─`);
        return;
      }

      const invSum = validVols.reduce((acc, cv) => acc + (1 / cv.vol), 0);

      for (const cv of childVols) {
        const tickerStr = cv.tickers.length === 1 ? cv.tickers[0] : `Group(${cv.tickers.join(',')})`;
        const volStr = cv.vol !== null ? cv.vol.toFixed(2) + '%' : 'NULL';
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

  // Consolidate results and filter negligible weights (< 0.1%)
  const consolidated = {};
  for (const r of results) {
    if (!consolidated[r.ticker]) consolidated[r.ticker] = 0;
    consolidated[r.ticker] += r.weight;
  }

  return Object.entries(consolidated)
    .filter(([, weight]) => weight > 0.001)
    .map(([ticker, weight]) => ({ ticker, weight }));
}

// ============================================================================
// DATA FETCHING (Parallel with concurrency limit)
// ============================================================================

const YAHOO_CONCURRENCY = 20;

// Yahoo-only fetch (fallback path)
async function fetchAllDataYahoo(tickers, intradayDays, dailyDays, quiet = false, skipIntraday = false) {
  const intradayData = {};
  const dailyData = {};
  const errors = { intraday: [], daily: [] };

  async function runWithConcurrency(items, fn) {
    const results = [];
    for (let i = 0; i < items.length; i += YAHOO_CONCURRENCY) {
      const batch = items.slice(i, i + YAHOO_CONCURRENCY);
      const batchResults = await Promise.all(batch.map(fn));
      results.push(...batchResults);
      if (i + YAHOO_CONCURRENCY < items.length) await sleep(100);
    }
    return results;
  }

  if (!quiet) {
    const label = skipIntraday ? 'daily' : 'intraday + daily';
    console.log(`  Fetching ${label} from Yahoo (${tickers.length} tickers)...`);
  }

  await runWithConcurrency(tickers, async (t) => {
    const yahooTicker = normalizeTickerYahoo(t);
    const promises = [];

    if (!skipIntraday) {
      promises.push(
        getYahooIntradayData(yahooTicker, intradayDays)
          .then(data => { intradayData[t] = data; })
          .catch(e => {
            errors.intraday.push(t);
            const errMsg = e.message || 'Unknown error';
            recordTickerError(t, 'intraday', errMsg.substring(0, 50));
          })
      );
    }

    promises.push(
      getYahooDailyData(yahooTicker, dailyDays)
        .then(data => { dailyData[t] = data; })
        .catch(e => {
          errors.daily.push(t);
          recordTickerError(t, 'daily', (e.message || 'Unknown error').substring(0, 50));
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

// Alpaca-primary fetch with per-ticker Yahoo fallback
async function fetchAllDataAlpaca(tickers, intradayDays, dailyDays, quiet = false, skipIntraday = false) {
  const intradayData = {};
  const dailyData = {};

  // Normalize tickers for Alpaca
  const alpacaTickerMap = {};  // alpaca_ticker -> original_ticker
  const alpacaTickers = tickers.map(t => {
    const alpaca = normalizeTickerAlpaca(t);
    alpacaTickerMap[alpaca] = t;
    return alpaca;
  });

  if (!quiet) {
    const label = skipIntraday ? 'daily' : `intraday (${CONFIG.ALPACA_TIMEFRAME}) + daily`;
    console.log(`  Fetching ${label} from Alpaca (${tickers.length} tickers)...`);
  }

  // Fetch intraday from Alpaca
  const failedIntraday = [];
  if (!skipIntraday) {
    const intradayResult = await getAlpacaIntradayData(alpacaTickers, intradayDays);
    for (const [alpacaTicker, data] of Object.entries(intradayResult.results)) {
      const original = alpacaTickerMap[alpacaTicker] || alpacaTicker;
      intradayData[original] = data;
    }
    for (const err of intradayResult.errors) {
      const original = alpacaTickerMap[err.ticker] || err.ticker;
      failedIntraday.push({ original, error: err.error });
    }
    if (!quiet) process.stdout.write('.');
  }

  // Fetch daily from Alpaca
  const failedDaily = [];
  const dailyResult = await getAlpacaDailyData(alpacaTickers, dailyDays);
  for (const [alpacaTicker, data] of Object.entries(dailyResult.results)) {
    const original = alpacaTickerMap[alpacaTicker] || alpacaTicker;
    dailyData[original] = data;
  }
  for (const err of dailyResult.errors) {
    const original = alpacaTickerMap[err.ticker] || err.ticker;
    failedDaily.push({ original, error: err.error });
  }
  if (!quiet) process.stdout.write('.');

  // Yahoo fallback for failed tickers
  const intradayFallbackTickers = failedIntraday.map(f => f.original);
  const dailyFallbackTickers = failedDaily.map(f => f.original);
  const allFallbackTickers = [...new Set([...intradayFallbackTickers, ...dailyFallbackTickers])];

  if (allFallbackTickers.length > 0 && !quiet) {
    console.log(`\n    Falling back to Yahoo for ${allFallbackTickers.length} ticker(s): ${allFallbackTickers.join(', ')}`);
  }

  // Per-ticker Yahoo fallback
  for (const t of allFallbackTickers) {
    const yahooTicker = normalizeTickerYahoo(t);

    if (intradayFallbackTickers.includes(t) && !skipIntraday) {
      try {
        const data = await getYahooIntradayData(yahooTicker, Math.min(intradayDays, CONFIG.MAX_INTRADAY_DAYS_YAHOO));
        intradayData[t] = data;
      } catch (e) {
        recordTickerError(t, 'intraday', `Alpaca + Yahoo both failed: ${(e.message || '').substring(0, 30)}`);
      }
    }

    if (dailyFallbackTickers.includes(t)) {
      try {
        const data = await getYahooDailyData(yahooTicker, dailyDays);
        dailyData[t] = data;
      } catch (e) {
        recordTickerError(t, 'daily', `Alpaca + Yahoo both failed: ${(e.message || '').substring(0, 30)}`);
      }
    }
  }

  if (!quiet) console.log(` done`);

  return { intradayData, dailyData };
}

// Hybrid fetch: Alpaca intraday + Yahoo daily (consolidated close prices match Composer better)
async function fetchAllDataHybrid(tickers, intradayDays, dailyDays, quiet = false, skipIntraday = false) {
  if (!quiet) console.log(`  Fetching hybrid: Alpaca intraday + Yahoo daily (${tickers.length} tickers)...`);

  // Fetch intraday from Alpaca (extended history)
  const alpacaResult = await fetchAllDataAlpaca(tickers, intradayDays, dailyDays, true, false);

  // Fetch daily from Yahoo (consolidated close prices)
  const yahooResult = await fetchAllDataYahoo(tickers, 0, dailyDays, true, true);  // skipIntraday=true

  // Use Alpaca intraday + Yahoo daily
  const intradayData = alpacaResult.intradayData;
  const dailyData = yahooResult.dailyData;

  // Fill in any missing Yahoo daily with Alpaca daily as fallback
  let yahooFailed = 0;
  for (const t of tickers) {
    if (!dailyData[t] || !dailyData[t].byDate || Object.keys(dailyData[t].byDate).length === 0) {
      if (alpacaResult.dailyData[t]) {
        dailyData[t] = alpacaResult.dailyData[t];
        yahooFailed++;
      }
    }
  }

  if (!quiet) {
    console.log(`.. done`);
    if (yahooFailed > 0) console.log(`    ${yahooFailed} ticker(s) used Alpaca daily as fallback`);
  }

  return { intradayData, dailyData };
}

// Unified fetch orchestrator - routes to Alpaca or Yahoo based on config
// ============================================================================
// PERSISTENT DISK CACHE — saves fetched price data per-ticker across runs
// ============================================================================

const CACHE_BASE = path.join(APP_DIR, 'cache');

function getDiskCacheDir(type) {
  // type: 'intraday' or 'daily'
  const subdir = type === 'intraday' ? `intraday-${CONFIG.ALPACA_TIMEFRAME}` : 'daily';
  const dir = path.join(CACHE_BASE, subdir);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function loadDiskCache(ticker, type) {
  try {
    const file = path.join(getDiskCacheDir(type), `${ticker}.json`);
    if (!fs.existsSync(file)) return null;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    // Reconstruct bar objects from cached format.
    // Handles: number (legacy close-only) → {open: val, close: val}
    //          {open, close} (current format) → kept as-is
    if (type === 'intraday' && raw.byDT) {
      for (const date of Object.keys(raw.byDT)) {
        const times = raw.byDT[date];
        for (const time of Object.keys(times)) {
          if (time < '09:30' || time > '16:00') { delete times[time]; continue; } // skip pre/post-market
          if (typeof times[time] === 'number') {
            // Legacy close-only: use close as open too (best available approximation)
            times[time] = { open: times[time], close: times[time] };
          }
        }
      }
    } else if (type === 'daily' && raw.byDate) {
      for (const date of Object.keys(raw.byDate)) {
        if (typeof raw.byDate[date] === 'number') {
          raw.byDate[date] = { close: raw.byDate[date] };
        }
      }
    }
    return raw;
  } catch { return null; }
}

function saveDiskCache(ticker, type, data) {
  try {
    const file = path.join(getDiskCacheDir(type), `${ticker}.json`);
    // Strip to open+close to minimize disk usage while preserving both price points.
    // Open is needed because bar timestamps are bar START times — open is the price AT that time,
    // while close is the price at the END of the bar (shifted forward by the bar interval).
    const slim = { ...data };
    if (type === 'intraday' && slim.byDT) {
      const stripped = {};
      for (const date of Object.keys(slim.byDT)) {
        stripped[date] = {};
        for (const [time, bar] of Object.entries(slim.byDT[date])) {
          if (time < '09:30' || time > '16:00') continue; // skip pre/post-market
          if (bar && typeof bar === 'object') {
            stripped[date][time] = { open: bar.open, close: bar.close };
          } else {
            // Legacy close-only format: number → use as both open and close
            stripped[date][time] = bar;
          }
        }
      }
      slim.byDT = stripped;
    } else if (type === 'daily' && slim.byDate) {
      const stripped = {};
      for (const [date, bar] of Object.entries(slim.byDate)) {
        stripped[date] = bar?.close ?? bar;
      }
      slim.byDate = stripped;
    }
    fs.writeFileSync(file, JSON.stringify(slim), 'utf8');
  } catch { /* silent fail */ }
}

function getTodayET() {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const y = et.getFullYear();
  const m = String(et.getMonth() + 1).padStart(2, '0');
  const d = String(et.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// ============================================================================
// TICKER DATA CACHE — avoids re-fetching shared tickers across strategies
// ============================================================================

const _tickerDataCache = {
  intraday: {},  // { ticker: { byDT: {...}, source, timeframe } }
  daily: {},     // { ticker: { byDate: {...}, source } }
  timeframe: null, // track which timeframe was cached
  hits: 0,
  misses: 0,
};

function clearTickerDataCache() {
  _tickerDataCache.intraday = {};
  _tickerDataCache.daily = {};
  _tickerDataCache.timeframe = null;
  _tickerDataCache.hits = 0;
  _tickerDataCache.misses = 0;
}

async function fetchAllData(tickers, intradayDays, dailyDays, quiet = false, skipIntraday = false) {
  // Check if timeframe changed (invalidate intraday cache)
  if (_tickerDataCache.timeframe && _tickerDataCache.timeframe !== CONFIG.ALPACA_TIMEFRAME) {
    if (!quiet) console.log(`  (Timeframe changed to ${CONFIG.ALPACA_TIMEFRAME}, clearing intraday cache)`);
    _tickerDataCache.intraday = {};
    _tickerDataCache.timeframe = null;
  }

  // Split tickers into cached and uncached.
  // Check memory cache first, then disk cache. If disk cache has sufficient
  // coverage and is fresh (last date within 4 calendar days of today — covers
  // weekends and holidays), load directly into memory and skip the API call.
  const uncachedIntraday = [];
  const uncachedDaily = [];
  const cachedIntradayData = {};
  const cachedDailyData = {};

  const todayForCache = getTodayET();
  const todayMsForCache = new Date(todayForCache + 'T00:00:00').getTime();
  const FRESH_THRESHOLD_DAYS = 4; // Covers weekends (Fri→Mon=3) + 1 buffer
  let diskHitsIntraday = 0;
  let diskHitsDaily = 0;

  for (const t of tickers) {
    // --- Intraday ---
    if (!skipIntraday) {
      if (_tickerDataCache.intraday[t]) {
        cachedIntradayData[t] = _tickerDataCache.intraday[t];
        _tickerDataCache.hits++;
      } else {
        // Try disk cache: if fresh enough and spans enough history, use it directly
        const disk = loadDiskCache(t, 'intraday');
        if (disk && disk.byDT && Object.keys(disk.byDT).length > 0) {
          const dates = Object.keys(disk.byDT).sort();
          const lastDate = dates[dates.length - 1];
          const oldestDate = dates[0];
          const gapDays = Math.ceil((todayMsForCache - new Date(lastDate + 'T00:00:00').getTime()) / 86400000);
          const spanDays = Math.ceil((todayMsForCache - new Date(oldestDate + 'T00:00:00').getTime()) / 86400000);
          if (gapDays <= FRESH_THRESHOLD_DAYS && spanDays >= intradayDays * 0.8) {
            // Disk cache is fresh and has sufficient history — use directly
            _tickerDataCache.intraday[t] = disk;
            cachedIntradayData[t] = disk;
            _tickerDataCache.hits++;
            diskHitsIntraday++;
          } else {
            uncachedIntraday.push(t);
            _tickerDataCache.misses++;
          }
        } else {
          uncachedIntraday.push(t);
          _tickerDataCache.misses++;
        }
      }
    }

    // --- Daily ---
    if (_tickerDataCache.daily[t]) {
      cachedDailyData[t] = _tickerDataCache.daily[t];
      _tickerDataCache.hits++;
    } else {
      const disk = loadDiskCache(t, 'daily');
      if (disk && disk.byDate && Object.keys(disk.byDate).length > 0) {
        const dates = Object.keys(disk.byDate).sort();
        const lastDate = dates[dates.length - 1];
        const oldestDate = dates[0];
        const gapDays = Math.ceil((todayMsForCache - new Date(lastDate + 'T00:00:00').getTime()) / 86400000);
        const spanDays = Math.ceil((todayMsForCache - new Date(oldestDate + 'T00:00:00').getTime()) / 86400000);
        if (gapDays <= FRESH_THRESHOLD_DAYS && spanDays >= dailyDays * 0.8) {
          _tickerDataCache.daily[t] = disk;
          cachedDailyData[t] = disk;
          _tickerDataCache.hits++;
          diskHitsDaily++;
        } else {
          uncachedDaily.push(t);
          _tickerDataCache.misses++;
        }
      } else {
        uncachedDaily.push(t);
        _tickerDataCache.misses++;
      }
    }
  }

  const cachedCount = tickers.length - Math.max(uncachedIntraday.length, uncachedDaily.length);
  const needsFetch = uncachedIntraday.length > 0 || uncachedDaily.length > 0;
  const totalDiskHits = Math.max(diskHitsIntraday, diskHitsDaily);

  if (cachedCount > 0 && !quiet) {
    const memOnly = cachedCount - totalDiskHits;
    const parts = [];
    if (memOnly > 0) parts.push(`${memOnly} memory`);
    if (totalDiskHits > 0) parts.push(`${totalDiskHits} disk`);
    console.log(`  Cache: ${cachedCount}/${tickers.length} tickers loaded (${parts.join(' + ')})`);
  }

  // Fetch only uncached tickers
  let freshIntradayData = {};
  let freshDailyData = {};

  if (needsFetch) {
    // Determine which tickers need fetching (union of uncached intraday + daily)
    const allUncached = [...new Set([...uncachedIntraday, ...uncachedDaily])];
    const skipIntra = skipIntraday || uncachedIntraday.length === 0;

    // Smart fetch: check disk cache to reduce API window to only new days
    const todayET = getTodayET();
    const todayMs = new Date(todayET + 'T00:00:00').getTime();
    let effectiveIntradayDays = intradayDays;
    let effectiveDailyDays = dailyDays;
    let hasDiskHistory = false;

    if (!skipIntra) {
      let maxIntraGap = 0;
      let anyMissingIntra = false;
      for (const t of uncachedIntraday) {
        const disk = loadDiskCache(t, 'intraday');
        if (disk && disk.byDT && Object.keys(disk.byDT).length > 0) {
          const dates = Object.keys(disk.byDT).sort();
          const oldestDate = dates[0];
          const lastDate = dates[dates.length - 1];
          // Check that cache spans back far enough for the requested window
          const spanDays = Math.ceil((todayMs - new Date(oldestDate + 'T00:00:00').getTime()) / 86400000);
          if (spanDays < intradayDays * 0.8) { // cache doesn't cover enough history
            anyMissingIntra = true;
          } else {
            const gap = Math.ceil((todayMs - new Date(lastDate + 'T00:00:00').getTime()) / 86400000) + 2; // +2 for safety
            maxIntraGap = Math.max(maxIntraGap, gap);
          }
        } else {
          anyMissingIntra = true;
        }
      }
      if (!anyMissingIntra && maxIntraGap > 0 && maxIntraGap < intradayDays) {
        effectiveIntradayDays = maxIntraGap;
        hasDiskHistory = true;
      }
    }

    let maxDailyGap = 0;
    let anyMissingDaily = false;
    for (const t of uncachedDaily) {
      const disk = loadDiskCache(t, 'daily');
      if (disk && disk.byDate && Object.keys(disk.byDate).length > 0) {
        const dates = Object.keys(disk.byDate).sort();
        const oldestDate = dates[0];
        const lastDate = dates[dates.length - 1];
        const spanDays = Math.ceil((todayMs - new Date(oldestDate + 'T00:00:00').getTime()) / 86400000);
        if (spanDays < dailyDays * 0.8) {
          anyMissingDaily = true;
        } else {
          const gap = Math.ceil((todayMs - new Date(lastDate + 'T00:00:00').getTime()) / 86400000) + 2;
          maxDailyGap = Math.max(maxDailyGap, gap);
        }
      } else {
        anyMissingDaily = true;
      }
    }
    if (!anyMissingDaily && maxDailyGap > 0 && maxDailyGap < dailyDays) {
      effectiveDailyDays = maxDailyGap;
      hasDiskHistory = true;
    }

    if (hasDiskHistory && !quiet) {
      console.log(`  Disk cache: fetching only ${effectiveIntradayDays}d intraday / ${effectiveDailyDays}d daily (new days only)`);
    }

    const source = CONFIG.dataSource;
    const useAlpaca = (source === 'alpaca' || source === 'auto') && hasAlpacaKeys();

    let result;
    if (source === 'hybrid' && hasAlpacaKeys()) {
      result = await fetchAllDataHybrid(allUncached, effectiveIntradayDays, effectiveDailyDays, quiet, skipIntra);
    } else if (useAlpaca) {
      result = await fetchAllDataAlpaca(allUncached, effectiveIntradayDays, effectiveDailyDays, quiet, skipIntra);
    } else {
      if (source === 'alpaca' && !hasAlpacaKeys()) {
        if (!quiet) console.log('  Warning: Alpaca requested but no API keys configured. Using Yahoo.');
      }
      const cappedIntradayDays = Math.min(effectiveIntradayDays, CONFIG.MAX_INTRADAY_DAYS_YAHOO);
      result = await fetchAllDataYahoo(allUncached, cappedIntradayDays, effectiveDailyDays, quiet, skipIntra);
    }

    freshIntradayData = result.intradayData || {};
    freshDailyData = result.dailyData || {};

    // Store freshly fetched data in memory cache + merge into disk cache
    // Disk cache preserves older days beyond the API window
    for (const [t, data] of Object.entries(freshIntradayData)) {
      const existingDisk = loadDiskCache(t, 'intraday');
      const merged = existingDisk && existingDisk.byDT
        ? { ...data, byDT: { ...existingDisk.byDT, ...data.byDT } }
        : data;
      _tickerDataCache.intraday[t] = merged;
      saveDiskCache(t, 'intraday', merged);
    }
    for (const [t, data] of Object.entries(freshDailyData)) {
      const existingDisk = loadDiskCache(t, 'daily');
      const merged = existingDisk && existingDisk.byDate
        ? { ...data, byDate: { ...existingDisk.byDate, ...data.byDate } }
        : data;
      _tickerDataCache.daily[t] = merged;
      saveDiskCache(t, 'daily', merged);
    }
    _tickerDataCache.timeframe = CONFIG.ALPACA_TIMEFRAME;

    // Update freshData references to use merged data for return
    for (const t of Object.keys(freshIntradayData)) {
      freshIntradayData[t] = _tickerDataCache.intraday[t];
    }
    for (const t of Object.keys(freshDailyData)) {
      freshDailyData[t] = _tickerDataCache.daily[t];
    }
  } else if (!quiet) {
    console.log(`  All ${tickers.length} tickers served from cache`);
  }

  // Merge cached + fresh
  const intradayData = { ...cachedIntradayData, ...freshIntradayData };
  const dailyData = { ...cachedDailyData, ...freshDailyData };

  return { intradayData, dailyData };
}

// ============================================================================
// DEBUG COMPARE MODE - Fetch from both sources and compare
// ============================================================================

async function debugCompareData(tickers, days) {
  console.log('\n  DEBUG COMPARE: Fetching from both Alpaca and Yahoo...\n');

  const yahooIntraday = Math.min(days, CONFIG.MAX_INTRADAY_DAYS_YAHOO);

  // Fetch from both sources
  console.log('  [1/2] Fetching from Yahoo...');
  const yahooResult = await fetchAllDataYahoo(tickers, yahooIntraday, CONFIG.MAX_DAILY_DAYS, true);

  console.log('  [2/2] Fetching from Alpaca...');
  const alpacaResult = await fetchAllDataAlpaca(tickers, days, CONFIG.MAX_DAILY_DAYS, true);

  // Compare intraday data for overlapping dates
  console.log(`\n${'═'.repeat(80)}`);
  console.log('  ALPACA vs YAHOO DATA COMPARISON');
  console.log(`${'═'.repeat(80)}`);

  let totalBars = 0;
  let matchedBars = 0;
  let mismatchedBars = 0;
  const threshold = 0.005;  // 0.5% tolerance

  for (const ticker of tickers) {
    const alpacaIntra = alpacaResult.intradayData[ticker]?.byDT || {};
    const yahooIntra = yahooResult.intradayData[ticker]?.byDT || {};

    const alpacaDates = Object.keys(alpacaIntra).sort();
    const yahooDates = Object.keys(yahooIntra).sort();
    const overlapDates = alpacaDates.filter(d => yahooDates.includes(d));

    if (overlapDates.length === 0) {
      console.log(`\n  ${ticker}: No overlapping dates to compare`);
      continue;
    }

    let tickerMismatches = 0;
    let tickerTotal = 0;

    for (const date of overlapDates) {
      const alpacaTimes = alpacaIntra[date] || {};
      const yahooTimes = yahooIntra[date] || {};

      for (const time of Object.keys(alpacaTimes)) {
        if (!yahooTimes[time]) continue;

        tickerTotal++;
        totalBars++;
        const alpacaClose = alpacaTimes[time].close;
        const yahooClose = yahooTimes[time].close;
        const diff = Math.abs(alpacaClose - yahooClose) / yahooClose;

        if (diff > threshold) {
          mismatchedBars++;
          tickerMismatches++;
          if (tickerMismatches <= 5) {
            console.log(`    ${ticker} ${date} ${time} | Alpaca: ${alpacaClose.toFixed(2)} | Yahoo: ${yahooClose.toFixed(2)} | diff: ${(diff * 100).toFixed(3)}%`);
          }
        } else {
          matchedBars++;
        }
      }
    }

    const matchPct = tickerTotal > 0 ? ((tickerTotal - tickerMismatches) / tickerTotal * 100).toFixed(1) : '0.0';
    console.log(`\n  ${ticker}: ${tickerTotal - tickerMismatches}/${tickerTotal} bars matched (${matchPct}%) over ${overlapDates.length} overlapping days`);
    if (tickerMismatches > 5) {
      console.log(`    ... (${tickerMismatches - 5} more mismatches not shown)`);
    }

    // Also compare daily data
    const alpacaDaily = alpacaResult.dailyData[ticker]?.byDate || {};
    const yahooDaily = yahooResult.dailyData[ticker]?.byDate || {};
    const dailyOverlap = Object.keys(alpacaDaily).filter(d => d in yahooDaily);
    let dailyMismatches = 0;
    for (const date of dailyOverlap) {
      const diff = Math.abs(alpacaDaily[date].close - yahooDaily[date].close) / yahooDaily[date].close;
      if (diff > threshold) dailyMismatches++;
    }
    console.log(`    Daily: ${dailyOverlap.length - dailyMismatches}/${dailyOverlap.length} matched`);
  }

  console.log(`\n${'─'.repeat(80)}`);
  console.log(`  SUMMARY: ${matchedBars}/${totalBars} intraday bars matched within ${(threshold * 100).toFixed(1)}% threshold`);
  if (mismatchedBars > 0) {
    console.log(`  NOTE: ${mismatchedBars} bars differed. IEX exchange data (Alpaca free tier) may differ`);
    console.log(`        from consolidated tape data (Yahoo). This is expected for ~2.5% of volume.`);
  }
  console.log(`${'─'.repeat(80)}\n`);

  // Return Alpaca data as the primary result
  return alpacaResult;
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

// Annualized return from cumulative return and number of trading days
// Uses 252 trading days per year
function annualizedReturn(cumReturn, tradingDays) {
  if (!tradingDays || tradingDays <= 0) return null;
  const totalReturn = cumReturn / 100; // convert from percentage
  const years = tradingDays / 252;
  if (years <= 0) return null;
  // CAGR = (1 + totalReturn)^(1/years) - 1
  const cagr = (Math.pow(1 + totalReturn, 1 / years) - 1) * 100;
  return cagr;
}

// Filter trading days to custom date range (CONFIG.dateStart / CONFIG.dateEnd)
function applyDateRange(tradingDays) {
  if (!CONFIG.dateStart && !CONFIG.dateEnd) return tradingDays;
  return tradingDays.filter(d => {
    if (CONFIG.dateStart && d < CONFIG.dateStart) return false;
    if (CONFIG.dateEnd && d > CONFIG.dateEnd) return false;
    return true;
  });
}

function getPreviousTradingDay(date, tradingDays) {
  const idx = tradingDays.indexOf(date);
  if (idx > 0) return tradingDays[idx - 1];
  return 'prior day';
}

// ============================================================================
// REBALANCE THRESHOLD LOGIC
// ============================================================================

/**
 * Determines whether the portfolio should rebalance, respecting the strategy's
 * rebalance-corridor-width threshold. If the strategy uses daily rebalancing
 * (threshold=null), always returns true. For threshold strategies, computes the
 * max weight drift between current (price-adjusted) holdings and new targets.
 */
function shouldRebalance(currentHoldings, targetHoldings, threshold, dailyData, intradayData, prevDate, currDate, prevTime, currTime) {
  if (threshold === null || threshold === undefined) return true; // daily = always rebalance
  if (currentHoldings.length === 0) return true; // no holdings yet = must rebalance

  // Compute actual weights after price movement
  let totalValue = 0;
  const holdingValues = [];
  for (const h of currentHoldings) {
    const prevPrice = getIntradayPrice(h.ticker, intradayData, prevDate, prevTime, dailyData);
    const currPrice = getIntradayPrice(h.ticker, intradayData, currDate, currTime, dailyData);
    const value = (prevPrice && currPrice && prevPrice > 0) ? h.weight * (currPrice / prevPrice) : h.weight;
    holdingValues.push({ ticker: h.ticker, value });
    totalValue += value;
  }

  // Build actual weight map (aggregate duplicate tickers)
  const actualWeights = {};
  for (const h of holdingValues) {
    actualWeights[h.ticker] = (actualWeights[h.ticker] || 0) + (totalValue > 0 ? h.value / totalValue : 0);
  }

  // Build target weight map
  const targetWeights = {};
  for (const h of targetHoldings) {
    targetWeights[h.ticker] = (targetWeights[h.ticker] || 0) + h.weight;
  }

  // Compute max absolute drift across all tickers in either portfolio
  const allTickers = new Set([...Object.keys(actualWeights), ...Object.keys(targetWeights)]);
  let maxDrift = 0;
  for (const ticker of allTickers) {
    const actual = actualWeights[ticker] || 0;
    const target = targetWeights[ticker] || 0;
    const drift = Math.abs(actual - target);
    if (drift > maxDrift) maxDrift = drift;
  }

  return maxDrift > threshold;
}

/**
 * Checks if a morning "Run Now" execution would pass the execution threshold.
 * This mirrors the n8n workflow's 5% skip rule: if the max allocation change
 * between current (drifted) holdings and the target selection is below the
 * threshold, skip the intraday execution entirely (no Run Now).
 * Returns true if the change is large enough to execute.
 */
function passesExecutionThreshold(currentHoldings, targetHoldings, dailyData, intradayData, prevDate, currDate, prevTime, currTime) {
  const execThreshold = CONFIG.executionThreshold;
  if (execThreshold === null || execThreshold === undefined) return true; // no threshold = always execute

  if (currentHoldings.length === 0) return true; // no holdings = must execute

  // Compute actual drifted weights after price movement
  let totalValue = 0;
  const holdingValues = [];
  for (const h of currentHoldings) {
    const prevPrice = getIntradayPrice(h.ticker, intradayData, prevDate, prevTime, dailyData);
    const currPrice = getIntradayPrice(h.ticker, intradayData, currDate, currTime, dailyData);
    const value = (prevPrice && currPrice && prevPrice > 0) ? h.weight * (currPrice / prevPrice) : h.weight;
    holdingValues.push({ ticker: h.ticker, value });
    totalValue += value;
  }

  const actualWeights = {};
  for (const h of holdingValues) {
    actualWeights[h.ticker] = (actualWeights[h.ticker] || 0) + (totalValue > 0 ? h.value / totalValue : 0);
  }

  const targetWeights = {};
  for (const h of targetHoldings) {
    targetWeights[h.ticker] = (targetWeights[h.ticker] || 0) + h.weight;
  }

  // Max allocation change across all tickers
  const allTickers = new Set([...Object.keys(actualWeights), ...Object.keys(targetWeights)]);
  let maxChange = 0;
  for (const ticker of allTickers) {
    const actual = actualWeights[ticker] || 0;
    const target = targetWeights[ticker] || 0;
    const change = Math.abs(actual - target);
    if (change > maxChange) maxChange = change;
  }

  return maxChange >= execThreshold;
}

/**
 * Checks if the portfolio is up enough since previous EOD to justify an intraday execution.
 * Only execute Run Now on "green" days where portfolio gain exceeds the take-profit threshold.
 * Returns true if gain >= threshold (or threshold is disabled).
 */
function passesTakeProfitThreshold(holdings, dailyData, intradayData, prevDate, currDate, morningTime) {
  const tpThreshold = CONFIG.takeProfitThreshold;
  if (tpThreshold === null || tpThreshold === undefined) return true; // disabled = always pass
  if (!prevDate || holdings.length === 0) return true; // no prior data = pass

  // Compute portfolio return from prevDate EOD to currDate morning
  let portfolioReturn = 0;
  let totalWeight = 0;
  for (const h of holdings) {
    const prevEOD = getIntradayPrice(h.ticker, intradayData, prevDate, CONFIG.EOD_TIME, dailyData);
    const currMorning = getIntradayPrice(h.ticker, intradayData, currDate, morningTime, dailyData);
    if (prevEOD && currMorning && prevEOD > 0) {
      portfolioReturn += h.weight * ((currMorning - prevEOD) / prevEOD);
      totalWeight += h.weight;
    }
  }

  return portfolioReturn >= tpThreshold;
}

/**
 * Computes drifted weights after price movement (for non-rebalance days).
 * Returns new holdings array with updated weights reflecting actual portfolio proportions.
 */
function getDriftedWeights(holdings, dailyData, intradayData, prevDate, currDate, prevTime, currTime) {
  let totalValue = 0;
  const holdingValues = [];
  for (const h of holdings) {
    const prevPrice = getIntradayPrice(h.ticker, intradayData, prevDate, prevTime, dailyData);
    const currPrice = getIntradayPrice(h.ticker, intradayData, currDate, currTime, dailyData);
    const value = (prevPrice && currPrice && prevPrice > 0) ? h.weight * (currPrice / prevPrice) : h.weight;
    holdingValues.push({ ticker: h.ticker, value });
    totalValue += value;
  }
  if (totalValue === 0) return holdings;
  return holdingValues.map(h => ({ ticker: h.ticker, weight: h.value / totalValue }));
}

// ============================================================================
// COMPOSER BASELINE (use Composer's actual backtest holdings as EOD baseline)
// ============================================================================

/**
 * Fetch Composer's full backtest for a strategy and extract day-by-day holdings from tdvm_weights.
 * Returns { holdingsByDate: { 'YYYY-MM-DD': [{ticker, weight}] }, equityCurve: {...} } or null on failure.
 */
async function fetchComposerBaselineHoldings(symphonyId, startDate, endDate) {
  return new Promise((resolve) => {
    const postData = JSON.stringify({
      start_date: startDate || '2020-01-01',
      end_date: endDate || new Date().toISOString().split('T')[0],
      capital: 10000,
      slippage_percent: 0.0001,
      apply_reg_fee: true,
      apply_taf_fee: true,
      backtest_version: 'v2'
    });

    const useAuth = hasComposerKeys();
    const apiPath = useAuth
      ? `/api/v2/symphonies/${symphonyId}/backtest`
      : `/api/v2/public/symphonies/${symphonyId}/backtest`;
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData),
      'Accept': 'application/json',
    };
    if (useAuth) {
      headers['x-api-key-id'] = CONFIG.composer.keyId;
      headers['Authorization'] = `Bearer ${CONFIG.composer.secret}`;
      headers['x-origin'] = 'public-api';
    }

    const req = https.request({
      hostname: 'backtest-api.composer.trade',
      port: 443,
      path: apiPath,
      method: 'POST',
      headers,
      timeout: 60000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          console.error(`  Composer baseline fetch failed: HTTP ${res.statusCode}`);
          resolve(null);
          return;
        }
        try {
          const result = JSON.parse(data);
          const tdvmWeights = result.tdvm_weights;
          if (!tdvmWeights) {
            console.error('  Composer baseline: no tdvm_weights in response');
            resolve(null);
            return;
          }

          // Convert epoch days to YYYY-MM-DD dates and build holdingsByDate
          const epochToDate = (epochDay) => {
            const d = new Date((epochDay) * 86400000);
            return d.toISOString().split('T')[0];
          };

          // Collect all unique epoch days across all tickers
          const allEpochDays = new Set();
          for (const ticker in tdvmWeights) {
            if (ticker === '$USD') continue; // skip cash marker
            for (const epochDay in tdvmWeights[ticker]) {
              allEpochDays.add(parseInt(epochDay));
            }
          }

          // Build holdingsByDate: for each day, collect all tickers held with their weights
          const holdingsByDate = {};
          const sortedEpochDays = [...allEpochDays].sort((a, b) => a - b);

          for (const epochDay of sortedEpochDays) {
            const dateStr = epochToDate(epochDay);
            const dayHoldings = [];
            for (const ticker in tdvmWeights) {
              if (ticker === '$USD') continue;
              const w = tdvmWeights[ticker][String(epochDay)];
              if (w && w > 0.001) { // filter negligible weights
                // Normalize ticker: strip EQUITIES::TICKER//USD format
                const cleanTicker = ticker.includes('::') ? ticker.split('::')[1].split('//')[0] : ticker;
                dayHoldings.push({ ticker: cleanTicker, weight: w });
              }
            }
            if (dayHoldings.length > 0) {
              holdingsByDate[dateStr] = dayHoldings;
            }
          }

          // Also extract rebalance_days for carry-forward logic
          const rebalanceDays = (result.rebalance_days || []).map(d => epochToDate(d)).sort();

          // Extract dvm_capital: Composer's own equity curve (Xignite prices, exact)
          let dvmCapital = null;
          const dvmRaw = result.dvm_capital;
          if (dvmRaw) {
            // dvm_capital is { symphonyId: { epochDay: dollarValue } } — find the first key
            const dvmKey = Object.keys(dvmRaw)[0];
            if (dvmKey && dvmRaw[dvmKey]) {
              dvmCapital = {};
              for (const epochDay in dvmRaw[dvmKey]) {
                dvmCapital[epochToDate(parseInt(epochDay))] = dvmRaw[dvmKey][epochDay];
              }
            }
          }

          resolve({ holdingsByDate, rebalanceDays, dvmCapital, stats: result.stats || null });
        } catch (e) {
          console.error(`  Composer baseline parse error: ${e.message}`);
          resolve(null);
        }
      });
    });
    req.on('error', (e) => { console.error(`  Composer baseline error: ${e.message}`); resolve(null); });
    req.on('timeout', () => { req.destroy(); console.error('  Composer baseline timeout'); resolve(null); });
    req.write(postData);
    req.end();
  });
}

/**
 * Run EOD baseline using Composer's actual backtest data.
 * If dvmCapital is available, uses Composer's exact equity curve (Xignite prices).
 * Otherwise falls back to re-pricing Composer's holdings with Yahoo/Alpaca data.
 */
function runComposerBaselineBacktest(composerHoldings, dailyData, intradayData, tradingDays) {
  const { holdingsByDate, dvmCapital } = composerHoldings;

  // PREFERRED: Use dvm_capital directly (Composer's exact equity curve, Xignite prices)
  if (dvmCapital) {
    // Find the starting value: use the value on the first trading day
    const firstVal = dvmCapital[tradingDays[0]];
    if (firstVal && firstVal > 0) {
      let peak = 100;
      let maxDD = 0;
      const equityCurve = [100]; // normalized to start at 100

      for (let i = 0; i < tradingDays.length; i++) {
        const date = tradingDays[i];
        const val = dvmCapital[date];
        let equity;
        if (val != null) {
          equity = (val / firstVal) * 100;
        } else {
          // If this date is missing from dvm_capital, use previous value
          equity = equityCurve[equityCurve.length - 1];
        }
        equityCurve.push(equity);
        if (equity > peak) peak = equity;
        const dd = (peak - equity) / peak * 100;
        if (dd > maxDD) maxDD = dd;
      }

      return {
        cumReturn: equityCurve[equityCurve.length - 1] - 100,
        maxDD,
        tradingDays: tradingDays.length,
        equityCurve
      };
    }
  }

  // FALLBACK: Re-price Composer's holdings with Yahoo/Alpaca data
  let equity = 100;
  const equityCurve = [100];
  let peak = 100;
  let maxDD = 0;
  let currentHoldings = [];

  for (let i = 0; i < tradingDays.length; i++) {
    const date = tradingDays[i];
    const prevDate = i > 0 ? tradingDays[i - 1] : null;

    if (prevDate && currentHoldings.length > 0) {
      let dayReturn = 0;
      let totalWeight = 0;
      for (const h of currentHoldings) {
        const prevEOD = getIntradayPrice(h.ticker, intradayData, prevDate, CONFIG.EOD_TIME, dailyData);
        const currEOD = getIntradayPrice(h.ticker, intradayData, date, CONFIG.EOD_TIME, dailyData);
        if (prevEOD && currEOD) {
          dayReturn += h.weight * (currEOD - prevEOD) / prevEOD;
          totalWeight += h.weight;
        }
      }
      if (totalWeight > 0) {
        // Re-normalize for missing tickers: apply the partial-weight return as full exposure.
        // Without this, a day where one ticker has null data understates the day's return.
        equity *= (1 + dayReturn / totalWeight);
      }
    }

    equityCurve.push(equity);
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak * 100;
    if (dd > maxDD) maxDD = dd;

    if (holdingsByDate[date]) {
      currentHoldings = holdingsByDate[date];
    }
  }

  return {
    cumReturn: equity - 100,
    maxDD,
    tradingDays: tradingDays.length,
    equityCurve
  };
}

// ============================================================================
// BACKTESTS (V3 - using proper indicator calculation and weights)
// ============================================================================

function runDualTimeBacktest(score, dailyData, intradayData, tradingDays, morningTime, rebalanceThreshold = null) {
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
        equity *= (1 + overnightReturn / totalWeight);
      }
    }

    // Morning rebalance (threshold-aware + execution threshold + take-profit filter)
    // Execution threshold: skip if allocation change too small (n8n 5% rule)
    // Take-profit threshold: only execute on "green" days (portfolio up since prev EOD)
    const morningExecPass = passesExecutionThreshold(holdings, morningSelection, dailyData, intradayData, prevDate, date, CONFIG.EOD_TIME, morningTime);
    const morningTPPass = passesTakeProfitThreshold(holdings, dailyData, intradayData, prevDate, date, morningTime);

    if (morningExecPass && morningTPPass && morningSelection.length > 0) {
      if (shouldRebalance(holdings, morningSelection, rebalanceThreshold, dailyData, intradayData, prevDate, date, CONFIG.EOD_TIME, morningTime)) {
        holdings = morningSelection;
      } else if (prevDate && holdings.length > 0) {
        holdings = getDriftedWeights(holdings, dailyData, intradayData, prevDate, date, CONFIG.EOD_TIME, morningTime);
      }
    } else if ((!morningExecPass || !morningTPPass) && prevDate && holdings.length > 0) {
      // Below execution/take-profit threshold — skip Run Now, just drift to morning time
      holdings = getDriftedWeights(holdings, dailyData, intradayData, prevDate, date, CONFIG.EOD_TIME, morningTime);
    } else if (morningSelection.length === 0) {
      holdings = []; // Cash signal: liquidate
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
        equity *= (1 + intradayReturn / totalWeight);
      }
    }

    // EOD rebalance (threshold-aware)
    if (eodSelection.length > 0) {
      if (shouldRebalance(holdings, eodSelection, rebalanceThreshold, dailyData, intradayData, date, date, morningTime, CONFIG.EOD_TIME)) {
        holdings = eodSelection;
      } else {
        holdings = getDriftedWeights(holdings, dailyData, intradayData, date, date, morningTime, CONFIG.EOD_TIME);
      }
    } else {
      holdings = []; // Cash signal: liquidate
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

function runEODOnlyBacktest(score, dailyData, intradayData, tradingDays, rebalanceThreshold = null) {
  let equity = 100;
  const equityCurve = [100];
  let peak = 100;
  let maxDD = 0;
  let holdings = [];
  const _debugHoldings = process.env.DEBUG_HOLDINGS === '1';

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
        equity *= (1 + dayReturn / totalWeight);
      }
    }

    equityCurve.push(equity);
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak * 100;
    if (dd > maxDD) maxDD = dd;

    if (_debugHoldings) {
      const selStr = selection.map(h => `${h.ticker}:${(h.weight*100).toFixed(0)}%`).join(', ');
      const dayRet = prevDate && holdings.length > 0 ? ((equity / equityCurve[equityCurve.length - 2]) - 1) * 100 : 0;
      console.error(`DBG ${date} eq=${(equity-100).toFixed(1)}% day=${dayRet >= 0 ? '+' : ''}${dayRet.toFixed(2)}% sel=[${selStr}]`);
    }

    if (selection.length > 0) {
      if (shouldRebalance(holdings, selection, rebalanceThreshold, dailyData, intradayData, prevDate, date, CONFIG.EOD_TIME, CONFIG.EOD_TIME)) {
        holdings = selection;
      } else if (prevDate && holdings.length > 0) {
        holdings = getDriftedWeights(holdings, dailyData, intradayData, prevDate, date, CONFIG.EOD_TIME, CONFIG.EOD_TIME);
      }
    } else {
      holdings = []; // Cash signal: liquidate
    }
  }

  return {
    cumReturn: equity - 100,
    maxDD,
    tradingDays: tradingDays.length,
    equityCurve
  };
}

function runSingleTimeBacktest(score, dailyData, intradayData, tradingDays, tradeTime, rebalanceThreshold = null) {
  let equity = 100;
  const equityCurve = [100];
  let peak = 100;
  let maxDD = 0;
  let holdings = [];
  const _debugHoldings = process.env.DEBUG_HOLDINGS === '1' && tradeTime === CONFIG.EOD_TIME;

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
        equity *= (1 + dayReturn / totalWeight);
      }
    }

    if (_debugHoldings) {
      const selStr = selection.map(h => `${h.ticker}:${(h.weight*100).toFixed(0)}%`).join(', ');
      const dayRet = prevDate && holdings.length > 0 ? ((equity / equityCurve[equityCurve.length - 1]) - 1) * 100 : 0;
      console.error(`DBG ${date} eq=${(equity-100).toFixed(1)}% day=${dayRet >= 0 ? '+' : ''}${dayRet.toFixed(2)}% hold=[${holdings.map(h=>h.ticker).join(',')}] sel=[${selStr}]`);
    }

    equityCurve.push(equity);
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak * 100;
    if (dd > maxDD) maxDD = dd;

    if (selection.length > 0) {
      if (shouldRebalance(holdings, selection, rebalanceThreshold, dailyData, intradayData, prevDate, date, tradeTime, tradeTime)) {
        holdings = selection;
      } else if (prevDate && holdings.length > 0) {
        holdings = getDriftedWeights(holdings, dailyData, intradayData, prevDate, date, tradeTime, tradeTime);
      }
    } else {
      holdings = []; // Cash signal: liquidate
    }
  }

  return {
    cumReturn: equity - 100,
    maxDD,
    tradingDays: tradingDays.length,
    equityCurve
  };
}

/**
 * Cash-at-time backtest: At cashTime, go to cash (liquidate all holdings).
 * At EOD, strategy runs normally and positions are re-established for overnight.
 *
 * Three legs per day:
 *   LEG 1 (Overnight): Previous EOD holdings from prevDate@EOD to date@cashTime
 *   LEG 2 (Cash):      Cash from cashTime to EOD — 0% return
 *   LEG 3 (EOD rebal): Strategy evaluates at EOD, sets holdings for next overnight
 */
function runCashTimeBacktest(score, dailyData, intradayData, tradingDays, cashTime, rebalanceThreshold = null) {
  let equity = 100;
  const equityCurve = [100];
  let peak = 100;
  let maxDD = 0;
  let holdings = [];  // Array of {ticker, weight}

  for (let i = 0; i < tradingDays.length; i++) {
    const date = tradingDays[i];
    const prevDate = i > 0 ? tradingDays[i - 1] : null;

    // LEG 1: Overnight - prev EOD holdings held until cashTime
    if (prevDate && holdings.length > 0) {
      let overnightReturn = 0;
      let totalWeight = 0;
      for (const h of holdings) {
        const prevEOD = getIntradayPrice(h.ticker, intradayData, prevDate, CONFIG.EOD_TIME, dailyData);
        const morning = getIntradayPrice(h.ticker, intradayData, date, cashTime, dailyData);
        if (prevEOD && morning) {
          overnightReturn += h.weight * (morning - prevEOD) / prevEOD;
          totalWeight += h.weight;
        }
      }
      if (totalWeight > 0) {
        equity *= (1 + overnightReturn / totalWeight);
      }
    }

    // At cashTime: go to cash — no strategy evaluation, just liquidate
    // LEG 2: Cash from cashTime to EOD — 0% return (nothing to do)

    // EOD rebalance: evaluate strategy at EOD, establish holdings for overnight
    const eodSelection = getAssetsWithWeights(score, dailyData, intradayData, date, CONFIG.EOD_TIME);
    if (eodSelection.length > 0) {
      // For threshold check: we're coming from cash so always rebalance
      // (holdings are empty, so shouldRebalance would always trigger anyway)
      holdings = eodSelection;
    } else {
      holdings = []; // Cash signal: stay in cash
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

// ============================================================================
// WALK-FORWARD ANALYSIS
// ============================================================================

/**
 * Runs dual-time AND EOD-only backtests in parallel on the same trading days,
 * returning per-day returns for both modes. Ensures perfect day alignment.
 */
function runDualVsEodBacktestDaily(score, dailyData, intradayData, tradingDays, morningTime, rebalanceThreshold = null) {
  // Dual-time state
  let dualEquity = 100;
  let dualPeak = 100;
  let dualMaxDD = 0;
  let dualHoldings = [];

  // EOD-only state
  let eodEquity = 100;
  let eodPeak = 100;
  let eodMaxDD = 0;
  let eodHoldings = [];

  const dailyReturns = [];

  for (let i = 0; i < tradingDays.length; i++) {
    const date = tradingDays[i];
    const prevDate = i > 0 ? tradingDays[i - 1] : null;

    const prevDualEquity = dualEquity;
    const prevEodEquity = eodEquity;

    // Shared: EOD selection (used by both modes)
    const eodSelection = getAssetsWithWeights(score, dailyData, intradayData, date, CONFIG.EOD_TIME);

    // ---- DUAL-TIME MODE ----
    const morningSelection = getAssetsWithWeights(score, dailyData, intradayData, date, morningTime);

    // LEG 1: Overnight - prev EOD holdings held until morning
    if (prevDate && dualHoldings.length > 0) {
      let overnightReturn = 0;
      let totalWeight = 0;
      for (const h of dualHoldings) {
        const prevEOD = getIntradayPrice(h.ticker, intradayData, prevDate, CONFIG.EOD_TIME, dailyData);
        const morning = getIntradayPrice(h.ticker, intradayData, date, morningTime, dailyData);
        if (prevEOD && morning) {
          overnightReturn += h.weight * (morning - prevEOD) / prevEOD;
          totalWeight += h.weight;
        }
      }
      if (totalWeight > 0) dualEquity *= (1 + overnightReturn / totalWeight);
    }

    // Morning rebalance (threshold-aware + execution threshold + take-profit filter)
    const dualExecPass = passesExecutionThreshold(dualHoldings, morningSelection, dailyData, intradayData, prevDate, date, CONFIG.EOD_TIME, morningTime);
    const dualTPPass = passesTakeProfitThreshold(dualHoldings, dailyData, intradayData, prevDate, date, morningTime);

    if (dualExecPass && dualTPPass && morningSelection.length > 0) {
      if (shouldRebalance(dualHoldings, morningSelection, rebalanceThreshold, dailyData, intradayData, prevDate, date, CONFIG.EOD_TIME, morningTime)) {
        dualHoldings = morningSelection;
      } else if (prevDate && dualHoldings.length > 0) {
        dualHoldings = getDriftedWeights(dualHoldings, dailyData, intradayData, prevDate, date, CONFIG.EOD_TIME, morningTime);
      }
    } else if ((!dualExecPass || !dualTPPass) && prevDate && dualHoldings.length > 0) {
      dualHoldings = getDriftedWeights(dualHoldings, dailyData, intradayData, prevDate, date, CONFIG.EOD_TIME, morningTime);
    } else if (morningSelection.length === 0) {
      dualHoldings = [];
    }

    // LEG 2: Intraday - morning holdings held until EOD
    if (dualHoldings.length > 0) {
      let intradayReturn = 0;
      let totalWeight = 0;
      for (const h of dualHoldings) {
        const morning = getIntradayPrice(h.ticker, intradayData, date, morningTime, dailyData);
        const eod = getIntradayPrice(h.ticker, intradayData, date, CONFIG.EOD_TIME, dailyData);
        if (morning && eod) {
          intradayReturn += h.weight * (eod - morning) / morning;
          totalWeight += h.weight;
        }
      }
      if (totalWeight > 0) dualEquity *= (1 + intradayReturn / totalWeight);
    }

    // EOD rebalance (threshold-aware)
    if (eodSelection.length > 0) {
      if (shouldRebalance(dualHoldings, eodSelection, rebalanceThreshold, dailyData, intradayData, date, date, morningTime, CONFIG.EOD_TIME)) {
        dualHoldings = eodSelection;
      } else {
        dualHoldings = getDriftedWeights(dualHoldings, dailyData, intradayData, date, date, morningTime, CONFIG.EOD_TIME);
      }
    } else {
      dualHoldings = []; // Cash signal: liquidate
    }

    if (dualEquity > dualPeak) dualPeak = dualEquity;
    const dualDD = (dualPeak - dualEquity) / dualPeak * 100;
    if (dualDD > dualMaxDD) dualMaxDD = dualDD;

    // ---- EOD-ONLY MODE ----
    if (prevDate && eodHoldings.length > 0) {
      let dayReturn = 0;
      let totalWeight = 0;
      for (const h of eodHoldings) {
        const prevEODPrice = getIntradayPrice(h.ticker, intradayData, prevDate, CONFIG.EOD_TIME, dailyData);
        const currEODPrice = getIntradayPrice(h.ticker, intradayData, date, CONFIG.EOD_TIME, dailyData);
        if (prevEODPrice && currEODPrice) {
          dayReturn += h.weight * (currEODPrice - prevEODPrice) / prevEODPrice;
          totalWeight += h.weight;
        }
      }
      if (totalWeight > 0) eodEquity *= (1 + dayReturn / totalWeight);
    }

    if (eodSelection.length > 0) {
      if (shouldRebalance(eodHoldings, eodSelection, rebalanceThreshold, dailyData, intradayData, prevDate, date, CONFIG.EOD_TIME, CONFIG.EOD_TIME)) {
        eodHoldings = eodSelection;
      } else if (prevDate && eodHoldings.length > 0) {
        eodHoldings = getDriftedWeights(eodHoldings, dailyData, intradayData, prevDate, date, CONFIG.EOD_TIME, CONFIG.EOD_TIME);
      }
    } else {
      eodHoldings = []; // Cash signal: liquidate
    }

    if (eodEquity > eodPeak) eodPeak = eodEquity;
    const eodDD = (eodPeak - eodEquity) / eodPeak * 100;
    if (eodDD > eodMaxDD) eodMaxDD = eodDD;

    // Record daily returns (skip day 0 - no previous day to compare)
    if (prevDate) {
      dailyReturns.push({
        date,
        eodReturn: (eodEquity - prevEodEquity) / prevEodEquity,
        altReturn: (dualEquity - prevDualEquity) / prevDualEquity
      });
    }
  }

  return {
    eod: { cumReturn: eodEquity - 100, maxDD: eodMaxDD },
    alt: { cumReturn: dualEquity - 100, maxDD: dualMaxDD },
    dailyReturns,
    tradingDays: tradingDays.length
  };
}

/**
 * Runs single-time AND EOD-only backtests in parallel on the same trading days,
 * returning per-day returns for both modes.
 */
function runSingleVsEodBacktestDaily(score, dailyData, intradayData, tradingDays, tradeTime, rebalanceThreshold = null) {
  // Single-time state (trade at tradeTime)
  let singleEquity = 100;
  let singlePeak = 100;
  let singleMaxDD = 0;
  let singleHoldings = [];

  // EOD-only state
  let eodEquity = 100;
  let eodPeak = 100;
  let eodMaxDD = 0;
  let eodHoldings = [];

  const dailyReturns = [];

  for (let i = 0; i < tradingDays.length; i++) {
    const date = tradingDays[i];
    const prevDate = i > 0 ? tradingDays[i - 1] : null;

    const prevSingleEquity = singleEquity;
    const prevEodEquity = eodEquity;

    // ---- SINGLE TIME MODE ----
    const singleSelection = getAssetsWithWeights(score, dailyData, intradayData, date, tradeTime);

    if (prevDate && singleHoldings.length > 0) {
      let dayReturn = 0;
      let totalWeight = 0;
      for (const h of singleHoldings) {
        const prevPrice = getIntradayPrice(h.ticker, intradayData, prevDate, tradeTime, dailyData);
        const currPrice = getIntradayPrice(h.ticker, intradayData, date, tradeTime, dailyData);
        if (prevPrice && currPrice) {
          dayReturn += h.weight * (currPrice - prevPrice) / prevPrice;
          totalWeight += h.weight;
        }
      }
      if (totalWeight > 0) singleEquity *= (1 + dayReturn / totalWeight);
    }

    if (singleSelection.length > 0) {
      if (shouldRebalance(singleHoldings, singleSelection, rebalanceThreshold, dailyData, intradayData, prevDate, date, tradeTime, tradeTime)) {
        singleHoldings = singleSelection;
      } else if (prevDate && singleHoldings.length > 0) {
        singleHoldings = getDriftedWeights(singleHoldings, dailyData, intradayData, prevDate, date, tradeTime, tradeTime);
      }
    } else {
      singleHoldings = []; // Cash signal: liquidate
    }

    if (singleEquity > singlePeak) singlePeak = singleEquity;
    const singleDD = (singlePeak - singleEquity) / singlePeak * 100;
    if (singleDD > singleMaxDD) singleMaxDD = singleDD;

    // ---- EOD-ONLY MODE ----
    const eodSelection = getAssetsWithWeights(score, dailyData, intradayData, date, CONFIG.EOD_TIME);

    if (prevDate && eodHoldings.length > 0) {
      let dayReturn = 0;
      let totalWeight = 0;
      for (const h of eodHoldings) {
        const prevPrice = getIntradayPrice(h.ticker, intradayData, prevDate, CONFIG.EOD_TIME, dailyData);
        const currPrice = getIntradayPrice(h.ticker, intradayData, date, CONFIG.EOD_TIME, dailyData);
        if (prevPrice && currPrice) {
          dayReturn += h.weight * (currPrice - prevPrice) / prevPrice;
          totalWeight += h.weight;
        }
      }
      if (totalWeight > 0) eodEquity *= (1 + dayReturn / totalWeight);
    }

    if (eodSelection.length > 0) {
      if (shouldRebalance(eodHoldings, eodSelection, rebalanceThreshold, dailyData, intradayData, prevDate, date, CONFIG.EOD_TIME, CONFIG.EOD_TIME)) {
        eodHoldings = eodSelection;
      } else if (prevDate && eodHoldings.length > 0) {
        eodHoldings = getDriftedWeights(eodHoldings, dailyData, intradayData, prevDate, date, CONFIG.EOD_TIME, CONFIG.EOD_TIME);
      }
    } else {
      eodHoldings = []; // Cash signal: liquidate
    }

    if (eodEquity > eodPeak) eodPeak = eodEquity;
    const eodDD = (eodPeak - eodEquity) / eodPeak * 100;
    if (eodDD > eodMaxDD) eodMaxDD = eodDD;

    // Record daily returns
    if (prevDate) {
      dailyReturns.push({
        date,
        eodReturn: (eodEquity - prevEodEquity) / prevEodEquity,
        altReturn: (singleEquity - prevSingleEquity) / prevSingleEquity
      });
    }
  }

  return {
    eod: { cumReturn: eodEquity - 100, maxDD: eodMaxDD },
    alt: { cumReturn: singleEquity - 100, maxDD: singleMaxDD },
    dailyReturns,
    tradingDays: tradingDays.length
  };
}

/**
 * Slices per-day returns into rolling windows and computes walk-forward consistency.
 * @param {Array} dailyReturns - [{date, eodReturn, altReturn}, ...]
 * @param {number} windowSize - Trading days per window (default 21)
 * @param {number} stepSize - Step between windows (default 21, non-overlapping)
 * @returns {Object} { windows: [...], summary: { winRate, avgAlpha, verdict, ... } }
 */
function computeWalkforward(dailyReturns, windowSize = 21, stepSize = 21) {
  if (dailyReturns.length < windowSize) {
    return {
      windows: [],
      summary: { winRate: 0, avgAlpha: 0, verdict: 'INSUFFICIENT_DATA', wins: 0, total: 0, recentWins: 0, recentAlpha: 0 }
    };
  }

  const windows = [];

  for (let start = 0; start <= dailyReturns.length - windowSize; start += stepSize) {
    const window = dailyReturns.slice(start, start + windowSize);
    const startDate = window[0].date;
    const endDate = window[window.length - 1].date;

    // Compound returns for each mode
    let eodCum = 1;
    let altCum = 1;
    for (const day of window) {
      eodCum *= (1 + day.eodReturn);
      altCum *= (1 + day.altReturn);
    }
    eodCum = (eodCum - 1) * 100;  // Convert to percentage
    altCum = (altCum - 1) * 100;

    const alpha = altCum - eodCum;
    const win = altCum > eodCum;

    windows.push({ startDate, endDate, eodCum, altCum, alpha, win });
  }

  if (windows.length === 0) {
    return {
      windows: [],
      summary: { winRate: 0, avgAlpha: 0, verdict: 'INSUFFICIENT_DATA', wins: 0, total: 0, recentWins: 0, recentAlpha: 0 }
    };
  }

  const wins = windows.filter(w => w.win).length;
  const winRate = wins / windows.length;
  const avgAlpha = windows.reduce((sum, w) => sum + w.alpha, 0) / windows.length;

  // Best/worst windows
  const bestWindow = windows.reduce((best, w) => w.alpha > best.alpha ? w : best, windows[0]);
  const worstWindow = windows.reduce((worst, w) => w.alpha < worst.alpha ? w : worst, windows[0]);

  // Recent 3 windows
  const recentWindows = windows.slice(-3);
  const recentWins = recentWindows.filter(w => w.win).length;
  const recentAlpha = recentWindows.reduce((sum, w) => sum + w.alpha, 0) / recentWindows.length;

  // Verdict
  let verdict;
  if (winRate >= 0.70) {
    verdict = 'CONSISTENT';
  } else if (winRate >= 0.40) {
    verdict = 'EPISODIC';
  } else {
    verdict = 'OVERFITTED';
  }

  return {
    windows,
    summary: {
      winRate,
      avgAlpha,
      verdict,
      wins,
      total: windows.length,
      bestWindow,
      worstWindow,
      recentWins,
      recentAlpha
    }
  };
}

/**
 * Holdings Reliability Check — compares our simulated holdings against Composer's
 * actual backtest holdings across multiple days. Produces an overlap score (0-100)
 * indicating how well our Yahoo/Alpaca-based strategy evaluation matches Composer's
 * Xignite-based evaluation. Low scores mean the intraday analysis is unreliable
 * because the baseline holdings are already wrong.
 */
function computeHoldingsReliability(score, dailyData, intradayData, composerHoldings, tradingDays) {
  if (!composerHoldings || !composerHoldings.holdingsByDate) return null;

  const composerDates = Object.keys(composerHoldings.holdingsByDate).sort();
  if (composerDates.length === 0) return null;

  // Check every day across the full backtest period
  // The cost is minimal (~1ms per day for getAssetsWithWeights tree walk)
  // and checking every day gives the most accurate reliability picture
  const ourDatesSet = new Set(tradingDays);
  const commonDates = composerDates.filter(d => ourDatesSet.has(d));
  const sampleDates = commonDates;

  if (sampleDates.length < 3) return null;

  // Compare both Yahoo (16:00) and Alpaca (16:00a) against Composer
  function computeOverlapStats(evalTime) {
    let totalOverlap = 0, totalExactMatch = 0, totalWeightedOverlap = 0;
    const perDay = [];

    for (const date of sampleDates) {
      const composerH = composerHoldings.holdingsByDate[date];
      if (!composerH || composerH.length === 0) continue;

      const ourH = getAssetsWithWeights(score, dailyData, intradayData, date, evalTime);
      const ourFiltered = ourH.filter(h => h.weight > 0.001);

      const composerSet = new Set(composerH.map(h => h.ticker));
      const ourSet = new Set(ourFiltered.map(h => h.ticker));
      const intersection = [...composerSet].filter(t => ourSet.has(t)).length;
      const union = new Set([...composerSet, ...ourSet]).size;
      const jaccard = union > 0 ? intersection / union : 0;

      const composerWeights = {};
      const totalCW = composerH.reduce((s, h) => s + h.weight, 0);
      for (const h of composerH) composerWeights[h.ticker] = h.weight / (totalCW || 1);
      const ourWeights = {};
      for (const h of ourFiltered) ourWeights[h.ticker] = h.weight;

      let weightOverlap = 0;
      for (const t of [...composerSet]) {
        if (ourSet.has(t)) {
          weightOverlap += Math.min(composerWeights[t] || 0, ourWeights[t] || 0);
        }
      }

      const exactMatch = jaccard === 1.0 &&
        ourFiltered.map(h => h.ticker + ':' + (h.weight * 100).toFixed(0)).sort().join(',') ===
        composerH.map(h => h.ticker + ':' + ((h.weight / (totalCW || 1)) * 100).toFixed(0)).sort().join(',');

      totalOverlap += jaccard;
      totalWeightedOverlap += weightOverlap;
      if (exactMatch) totalExactMatch++;
      perDay.push({ date, jaccard, weightOverlap, exactMatch, composerTickers: composerSet.size, ourTickers: ourSet.size });
    }

    const n = perDay.length;
    if (n === 0) return null;

    const avgOverlap = totalOverlap / n;
    const avgWeightedOverlap = totalWeightedOverlap / n;
    const exactMatchRate = totalExactMatch / n;
    const reliabilityScore = Math.round(avgOverlap * 50 + avgWeightedOverlap * 30 + exactMatchRate * 20);

    let verdict;
    // Bands match the documented thresholds in README.md:
    // HIGH 90+, MODERATE 70-89, LOW 50-69, UNRELIABLE <50.
    if (reliabilityScore >= 90) verdict = 'HIGH';
    else if (reliabilityScore >= 70) verdict = 'MODERATE';
    else if (reliabilityScore >= 50) verdict = 'LOW';
    else verdict = 'UNRELIABLE';

    return { score: reliabilityScore, verdict, avgTickerOverlap: avgOverlap, avgWeightOverlap: avgWeightedOverlap, exactMatchRate, daysChecked: n, perDay: perDay.slice(-10) };
  }

  const yahoo = computeOverlapStats('16:00');    // Yahoo daily close
  const alpaca = computeOverlapStats('16:00a');  // Alpaca bar close

  // Use the better of the two as the primary score, but report both
  const primary = (alpaca && yahoo) ? (alpaca.score >= yahoo.score ? alpaca : yahoo) : (yahoo || alpaca);
  if (!primary) return null;

  return {
    ...primary,
    yahoo: yahoo ? { score: yahoo.score, verdict: yahoo.verdict, avgTickerOverlap: yahoo.avgTickerOverlap, exactMatchRate: yahoo.exactMatchRate } : null,
    alpaca: alpaca ? { score: alpaca.score, verdict: alpaca.verdict, avgTickerOverlap: alpaca.avgTickerOverlap, exactMatchRate: alpaca.exactMatchRate } : null,
    bestSource: (alpaca && yahoo) ? (alpaca.score >= yahoo.score ? 'alpaca' : 'yahoo') : (yahoo ? 'yahoo' : 'alpaca')
  };
}

/**
 * Tags WF/RC windows with SPY regime data for regime-dependent analysis.
 * Each window gets: spyReturn (%), regime ('bull'/'bear'/'sideways')
 * Thresholds: >3% = bull, <-3% = bear, else sideways (per ~21-day window)
 */
function tagRegimeData(wfResults, dailyData) {
  if (!wfResults || !dailyData) return;
  const spyData = dailyData['SPY']?.byDate;
  if (!spyData) return; // SPY not in dataset

  for (const time in wfResults) {
    const wf = wfResults[time];
    if (!wf || !wf.windows) continue;
    for (const win of wf.windows) {
      const startClose = spyData[win.startDate]?.close;
      // Find closest date <= endDate for SPY close
      let endClose = spyData[win.endDate]?.close;
      if (!endClose) {
        // Try a few days before endDate
        const dates = Object.keys(spyData).sort();
        for (let i = dates.length - 1; i >= 0; i--) {
          if (dates[i] <= win.endDate) { endClose = spyData[dates[i]]?.close; break; }
        }
      }
      if (startClose && endClose && startClose > 0) {
        const spyReturn = ((endClose - startClose) / startClose) * 100;
        win.spyReturn = spyReturn;
        win.regime = spyReturn > 3 ? 'bull' : spyReturn < -3 ? 'bear' : 'sideways';
      } else {
        win.spyReturn = null;
        win.regime = 'unknown';
      }
    }
  }
}

/**
 * Tags OOS walkforward windows with SPY regime data.
 */
function tagOOSRegimeData(oosWalkforward, dailyData) {
  if (!oosWalkforward || !dailyData) return;
  const spyData = dailyData['SPY']?.byDate;
  if (!spyData) return;

  // Tag the headline windows
  if (oosWalkforward.windows) {
    for (const win of oosWalkforward.windows) {
      const startClose = spyData[win.testStart]?.close;
      let endClose = spyData[win.testEnd]?.close;
      if (!endClose) {
        const dates = Object.keys(spyData).sort();
        for (let i = dates.length - 1; i >= 0; i--) {
          if (dates[i] <= win.testEnd) { endClose = spyData[dates[i]]?.close; break; }
        }
      }
      if (startClose && endClose && startClose > 0) {
        const spyReturn = ((endClose - startClose) / startClose) * 100;
        win.spyReturn = spyReturn;
        win.regime = spyReturn > 3 ? 'bull' : spyReturn < -3 ? 'bear' : 'sideways';
      }
    }
  }

  // Tag per-candidate OOS windows
  if (oosWalkforward.perCandidateOOS) {
    for (const time in oosWalkforward.perCandidateOOS) {
      const candidate = oosWalkforward.perCandidateOOS[time];
      if (!candidate || !candidate.windows) continue;
      for (const win of candidate.windows) {
        const startClose = spyData[win.testStart]?.close;
        let endClose = spyData[win.testEnd]?.close;
        if (!endClose) {
          const dates = Object.keys(spyData).sort();
          for (let i = dates.length - 1; i >= 0; i--) {
            if (dates[i] <= win.testEnd) { endClose = spyData[dates[i]]?.close; break; }
          }
        }
        if (startClose && endClose && startClose > 0) {
          const spyReturn = ((endClose - startClose) / startClose) * 100;
          win.spyReturn = spyReturn;
          win.regime = spyReturn > 3 ? 'bull' : spyReturn < -3 ? 'bear' : 'sideways';
        }
      }
    }
  }
}

/**
 * Derives paired daily returns from two equity curves (e.g. EOD vs alt-time).
 * Both curves use the same tradingDays array so indices align perfectly.
 * Equity curves start at index 0 = 100 (initial), index i+1 = after tradingDays[i].
 * @param {number[]} eodCurve - EOD equity curve
 * @param {number[]} altCurve - Alternative time equity curve
 * @param {string[]} tradingDays - Array of date strings
 * @returns {Array<{date: string, eodReturn: number, altReturn: number}>}
 */
function deriveDailyReturns(eodCurve, altCurve, tradingDays) {
  const dailyReturns = [];
  // Equity curves are length tradingDays.length + 1 (start at 100, one value per day end)
  const len = Math.min(tradingDays.length, eodCurve.length - 1, altCurve.length - 1);
  for (let i = 0; i < len; i++) {
    dailyReturns.push({
      date: tradingDays[i],
      eodReturn: eodCurve[i] !== 0 ? (eodCurve[i + 1] - eodCurve[i]) / eodCurve[i] : 0,
      altReturn: altCurve[i] !== 0 ? (altCurve[i + 1] - altCurve[i]) / altCurve[i] : 0
    });
  }
  return dailyReturns;
}

/**
 * Composite scoring to select the best execution time.
 * Scores each tested time on 4 axes (0-1), weighted sum picks highest.
 *
 * Axes (WF enabled / disabled weights):
 *   Return improvement: 30% / 40% — How much better than EOD
 *   DD quality:         20% / 25% — Drawdown in ballpark of EOD
 *   Neighbor robustness: 25% / 35% — ±1/±2 neighbors also positive
 *   Walk-forward:       25% / 0%  — Win rate + avg alpha + recent perf
 *
 * @param {Object} timeResults - Keyed by time: {cumReturn, maxDD, improvement, equityCurve}
 * @param {Object} eodResult - EOD baseline: {cumReturn, maxDD, equityCurve}
 * @param {string[]} tradingDays - Array of date strings
 * @param {string[]} testTimes - Sorted test times
 * @param {boolean} wfEnabled - Whether walk-forward is enabled
 * @param {number} wfWindowSize - Walk-forward window size
 * @param {number} wfStepSize - Walk-forward step size
 * @returns {{bestTime: string, bestImprovement: number, compositeScores: Object, walkforwardResults: Object, selectionMethod: string}}
 */
function selectBestTime(timeResults, eodResult, tradingDays, testTimes, wfEnabled, wfWindowSize, wfStepSize) {
  const times = testTimes.filter(t => timeResults[t]);
  if (times.length === 0) {
    return { bestTime: null, bestImprovement: -Infinity, compositeScores: {}, walkforwardResults: {}, selectionMethod: 'none' };
  }
  if (times.length === 1) {
    const t = times[0];
    return {
      bestTime: t,
      bestImprovement: timeResults[t].improvement,
      compositeScores: { [t]: { total: 100, returnScore: 1, ddScore: 1, neighborScore: 1, wfScore: 1 } },
      walkforwardResults: {},
      selectionMethod: 'single_time'
    };
  }

  // --- Axis 1: Return improvement (rank-based, outlier-resistant) ---
  const improvements = times.map(t => timeResults[t].improvement);
  const sorted = [...improvements].sort((a, b) => a - b);

  const returnScores = {};
  for (const t of times) {
    const imp = timeResults[t].improvement;
    // Average rank for ties: (firstIndex + lastIndex) / 2, normalized to 0-1
    const firstRank = sorted.indexOf(imp);
    const lastRank = sorted.lastIndexOf(imp);
    const avgRank = (firstRank + lastRank) / 2;
    returnScores[t] = times.length > 1 ? avgRank / (times.length - 1) : 1;
  }

  // --- Axis 2: DD quality (absolute comparison vs EOD baseline) ---
  // Better than EOD or within 2% = full score (1.0)
  // Linear decay from 2% to 15% worse than EOD
  // 15%+ worse than EOD = 0
  const eodDD = eodResult.maxDD;
  const ddScores = {};
  for (const t of times) {
    const ddDelta = timeResults[t].maxDD - eodDD; // positive = worse than EOD
    if (ddDelta <= 2) {
      ddScores[t] = 1.0; // Better than EOD or within 2% tolerance
    } else {
      ddScores[t] = Math.max(0, 1.0 - (ddDelta - 2) / 13); // Linear decay 2-15%
    }
  }

  // --- Axis 3: Neighbor robustness ---
  const neighborScores = {};
  for (const t of times) {
    const idx = times.indexOf(t);
    let score = 0;
    let checks = 0;

    // Check ±1 and ±2 neighbors
    for (const offset of [-2, -1, 1, 2]) {
      const ni = idx + offset;
      if (ni < 0 || ni >= times.length) continue;
      checks++;
      const neighbor = times[ni];
      const nImp = timeResults[neighbor].improvement;
      const nDDDelta = timeResults[neighbor].maxDD - eodDD;

      // Neighbor has positive improvement
      if (nImp > 0) score += 0.6;
      // Neighbor DD is reasonable (within 10% of EOD)
      if (nDDDelta <= 10) score += 0.2;
      // Gradient: closer neighbors should be closer in return (smooth peak, fixed cap)
      const absOffset = Math.abs(offset);
      const returnDiff = Math.abs(timeResults[t].improvement - nImp);
      const maxExpectedDiff = Math.max(5, Math.abs(timeResults[t].improvement) * 0.3) * absOffset;
      if (maxExpectedDiff > 0.01 && returnDiff <= maxExpectedDiff) score += 0.2;
      else if (maxExpectedDiff <= 0.01) score += 0.2; // Both near zero, that's fine
    }

    // Use the neighbor average directly; no edge multiplier. Boundary times (checks=1)
    // get a neutral 0.5 instead of being unfairly halved by both averaging and a penalty.
    if (checks >= 2) {
      neighborScores[t] = Math.min(1, score / checks);
    } else if (checks === 1) {
      neighborScores[t] = 0.5;
    } else {
      neighborScores[t] = 0;
    }
  }

  // --- Axis 4: Walk-forward (derive from equity curves) ---
  const wfScores = {};
  const walkforwardResults = {};

  if (wfEnabled) {
    const eodCurve = eodResult.equityCurve;
    for (const t of times) {
      const altCurve = timeResults[t].equityCurve;
      if (!eodCurve || !altCurve) {
        wfScores[t] = 0;
        continue;
      }
      const dailyReturns = deriveDailyReturns(eodCurve, altCurve, tradingDays);
      const wf = computeWalkforward(dailyReturns, wfWindowSize, wfStepSize);
      walkforwardResults[t] = wf;

      if (wf.summary.verdict === 'INSUFFICIENT_DATA') {
        wfScores[t] = 0;
        continue;
      }

      // Win rate component (0-0.5): 70%+ → 0.5, 40% → 0.2, below → 0
      let winRateScore = 0;
      if (wf.summary.winRate >= 0.70) winRateScore = 0.5;
      else if (wf.summary.winRate >= 0.40) winRateScore = 0.2 + 0.3 * ((wf.summary.winRate - 0.40) / 0.30);
      else winRateScore = 0;

      // Avg alpha component (0-0.3): positive alpha → proportional bonus
      let alphaScore = 0;
      if (wf.summary.avgAlpha > 0) {
        alphaScore = Math.min(0.3, wf.summary.avgAlpha / 5 * 0.3); // 5%+ avg alpha → full 0.3
      }

      // Recent performance component (0-0.2): recent 3 windows
      let recentScore = 0;
      if (wf.summary.total >= 3) {
        const recentWinRate = wf.summary.recentWins / Math.min(3, wf.summary.total);
        recentScore = recentWinRate * 0.2;
      } else {
        recentScore = wf.summary.winRate * 0.1; // Less data, less weight
      }

      wfScores[t] = Math.min(1, winRateScore + alphaScore + recentScore);
    }
  }

  // --- Composite weighted score ---
  const weights = wfEnabled
    ? { ret: 0.30, dd: 0.20, neighbor: 0.25, wf: 0.25 }
    : { ret: 0.40, dd: 0.25, neighbor: 0.35, wf: 0.00 };

  const compositeScores = {};
  let bestTime = null;
  let bestTotal = -Infinity;

  for (const t of times) {
    const rs = returnScores[t];
    const ds = ddScores[t];
    const ns = neighborScores[t];
    const ws = wfEnabled ? (wfScores[t] || 0) : 0;

    const total = Math.round((rs * weights.ret + ds * weights.dd + ns * weights.neighbor + ws * weights.wf) * 100);

    compositeScores[t] = {
      total,
      returnScore: Math.round(rs * 100),
      ddScore: Math.round(ds * 100),
      neighborScore: Math.round(ns * 100),
      wfScore: wfEnabled ? Math.round(ws * 100) : null
    };

    if (total > bestTotal) {
      bestTotal = total;
      bestTime = t;
    }
  }

  return {
    bestTime,
    bestImprovement: bestTime ? timeResults[bestTime].improvement : -Infinity,
    compositeScores,
    walkforwardResults,
    selectionMethod: wfEnabled ? 'composite_with_wf' : 'composite'
  };
}

// ============================================================================
// NEW SCORING PIPELINE (Base Scores → Candidates → WF → Final Scores)
// ============================================================================

/**
 * Compute base scores for all times on 3 axes (no WF).
 * Return score has absolute quality floor — negative improvements get near-zero scores.
 */
function computeBaseScores(timeResults, eodResult, testTimes) {
  const times = testTimes.filter(t => timeResults[t]);
  if (times.length === 0) return { returnScores: {}, ddScores: {}, neighborScores: {}, times: [] };

  // --- Axis 1: Return improvement (rank-based + absolute quality floor) ---
  const improvements = times.map(t => timeResults[t].improvement);
  const sorted = [...improvements].sort((a, b) => a - b);

  const returnScores = {};
  for (const t of times) {
    const imp = timeResults[t].improvement;
    const firstRank = sorted.indexOf(imp);
    const lastRank = sorted.lastIndexOf(imp);
    const avgRank = (firstRank + lastRank) / 2;
    returnScores[t] = times.length > 1 ? avgRank / (times.length - 1) : 1;
  }

  // Absolute quality floor: penalize negative improvements
  const bestImprovement = Math.max(...improvements);
  for (const t of times) {
    const imp = timeResults[t].improvement;
    if (bestImprovement <= 0) {
      // All negative — cap all return scores at 0.2 max
      returnScores[t] = returnScores[t] * 0.2;
    } else if (imp <= 0) {
      // This specific time is negative while others are positive
      returnScores[t] = returnScores[t] * 0.1;
    } else {
      // Positive — scale by how good relative to best
      const qualityFactor = imp / bestImprovement;
      returnScores[t] = returnScores[t] * Math.max(0.3, qualityFactor);
    }
  }

  // --- Axis 2: DD quality (absolute comparison vs EOD baseline) ---
  const eodDD = eodResult.maxDD;
  const ddScores = {};
  for (const t of times) {
    const ddDelta = timeResults[t].maxDD - eodDD;
    if (ddDelta <= 2) {
      ddScores[t] = 1.0;
    } else {
      ddScores[t] = Math.max(0, 1.0 - (ddDelta - 2) / 13);
    }
  }

  // --- Axis 3: Neighbor robustness ---
  const neighborScores = {};
  for (const t of times) {
    const idx = times.indexOf(t);
    let score = 0;
    let checks = 0;

    for (const offset of [-2, -1, 1, 2]) {
      const ni = idx + offset;
      if (ni < 0 || ni >= times.length) continue;
      checks++;
      const neighbor = times[ni];
      const nImp = timeResults[neighbor].improvement;
      const nDDDelta = timeResults[neighbor].maxDD - eodDD;

      if (nImp > 0) score += 0.6;
      if (nDDDelta <= 10) score += 0.2;
      const absOffset = Math.abs(offset);
      const returnDiff = Math.abs(timeResults[t].improvement - nImp);
      const maxExpectedDiff = Math.max(5, Math.abs(timeResults[t].improvement) * 0.3) * absOffset;
      if (maxExpectedDiff > 0.01 && returnDiff <= maxExpectedDiff) score += 0.2;
      else if (maxExpectedDiff <= 0.01) score += 0.2;
    }

    // Use neighbor average; require at least 2 checks for confidence (boundary times
    // with checks=1 get the neutral score 0.5 rather than being unfairly halved).
    if (checks >= 2) {
      neighborScores[t] = Math.min(1, score / checks);
    } else if (checks === 1) {
      neighborScores[t] = 0.5;
    } else {
      neighborScores[t] = 0;
    }
  }

  return { returnScores, ddScores, neighborScores, times };
}

/**
 * Select top N candidate times for WF testing.
 * Filters to positive improvement, scores on 3-axis base composite, takes top N.
 */
function selectWFCandidates(timeResults, baseScores, testTimes, maxCandidates = 10) {
  const { returnScores, ddScores, neighborScores, times } = baseScores;
  const weights = { ret: 0.40, dd: 0.25, neighbor: 0.35 };
  const eligible = times.filter(t => timeResults[t] && timeResults[t].improvement > 0);
  const scored = eligible.map(t => ({
    time: t,
    base: (returnScores[t] || 0) * weights.ret + (ddScores[t] || 0) * weights.dd + (neighborScores[t] || 0) * weights.neighbor
  }));
  scored.sort((a, b) => b.base - a.base);
  return scored.slice(0, maxCandidates).map(s => s.time);
}

/**
 * Tier 1: Robustness Check — runs computeWalkforward on candidates only.
 */
function computeRobustnessCheck(eodResult, timeResults, candidates, tradingDays, wfWindowSize, wfStepSize) {
  const allWalkforwardResults = {};
  const robustnessScores = {};
  const eodCurve = eodResult.equityCurve;

  for (const t of candidates) {
    const altCurve = timeResults[t].equityCurve;
    if (!eodCurve || !altCurve) { robustnessScores[t] = 0; continue; }
    const dailyReturns = deriveDailyReturns(eodCurve, altCurve, tradingDays);
    const wf = computeWalkforward(dailyReturns, wfWindowSize, wfStepSize);
    allWalkforwardResults[t] = wf;

    if (wf.summary.verdict === 'INSUFFICIENT_DATA') { robustnessScores[t] = 0; continue; }

    let winRateScore = 0;
    if (wf.summary.winRate >= 0.70) winRateScore = 0.5;
    else if (wf.summary.winRate >= 0.40) winRateScore = 0.2 + 0.3 * ((wf.summary.winRate - 0.40) / 0.30);

    let alphaScore = 0;
    if (wf.summary.avgAlpha > 0) {
      alphaScore = Math.min(0.3, wf.summary.avgAlpha / 5 * 0.3);
    }

    let recentScore = 0;
    if (wf.summary.total >= 3) {
      const recentWinRate = wf.summary.recentWins / Math.min(3, wf.summary.total);
      recentScore = recentWinRate * 0.2;
    } else {
      recentScore = wf.summary.winRate * 0.1;
    }

    robustnessScores[t] = Math.min(1, winRateScore + alphaScore + recentScore);
  }

  return { allWalkforwardResults, robustnessScores };
}

/**
 * Compute OOS scores (0-1) from per-candidate OOS data, using same formula as robustness.
 */
function computeOOSScores(perCandidateOOS, candidates) {
  const oosScores = {};
  for (const t of candidates) {
    const c = perCandidateOOS[t];
    if (!c || c.windows.length === 0) { oosScores[t] = 0; continue; }

    let winRateScore = 0;
    if (c.winRate >= 0.70) winRateScore = 0.5;
    else if (c.winRate >= 0.40) winRateScore = 0.2 + 0.3 * ((c.winRate - 0.40) / 0.30);

    let alphaScore = 0;
    if (c.avgAlpha > 0) {
      alphaScore = Math.min(0.3, c.avgAlpha / 5 * 0.3);
    }

    let recentScore = 0;
    const recentWindows = c.windows.slice(-3);
    const recentWins = recentWindows.filter(w => w.win).length;
    if (c.windows.length >= 3) {
      recentScore = (recentWins / 3) * 0.2;
    } else {
      recentScore = c.winRate * 0.1;
    }

    oosScores[t] = Math.min(1, winRateScore + alphaScore + recentScore);
  }
  return oosScores;
}

/**
 * Compute final composite scores with dynamic weights based on which tiers are enabled.
 */
function computeFinalScores(timeResults, baseScores, robustnessScores, oosScores, candidates, tier1Enabled, tier2Enabled) {
  const { returnScores, ddScores, neighborScores } = baseScores;

  let weights;
  if (tier1Enabled && tier2Enabled) {
    weights = { ret: 0.25, dd: 0.15, neighbor: 0.20, robustness: 0.20, walkforward: 0.20 };
  } else if (tier1Enabled) {
    weights = { ret: 0.30, dd: 0.20, neighbor: 0.25, robustness: 0.25, walkforward: 0.00 };
  } else if (tier2Enabled) {
    weights = { ret: 0.30, dd: 0.20, neighbor: 0.25, robustness: 0.00, walkforward: 0.25 };
  } else {
    weights = { ret: 0.40, dd: 0.25, neighbor: 0.35, robustness: 0.00, walkforward: 0.00 };
  }

  const compositeScores = {};
  let bestTime = null;
  let bestTotal = -Infinity;

  // Score only candidates (times with positive improvement that passed filtering)
  const scoreTimes = candidates.length > 0 ? candidates : baseScores.times;

  // No-viable-time penalty: if every candidate time underperforms EOD (improvement <= 0),
  // cap the composite so the DD and neighbor axes alone can't push the label to GOOD.
  // Without this, a strategy where every time loses can still show a 60+ "GOOD" composite
  // because DD-quality and neighbor-robustness can each independently hit 1.0.
  const allNegative = scoreTimes.every(t => timeResults[t] && timeResults[t].improvement <= 0);
  const losingPenalty = allNegative ? 0.4 : 1.0;

  for (const t of scoreTimes) {
    const rs = returnScores[t] || 0;
    const ds = ddScores[t] || 0;
    const ns = neighborScores[t] || 0;
    const rbS = tier1Enabled ? (robustnessScores[t] || 0) : 0;
    const wfS = tier2Enabled ? (oosScores[t] || 0) : 0;

    const raw = rs * weights.ret + ds * weights.dd + ns * weights.neighbor
              + rbS * weights.robustness + wfS * weights.walkforward;
    const total = Math.round(raw * losingPenalty * 100);

    compositeScores[t] = {
      total,
      returnScore: Math.round(rs * 100),
      ddScore: Math.round(ds * 100),
      neighborScore: Math.round(ns * 100),
      robustnessScore: tier1Enabled ? Math.round(rbS * 100) : null,
      wfScore: tier2Enabled ? Math.round(wfS * 100) : null,
      noViableTime: allNegative
    };

    if (total > bestTotal) {
      bestTotal = total;
      bestTime = t;
    }
  }

  return { compositeScores, bestTime, bestImprovement: bestTime && timeResults[bestTime] ? timeResults[bestTime].improvement : 0 };
}

// ============================================================================
// WALK-FORWARD TEST (Tier 2 — True Out-of-Sample)
// ============================================================================

/**
 * True out-of-sample walk-forward: train on past data to pick best time,
 * test on the next unseen window. Simulates real-time decision-making.
 *
 * @param {Object} score - Strategy tree from getSymphony
 * @param {Object} dailyData - Daily price data by ticker
 * @param {Object} intradayData - Intraday price data by ticker
 * @param {string[]} tradingDays - Full sorted array of trading days
 * @param {string[]} candidateTimes - Top candidate times from selectOOSCandidates
 * @param {Function} runBacktestFn - One of runDualTimeBacktest, runSingleTimeBacktest, runCashTimeBacktest
 * @param {number|null} rbThreshold - Rebalance threshold
 * @param {number} trainWindowSize - Training window in trading days (default 63)
 * @param {number} stepSize - Test window / step size (default 21)
 * @param {Object} fullTimeResults - Full-period timeResults for neighbor peak display
 * @param {string[]} allTestTimes - CONFIG.TEST_TIMES for neighbor lookup
 */
function runOOSWalkforward(score, dailyData, intradayData, tradingDays,
  candidateTimes, runBacktestFn, rbThreshold, trainWindowSize, stepSize, fullTimeResults, allTestTimes) {

  const minRequired = trainWindowSize + stepSize;
  if (tradingDays.length < minRequired || candidateTimes.length === 0) {
    return {
      windows: [],
      neighborPeak: {},
      summary: {
        oosWinRate: 0, oosAvgAlpha: 0, oosAnnAlpha: null,
        oosBestTime: null, fullBTBestTime: null,
        degradationRatio: null, wins: 0, total: 0,
        verdict: 'INSUFFICIENT_DATA'
      },
      candidateTimes
    };
  }

  const windows = [];

  for (let start = 0; start + trainWindowSize + stepSize <= tradingDays.length; start += stepSize) {
    const trainDays = tradingDays.slice(start, start + trainWindowSize);
    const testDays = tradingDays.slice(start + trainWindowSize, start + trainWindowSize + stepSize);

    if (testDays.length === 0) break;

    // TRAIN: run backtest for each candidate time on trainDays
    const trainEOD = runEODOnlyBacktest(score, dailyData, intradayData, trainDays, rbThreshold);
    const trainResults = {};

    for (const time of candidateTimes) {
      const r = runBacktestFn(score, dailyData, intradayData, trainDays, time, rbThreshold);
      trainResults[time] = {
        cumReturn: r.cumReturn,
        annReturn: annualizedReturn(r.cumReturn, r.tradingDays),
        maxDD: r.maxDD,
        improvement: r.cumReturn - trainEOD.cumReturn,
        equityCurve: r.equityCurve
      };
    }

    // SELECTION: pick best time from training data (no nested WF)
    const trainSelection = selectBestTime(trainResults, trainEOD, trainDays,
      candidateTimes, false, 21, 21);
    const chosenTime = trainSelection.bestTime;

    if (!chosenTime) continue;

    // TEST: run backtest for ONLY the chosen time on testDays
    const testEOD = runEODOnlyBacktest(score, dailyData, intradayData, testDays, rbThreshold);
    const testResult = runBacktestFn(score, dailyData, intradayData, testDays, chosenTime, rbThreshold);
    const testAlpha = testResult.cumReturn - testEOD.cumReturn;

    windows.push({
      trainStart: trainDays[0],
      trainEnd: trainDays[trainDays.length - 1],
      trainBestTime: chosenTime,
      testStart: testDays[0],
      testEnd: testDays[testDays.length - 1],
      testAlpha,
      win: testAlpha > 0
    });
  }

  if (windows.length === 0) {
    return {
      windows: [],
      neighborPeak: {},
      summary: {
        oosWinRate: 0, oosAvgAlpha: 0, oosAnnAlpha: null,
        oosBestTime: null, fullBTBestTime: null,
        degradationRatio: null, wins: 0, total: 0,
        verdict: 'INSUFFICIENT_DATA'
      },
      candidateTimes
    };
  }

  // Compute summary stats
  const wins = windows.filter(w => w.win).length;
  const oosWinRate = wins / windows.length;
  const oosAvgAlpha = windows.reduce((sum, w) => sum + w.testAlpha, 0) / windows.length;

  // Annualize: compound the per-window alphas
  let oosCompounded = 1;
  for (const w of windows) {
    oosCompounded *= (1 + w.testAlpha / 100);
  }
  const oosCumReturn = (oosCompounded - 1) * 100;
  const oosAnnAlpha = annualizedReturn(oosCumReturn, windows.length * stepSize);

  // Most frequently chosen time
  const timeCounts = {};
  for (const w of windows) {
    timeCounts[w.trainBestTime] = (timeCounts[w.trainBestTime] || 0) + 1;
  }
  const oosBestTime = Object.entries(timeCounts).sort((a, b) => b[1] - a[1])[0][0];
  const oosBestTimeCount = timeCounts[oosBestTime];

  // Full-BT best time (highest composite score among candidates)
  const fullBTBestTime = candidateTimes[0]; // already sorted by composite score
  const fullBTImprovement = fullTimeResults[fullBTBestTime] ? fullTimeResults[fullBTBestTime].improvement : 0;
  const fullBTAnnAlpha = annualizedReturn(fullBTImprovement, tradingDays.length);

  // Degradation ratio
  const degradationRatio = fullBTAnnAlpha && fullBTAnnAlpha > 0
    ? (oosAnnAlpha || 0) / fullBTAnnAlpha : null;

  // Verdict
  let verdict;
  if (oosWinRate >= 0.65 && oosAvgAlpha > 0) {
    verdict = 'OOS_CONFIRMED';
  } else if (oosWinRate >= 0.40 || oosAvgAlpha > 0) {
    verdict = 'OOS_DEGRADED';
  } else {
    verdict = 'OOS_FAILED';
  }

  // Neighbor peak: show oosBestTime ± 1-2 neighbors from allTestTimes
  const neighborPeak = {};
  const oosBestIdx = allTestTimes.indexOf(oosBestTime);
  const peakTimes = new Set();
  for (let offset = -2; offset <= 2; offset++) {
    const ni = oosBestIdx + offset;
    if (ni >= 0 && ni < allTestTimes.length) {
      peakTimes.add(allTestTimes[ni]);
    }
  }

  // Per-candidate OOS stats for neighbor peak
  const candidateOOSStats = {};
  for (const t of candidateTimes) {
    const tWindows = windows.filter(w => w.trainBestTime === t);
    // Also count total windows where this time was available (all of them, since it's a candidate)
    const tTestWindows = windows; // all windows tested against this candidate pool
    // For per-time OOS alpha: average test alpha across windows where this time was chosen
    if (tWindows.length > 0) {
      candidateOOSStats[t] = {
        oosWinRate: tWindows.filter(w => w.win).length / tWindows.length,
        oosAvgAlpha: tWindows.reduce((s, w) => s + w.testAlpha, 0) / tWindows.length,
        timesChosen: tWindows.length
      };
    }
  }

  for (const t of peakTimes) {
    neighborPeak[t] = {
      fullBTImprovement: fullTimeResults[t] ? fullTimeResults[t].improvement : null,
      isOOSBest: t === oosBestTime,
      isCandidate: candidateTimes.includes(t),
      ...(candidateOOSStats[t] || { oosWinRate: null, oosAvgAlpha: null, timesChosen: 0 })
    };
  }

  // Per-candidate independent OOS: test each candidate on each window independently
  const perCandidateOOS = {};
  for (const t of candidateTimes) {
    const cWindows = [];
    for (let start = 0; start + trainWindowSize + stepSize <= tradingDays.length; start += stepSize) {
      const testDays = tradingDays.slice(start + trainWindowSize, start + trainWindowSize + stepSize);
      if (testDays.length === 0) break;
      const testEOD = runEODOnlyBacktest(score, dailyData, intradayData, testDays, rbThreshold);
      const testResult = runBacktestFn(score, dailyData, intradayData, testDays, t, rbThreshold);
      const testAlpha = testResult.cumReturn - testEOD.cumReturn;
      const windowIdx = Math.floor(start / stepSize);
      const chosenInTraining = windows[windowIdx] ? windows[windowIdx].trainBestTime : null;
      cWindows.push({
        testStart: testDays[0],
        testEnd: testDays[testDays.length - 1],
        testAlpha,
        win: testAlpha > 0,
        chosenInTraining
      });
    }
    const cWins = cWindows.filter(w => w.win).length;
    perCandidateOOS[t] = {
      windows: cWindows,
      winRate: cWindows.length > 0 ? cWins / cWindows.length : 0,
      avgAlpha: cWindows.length > 0 ? cWindows.reduce((s, w) => s + w.testAlpha, 0) / cWindows.length : 0,
      timesChosenInTraining: cWindows.filter(w => w.chosenInTraining === t).length
    };
  }

  return {
    windows,
    neighborPeak,
    perCandidateOOS,
    summary: {
      oosWinRate,
      oosAvgAlpha,
      oosAnnAlpha,
      oosBestTime,
      oosBestTimeCount,
      fullBTBestTime,
      fullBTAnnAlpha,
      degradationRatio,
      wins,
      total: windows.length,
      verdict
    },
    candidateTimes
  };
}

/**
 * Prints walk-forward consistency results to console.
 * @param {Object} wfResult - Output from computeWalkforward()
 * @param {string} strategyName - Strategy name for display
 * @param {string} altLabel - Label for alternative mode ("Dual" or "Single @HH:MM")
 */
function printWalkforwardResults(wfResult, strategyName, altLabel) {
  const { windows, summary } = wfResult;

  if (summary.verdict === 'INSUFFICIENT_DATA') {
    console.log(`  WALK-FORWARD: Not enough data (need ${CONFIG.wfWindowSize}+ trading days)\n`);
    return;
  }

  console.log(`  ROBUSTNESS CHECK (post-hoc slicing, ${CONFIG.wfWindowSize}-day windows, step=${CONFIG.wfStepSize}d)`);
  console.log('  ┌──────────────────────────┬──────────┬──────────┬──────────┐');
  console.log(`  │  Period                  │  EOD     │  ${altLabel.padEnd(7).slice(0, 7)} │  Alpha   │`);
  console.log('  ├──────────────────────────┼──────────┼──────────┼──────────┤');

  for (const w of windows) {
    const period = `${w.startDate} -> ${w.endDate.slice(5)}`;
    const eod = `${w.eodCum >= 0 ? '+' : ''}${w.eodCum.toFixed(1)}%`;
    const alt = `${w.altCum >= 0 ? '+' : ''}${w.altCum.toFixed(1)}%`;
    const alpha = `${w.alpha >= 0 ? '+' : ''}${w.alpha.toFixed(1)}%`;
    const marker = w.win ? ' +' : ' -';
    console.log(`  │  ${period.padEnd(24)} │ ${eod.padStart(8)} │ ${alt.padStart(8)} │ ${alpha.padStart(7)}${marker} │`);
  }

  console.log('  └──────────────────────────┴──────────┴──────────┴──────────┘\n');

  // Verdict
  const verdictColors = { CONSISTENT: '(GOOD)', EPISODIC: '(MIXED)', OVERFITTED: '(BAD)' };
  console.log(`  VERDICT: ${summary.verdict} ${verdictColors[summary.verdict] || ''}`);
  console.log(`  Win rate: ${summary.wins}/${summary.total} = ${(summary.winRate * 100).toFixed(1)}% of windows`);
  // Annualize the avg alpha: compound per-window alphas
  let rcCompounded = 1;
  for (const w of windows) { rcCompounded *= (1 + w.alpha / 100); }
  const rcCumAlpha = (rcCompounded - 1) * 100;
  const rcAnnAlpha = annualizedReturn(rcCumAlpha, windows.length * CONFIG.wfStepSize);
  const rcAnnStr = rcAnnAlpha != null ? `  |  Annualized: ${rcAnnAlpha >= 0 ? '+' : ''}${rcAnnAlpha.toFixed(1)}%` : '';
  console.log(`  Avg alpha per window: ${summary.avgAlpha >= 0 ? '+' : ''}${summary.avgAlpha.toFixed(2)}%${rcAnnStr}`);
  console.log(`  Best window:  ${summary.bestWindow.startDate} -> ${summary.bestWindow.endDate.slice(5)} (${summary.bestWindow.alpha >= 0 ? '+' : ''}${summary.bestWindow.alpha.toFixed(1)}%)`);
  console.log(`  Worst window: ${summary.worstWindow.startDate} -> ${summary.worstWindow.endDate.slice(5)} (${summary.worstWindow.alpha >= 0 ? '+' : ''}${summary.worstWindow.alpha.toFixed(1)}%)`);

  if (windows.length >= 3) {
    console.log(`  Recent ${Math.min(3, windows.length)} windows: ${summary.recentWins}/${Math.min(3, windows.length)} wins, ${summary.recentAlpha >= 0 ? '+' : ''}${summary.recentAlpha.toFixed(2)}% avg alpha`);
  }

  // Recommendation
  if (summary.verdict === 'CONSISTENT') {
    console.log('  -> Alpha is persistent and reliable');
  } else if (summary.verdict === 'EPISODIC') {
    console.log('  -> Alpha is real but regime-dependent');
  } else {
    console.log('  -> Alpha concentrated in few windows - likely curve-fitted');
  }
  console.log('');
}

/**
 * Prints OOS walk-forward results (Tier 2) to console.
 */
function printOOSWalkforwardResults(oosResult, strategyName) {
  if (!oosResult) return;
  const { windows, neighborPeak, summary, candidateTimes } = oosResult;

  if (summary.verdict === 'INSUFFICIENT_DATA') {
    console.log(`  OOS WALK-FORWARD: Not enough data (need ${CONFIG.oosTrainWindowSize + CONFIG.oosStepSize}+ trading days)\n`);
    return;
  }

  console.log(`  WALK-FORWARD TEST (true OOS, ${CONFIG.oosTrainWindowSize}-day train / ${CONFIG.oosStepSize}-day test)`);
  console.log(`  Candidates tested: ${candidateTimes.join(', ')}`);
  console.log('  ┌──────────────────────────┬──────────┬──────────────────────────┬──────────┬───────┐');
  console.log('  │  Training Period          │  Chosen  │  Test Period              │  Alpha   │ Win?  │');
  console.log('  ├──────────────────────────┼──────────┼──────────────────────────┼──────────┼───────┤');

  for (const w of windows) {
    const trainP = `${w.trainStart} -> ${w.trainEnd.slice(5)}`;
    const testP = `${w.testStart} -> ${w.testEnd.slice(5)}`;
    const alpha = `${w.testAlpha >= 0 ? '+' : ''}${w.testAlpha.toFixed(1)}%`;
    const marker = w.win ? '  +  ' : '  -  ';
    console.log(`  │  ${trainP.padEnd(24)} │  ${w.trainBestTime.padEnd(7)} │  ${testP.padEnd(24)} │ ${alpha.padStart(8)} │${marker}│`);
  }

  console.log('  └──────────────────────────┴──────────┴──────────────────────────┴──────────┴───────┘\n');

  // Verdict
  const verdictLabels = { OOS_CONFIRMED: '(CONFIRMED)', OOS_DEGRADED: '(DEGRADED)', OOS_FAILED: '(FAILED)' };
  console.log(`  OOS VERDICT: ${summary.verdict} ${verdictLabels[summary.verdict] || ''}`);
  console.log(`  Win rate: ${summary.wins}/${summary.total} = ${(summary.oosWinRate * 100).toFixed(1)}% of out-of-sample windows`);
  console.log(`  Avg OOS alpha per window: ${summary.oosAvgAlpha >= 0 ? '+' : ''}${summary.oosAvgAlpha.toFixed(2)}%  |  Annualized: ${summary.oosAnnAlpha != null ? `${summary.oosAnnAlpha >= 0 ? '+' : ''}${summary.oosAnnAlpha.toFixed(1)}%` : 'n/a'}`);
  console.log(`  Most selected time in training: ${summary.oosBestTime} (${summary.oosBestTimeCount}/${summary.total} windows)`);

  // Comparison vs full backtest
  console.log('');
  console.log('  COMPARISON vs Full Backtest:');
  const fullBTStr = summary.fullBTAnnAlpha != null ? `${summary.fullBTAnnAlpha >= 0 ? '+' : ''}${summary.fullBTAnnAlpha.toFixed(1)}%` : 'n/a';
  const oosStr = summary.oosAnnAlpha != null ? `${summary.oosAnnAlpha >= 0 ? '+' : ''}${summary.oosAnnAlpha.toFixed(1)}%` : 'n/a';
  console.log(`  Full BT  @ ${summary.fullBTBestTime}: ${fullBTStr} ann. improvement`);
  console.log(`  OOS avg  @ ${summary.oosBestTime}: ${oosStr} ann. improvement`);
  if (summary.degradationRatio != null) {
    const ratio = summary.degradationRatio;
    const label = ratio >= 0.75 ? 'EXCELLENT' : ratio >= 0.50 ? 'ACCEPTABLE' : ratio >= 0.25 ? 'SIGNIFICANT' : 'SEVERE';
    console.log(`  Degradation ratio: ${ratio.toFixed(2)} -- ${label}`);
  }

  // Neighbor robustness peak
  if (Object.keys(neighborPeak).length > 0) {
    console.log('');
    console.log('  ROBUSTNESS PEAK (OOS best time +/- neighbors):');
    const peakTimes = Object.keys(neighborPeak).sort();
    for (const t of peakTimes) {
      const p = neighborPeak[t];
      const fullBT = p.fullBTImprovement != null ? `full BT ${p.fullBTImprovement >= 0 ? '+' : ''}${p.fullBTImprovement.toFixed(1)}%` : 'full BT n/a';
      let oosInfo = '';
      if (p.isCandidate && p.timesChosen > 0) {
        oosInfo = `  OOS ${p.oosAvgAlpha >= 0 ? '+' : ''}${p.oosAvgAlpha.toFixed(1)}% (${p.timesChosen}x chosen)`;
      } else if (p.isCandidate) {
        oosInfo = '  OOS: never chosen';
      } else {
        oosInfo = '  OOS: not tested';
      }
      const marker = p.isOOSBest ? ' <-- OOS BEST' : '';
      console.log(`    ${t}:  ${fullBT}${oosInfo}${marker}`);
    }
  }

  console.log('');
}

// ============================================================================
// ANALYSIS FUNCTIONS
// ============================================================================

async function dualTimeAnalysis(ids, intradayDays, quiet = false) {
  const results = [];
  const dailyDays = CONFIG.MAX_DAILY_DAYS;  // Full history for SMA(360), cumret(252), etc.

  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    DIAGNOSTICS.reset();  // Reset diagnostics for each strategy
    clearMemoCache(); clearSortedKeysCache();     // Clear memoization cache for each strategy
    if (!quiet) console.log(`\n[${i + 1}/${ids.length}] Analyzing ${id}...`);

    try {
      const { score, name, rebalanceConfig } = await getSymphony(id);
      if (!quiet) console.log(`  Name: ${name}`);
      const rbThreshold = rebalanceConfig?.threshold ?? null;
      if (!quiet && rbThreshold !== null) console.log(`  Rebalance: threshold ${(rbThreshold * 100).toFixed(1)}% (not daily)`);

      const tickers = Array.from(extractTickers(score));
      if (!quiet) console.log(`  Tickers: ${tickers.join(', ')}`);

      const { intradayData, dailyData } = await fetchAllData(tickers, intradayDays, dailyDays, quiet);

      if (Object.keys(intradayData).length === 0) {
        results.push({ id, name, error: 'No intraday data available' });
        printDiagnostics();
        continue;
      }

      const tradingDays = applyDateRange(getTradingDays(intradayData));
      if (tradingDays.length < 5) {
        results.push({ id, name, error: 'Not enough trading days' });
        continue;
      }

      if (!quiet) console.log(`  Trading days: ${tradingDays.length} (${tradingDays[0]} to ${tradingDays[tradingDays.length-1]})`);

      // Do a diagnostic run on the last day to capture null conditions
      const lastDay = tradingDays[tradingDays.length - 1];
      getAssetsWithWeights(score, dailyData, intradayData, lastDay, CONFIG.EOD_TIME, 1.0, true);

      const _tStart = Date.now();
      let eodResult;
      let baselineSource = 'simulated';
      let holdingsReliability = null;
      let composerHoldingsData = null;

      // Fetch Composer holdings for baseline and/or reliability check
      if (hasComposerKeys()) {
        if (!quiet) console.log('  Fetching Composer baseline holdings...');
        composerHoldingsData = await fetchComposerBaselineHoldings(id, tradingDays[0], tradingDays[tradingDays.length - 1]);
      }

      // Holdings reliability check — compare our simulated holdings vs Composer actual
      if (composerHoldingsData) {
        holdingsReliability = computeHoldingsReliability(score, dailyData, intradayData, composerHoldingsData, tradingDays);
        if (holdingsReliability && !quiet) {
          const hr = holdingsReliability;
          const color = hr.verdict === 'HIGH' ? '\x1b[32m' : hr.verdict === 'MODERATE' ? '\x1b[33m' : '\x1b[31m';
          console.log(`  Holdings reliability: ${color}${hr.score}/100 ${hr.verdict}\x1b[0m (${hr.daysChecked} days checked)`);
          if (hr.yahoo) console.log(`    Yahoo vs Composer:  ${hr.yahoo.score}/100 ${hr.yahoo.verdict} (${(hr.yahoo.avgTickerOverlap*100).toFixed(0)}% overlap, ${(hr.yahoo.exactMatchRate*100).toFixed(0)}% exact)`);
          if (hr.alpaca) console.log(`    Alpaca vs Composer: ${hr.alpaca.score}/100 ${hr.alpaca.verdict} (${(hr.alpaca.avgTickerOverlap*100).toFixed(0)}% overlap, ${(hr.alpaca.exactMatchRate*100).toFixed(0)}% exact)`);
          if (hr.bestSource) console.log(`    Best source: ${hr.bestSource}`);
        }
      }

      // Gate: skip backtests if holdings reliability is below minimum threshold
      if (holdingsReliability && CONFIG.minReliability > 0 && holdingsReliability.score < CONFIG.minReliability) {
        if (!quiet) console.log(`  \x1b[31mSKIPPED — Holdings reliability ${holdingsReliability.score}/100 is below minimum ${CONFIG.minReliability}. Intraday analysis would be unreliable.\x1b[0m`);
        results.push({
          id, name, tradingDays: tradingDays.length, dateRange: `${tradingDays[0]} to ${tradingDays[tradingDays.length-1]}`,
          holdingsReliability,
          error: `Holdings reliability too low (${holdingsReliability.score}/100 < ${CONFIG.minReliability} minimum). Strategy skipped.`,
          skippedReason: 'reliability'
        });
        continue;
      }

      if (CONFIG.composerBaseline && composerHoldingsData) {
        eodResult = runComposerBaselineBacktest(composerHoldingsData, dailyData, intradayData, tradingDays);
        baselineSource = 'composer';
        if (!quiet) console.log(`  Composer baseline: ${Object.keys(composerHoldingsData.holdingsByDate).length} days of holdings`);
      } else if (CONFIG.composerBaseline && !composerHoldingsData) {
        if (!quiet) console.log('  Composer baseline unavailable, falling back to simulated EOD');
        eodResult = runEODOnlyBacktest(score, dailyData, intradayData, tradingDays, rbThreshold);
      } else {
        eodResult = runEODOnlyBacktest(score, dailyData, intradayData, tradingDays, rbThreshold);
      }

      const timeResults = {};

      for (const time of CONFIG.TEST_TIMES) {
        const dualResult = runDualTimeBacktest(score, dailyData, intradayData, tradingDays, time, rbThreshold);
        const improvement = dualResult.cumReturn - eodResult.cumReturn;

        timeResults[time] = {
          cumReturn: dualResult.cumReturn,
          annReturn: annualizedReturn(dualResult.cumReturn, dualResult.tradingDays),
          maxDD: dualResult.maxDD,
          improvement,
          equityCurve: dualResult.equityCurve
        };
      }
      const _tBacktest = Date.now();

      // Check for no trades (0% return and 0% drawdown)
      const noTrades = Math.abs(eodResult.cumReturn) < 0.01 && Math.abs(eodResult.maxDD) < 0.01;
      if (noTrades && !quiet) {
        console.log(`  ⚠️  NO TRADES DETECTED - Strategy returned 0% with 0% drawdown`);
        printDiagnostics();
      }

      // Phase 1: Base scores for all times (3 axes, no WF)
      const baseScores = computeBaseScores(timeResults, eodResult, CONFIG.TEST_TIMES);

      // Phase 2: Select top candidates for WF testing
      const candidates = selectWFCandidates(timeResults, baseScores, CONFIG.TEST_TIMES, CONFIG.wfMaxCandidates);

      // Phase 3a: Robustness Check (Tier 1) — candidates only
      let allWalkforwardResults = {};
      let robustnessScores = {};
      if (CONFIG.walkforward && candidates.length > 0) {
        if (!quiet) console.log(`  Computing Robustness Check on ${candidates.length} candidates...`);
        const rcResult = computeRobustnessCheck(eodResult, timeResults, candidates, tradingDays,
          CONFIG.wfWindowSize, CONFIG.wfStepSize);
        allWalkforwardResults = rcResult.allWalkforwardResults;
        robustnessScores = rcResult.robustnessScores;
      }

      // Phase 3b: Walk-Forward Test (Tier 2) — candidates only
      let oosWalkforward = null;
      let oosScores = {};
      if (CONFIG.oosWalkforward && candidates.length > 0) {
        if (!quiet) console.log(`  Computing Walk-Forward Test on ${candidates.length} candidates...`);
        oosWalkforward = runOOSWalkforward(score, dailyData, intradayData, tradingDays,
          candidates, runDualTimeBacktest, rbThreshold,
          CONFIG.oosTrainWindowSize, CONFIG.oosStepSize, timeResults, CONFIG.TEST_TIMES);
        if (oosWalkforward && oosWalkforward.perCandidateOOS) {
          oosScores = computeOOSScores(oosWalkforward.perCandidateOOS, candidates);
        }
      }

      // Tag regime data (SPY performance per window)
      if (allWalkforwardResults) tagRegimeData(allWalkforwardResults, dailyData);
      if (oosWalkforward) tagOOSRegimeData(oosWalkforward, dailyData);

      // Phase 4: Final composite scoring
      const { compositeScores, bestTime, bestImprovement } = computeFinalScores(
        timeResults, baseScores, robustnessScores, oosScores, candidates,
        CONFIG.walkforward, CONFIG.oosWalkforward);
      const _tWF = Date.now();
      const _shortName = name.length > 30 ? name.slice(0, 27) + '...' : name;
      const _tierLabel = CONFIG.walkforward && CONFIG.oosWalkforward ? 'RC+OOS' : CONFIG.walkforward ? 'RC' : CONFIG.oosWalkforward ? 'OOS' : '';
      console.log(`  [DUAL] ${_shortName} — ${CONFIG.TEST_TIMES.length} backtests ${((_tBacktest - _tStart)/1000).toFixed(1)}s, scoring${_tierLabel ? '+' + _tierLabel : ''} ${((_tWF - _tBacktest)/1000).toFixed(1)}s, total ${((_tWF - _tStart)/1000).toFixed(1)}s`);
      let walkforward = bestTime && allWalkforwardResults[bestTime] ? allWalkforwardResults[bestTime] : null;

      // Strip equityCurves before storing in results
      for (const t of CONFIG.TEST_TIMES) if (timeResults[t]) delete timeResults[t].equityCurve;

      results.push({
        id,
        name,
        tradingDays: eodResult.tradingDays,
        dateRange: `${tradingDays[0]} to ${tradingDays[tradingDays.length-1]}`,
        holdingsReliability: holdingsReliability || null,
        eod: {
          cumReturn: eodResult.cumReturn,
          annReturn: annualizedReturn(eodResult.cumReturn, eodResult.tradingDays),
          maxDD: eodResult.maxDD
        },
        times: timeResults,
        bestTime,
        bestImprovement,
        recommendation: (() => {
          const cs = compositeScores && compositeScores[bestTime];
          const csScore = cs ? cs.total : 0;
          const eodAbs = Math.abs(eodResult.cumReturn);
          const relPct = eodAbs > 1 ? (bestImprovement / eodAbs) * 100 : bestImprovement * 10;
          if (bestImprovement <= 0 || relPct < 10) return 'STICK_EOD';
          if (csScore >= 60) return 'ADD_MORNING';
          if (csScore < 40) return 'STICK_EOD';
          return 'MARGINAL';
        })(),
        walkforward,
        allWalkforwardResults,
        oosWalkforward,
        compositeScores,
        selectionMethod: CONFIG.walkforward && CONFIG.oosWalkforward ? 'composite_with_both'
          : CONFIG.walkforward ? 'composite_with_robustness'
          : CONFIG.oosWalkforward ? 'composite_with_walkforward' : 'composite',
        baselineSource,
        candidates
      });

    } catch (e) {
      results.push({ id, name: 'Error', error: e.message });
    }
  }

  return results;
}

async function singleTimeAnalysis(ids, intradayDays, quiet = false) {
  const results = [];
  const dailyDays = CONFIG.MAX_DAILY_DAYS;
  const holdingsReliability = null; // Only computed in dual analysis; single/cash inherit via combined results

  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    DIAGNOSTICS.reset();  // Reset diagnostics for each strategy
    clearMemoCache(); clearSortedKeysCache();     // Clear memoization cache for each strategy
    if (!quiet) console.log(`\n[${i + 1}/${ids.length}] Analyzing ${id}...`);

    try {
      const { score, name, rebalanceConfig } = await getSymphony(id);
      if (!quiet) console.log(`  Name: ${name}`);
      const rbThreshold = rebalanceConfig?.threshold ?? null;
      if (!quiet && rbThreshold !== null) console.log(`  Rebalance: threshold ${(rbThreshold * 100).toFixed(1)}% (not daily)`);

      const tickers = Array.from(extractTickers(score));
      if (!quiet) console.log(`  Tickers: ${tickers.join(', ')}`);

      const { intradayData, dailyData } = await fetchAllData(tickers, intradayDays, dailyDays, quiet);

      if (Object.keys(intradayData).length === 0) {
        results.push({ id, name, error: 'No intraday data available' });
        printDiagnostics();
        continue;
      }

      const tradingDays = applyDateRange(getTradingDays(intradayData));
      if (tradingDays.length < 5) {
        results.push({ id, name, error: 'Not enough trading days' });
        continue;
      }

      if (!quiet) console.log(`  Trading days: ${tradingDays.length} (${tradingDays[0]} to ${tradingDays[tradingDays.length-1]})`);

      // Do a diagnostic run on the last day to capture null conditions
      const lastDay = tradingDays[tradingDays.length - 1];
      getAssetsWithWeights(score, dailyData, intradayData, lastDay, CONFIG.EOD_TIME, 1.0, true);

      const _tStart = Date.now();
      let eodResult;
      let baselineSource = 'simulated';
      if (CONFIG.composerBaseline && hasComposerKeys()) {
        if (!quiet) console.log('  Fetching Composer baseline holdings...');
        const composerHoldings = await fetchComposerBaselineHoldings(id, tradingDays[0], tradingDays[tradingDays.length - 1]);
        if (composerHoldings) {
          eodResult = runComposerBaselineBacktest(composerHoldings, dailyData, intradayData, tradingDays);
          baselineSource = 'composer';
          if (!quiet) console.log(`  Composer baseline: ${Object.keys(composerHoldings.holdingsByDate).length} days of holdings`);
        } else {
          if (!quiet) console.log('  Composer baseline unavailable, falling back to simulated EOD');
          eodResult = runSingleTimeBacktest(score, dailyData, intradayData, tradingDays, CONFIG.EOD_TIME, rbThreshold);
        }
      } else {
        eodResult = runSingleTimeBacktest(score, dailyData, intradayData, tradingDays, CONFIG.EOD_TIME, rbThreshold);
      }

      const timeResults = {};

      for (const time of CONFIG.TEST_TIMES) {
        const result = runSingleTimeBacktest(score, dailyData, intradayData, tradingDays, time, rbThreshold);
        const improvement = result.cumReturn - eodResult.cumReturn;

        timeResults[time] = {
          cumReturn: result.cumReturn,
          annReturn: annualizedReturn(result.cumReturn, result.tradingDays),
          maxDD: result.maxDD,
          improvement,
          equityCurve: result.equityCurve
        };
      }
      const _tBacktest = Date.now();

      // Check for no trades (0% return and 0% drawdown)
      const noTrades = Math.abs(eodResult.cumReturn) < 0.01 && Math.abs(eodResult.maxDD) < 0.01;
      if (noTrades && !quiet) {
        console.log(`  ⚠️  NO TRADES DETECTED - Strategy returned 0% with 0% drawdown`);
        printDiagnostics();
      }

      // Phase 1-4: New scoring pipeline (same as dual)
      const baseScores = computeBaseScores(timeResults, eodResult, CONFIG.TEST_TIMES);
      const candidates = selectWFCandidates(timeResults, baseScores, CONFIG.TEST_TIMES, CONFIG.wfMaxCandidates);

      let allWalkforwardResults = {};
      let robustnessScores = {};
      if (CONFIG.walkforward && candidates.length > 0) {
        if (!quiet) console.log(`  Computing Robustness Check on ${candidates.length} candidates...`);
        const rcResult = computeRobustnessCheck(eodResult, timeResults, candidates, tradingDays,
          CONFIG.wfWindowSize, CONFIG.wfStepSize);
        allWalkforwardResults = rcResult.allWalkforwardResults;
        robustnessScores = rcResult.robustnessScores;
      }

      let oosWalkforward = null;
      let oosScores = {};
      if (CONFIG.oosWalkforward && candidates.length > 0) {
        if (!quiet) console.log(`  Computing Walk-Forward Test on ${candidates.length} candidates...`);
        oosWalkforward = runOOSWalkforward(score, dailyData, intradayData, tradingDays,
          candidates, runSingleTimeBacktest, rbThreshold,
          CONFIG.oosTrainWindowSize, CONFIG.oosStepSize, timeResults, CONFIG.TEST_TIMES);
        if (oosWalkforward && oosWalkforward.perCandidateOOS) {
          oosScores = computeOOSScores(oosWalkforward.perCandidateOOS, candidates);
        }
      }

      if (allWalkforwardResults) tagRegimeData(allWalkforwardResults, dailyData);
      if (oosWalkforward) tagOOSRegimeData(oosWalkforward, dailyData);

      const { compositeScores, bestTime, bestImprovement } = computeFinalScores(
        timeResults, baseScores, robustnessScores, oosScores, candidates,
        CONFIG.walkforward, CONFIG.oosWalkforward);
      const _tWF = Date.now();
      const _shortName = name.length > 30 ? name.slice(0, 27) + '...' : name;
      const _tierLabel = CONFIG.walkforward && CONFIG.oosWalkforward ? 'RC+OOS' : CONFIG.walkforward ? 'RC' : CONFIG.oosWalkforward ? 'OOS' : '';
      console.log(`  [SINGLE] ${_shortName} — ${CONFIG.TEST_TIMES.length} backtests ${((_tBacktest - _tStart)/1000).toFixed(1)}s, scoring${_tierLabel ? '+' + _tierLabel : ''} ${((_tWF - _tBacktest)/1000).toFixed(1)}s, total ${((_tWF - _tStart)/1000).toFixed(1)}s`);
      let walkforward = bestTime && allWalkforwardResults[bestTime] ? allWalkforwardResults[bestTime] : null;

      // Strip equityCurves before storing in results
      for (const t of CONFIG.TEST_TIMES) if (timeResults[t]) delete timeResults[t].equityCurve;

      results.push({
        id,
        name,
        tradingDays: eodResult.tradingDays,
        dateRange: `${tradingDays[0]} to ${tradingDays[tradingDays.length-1]}`,
        holdingsReliability: holdingsReliability || null,
        eod: {
          cumReturn: eodResult.cumReturn,
          annReturn: annualizedReturn(eodResult.cumReturn, eodResult.tradingDays),
          maxDD: eodResult.maxDD
        },
        times: timeResults,
        bestTime,
        bestImprovement,
        recommendation: (() => {
          const cs = compositeScores && compositeScores[bestTime];
          const csScore = cs ? cs.total : 0;
          const eodAbs = Math.abs(eodResult.cumReturn);
          const relPct = eodAbs > 1 ? (bestImprovement / eodAbs) * 100 : bestImprovement * 10;
          if (bestImprovement <= 0 || relPct < 10) return 'KEEP_EOD';
          if (bestTime !== CONFIG.EOD_TIME && csScore >= 50) return 'USE_MORNING';
          return 'KEEP_EOD';
        })(),
        walkforward,
        allWalkforwardResults,
        oosWalkforward,
        compositeScores,
        selectionMethod: CONFIG.walkforward && CONFIG.oosWalkforward ? 'composite_with_both'
          : CONFIG.walkforward ? 'composite_with_robustness'
          : CONFIG.oosWalkforward ? 'composite_with_walkforward' : 'composite',
        baselineSource,
        candidates
      });

    } catch (e) {
      results.push({ id, name: 'Error', error: e.message });
    }
  }

  return results;
}

async function cashTimeAnalysis(ids, intradayDays, quiet = false) {
  const results = [];
  const dailyDays = CONFIG.MAX_DAILY_DAYS;
  const holdingsReliability = null; // Only computed in dual analysis; single/cash inherit via combined results

  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    DIAGNOSTICS.reset();
    clearMemoCache(); clearSortedKeysCache();
    if (!quiet) console.log(`\n[${i + 1}/${ids.length}] Analyzing ${id}...`);

    try {
      const { score, name, rebalanceConfig } = await getSymphony(id);
      if (!quiet) console.log(`  Name: ${name}`);
      const rbThreshold = rebalanceConfig?.threshold ?? null;
      if (!quiet && rbThreshold !== null) console.log(`  Rebalance: threshold ${(rbThreshold * 100).toFixed(1)}% (not daily)`);

      const tickers = Array.from(extractTickers(score));
      if (!quiet) console.log(`  Tickers: ${tickers.join(', ')}`);

      const { intradayData, dailyData } = await fetchAllData(tickers, intradayDays, dailyDays, quiet);

      if (Object.keys(intradayData).length === 0) {
        results.push({ id, name, error: 'No intraday data available' });
        printDiagnostics();
        continue;
      }

      const tradingDays = applyDateRange(getTradingDays(intradayData));
      if (tradingDays.length < 5) {
        results.push({ id, name, error: 'Not enough trading days' });
        continue;
      }

      if (!quiet) console.log(`  Trading days: ${tradingDays.length} (${tradingDays[0]} to ${tradingDays[tradingDays.length-1]})`);

      // Diagnostic run on the last day
      const lastDay = tradingDays[tradingDays.length - 1];
      getAssetsWithWeights(score, dailyData, intradayData, lastDay, CONFIG.EOD_TIME, 1.0, true);

      const _tStart = Date.now();
      let eodResult;
      let baselineSource = 'simulated';
      if (CONFIG.composerBaseline && hasComposerKeys()) {
        if (!quiet) console.log('  Fetching Composer baseline holdings...');
        const composerHoldings = await fetchComposerBaselineHoldings(id, tradingDays[0], tradingDays[tradingDays.length - 1]);
        if (composerHoldings) {
          eodResult = runComposerBaselineBacktest(composerHoldings, dailyData, intradayData, tradingDays);
          baselineSource = 'composer';
          if (!quiet) console.log(`  Composer baseline: ${Object.keys(composerHoldings.holdingsByDate).length} days of holdings`);
        } else {
          if (!quiet) console.log('  Composer baseline unavailable, falling back to simulated EOD');
          eodResult = runEODOnlyBacktest(score, dailyData, intradayData, tradingDays, rbThreshold);
        }
      } else {
        eodResult = runEODOnlyBacktest(score, dailyData, intradayData, tradingDays, rbThreshold);
      }

      const timeResults = {};

      for (const time of CONFIG.TEST_TIMES) {
        const cashResult = runCashTimeBacktest(score, dailyData, intradayData, tradingDays, time, rbThreshold);
        const improvement = cashResult.cumReturn - eodResult.cumReturn;

        timeResults[time] = {
          cumReturn: cashResult.cumReturn,
          annReturn: annualizedReturn(cashResult.cumReturn, cashResult.tradingDays),
          maxDD: cashResult.maxDD,
          improvement,
          equityCurve: cashResult.equityCurve
        };
      }
      const _tBacktest = Date.now();

      // Check for no trades
      const noTrades = Math.abs(eodResult.cumReturn) < 0.01 && Math.abs(eodResult.maxDD) < 0.01;
      if (noTrades && !quiet) {
        console.log(`  ⚠️  NO TRADES DETECTED - Strategy returned 0% with 0% drawdown`);
        printDiagnostics();
      }

      // Phase 1-4: New scoring pipeline (same as dual/single)
      const baseScores = computeBaseScores(timeResults, eodResult, CONFIG.TEST_TIMES);
      const candidates = selectWFCandidates(timeResults, baseScores, CONFIG.TEST_TIMES, CONFIG.wfMaxCandidates);

      let allWalkforwardResults = {};
      let robustnessScores = {};
      if (CONFIG.walkforward && candidates.length > 0) {
        if (!quiet) console.log(`  Computing Robustness Check on ${candidates.length} candidates...`);
        const rcResult = computeRobustnessCheck(eodResult, timeResults, candidates, tradingDays,
          CONFIG.wfWindowSize, CONFIG.wfStepSize);
        allWalkforwardResults = rcResult.allWalkforwardResults;
        robustnessScores = rcResult.robustnessScores;
      }

      let oosWalkforward = null;
      let oosScores = {};
      if (CONFIG.oosWalkforward && candidates.length > 0) {
        if (!quiet) console.log(`  Computing Walk-Forward Test on ${candidates.length} candidates...`);
        oosWalkforward = runOOSWalkforward(score, dailyData, intradayData, tradingDays,
          candidates, runCashTimeBacktest, rbThreshold,
          CONFIG.oosTrainWindowSize, CONFIG.oosStepSize, timeResults, CONFIG.TEST_TIMES);
        if (oosWalkforward && oosWalkforward.perCandidateOOS) {
          oosScores = computeOOSScores(oosWalkforward.perCandidateOOS, candidates);
        }
      }

      if (allWalkforwardResults) tagRegimeData(allWalkforwardResults, dailyData);
      if (oosWalkforward) tagOOSRegimeData(oosWalkforward, dailyData);

      const { compositeScores, bestTime, bestImprovement } = computeFinalScores(
        timeResults, baseScores, robustnessScores, oosScores, candidates,
        CONFIG.walkforward, CONFIG.oosWalkforward);
      const _tWF = Date.now();
      const _shortName = name.length > 30 ? name.slice(0, 27) + '...' : name;
      const _tierLabel = CONFIG.walkforward && CONFIG.oosWalkforward ? 'RC+OOS' : CONFIG.walkforward ? 'RC' : CONFIG.oosWalkforward ? 'OOS' : '';
      console.log(`  [CASH] ${_shortName} — ${CONFIG.TEST_TIMES.length} backtests ${((_tBacktest - _tStart)/1000).toFixed(1)}s, scoring${_tierLabel ? '+' + _tierLabel : ''} ${((_tWF - _tBacktest)/1000).toFixed(1)}s, total ${((_tWF - _tStart)/1000).toFixed(1)}s`);
      let walkforward = bestTime && allWalkforwardResults[bestTime] ? allWalkforwardResults[bestTime] : null;

      // Strip equityCurves before storing in results
      for (const t of CONFIG.TEST_TIMES) if (timeResults[t]) delete timeResults[t].equityCurve;

      results.push({
        id,
        name,
        tradingDays: eodResult.tradingDays,
        dateRange: `${tradingDays[0]} to ${tradingDays[tradingDays.length-1]}`,
        holdingsReliability: holdingsReliability || null,
        eod: {
          cumReturn: eodResult.cumReturn,
          annReturn: annualizedReturn(eodResult.cumReturn, eodResult.tradingDays),
          maxDD: eodResult.maxDD
        },
        times: timeResults,
        bestTime,
        bestImprovement,
        recommendation: (() => {
          const cs = compositeScores && compositeScores[bestTime];
          const csScore = cs ? cs.total : 0;
          const eodAbs = Math.abs(eodResult.cumReturn);
          const relPct = eodAbs > 1 ? (bestImprovement / eodAbs) * 100 : bestImprovement * 10;
          if (bestImprovement <= 0 || relPct < 10) return 'STICK_EOD';
          if (csScore >= 60) return 'GO_CASH';
          if (csScore < 40) return 'STICK_EOD';
          return 'MARGINAL';
        })(),
        walkforward,
        allWalkforwardResults,
        oosWalkforward,
        compositeScores,
        selectionMethod: CONFIG.walkforward && CONFIG.oosWalkforward ? 'composite_with_both'
          : CONFIG.walkforward ? 'composite_with_robustness'
          : CONFIG.oosWalkforward ? 'composite_with_walkforward' : 'composite',
        baselineSource,
        candidates
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

function printCashTimeResults(results) {
  console.log(`\n${'═'.repeat(100)}`);
  console.log('  CASH-AT-TIME ANALYSIS RESULTS (Go to Cash Midday, Re-enter at EOD)');
  console.log(`  Question: "If I go to cash at a morning time, then re-enter at ${CONFIG.EOD_TIME} EOD, what is my cumulative return?"`);
  console.log(`${'═'.repeat(100)}\n`);

  for (const r of results) {
    if (r.error) {
      console.log(`${r.name || r.id}: ERROR - ${r.error}\n`);
      continue;
    }

    console.log(`${'─'.repeat(100)}`);
    console.log(`STRATEGY: ${r.name}`);
    console.log(`ID: ${r.id}`);
    console.log(`${r.tradingDays} trading days | ${r.dateRange}`);
    console.log(`${'─'.repeat(100)}`);

    console.log(`\n  CASH-AT-TIME RESULTS (Go cash at time, re-enter at ${CONFIG.EOD_TIME} EOD):`);
    console.log('  ┌─────────┬─────────────────┬─────────────────┬─────────────────┬─────────────────┐');
    console.log('  │  Time   │  Ann Return     │  Cum Return     │  Max Drawdown   │  vs EOD-Only    │');
    console.log('  ├─────────┼─────────────────┼─────────────────┼─────────────────┼─────────────────┤');

    // EOD baseline row first
    const eodAnn = r.eod.annReturn != null ? r.eod.annReturn : annualizedReturn(r.eod.cumReturn, r.tradingDays);
    const eodAnnStr = eodAnn != null ? `${eodAnn >= 0 ? '+' : ''}${eodAnn.toFixed(1)}%` : '—';
    const eodRet = `${r.eod.cumReturn >= 0 ? '+' : ''}${r.eod.cumReturn.toFixed(1)}%`;
    const eodDD = `${r.eod.maxDD.toFixed(1)}%`;
    const _blSrc = r.baselineSource === 'composer' ? '◀ COMPOSER' : '◀ EOD-ONLY';
    console.log(`  │  ${CONFIG.EOD_TIME}  │  ${eodAnnStr.padStart(12)}  │  ${eodRet.padStart(12)}  │  ${eodDD.padStart(12)}  │    (baseline)   │ ${_blSrc}`);
    console.log('  ├─────────┼─────────────────┼─────────────────┼─────────────────┼─────────────────┤');

    for (const time of CONFIG.TEST_TIMES) {
      const t = r.times[time];
      const tAnn = t.annReturn != null ? t.annReturn : annualizedReturn(t.cumReturn, r.tradingDays);
      const annStr = tAnn != null ? `${tAnn >= 0 ? '+' : ''}${tAnn.toFixed(1)}%` : '—';
      const ret = `${t.cumReturn >= 0 ? '+' : ''}${t.cumReturn.toFixed(1)}%`;
      const dd = `${t.maxDD.toFixed(1)}%`;
      const imp = `${t.improvement >= 0 ? '+' : ''}${t.improvement.toFixed(1)}%`;
      const marker = time === r.bestTime ? ' <-- BEST' : '';
      console.log(`  │  ${time}  │  ${annStr.padStart(12)}  │  ${ret.padStart(12)}  │  ${dd.padStart(12)}  │  ${imp.padStart(12)}  │${marker}`);
    }

    console.log('  └─────────┴─────────────────┴─────────────────┴─────────────────┴─────────────────┘\n');

    const cashCS = r.compositeScores && r.bestTime && r.compositeScores[r.bestTime];
    const cashScoreStr = cashCS ? ` (score ${cashCS.total}/100)` : '';
    if (r.recommendation === 'GO_CASH') {
      console.log(`  RECOMMENDATION: Consider going to cash at ${r.bestTime}${cashScoreStr} (${r.bestImprovement >= 0 ? '+' : ''}${r.bestImprovement.toFixed(1)}% improvement)`);
    } else if (r.recommendation === 'STICK_EOD') {
      console.log(`  RECOMMENDATION: Stick with EOD-only - going to cash midday shows worse results`);
    } else {
      console.log(`  RECOMMENDATION: Marginal difference${cashScoreStr} - EOD-only is simpler`);
    }

    // Composite score breakdown
    if (cashCS) {
      const rcPart = cashCS.robustnessScore !== null ? `, RC ${cashCS.robustnessScore}` : '';
      const oosPart = cashCS.wfScore !== null ? `, OOS ${cashCS.wfScore}` : '';
      console.log(`  SELECTION: Composite ${cashCS.total}/100 (Return ${cashCS.returnScore}, DD ${cashCS.ddScore}, Neighbors ${cashCS.neighborScore}${rcPart}${oosPart})`);
    }
    console.log('');

    if (r.walkforward) {
      printWalkforwardResults(r.walkforward, r.name, 'Cash');
    }
    if (r.oosWalkforward) {
      printOOSWalkforwardResults(r.oosWalkforward, r.name);
    }
  }

  // Summary table for multiple strategies
  if (results.filter(r => !r.error).length > 1) {
    console.log(`\n${'═'.repeat(100)}`);
    console.log('  CASH-AT-TIME SUMMARY');
    console.log(`${'═'.repeat(100)}\n`);

    const reset = '\x1b[0m';
    for (const r of results) {
      if (r.error) continue;
      const cs = r.compositeScores && r.bestTime && r.compositeScores[r.bestTime];
      const scoreVal = cs ? cs.total : 0;
      const q = getCompositeQuality(scoreVal);
      const impStr = `${r.bestImprovement >= 0 ? '+' : ''}${r.bestImprovement.toFixed(1)}%`;
      const ddStr = `${r.times[r.bestTime].maxDD.toFixed(1)}%`;
      const shortName = r.name.length > 40 ? r.name.slice(0, 37) + '...' : r.name;
      console.log(`  ${shortName.padEnd(42)} Cash@${r.bestTime}  ${q.color}${q.label.padEnd(8)}${reset} ${String(scoreVal).padStart(3)}/100  ${impStr.padStart(8)}  DD ${ddStr.padStart(6)}  ${r.recommendation}`);
    }
    console.log('');
  }
}

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
    console.log(`${r.tradingDays} trading days | ${r.dateRange}`);
    console.log(`${'─'.repeat(100)}`);

    console.log(`\n  DUAL-TIME RESULTS (Morning + ${CONFIG.EOD_TIME} EOD):`);
    console.log('  ┌─────────┬─────────────────┬─────────────────┬─────────────────┬─────────────────┐');
    console.log('  │  Time   │  Ann Return     │  Cum Return     │  Max Drawdown   │  vs EOD-Only    │');
    console.log('  ├─────────┼─────────────────┼─────────────────┼─────────────────┼─────────────────┤');

    // EOD baseline row first
    const eodAnnDual = r.eod.annReturn != null ? r.eod.annReturn : annualizedReturn(r.eod.cumReturn, r.tradingDays);
    const eodAnnStr2 = eodAnnDual != null ? `${eodAnnDual >= 0 ? '+' : ''}${eodAnnDual.toFixed(1)}%` : '—';
    const eodRet = `${r.eod.cumReturn >= 0 ? '+' : ''}${r.eod.cumReturn.toFixed(1)}%`;
    const eodDD = `${r.eod.maxDD.toFixed(1)}%`;
    const _blSrc2 = r.baselineSource === 'composer' ? '◀ COMPOSER' : '◀ EOD-ONLY';
    console.log(`  │  ${CONFIG.EOD_TIME}  │  ${eodAnnStr2.padStart(12)}  │  ${eodRet.padStart(12)}  │  ${eodDD.padStart(12)}  │    (baseline)   │ ${_blSrc2}`);
    console.log('  ├─────────┼─────────────────┼─────────────────┼─────────────────┼─────────────────┤');

    for (const time of CONFIG.TEST_TIMES) {
      const t = r.times[time];
      const tAnn = t.annReturn != null ? t.annReturn : annualizedReturn(t.cumReturn, r.tradingDays);
      const annStr = tAnn != null ? `${tAnn >= 0 ? '+' : ''}${tAnn.toFixed(1)}%` : '—';
      const ret = `${t.cumReturn >= 0 ? '+' : ''}${t.cumReturn.toFixed(1)}%`;
      const dd = `${t.maxDD.toFixed(1)}%`;
      const imp = `${t.improvement >= 0 ? '+' : ''}${t.improvement.toFixed(1)}%`;
      const marker = time === r.bestTime ? ' <-- BEST' : '';
      console.log(`  │  ${time}  │  ${annStr.padStart(12)}  │  ${ret.padStart(12)}  │  ${dd.padStart(12)}  │  ${imp.padStart(12)}  │${marker}`);
    }

    console.log('  └─────────┴─────────────────┴─────────────────┴─────────────────┴─────────────────┘\n');

    const dualCS = r.compositeScores && r.bestTime && r.compositeScores[r.bestTime];
    const dualScoreStr = dualCS ? ` (score ${dualCS.total}/100)` : '';
    if (r.recommendation === 'ADD_MORNING') {
      console.log(`  RECOMMENDATION: Consider adding "Run Now" at ${r.bestTime}${dualScoreStr} (+${r.bestImprovement.toFixed(1)}% improvement)`);
    } else if (r.recommendation === 'STICK_EOD') {
      console.log(`  RECOMMENDATION: Stick with EOD-only - dual-time shows worse results`);
    } else {
      console.log(`  RECOMMENDATION: Marginal difference${dualScoreStr} - EOD-only is simpler`);
    }

    // Composite score breakdown
    if (dualCS) {
      const rcPart = dualCS.robustnessScore !== null ? `, RC ${dualCS.robustnessScore}` : '';
      const oosPart = dualCS.wfScore !== null ? `, OOS ${dualCS.wfScore}` : '';
      console.log(`  SELECTION: Composite ${dualCS.total}/100 (Return ${dualCS.returnScore}, DD ${dualCS.ddScore}, Neighbors ${dualCS.neighborScore}${rcPart}${oosPart})`);
    }
    console.log('');

    if (r.walkforward) {
      printWalkforwardResults(r.walkforward, r.name, 'Dual');
    }
    if (r.oosWalkforward) {
      printOOSWalkforwardResults(r.oosWalkforward, r.name);
    }

    if (r.bestImprovement > 0) {
      console.log(`  TIP: Run "combined ${r.id} --wf --oos-wf" for full analysis (consistency + OOS walk-forward)\n`);
    }
  }

  // Summary
  if (results.filter(r => !r.error).length > 1) {
    // Helper: get display width of string (emojis count as 2)
    const getDisplayWidth = (str) => {
      let width = 0;
      for (const char of str) {
        const code = char.codePointAt(0);
        // Emoji ranges and other wide characters
        if (code > 0x1F000 || (code >= 0x2600 && code <= 0x27BF) || (code >= 0x1F300 && code <= 0x1F9FF)) {
          width += 2;
        } else {
          width += 1;
        }
      }
      return width;
    };

    // Helper: pad string to display width (accounting for emojis)
    const padEndDisplay = (str, targetWidth) => {
      const currentWidth = getDisplayWidth(str);
      const padding = Math.max(0, targetWidth - currentWidth);
      return str + ' '.repeat(padding);
    };

    // Helper: wrap string into lines of max display width (respects emoji widths)
    const wrapText = (str, maxWidth) => {
      const lines = [];
      let currentLine = '';
      let currentWidth = 0;

      for (const char of str) {
        const code = char.codePointAt(0);
        const charWidth = (code > 0x1F000 || (code >= 0x2600 && code <= 0x27BF) || (code >= 0x1F300 && code <= 0x1F9FF)) ? 2 : 1;

        if (currentWidth + charWidth > maxWidth) {
          lines.push(currentLine);
          currentLine = char;
          currentWidth = charWidth;
        } else {
          currentLine += char;
          currentWidth += charWidth;
        }
      }
      if (currentLine) lines.push(currentLine);
      return lines;
    };

    // Fixed max width for name column to keep table readable
    const MAX_NAME_WIDTH = 50;
    const validResults = results.filter(r => !r.error);
    const maxNameWidth = Math.min(MAX_NAME_WIDTH, Math.max(8, ...validResults.map(r => getDisplayWidth(r.name))));
    const nameCol = maxNameWidth + 2;  // padding
    const totalWidth = nameCol + 67;  // other columns width

    console.log(`\n${'═'.repeat(totalWidth + 4)}`);
    console.log('  SUMMARY');
    console.log(`${'═'.repeat(totalWidth + 4)}\n`);

    // Column order: Strategy | Days | Best Time | DD Chg | EOD-Only | Best | Difference | % Improve
    console.log(`  ┌${'─'.repeat(nameCol)}┬───────┬───────────┬────────┬───────────┬───────────┬────────────┬───────────┐`);
    console.log(`  │ ${'Strategy'.padEnd(nameCol - 2)} │ Days  │ Best Time │ DD Chg │ EOD-Only  │   Best    │ Difference │ % Improve │`);
    console.log(`  ├${'─'.repeat(nameCol)}┼───────┼───────────┼────────┼───────────┼───────────┼────────────┼───────────┤`);

    for (let idx = 0; idx < validResults.length; idx++) {
      const r = validResults[idx];
      const eodRet = r.eod.cumReturn;
      const bestRet = r.times[r.bestTime].cumReturn;
      const eod = `${eodRet >= 0 ? '+' : ''}${eodRet.toFixed(0)}%`;
      const best = `${bestRet >= 0 ? '+' : ''}${bestRet.toFixed(0)}%`;
      const diff = `${r.bestImprovement >= 0 ? '+' : ''}${r.bestImprovement.toFixed(0)}%`;
      const pctImprove = eodRet !== 0 ? (r.bestImprovement / Math.abs(eodRet)) * 100 : 0;
      const pctStr = `${pctImprove >= 0 ? '+' : ''}${pctImprove.toFixed(1)}%`;
      const ddChange = r.times[r.bestTime].maxDD - r.eod.maxDD;
      const ddChg = `${ddChange >= 0 ? '+' : ''}${ddChange.toFixed(0)}`;
      const timeStr = r.bestTime;  // Keep colon: "09:30"
      // Checkmark for >10% relative improvement
      const highlight = pctImprove > 10;
      const marker = highlight ? ' ✓' : '';

      // Wrap long names across multiple rows
      const nameLines = wrapText(r.name, maxNameWidth);
      // First line with data
      console.log(`  │ ${padEndDisplay(nameLines[0], nameCol - 2)} │ ${String(r.tradingDays).padStart(5)} │ ${timeStr.padStart(9)} │ ${ddChg.padStart(6)} │ ${eod.padStart(9)} │ ${best.padStart(9)} │ ${diff.padStart(10)} │ ${pctStr.padStart(9)} │${marker}`);
      // Additional name lines (data columns empty)
      for (let i = 1; i < nameLines.length; i++) {
        console.log(`  │ ${padEndDisplay(nameLines[i], nameCol - 2)} │       │           │        │           │           │            │           │`);
      }
      // Add separator line between rows (not after last row)
      if (idx < validResults.length - 1) {
        console.log(`  ├${'─'.repeat(nameCol)}┼───────┼───────────┼────────┼───────────┼───────────┼────────────┼───────────┤`);
      }
    }

    console.log(`  └${'─'.repeat(nameCol)}┴───────┴───────────┴────────┴───────────┴───────────┴────────────┴───────────┘\n`);

    const addMorning = results.filter(r => r.recommendation === 'ADD_MORNING').length;
    const stickEOD = results.filter(r => r.recommendation === 'STICK_EOD').length;
    const marginal = results.filter(r => r.recommendation === 'MARGINAL').length;
    const highlighted = validResults.filter(r => {
      const eodRet = r.eod.cumReturn;
      const pctImprove = eodRet !== 0 ? (r.bestImprovement / Math.abs(eodRet)) * 100 : 0;
      return pctImprove > 10;
    }).length;

    console.log(`  Total: ${addMorning} should ADD MORNING | ${stickEOD} should STICK WITH EOD | ${marginal} MARGINAL`);
    if (highlighted > 0) {
      console.log(`  ✓ = >10% relative improvement (${highlighted} strategies)`);
    }
    console.log('');
  }
}

function printSingleTimeResults(results) {
  console.log(`\n${'═'.repeat(100)}`);
  console.log('  SINGLE TIME REPLACEMENT ANALYSIS RESULTS (V3 - Daily Indicators + Intraday Execution)');
  console.log(`  Question: "If I REPLACE ${CONFIG.EOD_TIME} EOD with a morning trade, would I do better?"`);
  console.log(`${'═'.repeat(100)}\n`);

  for (const r of results) {
    if (r.error) {
      console.log(`${r.name || r.id}: ERROR - ${r.error}\n`);
      continue;
    }

    console.log(`${'─'.repeat(100)}`);
    console.log(`STRATEGY: ${r.name}`);
    console.log(`ID: ${r.id}`);
    console.log(`${r.tradingDays} trading days | ${r.dateRange}`);
    console.log(`${'─'.repeat(100)}`);

    const eodAnnVal = r.eod.annReturn != null ? r.eod.annReturn : annualizedReturn(r.eod.cumReturn, r.tradingDays);
    const eodAnnStr = eodAnnVal != null ? `${eodAnnVal >= 0 ? '+' : ''}${eodAnnVal.toFixed(1)}% ann.` : '';
    const eodCumStr = `(${r.eod.cumReturn >= 0 ? '+' : ''}${r.eod.cumReturn.toFixed(1)}% cum.)`;
    console.log(`\n  DEFAULT EOD (${CONFIG.EOD_TIME}):  Return: ${eodAnnStr} ${eodCumStr}  |  Max DD: ${r.eod.maxDD.toFixed(1)}%\n`);

    console.log(`  ALTERNATIVE TIMES (Instead of ${CONFIG.EOD_TIME}):`);
    console.log('  ┌─────────┬─────────────────┬─────────────────┬─────────────────┬─────────────────┐');
    console.log('  │  Time   │  Ann Return     │  Cum Return     │  Max Drawdown   │  vs EOD         │');
    console.log('  ├─────────┼─────────────────┼─────────────────┼─────────────────┼─────────────────┤');

    for (const time of CONFIG.TEST_TIMES) {
      const t = r.times[time];
      const annVal = t.annReturn != null ? t.annReturn : annualizedReturn(t.cumReturn, r.tradingDays);
      const annStr = annVal != null ? `${annVal >= 0 ? '+' : ''}${annVal.toFixed(1)}%` : '—';
      const ret = `${t.cumReturn >= 0 ? '+' : ''}${t.cumReturn.toFixed(1)}%`;
      const dd = `${t.maxDD.toFixed(1)}%`;
      const imp = `${t.improvement >= 0 ? '+' : ''}${t.improvement.toFixed(1)}%`;
      const marker = time === r.bestTime && r.bestTime !== CONFIG.EOD_TIME ? ' <-- BEST' : '';
      console.log(`  │  ${time}  │  ${annStr.padStart(12)}  │  ${ret.padStart(12)}  │  ${dd.padStart(12)}  │  ${imp.padStart(12)}  │${marker}`);
    }

    console.log('  └─────────┴─────────────────┴─────────────────┴─────────────────┴─────────────────┘\n');

    const singleCS = r.compositeScores && r.bestTime && r.compositeScores[r.bestTime];
    const singleScoreStr = singleCS ? ` (score ${singleCS.total}/100)` : '';
    if (r.recommendation === 'USE_MORNING') {
      console.log(`  RECOMMENDATION: Consider switching to ${r.bestTime}${singleScoreStr} (+${r.bestImprovement.toFixed(1)}% vs EOD)`);
    } else {
      console.log(`  RECOMMENDATION: Keep default EOD execution`);
    }

    // Composite score breakdown
    if (singleCS) {
      const rcPart = singleCS.robustnessScore !== null ? `, RC ${singleCS.robustnessScore}` : '';
      const oosPart = singleCS.wfScore !== null ? `, OOS ${singleCS.wfScore}` : '';
      console.log(`  SELECTION: Composite ${singleCS.total}/100 (Return ${singleCS.returnScore}, DD ${singleCS.ddScore}, Neighbors ${singleCS.neighborScore}${rcPart}${oosPart})`);
    }
    console.log('');

    if (r.walkforward) {
      printWalkforwardResults(r.walkforward, r.name, `@${r.bestTime}`);
    }
    if (r.oosWalkforward) {
      printOOSWalkforwardResults(r.oosWalkforward, r.name);
    }

    if (r.bestImprovement > 0) {
      console.log(`  TIP: Run "combined ${r.id} --wf --oos-wf" for full analysis (consistency + OOS walk-forward)\n`);
    }
  }

  if (results.filter(r => !r.error).length > 1) {
    // Helper: get display width of string (emojis count as 2)
    const getDisplayWidth = (str) => {
      let width = 0;
      for (const char of str) {
        const code = char.codePointAt(0);
        // Emoji ranges and other wide characters
        if (code > 0x1F000 || (code >= 0x2600 && code <= 0x27BF) || (code >= 0x1F300 && code <= 0x1F9FF)) {
          width += 2;
        } else {
          width += 1;
        }
      }
      return width;
    };

    // Helper: pad string to display width (accounting for emojis)
    const padEndDisplay = (str, targetWidth) => {
      const currentWidth = getDisplayWidth(str);
      const padding = Math.max(0, targetWidth - currentWidth);
      return str + ' '.repeat(padding);
    };

    // Helper: wrap string into lines of max display width (respects emoji widths)
    const wrapText = (str, maxWidth) => {
      const lines = [];
      let currentLine = '';
      let currentWidth = 0;

      for (const char of str) {
        const code = char.codePointAt(0);
        const charWidth = (code > 0x1F000 || (code >= 0x2600 && code <= 0x27BF) || (code >= 0x1F300 && code <= 0x1F9FF)) ? 2 : 1;

        if (currentWidth + charWidth > maxWidth) {
          lines.push(currentLine);
          currentLine = char;
          currentWidth = charWidth;
        } else {
          currentLine += char;
          currentWidth += charWidth;
        }
      }
      if (currentLine) lines.push(currentLine);
      return lines;
    };

    // Fixed max width for name column to keep table readable
    const MAX_NAME_WIDTH = 50;
    const validResults = results.filter(r => !r.error);
    const maxNameWidth = Math.min(MAX_NAME_WIDTH, Math.max(8, ...validResults.map(r => getDisplayWidth(r.name))));
    const nameCol = maxNameWidth + 2;  // padding
    const totalWidth = nameCol + 67;  // other columns width

    console.log(`\n${'═'.repeat(totalWidth + 4)}`);
    console.log('  SUMMARY');
    console.log(`${'═'.repeat(totalWidth + 4)}\n`);

    // Column order: Strategy | Days | Best Time | DD Chg | EOD Ann | Best Ann | Difference | % Improve
    console.log(`  ┌${'─'.repeat(nameCol)}┬───────┬───────────┬────────┬───────────┬───────────┬────────────┬───────────┐`);
    console.log(`  │ ${'Strategy'.padEnd(nameCol - 2)} │ Days  │ Best Time │ DD Chg │ EOD Ann   │ Best Ann  │ Difference │ % Improve │`);
    console.log(`  ├${'─'.repeat(nameCol)}┼───────┼───────────┼────────┼───────────┼───────────┼────────────┼───────────┤`);

    for (let idx = 0; idx < validResults.length; idx++) {
      const r = validResults[idx];
      const eodAnnRet = r.eod.annReturn != null ? r.eod.annReturn : annualizedReturn(r.eod.cumReturn, r.tradingDays);
      const bestData = r.bestTime === CONFIG.EOD_TIME ? r.eod : r.times[r.bestTime];
      const bestAnnRet = bestData.annReturn != null ? bestData.annReturn : annualizedReturn(bestData.cumReturn, r.tradingDays);
      const eod = eodAnnRet != null ? `${eodAnnRet >= 0 ? '+' : ''}${eodAnnRet.toFixed(0)}%` : '—';
      const best = bestAnnRet != null ? `${bestAnnRet >= 0 ? '+' : ''}${bestAnnRet.toFixed(0)}%` : '—';
      const annDiff = (eodAnnRet != null && bestAnnRet != null) ? bestAnnRet - eodAnnRet : r.bestImprovement;
      const diff = `${annDiff >= 0 ? '+' : ''}${annDiff.toFixed(0)}%`;
      const pctImprove = eodAnnRet != null && eodAnnRet !== 0 ? (annDiff / Math.abs(eodAnnRet)) * 100 : 0;
      const pctStr = `${pctImprove >= 0 ? '+' : ''}${pctImprove.toFixed(1)}%`;
      const bestDD = r.bestTime === CONFIG.EOD_TIME ? r.eod.maxDD : r.times[r.bestTime].maxDD;
      const ddChange = bestDD - r.eod.maxDD;
      const ddChg = `${ddChange >= 0 ? '+' : ''}${ddChange.toFixed(0)}`;
      const timeStr = r.bestTime;
      // Checkmark for >10% relative improvement
      const highlight = pctImprove > 10;
      const marker = highlight ? ' ✓' : '';

      // Wrap long names across multiple rows
      const nameLines = wrapText(r.name, maxNameWidth);
      // First line with data
      console.log(`  │ ${padEndDisplay(nameLines[0], nameCol - 2)} │ ${String(r.tradingDays).padStart(5)} │ ${timeStr.padStart(9)} │ ${ddChg.padStart(6)} │ ${eod.padStart(9)} │ ${best.padStart(9)} │ ${diff.padStart(10)} │ ${pctStr.padStart(9)} │${marker}`);
      // Additional name lines (data columns empty)
      for (let i = 1; i < nameLines.length; i++) {
        console.log(`  │ ${padEndDisplay(nameLines[i], nameCol - 2)} │       │           │        │           │           │            │           │`);
      }
      // Add separator line between rows (not after last row)
      if (idx < validResults.length - 1) {
        console.log(`  ├${'─'.repeat(nameCol)}┼───────┼───────────┼────────┼───────────┼───────────┼────────────┼───────────┤`);
      }
    }

    console.log(`  └${'─'.repeat(nameCol)}┴───────┴───────────┴────────┴───────────┴───────────┴────────────┴───────────┘\n`);

    const useMorning = results.filter(r => r.recommendation === 'USE_MORNING').length;
    const keepEOD = results.filter(r => r.recommendation === 'KEEP_EOD').length;
    const highlighted = validResults.filter(r => {
      const eodRet = r.eod.cumReturn;
      const pctImprove = eodRet !== 0 ? (r.bestImprovement / Math.abs(eodRet)) * 100 : 0;
      return pctImprove > 10;
    }).length;

    console.log(`  Total: ${useMorning} could benefit from morning time | ${keepEOD} should keep EOD`);
    if (highlighted > 0) {
      console.log(`  ✓ = >10% relative improvement (${highlighted} strategies)`);
    }
    console.log('');
  }
}

// ============================================================================
// COMBINED ANALYSIS
// ============================================================================

async function combinedAnalysis(ids, intradayDays, quiet = false) {
  // Run all three analyses
  if (!quiet) console.log('\n  Running DUAL analysis...\n');
  const dualResults = await dualTimeAnalysis(ids, intradayDays, true);

  if (!quiet) console.log('\n  Running SINGLE analysis...\n');
  const singleResults = await singleTimeAnalysis(ids, intradayDays, true);

  if (!quiet) console.log('\n  Running CASH analysis...\n');
  const cashResults = await cashTimeAnalysis(ids, intradayDays, true);

  // Combine results
  const combined = [];
  for (let i = 0; i < ids.length; i++) {
    const dual = dualResults[i];
    const single = singleResults[i];
    const cash = cashResults[i];

    if (dual.error || single.error || cash.error) {
      combined.push({
        id: ids[i],
        name: dual.name || single.name || cash.name || 'Unknown',
        error: dual.error || single.error || cash.error
      });
      continue;
    }

    combined.push({
      id: ids[i],
      name: dual.name,
      tradingDays: dual.tradingDays,
      dateRange: dual.dateRange,
      baselineSource: dual.baselineSource || 'simulated',
      holdingsReliability: dual.holdingsReliability || null,
      eod: dual.eod,
      dual: {
        bestTime: dual.bestTime,
        bestReturn: dual.times[dual.bestTime].cumReturn,
        bestAnnReturn: dual.times[dual.bestTime].annReturn,
        bestDD: dual.times[dual.bestTime].maxDD,
        improvement: dual.bestImprovement,
        recommendation: dual.recommendation,
        times: dual.times,
        walkforward: dual.walkforward || null,
        allWalkforwardResults: dual.allWalkforwardResults || {},
        oosWalkforward: dual.oosWalkforward || null,
        compositeScores: dual.compositeScores || null,
        selectionMethod: dual.selectionMethod || null
      },
      single: {
        bestTime: single.bestTime,
        bestReturn: single.times[single.bestTime] ? single.times[single.bestTime].cumReturn : single.eod.cumReturn,
        bestAnnReturn: single.times[single.bestTime] ? single.times[single.bestTime].annReturn : single.eod.annReturn,
        bestDD: single.times[single.bestTime] ? single.times[single.bestTime].maxDD : single.eod.maxDD,
        improvement: single.bestImprovement,
        recommendation: single.recommendation,
        times: single.times,
        walkforward: single.walkforward || null,
        allWalkforwardResults: single.allWalkforwardResults || {},
        oosWalkforward: single.oosWalkforward || null,
        compositeScores: single.compositeScores || null,
        selectionMethod: single.selectionMethod || null
      },
      cash: {
        bestTime: cash.bestTime,
        bestReturn: cash.times[cash.bestTime] ? cash.times[cash.bestTime].cumReturn : cash.eod.cumReturn,
        bestAnnReturn: cash.times[cash.bestTime] ? cash.times[cash.bestTime].annReturn : cash.eod.annReturn,
        bestDD: cash.times[cash.bestTime] ? cash.times[cash.bestTime].maxDD : cash.eod.maxDD,
        improvement: cash.bestImprovement,
        recommendation: cash.recommendation,
        times: cash.times,
        walkforward: cash.walkforward || null,
        allWalkforwardResults: cash.allWalkforwardResults || {},
        oosWalkforward: cash.oosWalkforward || null,
        compositeScores: cash.compositeScores || null,
        selectionMethod: cash.selectionMethod || null
      }
    });
  }

  return combined;
}

function printCombinedResults(results) {
  console.log(`\n${'═'.repeat(120)}`);
  console.log('  COMBINED ANALYSIS RESULTS (Dual + Single + Cash Comparison)');
  console.log('  Compares: DUAL (morning + EOD) vs SINGLE (replace EOD) vs CASH (go to cash midday, re-enter EOD)');
  console.log(`${'═'.repeat(120)}\n`);

  // Detailed results per strategy
  for (const r of results) {
    if (r.error) {
      console.log(`${r.name || r.id}: ERROR - ${r.error}\n`);
      continue;
    }

    console.log(`${'─'.repeat(120)}`);
    console.log(`STRATEGY: ${r.name}`);
    console.log(`ID: ${r.id}`);
    console.log(`${r.tradingDays} trading days | ${r.dateRange}`);
    console.log(`${'─'.repeat(120)}`);

    const cbAnn = r.eod.annReturn != null ? r.eod.annReturn : annualizedReturn(r.eod.cumReturn, r.tradingDays);
    const cbAnnStr = cbAnn != null ? `${cbAnn >= 0 ? '+' : ''}${cbAnn.toFixed(1)}% ann.` : '';
    const cbCumStr = `(${r.eod.cumReturn >= 0 ? '+' : ''}${r.eod.cumReturn.toFixed(1)}% cum.)`;
    const _blSrc3 = r.dual && r.dual.baselineSource === 'composer' ? 'Composer Backtest' : `EOD-Only @ ${CONFIG.EOD_TIME}`;
    console.log(`\n  BASELINE (${_blSrc3}):  Return: ${cbAnnStr} ${cbCumStr}  |  Max DD: ${r.eod.maxDD.toFixed(1)}%\n`);

    // Composite quality labels for each mode
    const reset = '\x1b[0m';
    const dualCS = (r.dual.compositeScores && r.dual.bestTime && r.dual.compositeScores[r.dual.bestTime]) ? r.dual.compositeScores[r.dual.bestTime] : null;
    const singleCS = (r.single.compositeScores && r.single.bestTime && r.single.compositeScores[r.single.bestTime]) ? r.single.compositeScores[r.single.bestTime] : null;
    const cashCS = (r.cash && r.cash.compositeScores && r.cash.bestTime && r.cash.compositeScores[r.cash.bestTime]) ? r.cash.compositeScores[r.cash.bestTime] : null;
    if (dualCS) {
      const dq = getCompositeQuality(dualCS.total);
      const rcP = dualCS.robustnessScore !== null ? `, RC ${dualCS.robustnessScore}` : '';
      const oosP = dualCS.wfScore !== null ? `, OOS ${dualCS.wfScore}` : '';
      console.log(`  DUAL @ ${r.dual.bestTime}:   ${dq.color}${dq.label} ${dualCS.total}/100${reset} (Return ${dualCS.returnScore}, DD ${dualCS.ddScore}, Neighbors ${dualCS.neighborScore}${rcP}${oosP})`);
    }
    if (singleCS) {
      const sq = getCompositeQuality(singleCS.total);
      const rcP = singleCS.robustnessScore !== null ? `, RC ${singleCS.robustnessScore}` : '';
      const oosP = singleCS.wfScore !== null ? `, OOS ${singleCS.wfScore}` : '';
      console.log(`  SINGLE @ ${r.single.bestTime}: ${sq.color}${sq.label} ${singleCS.total}/100${reset} (Return ${singleCS.returnScore}, DD ${singleCS.ddScore}, Neighbors ${singleCS.neighborScore}${rcP}${oosP})`);
    }
    if (cashCS) {
      const cq = getCompositeQuality(cashCS.total);
      const rcP = cashCS.robustnessScore !== null ? `, RC ${cashCS.robustnessScore}` : '';
      const oosP = cashCS.wfScore !== null ? `, OOS ${cashCS.wfScore}` : '';
      console.log(`  CASH @ ${r.cash.bestTime}:   ${cq.color}${cq.label} ${cashCS.total}/100${reset} (Return ${cashCS.returnScore}, DD ${cashCS.ddScore}, Neighbors ${cashCS.neighborScore}${rcP}${oosP})`);
    }
    console.log('');

    console.log('  COMPARISON:');
    console.log('  ┌─────────────┬─────────────┬─────────────────┬─────────────────┬─────────────────┐');
    console.log('  │   Mode      │  Best Time  │   Ann Return    │   Max Drawdown  │  vs EOD-Only    │');
    console.log('  ├─────────────┼─────────────┼─────────────────┼─────────────────┼─────────────────┤');

    const dualAnnCli = r.dual.bestAnnReturn != null ? r.dual.bestAnnReturn : annualizedReturn(r.dual.bestReturn, r.tradingDays);
    const dualRet = dualAnnCli != null ? `${dualAnnCli >= 0 ? '+' : ''}${dualAnnCli.toFixed(1)}%` : '—';
    const dualDD = `${r.dual.bestDD.toFixed(1)}%`;
    const dualImp = `${r.dual.improvement >= 0 ? '+' : ''}${r.dual.improvement.toFixed(1)}%`;
    console.log(`  │  DUAL       │    ${r.dual.bestTime}    │  ${dualRet.padStart(12)}  │  ${dualDD.padStart(12)}  │  ${dualImp.padStart(12)}  │`);

    const singleAnnCli = r.single.bestAnnReturn != null ? r.single.bestAnnReturn : annualizedReturn(r.single.bestReturn, r.tradingDays);
    const singleRet = singleAnnCli != null ? `${singleAnnCli >= 0 ? '+' : ''}${singleAnnCli.toFixed(1)}%` : '—';
    const singleDD = `${r.single.bestDD.toFixed(1)}%`;
    const singleImp = `${r.single.improvement >= 0 ? '+' : ''}${r.single.improvement.toFixed(1)}%`;
    console.log(`  │  SINGLE     │    ${r.single.bestTime}    │  ${singleRet.padStart(12)}  │  ${singleDD.padStart(12)}  │  ${singleImp.padStart(12)}  │`);

    if (r.cash) {
      const cashAnnCli = r.cash.bestAnnReturn != null ? r.cash.bestAnnReturn : annualizedReturn(r.cash.bestReturn, r.tradingDays);
      const cashRet = cashAnnCli != null ? `${cashAnnCli >= 0 ? '+' : ''}${cashAnnCli.toFixed(1)}%` : '—';
      const cashDD = `${r.cash.bestDD.toFixed(1)}%`;
      const cashImp = `${r.cash.improvement >= 0 ? '+' : ''}${r.cash.improvement.toFixed(1)}%`;
      console.log(`  │  CASH       │    ${r.cash.bestTime}    │  ${cashRet.padStart(12)}  │  ${cashDD.padStart(12)}  │  ${cashImp.padStart(12)}  │`);
    }

    console.log('  └─────────────┴─────────────┴─────────────────┴─────────────────┴─────────────────┘\n');

    // Generate recommendation
    const rec = generateCombinedRecommendation(r);
    console.log(`  RECOMMENDATION: ${rec.text}`);
    if (rec.warning) {
      console.log(`  ⚠️  WARNING: ${rec.warning}`);
    }

    console.log('');

    if (r.dual.walkforward) {
      printWalkforwardResults(r.dual.walkforward, r.name, 'Dual');
    }
    if (r.dual.oosWalkforward) {
      printOOSWalkforwardResults(r.dual.oosWalkforward, r.name);
    }
    if (r.single.walkforward) {
      printWalkforwardResults(r.single.walkforward, r.name, `@${r.single.bestTime}`);
    }
    if (r.single.oosWalkforward) {
      printOOSWalkforwardResults(r.single.oosWalkforward, r.name);
    }
    if (r.cash && r.cash.walkforward) {
      printWalkforwardResults(r.cash.walkforward, r.name, 'Cash');
    }
    if (r.cash && r.cash.oosWalkforward) {
      printOOSWalkforwardResults(r.cash.oosWalkforward, r.name);
    }
  }

  // Summary table
  if (results.filter(r => !r.error).length > 1) {
    printCombinedSummaryTable(results);
  }
}

// ── Composite Quality Label ───────────────────────────────────────────────

/**
 * Derive a quality label from composite score.
 * Returns { label, color (ansi), htmlColor, bgColor, borderColor }
 */
function getCompositeQuality(score) {
  if (score >= 75) return { label: 'STRONG', color: '\x1b[32m', htmlColor: '#3fb950', bgColor: 'rgba(63,185,80,0.12)', borderColor: 'rgba(63,185,80,0.3)' };
  if (score >= 55) return { label: 'GOOD', color: '\x1b[34m', htmlColor: '#58a6ff', bgColor: 'rgba(88,166,255,0.12)', borderColor: 'rgba(88,166,255,0.3)' };
  if (score >= 40) return { label: 'MARGINAL', color: '\x1b[33m', htmlColor: '#d29922', bgColor: 'rgba(210,153,34,0.12)', borderColor: 'rgba(210,153,34,0.3)' };
  return { label: 'WEAK', color: '\x1b[31m', htmlColor: '#f85149', bgColor: 'rgba(248,81,73,0.12)', borderColor: 'rgba(248,81,73,0.3)' };
}

// ── End Composite Quality Label ──────────────────────────────────────────

function generateCombinedRecommendation(r) {
  // Get composite scores for the selected best time in each mode
  const dualScore = (r.dual.compositeScores && r.dual.bestTime && r.dual.compositeScores[r.dual.bestTime])
    ? r.dual.compositeScores[r.dual.bestTime].total : 0;
  const singleScore = (r.single.compositeScores && r.single.bestTime && r.single.compositeScores[r.single.bestTime])
    ? r.single.compositeScores[r.single.bestTime].total : 0;
  const cashScore = (r.cash && r.cash.compositeScores && r.cash.bestTime && r.cash.compositeScores[r.cash.bestTime])
    ? r.cash.compositeScores[r.cash.bestTime].total : 0;

  const dualDDWorse = r.dual.bestDD > r.eod.maxDD + 5;
  const singleDDWorse = r.single.bestDD > r.eod.maxDD + 5;
  const cashDDWorse = r.cash && r.cash.bestDD > r.eod.maxDD + 5;
  const dualHasHighDD = r.dual.bestDD > 30;
  const singleHasHighDD = r.single.bestDD > 30;
  const cashHasHighDD = r.cash && r.cash.bestDD > 30;

  // Relative improvement: improvement as % of EOD return (handles negative/zero EOD)
  const eodAbs = Math.abs(r.eod.cumReturn);
  const dualRelPct = eodAbs > 1 ? (r.dual.improvement / eodAbs) * 100 : r.dual.improvement * 10;
  const singleRelPct = eodAbs > 1 ? (r.single.improvement / eodAbs) * 100 : r.single.improvement * 10;
  const cashRelPct = r.cash ? (eodAbs > 1 ? (r.cash.improvement / eodAbs) * 100 : r.cash.improvement * 10) : -Infinity;
  const REL_THRESHOLD = 10; // Need >= 10% relative improvement to recommend

  let text = '';
  let warning = null;

  // Comparison line always included: shows all modes so user sees the gap
  const dualLabel = `Dual @${r.dual.bestTime}: ${dualScore}/100, ${r.dual.improvement >= 0 ? '+' : ''}${r.dual.improvement.toFixed(1)}% (${dualRelPct >= 0 ? '+' : ''}${dualRelPct.toFixed(0)}% rel)`;
  const singleLabel = `Single @${r.single.bestTime}: ${singleScore}/100, ${r.single.improvement >= 0 ? '+' : ''}${r.single.improvement.toFixed(1)}% (${singleRelPct >= 0 ? '+' : ''}${singleRelPct.toFixed(0)}% rel)`;
  const cashLabel = r.cash ? `Cash @${r.cash.bestTime}: ${cashScore}/100, ${r.cash.improvement >= 0 ? '+' : ''}${r.cash.improvement.toFixed(1)}% (${cashRelPct >= 0 ? '+' : ''}${cashRelPct.toFixed(0)}% rel)` : '';
  const comparison = cashLabel ? `${dualLabel}  vs  ${singleLabel}  vs  ${cashLabel}` : `${dualLabel}  vs  ${singleLabel}`;

  // Determine viability: must pass relative threshold
  const dualViable = dualRelPct >= REL_THRESHOLD;
  const singleViable = singleRelPct >= REL_THRESHOLD;
  const cashViable = cashRelPct >= REL_THRESHOLD;

  // No mode passes relative improvement threshold
  if (!dualViable && !singleViable && !cashViable) {
    text = `NOT RECOMMENDED - Improvement too small relative to EOD returns. ${comparison}`;
    return { text, warning };
  }

  // Build candidates array: {mode, score, dd, ddWorse, ddHigh, time}
  const candidates = [];
  if (dualViable) candidates.push({ mode: 'DUAL', score: dualScore, dd: r.dual.bestDD, ddWorse: dualDDWorse, ddHigh: dualHasHighDD, time: r.dual.bestTime });
  if (singleViable) candidates.push({ mode: 'SINGLE', score: singleScore, dd: r.single.bestDD, ddWorse: singleDDWorse, ddHigh: singleHasHighDD, time: r.single.bestTime });
  if (cashViable) candidates.push({ mode: 'CASH', score: cashScore, dd: r.cash.bestDD, ddWorse: cashDDWorse, ddHigh: cashHasHighDD, time: r.cash.bestTime });

  // Sort by composite score descending, then DD ascending as tiebreaker
  candidates.sort((a, b) => {
    if (Math.abs(a.score - b.score) > 5) return b.score - a.score;
    return a.dd - b.dd;
  });

  const best = candidates[0];
  if (best) {
    const q = getCompositeQuality(best.score);
    text = `USE ${best.mode} @ ${best.time} (${q.label}). ${comparison}`;
    if (best.ddWorse) warning = `Drawdown increases from ${r.eod.maxDD.toFixed(1)}% to ${best.dd.toFixed(1)}%`;
    if (best.ddHigh) warning = (warning ? warning + ' | ' : '') + `High drawdown risk (${best.dd.toFixed(1)}%)`;
  } else {
    text = `NOT RECOMMENDED - No mode passes thresholds. ${comparison}`;
  }

  return { text, warning };
}

function printCombinedSummaryTable(results) {
  // Helper functions (same as other tables)
  const getDisplayWidth = (str) => {
    let width = 0;
    for (const char of str) {
      const code = char.codePointAt(0);
      if (code > 0x1F000 || (code >= 0x2600 && code <= 0x27BF) || (code >= 0x1F300 && code <= 0x1F9FF)) {
        width += 2;
      } else {
        width += 1;
      }
    }
    return width;
  };

  const padEndDisplay = (str, targetWidth) => {
    const currentWidth = getDisplayWidth(str);
    const padding = Math.max(0, targetWidth - currentWidth);
    return str + ' '.repeat(padding);
  };

  const wrapText = (str, maxWidth) => {
    const lines = [];
    let currentLine = '';
    let currentWidth = 0;
    for (const char of str) {
      const code = char.codePointAt(0);
      const charWidth = (code > 0x1F000 || (code >= 0x2600 && code <= 0x27BF) || (code >= 0x1F300 && code <= 0x1F9FF)) ? 2 : 1;
      if (currentWidth + charWidth > maxWidth) {
        lines.push(currentLine);
        currentLine = char;
        currentWidth = charWidth;
      } else {
        currentLine += char;
        currentWidth += charWidth;
      }
    }
    if (currentLine) lines.push(currentLine);
    return lines;
  };

  const MAX_NAME_WIDTH = 40;
  const validResults = results.filter(r => !r.error);
  const maxNameWidth = Math.min(MAX_NAME_WIDTH, Math.max(8, ...validResults.map(r => getDisplayWidth(r.name))));
  const nameCol = maxNameWidth + 2;
  const totalWidth = nameCol + 103;

  console.log(`\n${'═'.repeat(totalWidth + 4)}`);
  console.log('  COMBINED SUMMARY');
  console.log(`${'═'.repeat(totalWidth + 4)}\n`);

  // Column headers: Strategy | Days | EOD Ret | EOD DD | Dual Time | Dual Imp | Dual DD | Single Time | Single Imp | Single DD | Best | Score
  console.log(`  ┌${'─'.repeat(nameCol)}┬───────┬─────────┬─────────┬───────────┬──────────┬─────────┬─────────────┬────────────┬─────────┬────────────┬────────┐`);
  console.log(`  │ ${'Strategy'.padEnd(nameCol - 2)} │ Days  │ EOD Ret │  EOD DD │ Dual Time │ Dual Imp │ Dual DD │ Single Time │ Single Imp │ Sngl DD │    Best    │ Score  │`);
  console.log(`  ├${'─'.repeat(nameCol)}┼───────┼─────────┼─────────┼───────────┼──────────┼─────────┼─────────────┼────────────┼─────────┼────────────┼────────┤`);

  for (let idx = 0; idx < validResults.length; idx++) {
    const r = validResults[idx];

    const eodRet = `${r.eod.cumReturn >= 0 ? '+' : ''}${r.eod.cumReturn.toFixed(0)}%`;
    const eodDD = `${r.eod.maxDD.toFixed(0)}%`;
    const dualTime = r.dual.bestTime;
    const dualImp = `${r.dual.improvement >= 0 ? '+' : ''}${r.dual.improvement.toFixed(0)}%`;
    const dualDD = `${r.dual.bestDD.toFixed(0)}%`;
    const singleTime = r.single.bestTime;
    const singleImp = `${r.single.improvement >= 0 ? '+' : ''}${r.single.improvement.toFixed(0)}%`;
    const singleDD = `${r.single.bestDD.toFixed(0)}%`;

    // Determine best recommendation
    let best = 'EOD';
    let hasWarning = false;
    const rec = generateCombinedRecommendation(r);
    if (rec.text.includes('USE DUAL')) {
      best = 'DUAL';
    } else if (rec.text.includes('USE SINGLE')) {
      best = 'SINGLE';
    } else if (rec.text.includes('USE CASH')) {
      best = 'CASH';
    }
    if (rec.warning) {
      hasWarning = true;
    }

    const bestStr = hasWarning ? `${best} ⚠️` : best;

    // Best composite score (from whichever mode the recommendation prefers)
    const dualCS = (r.dual.compositeScores && r.dual.bestTime && r.dual.compositeScores[r.dual.bestTime]) ? r.dual.compositeScores[r.dual.bestTime].total : 0;
    const singleCS = (r.single.compositeScores && r.single.bestTime && r.single.compositeScores[r.single.bestTime]) ? r.single.compositeScores[r.single.bestTime].total : 0;
    const cashCSVal = (r.cash && r.cash.compositeScores && r.cash.bestTime && r.cash.compositeScores[r.cash.bestTime]) ? r.cash.compositeScores[r.cash.bestTime].total : 0;
    const topScore = Math.max(dualCS, singleCS, cashCSVal);
    const scoreStr = topScore > 0 ? `${topScore}` : '-';

    // Wrap long names
    const nameLines = wrapText(r.name, maxNameWidth);

    // First line with data
    console.log(`  │ ${padEndDisplay(nameLines[0], nameCol - 2)} │ ${String(r.tradingDays).padStart(5)} │ ${eodRet.padStart(7)} │ ${eodDD.padStart(7)} │ ${dualTime.padStart(9)} │ ${dualImp.padStart(8)} │ ${dualDD.padStart(7)} │ ${singleTime.padStart(11)} │ ${singleImp.padStart(10)} │ ${singleDD.padStart(7)} │ ${bestStr.padStart(10)} │ ${scoreStr.padStart(6)} │`);

    // Additional name lines
    for (let i = 1; i < nameLines.length; i++) {
      console.log(`  │ ${padEndDisplay(nameLines[i], nameCol - 2)} │       │         │         │           │          │         │             │            │         │            │        │`);
    }

    // Separator between rows
    if (idx < validResults.length - 1) {
      console.log(`  ├${'─'.repeat(nameCol)}┼───────┼─────────┼─────────┼───────────┼──────────┼─────────┼─────────────┼────────────┼─────────┼────────────┼────────┤`);
    }
  }

  console.log(`  └${'─'.repeat(nameCol)}┴───────┴─────────┴─────────┴───────────┴──────────┴─────────┴─────────────┴────────────┴─────────┴────────────┴────────┘\n`);

  // Legend
  console.log('  Legend:');
  console.log('    • EOD Ret/DD = Baseline performance (EOD-only trading)');
  console.log('    • Dual = Morning trade + EOD trade | Single = Replace EOD with different time');
  console.log('    • Cash = Go to cash midday, re-enter at EOD');
  console.log('    • Imp = Improvement vs EOD-only baseline');
  console.log('    • Best = Recommended mode (EOD/DUAL/SINGLE/CASH)');
  console.log('    • Score = Composite quality score: STRONG (75+), GOOD (55-74), MARGINAL (40-54), WEAK (<40)');
  console.log('    • ⚠️ = High drawdown warning (DD > 30% or DD increased significantly)');
  console.log('');
}

// ============================================================================
// SUB-ANALYSIS
// ============================================================================

async function flipAnalysis(id, intradayDays) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log('  SIGNAL FLIP FREQUENCY ANALYSIS (V3)');
  console.log(`${'═'.repeat(60)}\n`);

  clearMemoCache(); clearSortedKeysCache();  // Clear caches for fresh analysis
  console.log(`Fetching symphony ${id}...`);
  const { score, name } = await getSymphony(id);
  console.log(`Name: ${name}\n`);

  const tickers = Array.from(extractTickers(score));
  const dailyDays = CONFIG.MAX_DAILY_DAYS;  // Full history for SMA(360), cumret(252), etc.
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
  // Full history for SMA(360), cumret(252), etc.
  const { intradayData, dailyData } = await fetchAllData(tickers, CONFIG.MAX_INTRADAY_DAYS, CONFIG.MAX_DAILY_DAYS);

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
        let combinedResult;
        if (isCompoundCondition(cond)) {
          // Compound condition (ANY/ALL): evaluate each sub-condition and collect results
          const { operator, conditions: subConds } = cond.condition;
          const opLabel = operator === 'any' ? 'ANY' : 'ALL';
          const subResults = [];

          for (let si = 0; si < subConds.length; si++) {
            const sub = subConds[si];
            // Handle nested compound conditions (ANY of ALLs, etc.)
            if (sub['condition-type'] === 'compound' || (sub.operator && sub.conditions)) {
              const nestedOp = sub.operator;
              const nestedLabel = nestedOp === 'any' ? 'ANY' : 'ALL';
              const nestedResult = evalCompoundSubRecursive(sub, dailyData, intradayData, date, time, false);
              conditions.push({
                path: currentPath.join(' > '),
                condition: `[${opLabel} ${si + 1}/${subConds.length}] Nested [${nestedLabel}] (${sub.conditions.length} sub-conditions)`,
                lhsValue: null,
                rhsValue: null,
                result: nestedResult,
                margin: null,
                branchTaken: null,
                _compoundOperator: operator,
                _compoundIndex: si
              });
              subResults.push(nestedResult);
              continue;
            }
            const flatSub = flattenCompoundSubCondition(sub);
            if (!flatSub) { subResults.push(null); continue; }
            const v = evalCondVerbose(flatSub, dailyData, intradayData, date, time);

            let margin = null;
            if (v.lhsValue !== null && v.rhsValue !== null) {
              const diff = v.lhsValue - v.rhsValue;
              const base = Math.abs(v.rhsValue) > 0.0001 ? Math.abs(v.rhsValue) : 1;
              margin = (diff / base) * 100;
            }

            conditions.push({
              path: currentPath.join(' > '),
              condition: `[${opLabel} ${si + 1}/${subConds.length}] ${formatConditionString(v)}`,
              lhsValue: v.lhsValue,
              rhsValue: v.rhsValue,
              result: v.evalResult,
              margin,
              branchTaken: null, // Individual sub-conditions don't determine branch
              _compoundOperator: operator,
              _compoundIndex: si
            });
            subResults.push(v.evalResult);
          }

          // Three-valued logic: short-circuit before considering nulls
          const hasNull = subResults.some(s => s === null);
          if (operator === 'any') {
            if (subResults.some(s => s === true)) combinedResult = true;
            else combinedResult = hasNull ? null : false;
          } else { // 'all'
            if (subResults.some(s => s === false)) combinedResult = false;
            else combinedResult = hasNull ? null : true;
          }

          // Push a summary entry for the combined result
          conditions.push({
            path: currentPath.join(' > '),
            condition: `[${opLabel} combined] ${subConds.length} sub-conditions`,
            lhsValue: null,
            rhsValue: null,
            result: combinedResult,
            margin: null,
            branchTaken: combinedResult === true ? 'THEN' : 'ELSE',
            _compoundSummary: true
          });
        } else {
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
            margin = (diff / base) * 100;
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
          combinedResult = v.evalResult;
        }

        // Continue walking the taken branch
        if (combinedResult === true && cond.children) {
          cond.children.forEach((child, i) => walk(child, [...currentPath, `THEN[${i}]`]));
        } else if ((combinedResult === false || combinedResult === null) && els?.children) {
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

    // Use authenticated endpoint for private strategies, public for shared ones
    const useAuth = hasComposerKeys();
    const apiPath = useAuth
      ? `/api/v2/symphonies/${symphonyId}/backtest`
      : `/api/v2/public/symphonies/${symphonyId}/backtest`;
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData),
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0'
    };
    if (useAuth) {
      headers['x-api-key-id'] = CONFIG.composer.keyId;
      headers['Authorization'] = `Bearer ${CONFIG.composer.secret}`;
      headers['x-origin'] = 'public-api';
    }
    const options = {
      hostname: 'backtest-api.composer.trade',
      port: 443,
      path: apiPath,
      method: 'POST',
      headers,
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

  clearMemoCache(); clearSortedKeysCache();  // Clear caches for fresh analysis

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

  const useAlpaca = hasAlpacaKeys() && CONFIG.dataSource !== 'yahoo';
  const maxDays = useAlpaca ? CONFIG.MAX_INTRADAY_DAYS_ALPACA : CONFIG.MAX_INTRADAY_DAYS_YAHOO;
  const sourceLabel = useAlpaca ? 'Alpaca' : 'Yahoo Finance';

  if (useAlpaca) {
    console.log(`
Date Range Options (${sourceLabel} - extended intraday history):
  1. Maximum available (~${maxDays} days / ~${Math.floor(maxDays * 5 / 7)} trading days)
  2. Last 365 days (~250 trading days)
  3. Last 180 days (~125 trading days)
  4. Last 60 days (~40 trading days)
  5. Last 30 days (~20 trading days)
  6. Last 14 days (~10 trading days)${oosDays && oosDays <= maxDays ? `
  7. From OOS date (${oosDays} days)` : ''}
  8. Custom number of days
`);
  } else {
    console.log(`
Date Range Options (${sourceLabel} - intraday limited to ~60 days):
  1. Maximum available (${maxDays} days / ~40 trading days)
  2. Last 30 days (~20 trading days)
  3. Last 14 days (~10 trading days)${oosDays && oosDays <= maxDays ? `
  4. From OOS date (${oosDays} days)` : ''}
  5. Custom number of days
`);
  }

  const choice = await ask(r, 'Select [1]: ');

  if (useAlpaca) {
    switch (choice) {
      case '2': return 365;
      case '3': return 180;
      case '4': return 60;
      case '5': return 30;
      case '6': return 14;
      case '7':
        if (oosDays && oosDays <= maxDays) return oosDays;
        console.log('OOS date too old, using max');
        return maxDays;
      case '8': {
        const custom = await ask(r, `Enter days (max ${maxDays}): `);
        const d = parseInt(custom);
        if (d && d > 0) return Math.min(d, maxDays);
        return 30;
      }
      case '1':
      default:
        return maxDays;
    }
  } else {
    switch (choice) {
      case '2': return 30;
      case '3': return 14;
      case '4':
        if (oosDays && oosDays <= maxDays) return oosDays;
        console.log('OOS date too old, using max');
        return maxDays;
      case '5': {
        const custom = await ask(r, `Enter days (max ${maxDays}): `);
        const d = parseInt(custom);
        if (d && d > 0) return Math.min(d, maxDays);
        return 30;
      }
      case '1':
      default:
        return maxDays;
    }
  }
}

// ============================================================================
// API KEY CONFIGURATION
// ============================================================================

async function configureApiKeysMenu(r) {
  const currentSource = CONFIG.dataSource;
  const hasKeys = hasAlpacaKeys();
  const hasComposer = hasComposerKeys();

  console.log(`
  API KEY CONFIGURATION
  ${'─'.repeat(50)}
  Current data source: ${currentSource}
  Alpaca keys:   ${hasKeys ? 'Configured' : 'Not configured'}
  Composer keys:  ${hasComposer ? 'Configured' : 'Not configured'}
  Config file: ${CONFIG_FILE}
  ${'─'.repeat(50)}

  1. Enter Alpaca API Key + Secret
  2. Switch to Yahoo-only mode
  3. Switch to Alpaca (auto-fallback to Yahoo)
  4. Enter Composer API Keys
  5. Import Composer keys from Rainboy Backtester
  6. Back
`);

  const choice = await ask(r, '  Select: ');

  switch (choice) {
    case '1': {
      const apiKey = await ask(r, '  Alpaca API Key (PK...): ');
      if (!apiKey) { console.log('  Cancelled.'); return; }
      const apiSecret = await ask(r, '  Alpaca API Secret: ');
      if (!apiSecret) { console.log('  Cancelled.'); return; }

      CONFIG.alpaca = { ...CONFIG.alpaca, apiKey, apiSecret, dataSource: 'auto' };
      CONFIG.dataSource = 'auto';
      CONFIG.MAX_INTRADAY_DAYS = CONFIG.MAX_INTRADAY_DAYS_ALPACA;
      saveConfig(CONFIG.alpaca);
      console.log(`\n  Keys saved to ${CONFIG_FILE}`);
      console.log('  Data source: auto (Alpaca with Yahoo fallback)');
      console.log(`  Max intraday days: ${CONFIG.MAX_INTRADAY_DAYS}`);
      break;
    }
    case '2': {
      CONFIG.dataSource = 'yahoo';
      CONFIG.MAX_INTRADAY_DAYS = CONFIG.MAX_INTRADAY_DAYS_YAHOO;
      if (CONFIG.alpaca) {
        CONFIG.alpaca.dataSource = 'yahoo';
        saveConfig(CONFIG.alpaca);
      }
      console.log('\n  Switched to Yahoo-only mode.');
      console.log(`  Max intraday days: ${CONFIG.MAX_INTRADAY_DAYS}`);
      break;
    }
    case '3': {
      if (!hasKeys) {
        console.log('\n  No Alpaca keys configured. Enter keys first (option 1).');
        return;
      }
      CONFIG.dataSource = 'auto';
      CONFIG.MAX_INTRADAY_DAYS = CONFIG.MAX_INTRADAY_DAYS_ALPACA;
      CONFIG.alpaca.dataSource = 'auto';
      saveConfig(CONFIG.alpaca);
      console.log('\n  Switched to Alpaca (auto-fallback to Yahoo).');
      console.log(`  Max intraday days: ${CONFIG.MAX_INTRADAY_DAYS}`);
      break;
    }
    case '4': {
      const keyId = await ask(r, '  Composer API Key ID: ');
      if (!keyId) { console.log('  Cancelled.'); return; }
      const secret = await ask(r, '  Composer API Secret: ');
      if (!secret) { console.log('  Cancelled.'); return; }

      CONFIG.composer = { keyId, secret };
      saveConfig({ ...CONFIG.alpaca, composerKeyId: keyId, composerSecret: secret });
      _composerCache.portfolio = null;
      _composerCache.watchlist = null;
      console.log(`\n  Composer keys saved to ${CONFIG_FILE}`);

      // Quick validation
      try {
        console.log('  Validating...');
        const wl = await getComposerWatchlist();
        console.log(`  Success! Found ${wl.length} watchlist strategies.`);
      } catch (e) {
        console.log(`  Warning: Could not validate keys: ${e.message}`);
        console.log('  Keys saved anyway - check if they are correct.');
      }
      break;
    }
    case '5': {
      const rainboyConfigPath = path.join(__dirname, '..', 'Rainboy Backtester', 'config', 'gui-settings.json');
      try {
        if (!fs.existsSync(rainboyConfigPath)) {
          console.log(`\n  Rainboy config not found at:\n  ${rainboyConfigPath}`);
          return;
        }
        const rainboyConfig = JSON.parse(fs.readFileSync(rainboyConfigPath, 'utf8'));
        const keyId = rainboyConfig.composerKeyId;
        const secret = rainboyConfig.composerSecret;

        if (!keyId || !secret) {
          console.log('\n  Rainboy config found but no Composer keys in it.');
          return;
        }

        CONFIG.composer = { keyId, secret };
        saveConfig({ ...CONFIG.alpaca, composerKeyId: keyId, composerSecret: secret });
        _composerCache.portfolio = null;
        _composerCache.watchlist = null;
        console.log(`\n  Imported Composer keys from Rainboy Backtester config.`);
        console.log(`  Key ID: ${keyId.slice(0, 8)}...`);
        console.log(`  Saved to ${CONFIG_FILE}`);

        // Quick validation
        try {
          console.log('  Validating...');
          const wl = await getComposerWatchlist();
          console.log(`  Success! Found ${wl.length} watchlist strategies.`);
        } catch (e) {
          console.log(`  Warning: Could not validate keys: ${e.message}`);
        }
      } catch (e) {
        console.log(`\n  Error reading Rainboy config: ${e.message}`);
      }
      break;
    }
    default:
      return;
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

     INTRADAY EXECUTION ANALYZER FOR COMPOSER  v2.0 (Alpaca Edition)

     Data: ${hasAlpacaKeys() ? 'Alpaca Markets (extended history)' : 'Yahoo Finance (60-day limit)'}
     Mode: ${CONFIG.dataSource === 'auto' ? 'Auto (Alpaca w/ Yahoo fallback)' : CONFIG.dataSource}

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

  3. COMBINED ANALYSIS (Dual + Single + Cash)
     Runs all three analyses and recommends the best approach considering
     return improvement AND drawdown risk.

  c. CASH-AT-TIME ANALYSIS
     "Should I go to cash midday and re-enter at EOD (${CONFIG.EOD_TIME})?"
     Simulates liquidating to cash at a morning time, then letting
     Composer re-enter positions at EOD automated rebalance.

${'─'.repeat(70)}
  SIGNAL SUB-ANALYSIS:
${'─'.repeat(70)}

  4. Signal Flip Frequency  - How often do signals differ morning vs EOD?
  5. Holdings Check by Date - What holdings at each time on a given day?

${'─'.repeat(70)}
  DEBUGGING:
${'─'.repeat(70)}

  6. Indicator Validation   - Debug indicator values vs Composer (trace mode)

${'─'.repeat(70)}
  SETTINGS:
${'─'.repeat(70)}

  7. Change EOD Time        - Currently: ${CONFIG.EOD_TIME} ${CONFIG.EOD_TIME === '16:00' ? '(Market Close)' : '(Intraday)'}
  8. Configure API Keys     - ${hasAlpacaKeys() ? 'Alpaca ✓' : 'No Alpaca keys'} | ${hasComposerKeys() ? 'Composer ✓' : 'No Composer keys'}
  9. Debug Compare          - Compare Alpaca vs Yahoo data side-by-side
  10. Intraday Bar Size      - Currently: ${CONFIG.ALPACA_TIMEFRAME} ${CONFIG.ALPACA_TIMEFRAME === '15Min' ? '(Fast)' : CONFIG.ALPACA_TIMEFRAME === '5Min' ? '(Precise)' : '(Max precision)'}

${'─'.repeat(70)}
  q. Quit
`);

    const choice = await ask(r, 'Select: ');

    try {
      switch (choice) {
        case '1': {
          console.log('\nDUAL TRADE TIME ANALYSIS');
          const ids = await askSymphonyIds(r, 'dual analysis');

          if (ids.length === 0) break;

          const days = await askDateRange(r, ids[0]);
          const results = await dualTimeAnalysis(ids, days);
          printDualTimeResults(results);
          break;
        }

        case '2': {
          console.log('\nSINGLE TIME REPLACEMENT ANALYSIS');
          const ids = await askSymphonyIds(r, 'single time analysis');

          if (ids.length === 0) break;

          const days = await askDateRange(r, ids[0]);
          const results = await singleTimeAnalysis(ids, days);
          printSingleTimeResults(results);
          break;
        }

        case '3': {
          console.log('\nCOMBINED ANALYSIS (Dual + Single + Cash)');
          const ids = await askSymphonyIds(r, 'combined analysis');

          if (ids.length === 0) break;

          const days = await askDateRange(r, ids[0]);
          const results = await combinedAnalysis(ids, days);
          printCombinedResults(results);
          break;
        }

        case 'c': {
          console.log('\nCASH-AT-TIME ANALYSIS');
          const ids = await askSymphonyIds(r, 'cash-at-time analysis');

          if (ids.length === 0) break;

          const days = await askDateRange(r, ids[0]);
          const results = await cashTimeAnalysis(ids, days);
          printCashTimeResults(results);
          break;
        }

        case '4': {
          console.log('\nSIGNAL FLIP FREQUENCY');
          const ids = await askSymphonyIds(r, 'flip analysis');
          const id = ids[0];
          if (id) {
            const days = await askDateRange(r, id);
            await flipAnalysis(id, days);
          }
          break;
        }

        case '5': {
          console.log('\nHOLDINGS CHECK BY DATE');
          const ids = await askSymphonyIds(r, 'holdings check');
          const id = ids[0];
          if (id) await dailyCheck(id, r);
          break;
        }

        case '6': {
          console.log('\nINDICATOR VALIDATION');
          const ids = await askSymphonyIds(r, 'indicator validation');
          const id = ids[0];
          if (id) await indicatorValidationMode(id, r);
          break;
        }

        case '7': {
          console.log('\n  EOD TIME SETTINGS');
          console.log('  ─────────────────────────────────────────────────────');
          console.log('  Composer executes trades between 3:45-4:00 PM ET.');
          // In 15-min mode, only 15:45 and 16:00 produce different prices
          const eodOptions = CONFIG.ALPACA_TIMEFRAME === '1Min'
            ? ['15:44', '15:45', '15:50', '15:53', '15:55', '16:00']
            : CONFIG.ALPACA_TIMEFRAME === '5Min'
              ? ['15:45', '15:50', '15:55', '16:00']
              : ['15:45', '16:00'];
          if (CONFIG.ALPACA_TIMEFRAME === '15Min') {
            console.log('  (Using 15-min bars — only 15:45 and 16:00 are distinct. Switch to 5-min/1-min for finer control.)\n');
          } else if (CONFIG.ALPACA_TIMEFRAME === '5Min') {
            console.log('  (Using 5-min bars — all listed options produce distinct prices.)\n');
          } else {
            console.log('  (Using 1-min bars — minute-level precision available.)\n');
          }
          console.log('  Options:');
          eodOptions.forEach((t, i) => {
            const current = t === CONFIG.EOD_TIME ? ' ◀ CURRENT' : '';
            const desc = t === '15:45' ? '(Alpaca 15:45 bar open — Composer starts executing)' :
                        t === '15:50' ? '(Alpaca 15:50 bar open — mid-execution window)' :
                        t === '15:55' ? '(Alpaca 15:55 bar open — near end of window)' :
                        t === '16:00' ? '(Yahoo daily close — official market close)' :
                        t === '16:00a' ? '(Alpaca bar close — Alpaca market close)' : '';
            console.log(`    ${i + 1}. ${t} ${desc}${current}`);
          });
          console.log('');
          const eodChoice = await ask(r, `  Select EOD time [1-${eodOptions.length}]: `);
          const idx = parseInt(eodChoice) - 1;
          if (idx >= 0 && idx < eodOptions.length) {
            CONFIG.EOD_TIME = eodOptions[idx];
            console.log(`\n  ✓ EOD time set to ${CONFIG.EOD_TIME}`);
          } else {
            console.log('\n  No change made.');
          }
          break;
        }

        case '8': {
          await configureApiKeysMenu(r);
          break;
        }

        case '9': {
          if (!hasAlpacaKeys()) {
            console.log('\n  Debug compare requires Alpaca API keys. Configure them first (option 8).');
            break;
          }
          console.log('\nDEBUG COMPARE: Alpaca vs Yahoo');
          const ids9 = await askSymphonyIds(r, 'debug compare');
          const id9 = ids9[0];
          if (!id9) break;
          const { score, name } = await getSymphony(id9);
          console.log(`  Strategy: ${name}`);
          const tickers = [...extractTickers(score)].map(normalizeTicker);
          console.log(`  Tickers: ${tickers.join(', ')}`);
          await debugCompareData(tickers, CONFIG.MAX_INTRADAY_DAYS_YAHOO);
          break;
        }

        case '10': {
          console.log('\n  INTRADAY BAR SIZE');
          console.log('  ─────────────────────────────────────────────────────');
          console.log('  Controls the resolution of intraday price data.\n');
          const barOptions = [
            { tf: '15Min', label: '15-min bars (Fast)', desc: '3x fewer API calls, all test times except 09:35 are exact' },
            { tf: '5Min',  label: '5-min bars (Precise)', desc: 'Maximum granularity for standard analysis, ~3x slower' },
            { tf: '1Min',  label: '1-min bars (Max precision)', desc: 'Minute-level resolution, ~15x slower than 15-min, longer first-run fetch' },
          ];
          barOptions.forEach((opt, i) => {
            const current = opt.tf === CONFIG.ALPACA_TIMEFRAME ? ' ◀ CURRENT' : '';
            console.log(`    ${i + 1}. ${opt.label}${current}`);
            console.log(`       ${opt.desc}`);
          });
          console.log('');
          const barChoice = await ask(r, `  Select [1-${barOptions.length}]: `);
          const barIdx = parseInt(barChoice) - 1;
          if (barIdx >= 0 && barIdx < barOptions.length) {
            CONFIG.ALPACA_TIMEFRAME = barOptions[barIdx].tf;
            console.log(`\n  ✓ Intraday bars set to ${CONFIG.ALPACA_TIMEFRAME}`);
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

  // Parse flags
  const flags = args.filter(a => a.startsWith('--'));
  const filteredArgs = args.filter(a => !a.startsWith('--'));

  // Handle flags (--days processed last so it takes priority over --source)
  let cliDays = null;
  for (const flag of flags) {
    if (flag.startsWith('--source=')) {
      const src = flag.split('=')[1];
      if (['alpaca', 'yahoo', 'auto', 'hybrid'].includes(src)) {
        CONFIG.dataSource = src;
        if (src === 'yahoo') {
          CONFIG.MAX_INTRADAY_DAYS = CONFIG.MAX_INTRADAY_DAYS_YAHOO;
        } else if ((src === 'alpaca' || src === 'hybrid') && hasAlpacaKeys()) {
          CONFIG.MAX_INTRADAY_DAYS = CONFIG.MAX_INTRADAY_DAYS_ALPACA;
        }
      }
    }
    if (flag === '--debug-compare') {
      CONFIG.debugCompare = true;
    }
    if (flag === '--debug-invvol') {
      CONFIG.debugInverseVol = true;
    }
    if (flag === '--debug-filter') {
      CONFIG.debugFilter = true;
    }
    if (flag.startsWith('--days=')) {
      const d = parseInt(flag.split('=')[1]);
      if (d > 0) cliDays = d;
    }
    if (flag.startsWith('--eod=')) {
      const eod = flag.split('=')[1];
      if (CONFIG.EOD_TIME_OPTIONS.includes(eod)) {
        CONFIG.EOD_TIME = eod;
      }
    }
    if (flag === '--walkforward' || flag === '--wf') {
      CONFIG.walkforward = true;
    }
    if (flag === '--oos-wf' || flag === '--oos') {
      CONFIG.oosWalkforward = true;
    }
    if (flag === '--composer-baseline' || flag === '--cb') {
      CONFIG.composerBaseline = true;
    }
    if (flag.startsWith('--window=')) {
      CONFIG.wfWindowSize = parseInt(flag.split('=')[1]) || 21;
    }
    if (flag.startsWith('--step=')) {
      CONFIG.wfStepSize = parseInt(flag.split('=')[1]) || 21;
    }
    if (flag.startsWith('--oos-train=')) {
      CONFIG.oosTrainWindowSize = parseInt(flag.split('=')[1]) || 63;
    }
    if (flag.startsWith('--wf-candidates=')) {
      CONFIG.wfMaxCandidates = parseInt(flag.split('=')[1]) || 10;
    }
    if (flag.startsWith('--start=')) {
      const d = flag.split('=')[1];
      if (/^\d{4}-\d{2}-\d{2}$/.test(d)) CONFIG.dateStart = d;
    }
    if (flag.startsWith('--end=')) {
      const d = flag.split('=')[1];
      if (/^\d{4}-\d{2}-\d{2}$/.test(d)) CONFIG.dateEnd = d;
    }
  }
  // Apply --days after --source so it always wins
  if (cliDays) {
    CONFIG.MAX_INTRADAY_DAYS = Math.min(cliDays, CONFIG.MAX_INTRADAY_DAYS);
  }

  if (filteredArgs.length === 0) {
    await menu();
    return;
  }

  const cmd = filteredArgs[0].toLowerCase();
  const ids = filteredArgs.slice(1).filter(a => !a.startsWith('-'));

  try {
    switch (cmd) {
      case 'config': {
        const r = rl();
        await configureApiKeysMenu(r);
        r.close();
        break;
      }

      case 'dual':
        if (ids.length === 0) {
          console.log('Usage: node script.js dual <symphony_id> [id2] [id3]...');
          return;
        }
        if (CONFIG.debugCompare && hasAlpacaKeys()) {
          const { score } = await getSymphony(ids[0]);
          const tickers = [...extractTickers(score)].map(normalizeTicker);
          await debugCompareData(tickers, CONFIG.MAX_INTRADAY_DAYS_YAHOO);
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

      case 'combined':
        if (ids.length === 0) {
          console.log('Usage: node script.js combined <symphony_id> [id2] [id3]...');
          return;
        }
        const combinedResults = await combinedAnalysis(ids, CONFIG.MAX_INTRADAY_DAYS);
        printCombinedResults(combinedResults);
        break;

      case 'cash':
        if (ids.length === 0) {
          console.log('Usage: node script.js cash <symphony_id> [id2] [id3]...');
          return;
        }
        const cashResults = await cashTimeAnalysis(ids, CONFIG.MAX_INTRADAY_DAYS);
        printCashTimeResults(cashResults);
        break;

      case 'walkforward':
      case 'wf':
        if (ids.length === 0) {
          console.log('Usage: node script.js walkforward <id> [id2] [--window=21] [--step=21]');
          return;
        }
        CONFIG.walkforward = true;
        // Default to 5min for precision if not already set
        if (!flags.some(f => f === '--5min' || f.startsWith('--source='))) {
          CONFIG.ALPACA_TIMEFRAME = '5Min';
          CONFIG.MAX_INTRADAY_DAYS = CONFIG.MAX_INTRADAY_DAYS_ALPACA;
        }
        const wfResults = await dualTimeAnalysis(ids, CONFIG.MAX_INTRADAY_DAYS);
        printDualTimeResults(wfResults);
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

      case 'holdings': {
        // Non-interactive holdings dump for debugging
        if (ids.length === 0) {
          console.log('Usage: node script.js holdings <symphony_id> [--days=N] [--source=alpaca|yahoo]');
          return;
        }
        const hId = ids[0];
        const { score: hScore, name: hName } = await getSymphony(hId);
        console.log(`Strategy: ${hName}`);
        const hTickers = Array.from(extractTickers(hScore));
        console.log(`Tickers (${hTickers.length}): ${hTickers.join(', ')}`);
        const hDailyDays = CONFIG.MAX_DAILY_DAYS; // Need full history for SMA(309), SMA(360), etc.
        const { intradayData: hIntra, dailyData: hDaily } = await fetchAllData(hTickers, CONFIG.MAX_INTRADAY_DAYS, hDailyDays);

        // Report data coverage
        const hLoadedIntra = Object.keys(hIntra).length;
        const hLoadedDaily = Object.keys(hDaily).length;
        const hMissingIntra = hTickers.filter(t => !hIntra[t] || Object.keys(hIntra[t]).length === 0);
        const hMissingDaily = hTickers.filter(t => !hDaily[t] || Object.keys(hDaily[t]).length === 0);
        console.log(`Data loaded: ${hLoadedIntra}/${hTickers.length} intraday, ${hLoadedDaily}/${hTickers.length} daily`);
        if (hMissingIntra.length > 0) console.log(`  Missing intraday: ${hMissingIntra.join(', ')}`);
        if (hMissingDaily.length > 0) console.log(`  Missing daily: ${hMissingDaily.join(', ')}`);

        // Show daily close prices for a few key tickers on recent dates for comparison
        const hTradingDays = getTradingDays(hIntra);
        const hRecentDays = hTradingDays.slice(-5);
        console.log(`\nTrading days: ${hTradingDays.length} (${hTradingDays[0]} to ${hTradingDays[hTradingDays.length-1]})`);

        // Sample daily closes for first 5 tickers
        const sampleTickers = hTickers.slice(0, 5);
        console.log(`\nDaily close prices (sample: ${sampleTickers.join(', ')}):`);
        console.log('  Date       | ' + sampleTickers.map(t => t.padEnd(10)).join(' | '));
        console.log('  ' + '-'.repeat(14 + sampleTickers.length * 13));
        for (const d of hRecentDays) {
          const prices = sampleTickers.map(t => {
            const p = hDaily[t]?.byDate?.[d]?.close;
            return p != null ? p.toFixed(2).padStart(10) : '       N/A';
          });
          console.log(`  ${d} | ${prices.join(' | ')}`);
        }

        // Compute and display holdings for each recent day at EOD
        console.log(`\nHoldings at ${CONFIG.EOD_TIME} (EOD):`);
        console.log('-'.repeat(80));
        for (const d of hRecentDays) {
          clearMemoCache(); clearSortedKeysCache();
          DIAGNOSTICS.reset();
          const assets = getAssetsWithWeights(hScore, hDaily, hIntra, d, CONFIG.EOD_TIME);
          const holdStr = assets.length > 0
            ? assets.map(a => `${a.ticker}(${(a.weight*100).toFixed(0)}%)`).join(', ')
            : '(no signal)';
          console.log(`  ${d}: ${holdStr}`);
        }

        // Also show holdings at 09:30 and 10:30 for comparison
        for (const time of ['09:30', '10:30']) {
          console.log(`\nHoldings at ${time}:`);
          console.log('-'.repeat(80));
          for (const d of hRecentDays) {
            clearMemoCache(); clearSortedKeysCache();
            const assets = getAssetsWithWeights(hScore, hDaily, hIntra, d, time);
            const holdStr = assets.length > 0
              ? assets.map(a => `${a.ticker}(${(a.weight*100).toFixed(0)}%)`).join(', ')
              : '(no signal)';
            console.log(`  ${d}: ${holdStr}`);
          }
        }
        break;
      }

      case 'return-debug': {
        // Day-by-day EOD backtest trace showing holdings, prices, returns
        if (ids.length === 0) {
          console.log('Usage: node script.js return-debug <symphony_id> [--days=N] [--source=alpaca|yahoo]');
          return;
        }
        const rdId = ids[0];
        const { score: rdScore, name: rdName } = await getSymphony(rdId);
        console.log(`Strategy: ${rdName} (${rdId})`);
        console.log(`Source: ${CONFIG.dataSource}`);
        const rdTickers = Array.from(extractTickers(rdScore));
        console.log(`Tickers (${rdTickers.length}): ${rdTickers.join(', ')}`);
        const rdDailyDays = CONFIG.MAX_DAILY_DAYS; // Need full history for SMA(309), SMA(360), etc.
        const { intradayData: rdIntra, dailyData: rdDaily } = await fetchAllData(rdTickers, CONFIG.MAX_INTRADAY_DAYS, rdDailyDays);

        const rdTradingDays = getTradingDays(rdIntra);
        console.log(`Trading days: ${rdTradingDays.length} (${rdTradingDays[0]} to ${rdTradingDays[rdTradingDays.length-1]})`);

        // Run EOD-only backtest with verbose trace
        let rdEquity = 100;
        let rdPeak = 100;
        let rdMaxDD = 0;
        let rdHoldings = [];

        console.log('\n' + 'DAY-BY-DAY EOD BACKTEST TRACE'.padStart(50));
        console.log('='.repeat(100));
        console.log(`${'Day'.padEnd(4)} ${'Date'.padEnd(12)} ${'Holdings'.padEnd(30)} ${'PrevEOD'.padEnd(10)} ${'CurrEOD'.padEnd(10)} ${'DayRet'.padEnd(10)} ${'Equity'.padEnd(10)} ${'DD'.padEnd(8)}`);
        console.log('-'.repeat(100));

        for (let i = 0; i < rdTradingDays.length; i++) {
          const date = rdTradingDays[i];
          const prevDate = i > 0 ? rdTradingDays[i - 1] : null;

          clearMemoCache(); clearSortedKeysCache();
          DIAGNOSTICS.reset();
          const selection = getAssetsWithWeights(rdScore, rdDaily, rdIntra, date, CONFIG.EOD_TIME);

          if (prevDate && rdHoldings.length > 0) {
            let dayReturn = 0;
            let totalWeight = 0;
            const priceDetails = [];
            for (const h of rdHoldings) {
              const prevEOD = getIntradayPrice(h.ticker, rdIntra, prevDate, CONFIG.EOD_TIME, rdDaily);
              const currEOD = getIntradayPrice(h.ticker, rdIntra, date, CONFIG.EOD_TIME, rdDaily);
              if (prevEOD && currEOD) {
                const ret = h.weight * (currEOD - prevEOD) / prevEOD;
                dayReturn += ret;
                totalWeight += h.weight;
                priceDetails.push(`${h.ticker}:${prevEOD.toFixed(2)}->${currEOD.toFixed(2)}(${(ret*100).toFixed(2)}%)`);
              } else {
                priceDetails.push(`${h.ticker}:NULL(prev=${prevEOD},curr=${currEOD})`);
              }
            }
            if (totalWeight > 0) {
              rdEquity *= (1 + dayReturn / totalWeight);
            }

            if (rdEquity > rdPeak) rdPeak = rdEquity;
            const dd = (rdPeak - rdEquity) / rdPeak * 100;
            if (dd > rdMaxDD) rdMaxDD = dd;

            const holdStr = rdHoldings.map(h => `${h.ticker}(${(h.weight*100).toFixed(0)}%)`).join(',');
            console.log(`${String(i).padEnd(4)} ${date.padEnd(12)} ${holdStr.padEnd(30)} ${priceDetails.join(' | ')}`);
            console.log(`${''.padEnd(46)} DayRet: ${(dayReturn*100).toFixed(3)}%  Equity: ${rdEquity.toFixed(2)}  DD: ${dd.toFixed(1)}%`);
          } else if (i === 0) {
            console.log(`${String(i).padEnd(4)} ${date.padEnd(12)} (first day - no return)`);
          }

          rdHoldings = selection; // Empty selection = cash signal

          // Log new selection
          const selStr = selection.map(a => `${a.ticker}(${(a.weight*100).toFixed(0)}%)`).join(',');
          console.log(`${''.padEnd(17)} -> EOD selection: ${selStr}`);
        }

        console.log('='.repeat(100));
        console.log(`FINAL: CumReturn=${(rdEquity-100).toFixed(2)}%  MaxDD=${rdMaxDD.toFixed(2)}%  Days=${rdTradingDays.length}`);
        break;
      }

      case 'validate':
        if (ids.length === 0) {
          console.log('Usage: node script.js validate <symphony_id>');
          return;
        }
        await indicatorValidationMode(ids[0], rl());
        break;

      case 'portfolio': {
        if (!hasComposerKeys()) {
          console.log('Composer API keys not configured. Run: node script.js config');
          return;
        }
        console.log('\nFetching portfolio...');
        const portfolio = await getComposerPortfolio();
        portfolio.sort((a, b) => (b.value || 0) - (a.value || 0));
        console.log(`\nYour Portfolio (${portfolio.length} strategies):`);
        console.log('─'.repeat(65));
        portfolio.forEach((s, i) => {
          const num = String(i + 1).padStart(3);
          const name = s.name.length > 45 ? s.name.slice(0, 42) + '...' : s.name.padEnd(45);
          const val = s.value != null ? `$${s.value.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}` : '';
          console.log(`${num}. ${name}  ${val}  [${s.id}]`);
        });
        break;
      }

      case 'watchlist': {
        if (!hasComposerKeys()) {
          console.log('Composer API keys not configured. Run: node script.js config');
          return;
        }
        console.log('\nFetching watchlist...');
        const watchlist = await getComposerWatchlist();
        watchlist.sort((a, b) => a.name.localeCompare(b.name));
        console.log(`\nYour Watchlist (${watchlist.length} strategies):`);
        console.log('─'.repeat(70));
        watchlist.forEach((s, i) => {
          const num = String(i + 1).padStart(3);
          const name = s.name.length > 45 ? s.name.slice(0, 42) + '...' : s.name.padEnd(45);
          const sharpe = s.sharpe != null ? `Sharpe: ${s.sharpe.toFixed(2)}` : '';
          console.log(`${num}. ${name}  ${sharpe.padEnd(12)}  [${s.id}]`);
        });
        break;
      }

      case 'live-holdings': {
        // Show live holdings from Composer for all portfolio strategies
        if (!hasComposerKeys()) {
          console.log('Composer API keys not configured. Run: node script.js config');
          return;
        }

        const lhPredict = process.argv.includes('--predict');
        console.log('\nFetching portfolio from Composer...');
        const lhPortfolio = await getComposerPortfolio();
        const lhFilterArg = (process.argv.find(a => a.startsWith('--ids=')) || '').split('=')[1] || '';
        const lhFilterIds = lhFilterArg ? lhFilterArg.split(',') : null;
        const lhFiltered = lhFilterIds ? lhPortfolio.filter(s => lhFilterIds.includes(s.id)) : lhPortfolio;

        // Fetch total portfolio stats
        const totalStats = await getPortfolioTotalStats();
        const portfolioValue = totalStats.portfolio_value ? parseFloat(totalStats.portfolio_value) : null;
        console.log(`Portfolio: ${lhFiltered.length} strategies` +
          (portfolioValue ? `, total value: $${portfolioValue.toLocaleString('en-US', { maximumFractionDigits: 0 })}` : ''));

        console.log('\n' + '='.repeat(100));
        console.log('  LIVE HOLDINGS FROM COMPOSER' + (lhPredict ? ' (with predictions)' : ''));
        console.log('='.repeat(100));

        const lhResults = [];

        for (let i = 0; i < lhFiltered.length; i++) {
          const { id: lhId, name: lhName, value: lhValue } = lhFiltered[i];
          console.log(`\n[${i + 1}/${lhFiltered.length}] ${lhName.slice(0, 55)}`);

          const liveData = await getLiveSymphonyHoldings(lhId);
          const liveTickers = liveData.shares ? Object.keys(liveData.shares).sort() : [];
          const liveShares = liveData.shares || {};
          const cash = parseFloat(liveData.cash || 0);
          const rebalDate = liveData.last_rebalance_on || '?';

          let predictedTickers = null;
          let match = null;

          if (lhPredict) {
            try {
              const { score: pScore } = await getSymphony(lhId);
              const pTickers = Array.from(extractTickers(pScore));
              // Skip intraday — daily close fallback is used for EOD predictions (saves ~98% of API calls)
              const { intradayData: pIntra, dailyData: pDaily } = await fetchAllData(pTickers, CONFIG.MAX_INTRADAY_DAYS, CONFIG.MAX_DAILY_DAYS, false, true);
              const pTradingDays = getTradingDaysFromDaily(pDaily);
              const lastDay = pTradingDays[pTradingDays.length - 1];
              clearMemoCache(); clearSortedKeysCache();
              DIAGNOSTICS.reset();
              const pAssets = getAssetsWithWeights(pScore, pDaily, pIntra, lastDay, CONFIG.EOD_TIME);
              predictedTickers = pAssets.map(a => a.ticker).sort();

              // Compare
              const liveSet = new Set(liveTickers);
              const predSet = new Set(predictedTickers);
              const intersection = [...liveSet].filter(x => predSet.has(x));
              const union = new Set([...liveSet, ...predSet]);
              match = union.size > 0 ? (intersection.length / union.size * 100).toFixed(0) : '100';
            } catch (e) {
              predictedTickers = [`ERROR: ${e.message.slice(0, 50)}`];
            }
          }

          console.log('');
          const valStr = lhValue != null ? ` | value: $${lhValue.toLocaleString('en-US', { maximumFractionDigits: 0 })}` : '';
          console.log(`  Rebalanced: ${rebalDate}${valStr} | cash: $${cash.toFixed(2)}`);
          console.log(`  Live tickers: [${liveTickers.join(', ')}]`);

          // Show shares
          if (liveTickers.length > 0) {
            const shareStr = liveTickers.map(t => `${t}:${parseFloat(liveShares[t]).toFixed(2)}`).join(', ');
            console.log(`  Shares: ${shareStr}`);
          }

          if (lhPredict && predictedTickers) {
            console.log(`  Predicted:    [${predictedTickers.join(', ')}]`);
            if (match != null) {
              const icon = match === '100' ? 'MATCH' : parseInt(match) >= 80 ? 'CLOSE' : 'DIFF';
              console.log(`  Accuracy: ${match}% [${icon}]`);
            }
          }

          lhResults.push({ name: lhName, id: lhId, liveTickers, predictedTickers, match, rebalDate, cash });
        }

        // Summary
        if (lhPredict && lhResults.length > 1) {
          console.log('\n' + '='.repeat(100));
          console.log('  SUMMARY');
          console.log('='.repeat(100));
          let matchCount = 0, closeCount = 0, diffCount = 0, errCount = 0;
          for (const r of lhResults) {
            if (!r.match) { errCount++; continue; }
            const m = parseInt(r.match);
            if (m === 100) matchCount++;
            else if (m >= 80) closeCount++;
            else diffCount++;
          }
          console.log(`  ${matchCount} MATCH (100%) | ${closeCount} CLOSE (80-99%) | ${diffCount} DIFF (<80%) | ${errCount} ERROR`);
        }
        console.log('');
        break;
      }

      case 'live-check': {
        // Deep comparison of predicted vs actual live holdings for a single strategy
        if (!hasComposerKeys()) {
          console.log('Composer API keys not configured. Run: node script.js config');
          return;
        }
        if (ids.length === 0) {
          console.log('Usage: node script.js live-check <symphony_id>');
          return;
        }

        const lcId = ids[0];
        console.log('\nFetching live holdings from Composer...');
        const lcLive = await getLiveSymphonyHoldings(lcId);
        const lcLiveTickers = lcLive.shares ? Object.keys(lcLive.shares).sort() : [];
        const lcShares = lcLive.shares || {};

        console.log(`\nStrategy: ${lcId}`);
        console.log(`Last rebalance: ${lcLive.last_rebalance_on || '?'}`);
        console.log(`Cash: $${parseFloat(lcLive.cash || 0).toFixed(2)}`);
        console.log(`Live tickers (${lcLiveTickers.length}): [${lcLiveTickers.join(', ')}]`);

        // Get Composer's exact prices for the live tickers
        if (lcLiveTickers.length > 0) {
          console.log('\nFetching Composer prices (Xignite)...');
          const lcQuotes = await getPublicQuotes(lcLiveTickers);
          const quoteMap = {};
          for (const [qKey, qVal] of Object.entries(lcQuotes)) {
            if (qKey === '$USD') continue;
            const ticker = normalizeQuoteTicker(qKey);
            quoteMap[ticker] = qVal.price || qVal.last || qVal.close || null;
          }

          console.log('\n  ' + 'Ticker'.padEnd(8) + 'Shares'.padStart(12) + 'Price'.padStart(12) + 'Value'.padStart(14));
          console.log('  ' + '-'.repeat(46));
          let totalVal = 0;
          for (const t of lcLiveTickers) {
            const shares = parseFloat(lcShares[t] || 0);
            const price = quoteMap[t];
            const value = price ? shares * price : null;
            if (value) totalVal += value;
            console.log('  ' + t.padEnd(8) +
              shares.toFixed(4).padStart(12) +
              (price ? `$${price.toFixed(2)}` : 'N/A').padStart(12) +
              (value ? `$${value.toFixed(2)}` : 'N/A').padStart(14));
          }
          console.log('  ' + '-'.repeat(46));
          console.log('  ' + 'TOTAL'.padEnd(8) + ''.padStart(12) + ''.padStart(12) + `$${totalVal.toFixed(2)}`.padStart(14));
          console.log('  ' + '+ Cash'.padEnd(8) + ''.padStart(12) + ''.padStart(12) + `$${parseFloat(lcLive.cash || 0).toFixed(2)}`.padStart(14));
          console.log('  ' + '= Total'.padEnd(8) + ''.padStart(12) + ''.padStart(12) + `$${(totalVal + parseFloat(lcLive.cash || 0)).toFixed(2)}`.padStart(14));
        }

        // Now run our prediction
        console.log('\nRunning our tree-walk prediction...');
        const { score: lcScore, name: lcName } = await getSymphony(lcId);
        console.log(`Strategy name: ${lcName}`);
        const lcTickers = Array.from(extractTickers(lcScore));
        console.log(`Universe (${lcTickers.length}): [${lcTickers.join(', ')}]`);
        // Skip intraday — daily close fallback is used for EOD predictions (saves ~98% of API calls)
        const { intradayData: lcIntra, dailyData: lcDaily } = await fetchAllData(lcTickers, CONFIG.MAX_INTRADAY_DAYS, CONFIG.MAX_DAILY_DAYS, false, true);

        const lcTradingDays = getTradingDaysFromDaily(lcDaily);
        const lcLastDay = lcTradingDays[lcTradingDays.length - 1];
        console.log(`\nPredicting holdings for ${lcLastDay} at ${CONFIG.EOD_TIME}...`);

        clearMemoCache(); clearSortedKeysCache();
        DIAGNOSTICS.reset();
        const lcPredicted = getAssetsWithWeights(lcScore, lcDaily, lcIntra, lcLastDay, CONFIG.EOD_TIME);
        const lcPredTickers = lcPredicted.map(a => a.ticker).sort();
        const lcPredWeights = {};
        lcPredicted.forEach(a => { lcPredWeights[a.ticker] = a.weight; });

        console.log(`Predicted tickers (${lcPredTickers.length}): [${lcPredTickers.join(', ')}]`);

        if (lcPredicted.length > 0) {
          console.log('\n  ' + 'Ticker'.padEnd(8) + 'Weight'.padStart(10));
          console.log('  ' + '-'.repeat(18));
          for (const a of lcPredicted.sort((x, y) => y.weight - x.weight)) {
            console.log('  ' + a.ticker.padEnd(8) + `${(a.weight * 100).toFixed(1)}%`.padStart(10));
          }
        }

        // Compare
        const lcLiveSet = new Set(lcLiveTickers);
        const lcPredSet = new Set(lcPredTickers);
        const lcOnly = lcLiveTickers.filter(t => !lcPredSet.has(t));
        const lcPredOnly = lcPredTickers.filter(t => !lcLiveSet.has(t));
        const lcBoth = lcLiveTickers.filter(t => lcPredSet.has(t));

        console.log('\n' + '='.repeat(60));
        console.log('  COMPARISON: Live vs Predicted');
        console.log('='.repeat(60));
        console.log(`  In both:         [${lcBoth.join(', ')}]`);
        if (lcOnly.length > 0) console.log(`  Live only:       [${lcOnly.join(', ')}]`);
        if (lcPredOnly.length > 0) console.log(`  Predicted only:  [${lcPredOnly.join(', ')}]`);

        const lcUnion = new Set([...lcLiveSet, ...lcPredSet]);
        const lcJaccard = lcUnion.size > 0 ? (lcBoth.length / lcUnion.size * 100).toFixed(0) : '100';
        const lcIcon = lcJaccard === '100' ? 'PERFECT MATCH' : parseInt(lcJaccard) >= 80 ? 'CLOSE' : 'DIFFERENT';
        console.log(`  Overlap: ${lcJaccard}% [${lcIcon}]`);

        // Price comparison: Composer (Xignite) vs our source (Yahoo/Alpaca)
        if (lcBoth.length > 0) {
          console.log('\n  PRICE COMPARISON (Composer/Xignite vs Our Source):');
          const lcQuotes2 = await getPublicQuotes(lcBoth);
          console.log('  ' + 'Ticker'.padEnd(8) + 'Composer'.padStart(12) + 'Ours'.padStart(12) + 'Diff'.padStart(10));
          console.log('  ' + '-'.repeat(42));
          for (const t of lcBoth) {
            const composerPrice = (() => {
              for (const [qk, qv] of Object.entries(lcQuotes2)) {
                if (normalizeQuoteTicker(qk) === t) return qv.price || qv.last || qv.close || null;
              }
              return null;
            })();
            const ourPrice = getIntradayPrice(t, lcIntra, lcLastDay, CONFIG.EOD_TIME, lcDaily);
            const diff = composerPrice && ourPrice ? ((ourPrice - composerPrice) / composerPrice * 100) : null;
            console.log('  ' + t.padEnd(8) +
              (composerPrice ? `$${composerPrice.toFixed(2)}` : 'N/A').padStart(12) +
              (ourPrice ? `$${ourPrice.toFixed(2)}` : 'N/A').padStart(12) +
              (diff != null ? `${diff > 0 ? '+' : ''}${diff.toFixed(3)}%` : 'N/A').padStart(10));
          }
        }
        break;
      }

      case 'verify-live': {
        // Fast portfolio verification: compare live holdings vs backtest holdings (no price data needed)
        if (!hasComposerKeys()) {
          console.log('Composer API keys not configured. Run: node script.js config');
          return;
        }

        console.log('\nFetching portfolio from Composer...');
        const vlPortfolio = await getComposerPortfolio();
        const vlFilterArg = (process.argv.find(a => a.startsWith('--ids=')) || '').split('=')[1] || '';
        const vlFilterIds = vlFilterArg ? vlFilterArg.split(',') : null;
        const vlFiltered = vlFilterIds ? vlPortfolio.filter(s => vlFilterIds.includes(s.id)) : vlPortfolio;
        const vlUuid = await getAccountUUID();

        const totalStats = await getPortfolioTotalStats();
        const vlPortValue = totalStats.portfolio_value ? parseFloat(totalStats.portfolio_value) : null;
        console.log(`Portfolio: ${vlFiltered.length} strategies` +
          (vlPortValue ? `, total value: $${vlPortValue.toLocaleString('en-US', { maximumFractionDigits: 0 })}` : ''));

        console.log('\n' + '='.repeat(100));
        console.log('  LIVE vs BACKTEST HOLDINGS VERIFICATION');
        console.log('='.repeat(100));
        console.log(`  ${'#'.padEnd(4)} ${'Strategy'.padEnd(42)} ${'Rebal'.padEnd(12)} ${'Value'.padEnd(11)} ${'Live'.padEnd(20)} ${'BT'.padEnd(20)} Match`);
        console.log('  ' + '-'.repeat(95));

        let vlMatchCount = 0, vlMismatchCount = 0, vlErrCount = 0;
        const vlMismatches = [];

        for (let i = 0; i < vlFiltered.length; i++) {
          const { id: vlId, name: vlName, value: vlVal } = vlFiltered[i];

          // Fetch live holdings and backtest holdings in parallel
          const [liveData, btData] = await Promise.all([
            getLiveSymphonyHoldings(vlId),
            composerAuthRequest(`https://backtest-api.composer.trade/api/v1/symphonies/${vlId}`),
          ]);

          const liveTickers = liveData.shares ? Object.keys(liveData.shares).sort() : [];
          const btHoldings = btData.last_backtest_holdings || {};
          const btTickers = Object.entries(btHoldings)
            .filter(([t, shares]) => t !== '$USD' && shares > 0)
            .map(([t]) => t)
            .sort();

          const rebalDate = liveData.last_rebalance_on || '?';
          const valStr = vlVal != null ? `$${vlVal.toLocaleString('en-US', { maximumFractionDigits: 0 })}` : '?';
          const liveStr = liveTickers.length <= 4 ? liveTickers.join(',') : `${liveTickers.length} tickers`;
          const btStr = btTickers.length <= 4 ? btTickers.join(',') : `${btTickers.length} tickers`;
          const match = JSON.stringify(liveTickers) === JSON.stringify(btTickers);

          if (match) vlMatchCount++;
          else {
            vlMismatchCount++;
            vlMismatches.push({ name: vlName, id: vlId, liveTickers, btTickers });
          }

          console.log(`  ${String(i + 1).padEnd(4)} ${vlName.slice(0, 40).padEnd(42)} ${rebalDate.padEnd(12)} ${valStr.padEnd(11)} ${liveStr.padEnd(20)} ${btStr.padEnd(20)} ${match ? 'OK' : 'DIFF'}`);
        }

        console.log('  ' + '-'.repeat(95));
        console.log(`  RESULT: ${vlMatchCount} match, ${vlMismatchCount} differ, ${vlErrCount} errors (${vlFiltered.length} total)`);

        if (vlMismatches.length > 0) {
          console.log('\n  MISMATCHES:');
          for (const m of vlMismatches) {
            console.log(`\n  ${m.name} (${m.id}):`);
            console.log(`    Live:     [${m.liveTickers.join(', ')}]`);
            console.log(`    Backtest: [${m.btTickers.join(', ')}]`);
            const liveOnly = m.liveTickers.filter(t => !m.btTickers.includes(t));
            const btOnly = m.btTickers.filter(t => !m.liveTickers.includes(t));
            if (liveOnly.length > 0) console.log(`    Live only:     [${liveOnly.join(', ')}]`);
            if (btOnly.length > 0) console.log(`    Backtest only: [${btOnly.join(', ')}]`);
          }
        }
        console.log('');
        break;
      }

      case 'quotes': {
        // Fetch real-time quotes from Composer's Xignite feed
        if (ids.length === 0) {
          console.log('Usage: node script.js quotes <TICKER> [TICKER2] [TICKER3]...');
          return;
        }
        const qTickers = ids.map(t => t.toUpperCase());
        console.log(`\nFetching Composer quotes for: ${qTickers.join(', ')}`);
        const qResult = await getPublicQuotes(qTickers);

        console.log('\n  ' + 'Ticker'.padEnd(10) + 'Price'.padStart(12) + 'Source Key'.padStart(28));
        console.log('  ' + '-'.repeat(50));
        for (const [qKey, qVal] of Object.entries(qResult)) {
          if (qKey === '$USD') continue;
          const ticker = normalizeQuoteTicker(qKey);
          const price = qVal.price || qVal.last || qVal.close || null;
          console.log('  ' + ticker.padEnd(10) +
            (price ? `$${parseFloat(price).toFixed(2)}` : 'N/A').padStart(12) +
            qKey.padStart(28));
        }
        break;
      }

      case 'gui':
      case '--gui': {
        const guiPath = path.join(__dirname, 'gui-server.js');
        require(guiPath);
        return; // server keeps process alive
      }

      case 'help':
      case '-h':
      case '--help':
        console.log(`
Intraday Execution Analyzer for Composer v2.0 (Alpaca Edition)

Data Sources:
  PRIMARY:  Alpaca Markets API (free paper account, 7+ years of 5-min bars)
  FALLBACK: Yahoo Finance (no API key, limited to ~60 days intraday)

Usage:
  node script.js                             Interactive menu
  node script.js config                      Configure API keys
  node script.js dual <id> [id2]...          Dual trade time analysis
  node script.js single <id> [id2]...        Single time replacement analysis
  node script.js combined <id> [id2]...      Combined analysis
  node script.js cash <id> [id2]...          Cash-at-time analysis (go to cash midday)
  node script.js walkforward <id> [id2]...   Walk-forward consistency (auto 5min)
  node script.js flip <id>                   Signal flip frequency
  node script.js check <id>                  Today's signal check
  node script.js validate <id>               Indicator validation mode
  node script.js portfolio                   List portfolio strategies
  node script.js watchlist                   List watchlist strategies
  node script.js holdings <id>               Dump holdings over time
  node script.js return-debug <id>           Day-by-day EOD backtest trace
  node script.js live-holdings [--predict]   Show Composer's live holdings
  node script.js live-check <id>             Deep live vs predicted comparison
  node script.js verify-live                 Fast live vs backtest holdings check
  node script.js quotes <TICKER> [...]       Composer/Xignite real-time quotes
  node script.js gui                          Launch web dashboard (localhost:3000)

Flags:
  --days=N                                   Limit analysis to N days
  --source=alpaca                            Force Alpaca for this run
  --source=yahoo                             Force Yahoo for this run
  --5min                                     Use 5-min bars (precise, 3x slower)
  --1min                                     Use 1-min bars (max precision, ~15x slower)
  --debug-compare                            Compare Alpaca vs Yahoo data
  --ids=ID1,ID2                              Filter to specific strategy IDs
  --predict                                  Run tree-walk prediction (live-holdings)
  --walkforward, --wf                         Tier 1: walk-forward consistency check
  --oos-wf, --oos                             Tier 2: true out-of-sample walk-forward
  --window=N                                  Tier 1 window size (default: 21 days)
  --step=N                                    Tier 1 step size (default: 21 days)
  --oos-train=N                               Tier 2 training window (default: 63 days)
  --wf-candidates=N                           Max candidate times for WF (default: 10)
  --composer-baseline, --cb                   Use Composer's backtest holdings as EOD baseline

Intraday Modes:
  Default: 15-min bars (fast, ~1 min for 150 tickers)
  --5min:  5-min bars  (precise, ~3 min for 150 tickers)
  --1min:  1-min bars  (max precision, ~15 min for 150 tickers)
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

// Always export for gui-server.js (works whether required or run directly)
module.exports = {
  CONFIG,
  getComposerPortfolio,
  getComposerWatchlist,
  getComposerDrafts,
  getSymphony,
  loadLocalSymphony,
  extractTickers,
  dualTimeAnalysis,
  singleTimeAnalysis,
  combinedAnalysis,
  cashTimeAnalysis,
  runOOSWalkforward,
  computeBaseScores,
  selectWFCandidates,
  computeRobustnessCheck,
  computeOOSScores,
  computeFinalScores,
  computeWalkforward,
  deriveDailyReturns,
  selectBestTime,
  getCompositeQuality,
  runDualVsEodBacktestDaily,
  runSingleVsEodBacktestDaily,
  getLiveSymphonyHoldings,
  getPublicQuotes,
  normalizeQuoteTicker,
  getPortfolioTotalStats,
  getAllHoldingStats,
  getAllAccounts,
  fetchAllData,
  getTradingDays,
  getTradingDaysFromDaily,
  getAssetsWithWeights,
  hasAlpacaKeys: () => !!(CONFIG.alpaca?.apiKey && CONFIG.alpaca?.apiSecret),
  hasComposerKeys: () => !!(CONFIG.composer?.keyId && CONFIG.composer?.secret),
  clearTickerDataCache,
  saveConfig,
  loadConfig,
  walkVerbose,
  runSingleTimeBacktest,
  clearMemoCache,
  clearSortedKeysCache,
  applyDateRange,
  APP_DIR,
  getIntradayPrice,
  runDualTimeBacktest,
  runCashTimeBacktest,
  runEODOnlyBacktest,
  fetchComposerBaselineHoldings,
  runComposerBaselineBacktest,
  shouldRebalance,
  getDriftedWeights,
};

if (require.main === module) {
  main();
}
