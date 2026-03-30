# Trailing Stop Experiment Prompt

Use this prompt to start a fresh Claude Code session for the trailing stop simulation experiment.

---

## Context

I have a Composer trading portfolio with ~25 strategies that auto-rebalance daily at end-of-day. I also have:

1. **Intraday Execution Analyzer** -- a Node.js tool with ~2 years of cached 5-minute Alpaca candle data for all tickers across my portfolio. Located at `MyTools/Intraday-Execution-Analyzer-for-Composer/`.

2. **Portfolio Merger** -- a Python tool that can merge multiple Composer strategy JSONs into a single mega-strategy with combined weights. Located at `MyTools/My Maestro local version and portfolio merger/Gobi's Portfolio Merger/`.

3. **Browser Extension** -- I have a browser extension for Composer that supports trailing stop-loss with these modes:
   - Fixed daily threshold (e.g., portfolio drops -3% from open, trigger action)
   - Trailing stop (e.g., portfolio pulls back 1.5% from its intraday high, trigger action)
   - Take-profit threshold (portfolio hits +X%, trigger action)
   - Trailing take-profit (portfolio pulls back X% from intraday high after crossing a profit threshold)

   When triggered, the action can be either **"Go to Cash"** (sell everything, sit in cash) or **"Run Now"** (re-evaluate all strategy conditions and rebalance immediately).

## Goal

Build a simulation that uses 5-minute candle data to test trailing stop strategies on my combined portfolio. For each trading day, reconstruct the intraday P&L path of the portfolio, detect when a trailing stop would have triggered, and compare three scenarios:

- **A. Go to Cash** -- Sell everything at the trigger price, hold cash for the rest of the day.
- **B. Run Now** -- At the trigger time, re-evaluate strategy holdings using prices at that moment and rebalance immediately. Hold new positions through EOD.
- **C. Do Nothing (Control)** -- Ignore the stop signal, hold existing positions through EOD.

## Key Reference Files

Read these files to understand the existing infrastructure:

### Intraday Analyzer (core engine)
- **Main engine**: `MyTools/Intraday-Execution-Analyzer-for-Composer/app/intraday-analyzer-alpaca-v2.0.js`
  - `getIntradayPrice(ticker, date, time)` -- returns price from cached 5-min Alpaca bars
  - `fetchAllData(tickers)` -- downloads and caches intraday data for a list of tickers
  - `getAssetsWithWeights(symphonyId, date, time)` -- evaluates strategy conditions at a given date/time and returns the resulting holdings with weights
  - `getDailyPrice(ticker, date)` -- returns daily close price
  - Cache directory: `app/cache/` (Alpaca bars stored as JSON files per ticker)

### Portfolio Merger
- **Merge script**: `MyTools/My Maestro local version and portfolio merger/Gobi's Portfolio Merger/merge.py`
- **README**: `MyTools/My Maestro local version and portfolio merger/Gobi's Portfolio Merger/README.md`
- **Temp folder for merged output**: `MyTools/My Maestro local version and portfolio merger/Gobi's Portfolio Merger/temp portfolio/`

### Strategy Data
- **Strategy JSON files**: `strategies/library/` (organized in subfolders, scan recursively)
- **Current portfolio CSV**: `strategies/currentportfolio_*.csv` (use the most recent dated file)
  - Contains `strategy_id`, `portfolio_copy_id`, `strategy_name`, `allocation` (ticker universe) columns
  - `portfolio_copy_id` is the ID of the user's copy of each strategy

