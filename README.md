  ---
  # Intraday Execution Analyzer for Composer

  Analyzes whether executing your Composer strategy at different times of day improves returns vs the default 3:45 PM auto-rebalance.

  **No API key required** - uses Yahoo Finance (free, ~60 days of intraday history)

  ---

  ## Quick Start

  ### Prerequisites
  Install [Node.js](https://nodejs.org/) (LTS version)

  ```bash
  # Verify installation
  node --version

  Run

  # Interactive menu
  node intraday-analyzer-standalone-v3.js

  # Or direct CLI
  node intraday-analyzer-standalone-v3.js dual <symphony_id>
  node intraday-analyzer-standalone-v3.js single <symphony_id>

  Finding Your Symphony ID

  From URL: https://app.composer.trade/symphony/VfLXEvcG8VXvw52N8g9l/details
  The ID is: VfLXEvcG8VXvw52N8g9l

  ---
  Two Analysis Types

  1. DUAL Trade Time Analysis

  Question: "If I manually click 'Run Now' each morning IN ADDITION TO letting Composer auto-run at 3:45pm, would my returns be better or worse?"

  What it simulates:
  - You trade TWICE per day (morning + EOD)
  - Morning: Evaluate signals, rebalance if different
  - EOD: Composer auto-runs at 3:45pm as normal
  - Returns show combined effect of both trades

  Use case: Deciding whether to add a manual "Run Now" to your daily routine.

  ---
  2. SINGLE Time Replacement Analysis

  Question: "If I could magically make Composer trade at a different time INSTEAD OF 3:45pm, which single time would be best?"

  What it simulates:
  - You trade ONCE per day at the specified time
  - Hold from one day's trade time to the next day's same time
  - Compare different times against the default 3:45pm

  Use case: Theoretical analysis (you can't actually change Composer's execution time, but useful to understand timing sensitivity).

  ---
  Menu

  ══════════════════════════════════════════════════════════════════════
    MAIN ANALYSIS OPTIONS:
  ──────────────────────────────────────────────────────────────────────

    1. DUAL TRADE TIME ANALYSIS
       "Should I trade at BOTH morning AND 3:45pm?"

    2. SINGLE TIME REPLACEMENT ANALYSIS
       "Should I REPLACE 3:45pm with a different time?"

  ──────────────────────────────────────────────────────────────────────
    SIGNAL SUB-ANALYSIS:
  ──────────────────────────────────────────────────────────────────────

    3. Signal Flip Frequency  - How often do signals differ morning vs EOD?
    4. Daily Signal Check     - What would be selected at each time TODAY?

  ---
  Features

  - Single or batch - enter one ID or multiple comma/space separated
  - 6 morning times tested: 9:30, 9:45, 10:00, 10:30, 11:00, 12:00
  - Full strategy logic evaluation - RSI, SMA, EMA, cumulative return, filters, weighted allocations
  - Cumulative return over the test period (not daily %)
  - Max drawdown comparison
  - Clear recommendations (ADD_MORNING / STICK_EOD / MARGINAL)

  ---
  How It Works

  The script:
  1. Fetches your strategy's full logic from Composer's public API (not just tickers - the actual if/else tree)
  2. Gets daily price data for indicator calculation
  3. Gets 15-minute intraday data for execution prices
  4. Simulates what your strategy would hold at each time
  5. Calculates returns based on those simulated holdings

  Why Signals Can Flip

  Composer calculates indicators like RSI using daily closes + today's current price. As the price moves throughout the day, the "today" portion changes, which can flip signals.

  Example for 14-day RSI at 10:30am:
  prices[0..12]  = Last 13 daily closes
  prices[13]     = Current price at 10:30am  <-- This changes!

  ---
  Interpreting Results

  Recommendations

  | Label       | Meaning                                 |
  |-------------|-----------------------------------------|
  | ADD_MORNING | Dual-time improvement > +5% vs EOD-only |
  | STICK_EOD   | Dual-time worse by > 5% vs EOD-only     |
  | MARGINAL    | Difference within +/- 5%                |

  Confidence Level

  - Results are directional indicators, not guarantees
  - ~40 trading days (Yahoo limit) means limited statistical significance
  - Use for "should I experiment?" decisions, not "this will definitely work"

  ---
  Limitations

  | Feature              | How Modeled                      |
  |----------------------|----------------------------------|
  | wt-inverse-vol       | Treated as equal-weight          |
  | Transaction costs    | Not modeled (results optimistic) |
  | Bid-ask spread       | Not modeled                      |
  | Yahoo intraday limit | 60 calendar days (40 trading)    |

  ---
  Troubleshooting

  | Error                        | Solution                                              |
  |------------------------------|-------------------------------------------------------|
  | "No data available"          | Ticker may be delisted or have different Yahoo symbol |
  | "Not enough trading days"    | Need at least 5 trading days                          |
  | "JSON parse error"           | Rate limiting - wait and retry                        |
  | Numbers don't match Composer | Expected! This uses intraday execution prices         |


  ---
  License

  MIT - Use at your own risk. This is for educational/research purposes. Past performance doesn't guarantee future results.

  ---
