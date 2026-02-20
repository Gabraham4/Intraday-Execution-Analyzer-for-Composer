# Intraday Execution Analyzer for Composer

Find the best time of day to execute your [Composer.trade](https://www.composer.trade) strategies. Instead of using Composer's default execution window, this tool backtests every time slot from 9:30 AM to 3:45 PM using real intraday price data and shows you which execution time would have delivered the best risk-adjusted returns.

## Features

- **Three analysis modes** — Dual (run at optimal time vs. EOD), Single (compare all times head-to-head), Combined (both + cross-validation)
- **Walk-forward validation** — Rolling out-of-sample consistency check to distinguish real timing alpha from overfitting
- **Robustness tiers** — Automated STRONG / MODERATE / WEAK / NONE classification based on peak shape, mode agreement, and walk-forward consistency
- **Web GUI** — Browser-based dashboard with interactive charts and HTML report export
- **Full CLI** — Scriptable command-line interface for automation and batch analysis
- **Alpaca data** — Up to 2 years of 5-minute intraday bars via free Alpaca paper account (falls back to Yahoo Finance if no keys configured)
- **Composer API integration** — Optionally connect your Composer account to browse and select strategies directly from your portfolio/watchlist
- **Zero dependencies** — Pure Node.js, no npm install required

## Quick Start

```bash
# 1. Clone
git clone https://github.com/gabraham/Intraday-Execution-Analyzer-for-Composer.git
cd Intraday-Execution-Analyzer-for-Composer

# 2. Launch
node app/gui-server.js
# Or on macOS: double-click "Intraday Analyzer.command"

# 3. Open browser
# http://localhost:3000
```

On first launch, the Settings page will prompt you for API keys.

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

1. Launch with `node app/gui-server.js`
2. **Settings** (gear icon) — enter your API keys
3. **Sidebar** — click "Load Portfolio" or "Load Watchlist" to see your strategies (requires Composer keys), or paste strategy IDs manually
4. **Select** strategies using checkboxes
5. **Choose mode** — Dual, Single, or Combined
6. **Enable Walk-Forward** (checkbox, on by default) for out-of-sample validation
7. Click **Run Analysis**
8. View results inline or export as an HTML report

> **First run warning:** The first analysis for a strategy downloads up to 2 years of intraday price data for every ticker in the strategy. For complex strategies with many tickers, this can take **several hours**. It's fine to leave it running overnight. After the first run, data is cached locally and subsequent analyses are much faster.

### CLI

```bash
# Interactive menu
node app/intraday-analyzer-alpaca-v2.0.js

# Direct commands
node app/intraday-analyzer-alpaca-v2.0.js dual <symphonyId>
node app/intraday-analyzer-alpaca-v2.0.js single <symphonyId>
node app/intraday-analyzer-alpaca-v2.0.js combined <symphonyId>

# With walk-forward
node app/intraday-analyzer-alpaca-v2.0.js combined <symphonyId> --walkforward

# Configure API keys
node app/intraday-analyzer-alpaca-v2.0.js config
```

### Using Strategy IDs Without Composer API

You don't need Composer API keys to run analyses. To get a strategy's ID:

1. Open the strategy in Composer's web app
2. The URL will be: `https://app.composer.trade/symphony/ABC123XYZ/details`
3. Copy the ID from the URL (e.g., `ABC123XYZ`)
4. Paste it directly into the GUI's strategy input, or pass it as a CLI argument

## How It Works

For each strategy, the analyzer:

1. **Fetches the strategy's ticker allocation** from Composer's public API
2. **Downloads intraday price data** for all tickers (5-min or 15-min bars from Alpaca)
3. **Re-evaluates the strategy's conditions** at each candidate time using prices available at that moment
4. **Simulates execution** — enters positions at the candidate time's prices instead of end-of-day
5. **Compares returns** across all time slots to find the optimal execution window
6. **Validates with walk-forward** — runs rolling out-of-sample windows to check if the edge persists

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
