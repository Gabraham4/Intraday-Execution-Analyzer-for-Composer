# Intraday Execution Analyzer for Composer

A standalone tool to analyze whether executing your [Composer.trade](https://composer.trade) symphony at different times of day improves returns compared to the default 3:45-4:00 PM trading window auto-rebalance.

**No API keys required** - uses Yahoo Finance public data

---

## What This Tool Does

Composer symphonies auto-execute during the 3:45-4:00 PM ET trading window. But what if executing earlier in the day would give better results? This tool simulates your strategy at multiple intraday times and compares outcomes.

**Analysis Times:** 9:30, 9:45, 10:00, 10:30, 11:00, 12:00, 13:45, and your configured EOD time (default 15:45)

---

## Features

- **Dual Trade Time Analysis** - "Should I trade at BOTH morning AND 3:45pm?"
- **Single Time Replacement** - "Should I REPLACE 3:45pm with a different time?"
- **Signal Flip Frequency** - How often do signals differ morning vs EOD?
- **Holdings Check by Date** - What holdings would you have at each time on a given day?
- **Indicator Validation** - Debug mode to trace through IF/FILTER decisions
- **Customizable EOD Time** - Option 7 lets you set your baseline to 3:45, 3:50, 3:55, or 4:00 PM

---

## Quick Start

### Option 1: Run with Node.js

```bash
# Prerequisites: Install Node.js 18+ from https://nodejs.org/

# Clone the repo
git clone https://github.com/Gabraham4/Intraday-Execution-Analyzer-for-Composer.git
cd Intraday-Execution-Analyzer-for-Composer

# Run interactively
node intraday-analyzer-v1.3.js

# Or with symphony ID directly
node intraday-analyzer-v1.3.js dual <symphony_id>
```

### Option 2: Standalone Executables (No Node.js Required)

Download pre-built executables from [Releases](https://github.com/Gabraham4/Intraday-Execution-Analyzer-for-Composer/releases):

| Platform | File |
|----------|------|
| Windows | `intraday-analyzer-win.exe` |
| macOS (Intel) | `intraday-analyzer-macos-x64` |
| macOS (Apple Silicon) | `intraday-analyzer-macos-arm64` |
| Linux | `intraday-analyzer-linux` |

---

## Finding Your Symphony ID

From your symphony URL:
```
https://app.composer.trade/symphony/VfLXEvcG8VXvw52N8g9l/factsheet
                                    ^^^^^^^^^^^^^^^^^^
                                    This is your Symphony ID
```

---

## Menu Options

```
══════════════════════════════════════════════════════════════════════
  MAIN ANALYSIS OPTIONS:
──────────────────────────────────────────────────────────────────────

  1. DUAL TRADE TIME ANALYSIS
     "Should I trade at BOTH morning AND Composer auto-EOD (15:45)?"

  2. SINGLE TIME REPLACEMENT ANALYSIS
     "Should I REPLACE 15:45 with a different time?"

──────────────────────────────────────────────────────────────────────
  SIGNAL SUB-ANALYSIS:
──────────────────────────────────────────────────────────────────────

  3. Signal Flip Frequency  - How often do signals differ morning vs EOD?
  4. Holdings Check by Date - What holdings at each time on a given day?

──────────────────────────────────────────────────────────────────────
  DEBUGGING:
──────────────────────────────────────────────────────────────────────

  6. Indicator Validation   - Debug indicator values vs Composer (trace mode)

──────────────────────────────────────────────────────────────────────
  SETTINGS:
──────────────────────────────────────────────────────────────────────

  7. Change EOD Time        - Customize your baseline EOD time
```

### Option 7: Customize EOD Time

By default, the tool compares against 15:45 (3:45 PM). Use **Option 7** to set your baseline EOD time to 3:45, 3:50, 3:55, or 4:00 PM depending on when your trades tend to execute within Composer's trading window.

---

## Command Line Usage

```bash
# Dual trade time analysis
node intraday-analyzer-v1.3.js dual <symphony_id>

# Single time replacement analysis
node intraday-analyzer-v1.3.js single <symphony_id>

# Signal flip frequency
node intraday-analyzer-v1.3.js flip <symphony_id>

# Today's holdings check
node intraday-analyzer-v1.3.js check <symphony_id>

# Indicator validation (debug)
node intraday-analyzer-v1.3.js validate <symphony_id>
```

---

## Important Notes

### Data Limitations

- **Yahoo Finance data goes back ~60 days only** (~40 trading days)
- For longer historical analysis, I have a TwelveData version available - reach out if interested

### Complex Strategy Caveats

- Very complex symphonies (100+ IF nodes, deeply nested structures) may occasionally produce slightly different holdings than Composer
- This is typically due to minor data source differences between Yahoo Finance and Composer's Xignite feed
- The tool works best with symphonies under ~50 IF/FILTER nodes
- Always verify with Option 4 (Holdings Check) against your actual Composer holdings

### Verified Indicators

All indicator calculations have been verified against Composer's actual behavior:

| Indicator | Formula | Status |
|-----------|---------|--------|
| RSI | Wilder's smoothing method | Verified |
| Cumulative Return | (end - start) / start | Verified |
| Moving Average of Return | avg(daily returns) | Verified |
| SMA (Price) | Simple average of prices | Verified |
| EMA (Price) | Smoothing factor 2.0 | Verified |
| Standard Deviation | Population std dev | Verified |
| Max Drawdown | Peak-to-trough | Verified |

---

## How It Works

1. **Fetches** your symphony structure from Composer's public API
2. **Downloads** intraday + daily price data from Yahoo Finance
3. **Simulates** your strategy logic at each analysis time
4. **Compares** holdings and calculates theoretical returns
5. **Generates** recommendations based on performance differences

### Why Signals Can Flip

Composer calculates indicators using daily closes + today's current price. As price moves throughout the day, the "today" portion changes, which can flip signals.

```
Example for 14-day RSI at 10:30am:
  prices[0..12]  = Last 13 daily closes
  prices[13]     = Current price at 10:30am  <-- This changes!
```

---

## Interpreting Results

### Recommendations

| Label | Meaning |
|-------|---------|
| ADD_MORNING | Dual-time improvement > +5% vs EOD-only |
| STICK_EOD | Dual-time worse by > 5% vs EOD-only |
| MARGINAL | Difference within +/- 5% |

### Confidence Level

- Results are directional indicators, not guarantees
- ~40 trading days means limited statistical significance
- Use for "should I experiment?" decisions, not "this will definitely work"

---

## Limitations

| Feature | How Modeled |
|---------|-------------|
| wt-inverse-vol | Treated as equal-weight |
| Transaction costs | Not modeled (results optimistic) |
| Bid-ask spread | Not modeled |
| Yahoo intraday limit | ~60 calendar days (~40 trading) |

---

## Troubleshooting

| Error | Solution |
|-------|----------|
| "No data available" | Ticker may be delisted or have different Yahoo symbol |
| "Not enough trading days" | Need at least 5 trading days |
| "JSON parse error" | Rate limiting - wait and retry |
| Holdings don't match | Use Option 4 to debug; complex strategies may have edge cases |

---

## Version History

- **v1.3** - Fixed Moving Average of Return formula (empirically verified), improved filter handling
- **v3** - Major rewrite: daily bars for indicators (matches Composer), intraday price for "today"
- **v2** - Added signal flip analysis
- **v1** - Initial release

---

## Disclaimer

This tool is for **educational and research purposes only**. Past performance does not guarantee future results. Always do your own due diligence before making investment decisions.

---

## Contributing

Issues and PRs welcome! If you find a strategy where the analyzer produces different results than Composer, please open an issue with the symphony ID.

---

## License

MIT - Use at your own risk.

---

*Built for the Composer community*
