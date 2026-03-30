# Intraday Execution Analyzer for Composer

Find the best time of day to execute your [Composer.trade](https://www.composer.trade) strategies. Instead of using Composer's default execution window, this tool backtests every time slot from 9:30 AM to 3:45 PM using real intraday price data and shows you which execution time would have delivered the best risk-adjusted returns.

## Features

- **Four analysis modes** — Dual (add morning trade + EOD), Single (replace EOD with a different time), Cash (go to cash midday, re-enter at EOD), Combined (all three + cross-comparison)
- **Composer Baseline** — Use Composer's actual backtest equity curve (Xignite prices) as the EOD baseline for exact comparison, or fall back to Yahoo-based simulation
- **Composite scoring** — 5-axis quality score (Return, Drawdown, Neighbors, Robustness Check, Walk-Forward Test) with labels: STRONG (75+), GOOD (55-74), MARGINAL (40-54), WEAK (<40)
- **Two-tier walk-forward validation:**
  - **Robustness Check** (post-hoc slicing) — Slices completed backtest into 21-day windows to verify alpha is consistent, not concentrated in outliers
  - **Walk-Forward Test** (true OOS) — Trains on rolling 63-day windows, picks best time using only past data, tests on next unseen 21-day window. Simulates real-time decision-making.
- **SPY Regime Analysis** — RC and OOS windows are tagged with SPY return and market regime (bull/bear/sideways). A regime breakdown summary shows win rate per regime, revealing whether alpha is regime-dependent.
- **Smart candidate selection** — Walk-forward testing runs only on the top 10 candidates (not all times), selected by base scoring with positive improvement required
- **Holdings Reliability Check** — Pre-analysis quality gate comparing simulated holdings vs Composer's actual Xignite-based holdings. Shows both Yahoo and Alpaca overlap scores with verdicts: HIGH, MODERATE, LOW, or UNRELIABLE. Configurable minimum threshold to skip strategies that cannot be reliably simulated.
- **Execution Filters** — Minimum allocation change threshold (e.g., 5%) to trigger intraday Run Now, matching n8n workflow skip rules. Take-profit filter to only execute on days where the portfolio is up X% since previous close (options: Off, 0.5%, 1%, 2%, 3%, or negative thresholds).
- **Clickable Mode Tabs** — Combined reports use clickable Dual/Single/Cash tab cards instead of vertical scrolling for faster navigation between modes.
- **Unified tab interface** — Click any candidate time to see both Robustness Check and Walk-Forward Test results side-by-side
- **Web GUI** — Browser-based dashboard with interactive results and HTML report export
- **Full CLI** — Scriptable command-line interface for automation and batch analysis
- **Alpaca data** — Up to 2 years of 5-minute or 15-minute intraday bars via free Alpaca paper account
- **Data source resilience** — Missing Alpaca day fallback for all times, early-close day handling, and multiple EOD data source options including Alpaca bar close
- **Composer API integration** — Browse and select strategies directly from your portfolio/watchlist
- **Zero dependencies** — Pure Node.js, no npm install required

## Quick Start

```bash
# 1. Clone
git clone https://github.com/Gabraham4/Intraday-Execution-Analyzer-for-Composer.git
cd Intraday-Execution-Analyzer-for-Composer

# 2. Launch
node app/gui-server.js
# Or on macOS: double-click "Intraday Analyzer.command"
# Or on Windows: double-click "Intraday Analyzer.bat"

# 3. Open browser
# http://localhost:3000
```

On first launch, the Settings page will prompt you for API keys.

## Project Structure

```
├── Intraday Analyzer.command   # macOS launcher (double-click)
├── Intraday Analyzer.bat       # Windows launcher (double-click)
├── package.json                # npm start / npm run cli
├── reports/                    # Generated HTML reports (gitignored)
├── app/
│   ├── gui-server.js           # Web GUI server + report renderer
│   ├── intraday-analyzer-alpaca-v2.0.js  # Core analysis engine + CLI
│   ├── cache/                  # Cached price data (gitignored)
│   └── walkforward_csvs/       # Walk-forward CSV exports (gitignored)
```

## Getting API Keys

### Alpaca (recommended — free, 2 minutes)

Alpaca provides 2 years of intraday price data for free via a paper trading account.

1. Go to [alpaca.markets](https://alpaca.markets) and create a free account
2. Switch to **Paper Trading** in the dashboard
3. Go to **API Keys** and click **Generate New Key**
4. Copy the **API Key** (starts with `PK`) and **Secret Key**
5. Paste both into the Settings page in the analyzer

Without Alpaca keys, the analyzer falls back to Yahoo Finance (~60 days of intraday data).

### Composer API (optional)

Composer keys let the analyzer browse your portfolio and watchlist to select strategies. Without them, you can still paste strategy IDs manually.

1. Go to [app.composer.trade](https://app.composer.trade)
2. Open **Settings** > **API Keys**
3. Create a new key pair
4. Paste the **Key ID** and **Secret** into the analyzer's Settings page

## Usage

### Web GUI

1. Launch with `node app/gui-server.js` (or `npm start`)
2. **Settings** (gear icon) — enter your API keys, configure timeframe (5-min or 15-min), and choose EOD baseline source
3. **Sidebar** — click "Load Portfolio" or "Load Watchlist" to see your strategies (requires Composer keys), or paste strategy IDs manually
4. **Select** strategies using checkboxes
5. **Choose mode** — Dual, Single, Cash, or Combined
6. **Enable Robustness Check** and/or **Walk-Forward Test** (checkboxes)
7. Click **Run Analysis**
8. View results inline or open saved HTML reports from the `reports/` folder

> **First run warning:** The first analysis for a strategy downloads up to 2 years of intraday price data for every ticker in the strategy. For complex strategies with many tickers, this can take several minutes to hours. Data is cached locally and subsequent analyses are much faster.

### CLI

```bash
# Interactive menu
node app/intraday-analyzer-alpaca-v2.0.js

# Direct commands
node app/intraday-analyzer-alpaca-v2.0.js dual <symphonyId>
node app/intraday-analyzer-alpaca-v2.0.js single <symphonyId>
node app/intraday-analyzer-alpaca-v2.0.js cash <symphonyId>
node app/intraday-analyzer-alpaca-v2.0.js combined <symphonyId>

# With walk-forward tiers
node app/intraday-analyzer-alpaca-v2.0.js dual <id> --wf              # Robustness Check only
node app/intraday-analyzer-alpaca-v2.0.js dual <id> --oos-wf          # Walk-Forward Test only
node app/intraday-analyzer-alpaca-v2.0.js dual <id> --wf --oos-wf     # Both tiers

# With Composer baseline
node app/intraday-analyzer-alpaca-v2.0.js dual <id> --composer-baseline

# Configure API keys
node app/intraday-analyzer-alpaca-v2.0.js config
```

### Using Strategy IDs Without Composer API

You don't need Composer API keys to run analyses. To get a strategy's ID:

1. Open the strategy in Composer's web app
2. The URL will be: `https://app.composer.trade/symphony/ABC123XYZ/details`
3. Copy the ID from the URL (e.g., `ABC123XYZ`)
4. Paste it directly into the GUI's strategy input, or pass it as a CLI argument

## Analysis Modes

### Dual Time
"Should I trade at BOTH a morning time AND Composer's EOD?"
Simulates using "Run Now" mid-morning + letting Composer auto-trade at EOD. The strategy re-evaluates conditions at both times, potentially catching moves earlier.

### Single Time
"Should I REPLACE EOD with a different time entirely?"
Simulates trading ONLY at a different time, skipping EOD.

### Cash-at-Time
"Should I go to cash midday and re-enter at EOD?"
Simulates liquidating all positions at a morning time (sitting in cash earning 0% through the afternoon), then letting Composer buy back into positions at EOD. Tests whether avoiding intraday volatility improves returns.

### Combined
Runs all three modes and recommends the best approach considering return improvement, drawdown risk, and walk-forward consistency.

## How It Works

For each strategy, the analyzer:

1. **Fetches the strategy's ticker allocation** from Composer's public API
2. **Downloads intraday price data** for all tickers (5-min or 15-min bars from Alpaca)
3. **Re-evaluates the strategy's conditions** at each candidate time using prices available at that moment
4. **Simulates execution** — enters positions at the candidate time's prices instead of end-of-day
5. **Scores each time** on 3 base axes: return improvement (with absolute floor for negative improvements), drawdown quality, and neighbor robustness
6. **Selects top 10 candidates** — only times with positive improvement qualify for walk-forward testing
7. **Validates with Robustness Check** — post-hoc window slicing to verify consistency
8. **Validates with Walk-Forward Test** — true out-of-sample rolling train/test to simulate real-time decision-making
9. **Produces final composite score** with dynamic weights based on which tiers are enabled

## EOD Baseline Options

In Settings, you can choose between two EOD baseline sources:

- **Custom Yahoo EOD** — Simulates strategy evaluation using Yahoo Finance daily closes. Works without Composer API keys. EOD time is configurable (see options below).
- **Composer Backtest** — Uses Composer's actual backtest equity curve (`dvm_capital`) with Xignite prices. This is the ground truth — the exact returns Composer would have produced. Requires Composer API keys. The EOD time selector is disabled in this mode since Composer uses its own fixed trading window. Report filenames include 'composer' when this baseline is selected.

### EOD Time Options

| Time | Source | Description |
|------|--------|-------------|
| 15:45 | Alpaca | Alpaca bar open price at 15:45 |
| 16:00 | Yahoo | Yahoo Finance daily close price |
| 16:00a | Alpaca | Alpaca bar close price at 16:00 |
| Composer Backtest | Xignite | Composer's own backtest equity curve (ground truth) |

Labels in the UI indicate which data source is used for each option.

## Holdings Reliability Check

Before running a full analysis, the analyzer performs a quality gate by comparing its simulated holdings against Composer's actual Xignite-based holdings. This catches strategies where the Yahoo/Alpaca price data diverges enough from Xignite to produce different condition evaluations.

The check shows both Yahoo and Alpaca overlap scores and assigns a verdict:

| Verdict | Overlap | Meaning |
|---------|---------|---------|
| **HIGH** | 90%+ | Simulation closely matches Composer. Results are trustworthy. |
| **MODERATE** | 70-89% | Some divergence. Results are directionally useful but review edge cases. |
| **LOW** | 50-69% | Significant divergence. Take results with a grain of salt. |
| **UNRELIABLE** | <50% | Simulation does not reflect Composer's behavior. Strategy is skipped. |

The minimum reliability threshold is configurable in Settings. Strategies that fall below it are automatically skipped during batch analysis.

## Execution Filters

Two filters control when an intraday "Run Now" execution should be triggered, matching the logic used in the n8n automation workflow:

### Execution Threshold
Minimum allocation change (e.g., 5%) required to trigger an intraday Run Now. If the strategy's holdings would not change by at least this percentage, the execution is skipped. This matches the n8n workflow's skip rule to avoid unnecessary rebalances for trivial allocation shifts. Configurable in Settings.

### Take-Profit Filter
Only execute Run Now on days where the portfolio is up at least X% since the previous close. This prevents triggering rebalances on down days where the strategy might be better served by holding through.

Available thresholds: Off (disabled), 0.5%, 1%, 2%, 3%, and negative thresholds for loss-triggered execution.

## Scoring System

Each candidate time is scored 0-100 on up to 5 axes:

| Axis | No WF | Tier 1 | Tier 2 | Both |
|------|-------|--------|--------|------|
| Return improvement | 40% | 30% | 30% | 25% |
| Drawdown quality | 25% | 20% | 20% | 15% |
| Neighbor robustness | 35% | 25% | 25% | 20% |
| Robustness Check (RC) | — | 25% | — | 20% |
| Walk-Forward Test (OOS) | — | — | 25% | 20% |

**Return score** uses rank among tested times with an absolute quality floor: if a time's improvement is negative, its score is capped near zero regardless of rank. This prevents Cash mode from showing high scores when all times underperform EOD.

**Labels:** STRONG (75+), GOOD (55-74), MARGINAL (40-54), WEAK (<40)

## Walk-Forward Tiers

### Tier 1: Robustness Check (post-hoc slicing)
Slices the completed backtest equity curve into rolling 21-day windows and checks: "In how many windows did this time beat EOD?" This catches strategies where the improvement is driven by a few huge outlier windows rather than consistent alpha.

- **CONSISTENT** (70%+ win rate) — Alpha is persistent and reliable
- **EPISODIC** (40-70%) — Alpha is real but regime-dependent
- **OVERFITTED** (<40%) — Alpha concentrated in few windows, likely curve-fitted

### Tier 2: Walk-Forward Test (true OOS)
For each rolling 63-day training window, picks the best time using only past data, then tests on the next unseen 21-day window. This simulates what would have happened if you started using the tool at any point in the past.

- **OOS_CONFIRMED** (65%+ win rate, positive alpha) — Signal is real
- **OOS_DEGRADED** (40%+ win rate or positive alpha) — Signal exists but weaker than backtest suggests
- **OOS_FAILED** — Signal doesn't hold out-of-sample

**Degradation ratio** compares OOS annualized alpha to full-backtest alpha. >= 0.50 is ACCEPTABLE, >= 0.75 is EXCELLENT, < 0.25 is SEVERE.

## Security

- API keys are **encrypted at rest** using AES-256-GCM with a machine-derived key
- Keys are stored in `app/analyzer-config.enc` (gitignored)
- Keys are **never transmitted** except directly to the Alpaca and Composer APIs over HTTPS
- Environment variables (`ALPACA_API_KEY`, `ALPACA_API_SECRET`, `COMPOSER_KEY_ID`, `COMPOSER_SECRET`) can be used instead of file storage

## Requirements

- **Node.js 18+** (uses built-in `crypto`, `http`, `https` modules)
- No npm dependencies

## Disclaimer

This tool is for informational and educational purposes only. It is not financial advice. Past performance of any execution timing strategy does not guarantee future results. Use at your own risk.