### Project Instructions
- **CLAUDE.md**: Read `CLAUDE.md` at the repo root (`/Users/gabriel/AIProjects/ComposerTrading/CLAUDE.md`) for project conventions, API endpoints, and key rules (especially: Wilder's RSI, JSON format, Xignite vs Yahoo price differences).

## Experiment Design

### Phase 1: Portfolio Construction

1. Read the current portfolio CSV to get all active strategy IDs and allocations.
2. For each strategy, locate its JSON file in `strategies/library/`.
3. Use the portfolio merger to create a combined portfolio, OR simply track each strategy's weight proportionally (equal-weight or by allocation).
4. Collect the full ticker universe across all strategies.
5. Ensure all tickers have cached 5-min data (call `fetchAllData()` if needed).

### Phase 2: Daily P&L Path Reconstruction

For each trading day in the dataset (~2 years):

1. Get the previous day's EOD holdings for each strategy (using `getAssetsWithWeights()` at EOD of prior day).
2. Combine into portfolio-level holdings with weights.
3. For each 5-minute bar from 9:30 to 16:00:
   - Calculate portfolio value using intraday prices at that timestamp.
   - Track: open value, current value, intraday high value, drawdown from high.
4. Store the full intraday P&L path for the day.

### Phase 3: Trailing Stop Simulation

For each trailing stop threshold (1%, 1.5%, 2%, 3%):

1. Walk through each day's intraday P&L path.
2. Track the intraday high watermark of the portfolio.
3. When the portfolio drops X% from its intraday high, record:
   - **Trigger time** and **trigger price/value**
   - **Scenario A (Cash)**: Portfolio value = trigger value for rest of day (no further gain or loss).
   - **Scenario B (Run Now)**: At trigger time, call `getAssetsWithWeights()` for each strategy to get new holdings, then simulate the new portfolio from trigger time to EOD using 5-min prices.
   - **Scenario C (Control)**: Continue holding original positions, record EOD value.
4. On days where the stop does NOT trigger, all three scenarios have the same result (hold to EOD).

### Phase 4: SPY Regime Tagging

For each trading day, calculate SPY's return and classify the market regime:

- **Bull**: SPY trailing 20-day return > +2%
- **Sideways**: SPY trailing 20-day return between -2% and +2%
- **Bear**: SPY trailing 20-day return < -2%

Tag each day with its regime for the breakdown analysis.

### Phase 5: Metrics and Reporting

Calculate for each threshold and each scenario (A/B/C):

**Per-event metrics (days where stop triggered):**
- Total trigger count and trigger rate (% of all trading days)
- Average time of trigger (how early in the day)
- Average loss avoided (A vs C): how much further the portfolio dropped after the stop
- Average gain from Run Now (B vs C): improvement from rebalancing
- Win rate: % of triggered days where the scenario beat Control
- Average P&L for triggered days: A, B, and C

**Portfolio-level metrics (all days):**
- Total return, CAGR
- Max drawdown
- Sharpe ratio
- Sortino ratio

**Regime breakdown:**
- All per-event metrics broken down by bull/bear/sideways
- Trigger frequency per regime
- Win rate per regime

**Output:**
- Generate a self-contained HTML report with:
  - Summary table comparing all thresholds and scenarios
  - Regime breakdown tables
  - Charts: cumulative return curves for each scenario, trigger frequency distribution by time of day
- Also output a CSV with daily results for further analysis

## Implementation Notes

- Write this as a standalone Node.js script in `MyTools/Intraday-Execution-Analyzer-for-Composer/scripts/` (create the directory if needed).
- Import functions from the main analyzer engine (`../app/intraday-analyzer-alpaca-v2.0.js`) rather than reimplementing them.
- The analyzer's functions expect to be configured with API keys. The script should load the existing encrypted config the same way the main analyzer does.
- For "Run Now" simulation (Scenario B), you need to call `getAssetsWithWeights()` for each strategy at the trigger time. This is the expensive part -- it re-evaluates all strategy conditions. Consider caching results.
- Start with a single strategy for development/testing before scaling to the full portfolio.
- Use `console.error()` for progress logging (the analyzer convention) so stdout stays clean for piped output.
- RSI calculations use Wilder's method -- do NOT change this. See `scripts/Intraday/RSI_CALCULATION_METHOD.md`.

## Expected Insights

This experiment should answer:
1. Does a trailing stop improve risk-adjusted returns for this portfolio?
2. Is "Go to Cash" or "Run Now" the better action when a stop triggers?
3. What trailing stop percentage works best? (Tighter stops trigger more often but may whipsaw; wider stops trigger less but catch bigger drops.)
4. Does the optimal stop vary by market regime?
5. How often does the trailing stop trigger unnecessarily (portfolio recovers by EOD)?
