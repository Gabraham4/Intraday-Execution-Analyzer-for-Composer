#!/usr/bin/env node
/**
 * Intraday Execution Analyzer - Web GUI Server
 *
 * Zero-dependency web server that wraps the CLI analyzer with a browser dashboard.
 * Uses only Node.js built-in http module.
 *
 * Usage: node gui-server.js [--port=3000]
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const analyzer = require('./intraday-analyzer-alpaca-v2.0.js');

const PORT = parseInt(process.argv.find(a => a.startsWith('--port='))?.split('=')[1] || process.env.PORT || '3000', 10);

// Track running analyses so we can prevent concurrent runs
let analysisRunning = false;

// ============================================================================
// GUI SETTINGS PERSISTENCE
// ============================================================================

const APP_DIR = analyzer.APP_DIR || __dirname;
const GUI_SETTINGS_FILE = path.join(APP_DIR, 'gui-settings.json');

function loadGUISettings() {
  try {
    if (fs.existsSync(GUI_SETTINGS_FILE)) {
      return JSON.parse(fs.readFileSync(GUI_SETTINGS_FILE, 'utf8'));
    }
  } catch { /* ignore */ }
  return {};
}

function saveGUISettings(updates) {
  const current = loadGUISettings();
  const merged = { ...current, ...updates };
  fs.writeFileSync(GUI_SETTINGS_FILE, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  return merged;
}

// Apply saved GUI settings to analyzer CONFIG on startup
(function applyGUISettings() {
  const saved = loadGUISettings();
  if (saved.alpacaTimeframe && ['15Min', '5Min'].includes(saved.alpacaTimeframe)) {
    analyzer.CONFIG.ALPACA_TIMEFRAME = saved.alpacaTimeframe;
  }
  if (saved.eodTime && analyzer.CONFIG.EOD_TIME_OPTIONS.includes(saved.eodTime)) {
    analyzer.CONFIG.EOD_TIME = saved.eodTime;
  }
  if (saved.testTimes && Array.isArray(saved.testTimes) && saved.testTimes.length > 0) {
    analyzer.CONFIG.TEST_TIMES = saved.testTimes;
  }
})();

// ============================================================================
// HELPERS
// ============================================================================

function maskKey(key) {
  if (!key || key.length < 8) return '';
  return key.substring(0, 8) + '...';
}

// ============================================================================
// JSON BODY PARSER
// ============================================================================

function parseBody(req) {
  return new Promise((resolve, reject) => {
    if (req.method !== 'POST') return resolve(null);
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 1e6) { req.destroy(); reject(new Error('Body too large')); } });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

// ============================================================================
// SSE HELPERS
// ============================================================================

function sseHeaders(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
}

function sseSend(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ============================================================================
// REPORT SAVING
// ============================================================================

const REPORTS_DIR = path.join(APP_DIR, 'reports');

function sanitizeFilename(name) {
  return name.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, ' ').trim();
}

function saveReport(result, mode) {
  try {
    if (!result || result.error || !result.name) return;
    if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
    // Include settings in filename so different configs don't overwrite each other
    const eod = (analyzer.CONFIG && analyzer.CONFIG.EOD_TIME) || '15:45';
    const tf = (analyzer.CONFIG && analyzer.CONFIG.ALPACA_TIMEFRAME) || '15Min';
    const wf = (analyzer.CONFIG && analyzer.CONFIG.walkforward) ? 'wf' : 'nowf';
    const settings = tf + ' ' + eod.replace(':', '') + ' ' + wf;
    const filename = sanitizeFilename(result.name) + ' (' + mode + ') ' + settings + '.html';
    const html = buildReportHTML(result, mode);
    fs.writeFileSync(path.join(REPORTS_DIR, filename), html);
  } catch (e) {
    // Silent fail — report saving should never break analysis
  }
}

function buildReportHTML(r, mode) {
  const eodTime = (analyzer.CONFIG && analyzer.CONFIG.EOD_TIME) || '15:45';
  const testTimes = (analyzer.CONFIG && analyzer.CONFIG.TEST_TIMES) || [];
  const now = new Date();
  const runDate = now.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const modeLabel = mode === 'dual' ? 'Dual (Intraday + EOD)'
    : mode === 'single' ? 'Single (Replace EOD)'
    : 'Combined (Dual + Single)';

  function esc(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function pct(v, d) { if (v == null || isNaN(v)) return '-'; return (v >= 0 ? '+' : '') + v.toFixed(d) + '%'; }
  function cls(v) { if (v == null) return 'neutral'; return v > 0 ? 'pos' : v < 0 ? 'neg' : 'neutral'; }
  function ddCls(dd, baseDD) { if (dd == null || baseDD == null) return 'neutral'; return dd < baseDD ? 'pos' : dd > baseDD ? 'neg' : 'neutral'; }
  function ddCls2(chg) { if (chg == null) return 'neutral'; return chg < 0 ? 'pos' : chg > 0 ? 'neg' : 'neutral'; }
  function fDate(ymd) {
    if (!ymd) return '';
    var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    var p = ymd.split('-');
    return p.length === 3 ? months[parseInt(p[1],10)-1] + ' ' + parseInt(p[2],10) + ', ' + p[0] : ymd;
  }
  function dateRange(dr) {
    if (!dr) return '';
    var parts = dr.split(' to ');
    return parts.length === 2 ? fDate(parts[0]) + ' \u2014 ' + fDate(parts[1]) : dr;
  }

  function buildWalkforwardSection(wf, altLabel) {
    if (!wf || !wf.summary || wf.summary.verdict === 'INSUFFICIENT_DATA') return '';
    var s = wf.summary;
    var h = '<div class="section">';
    h += '<div class="section-title">Walk-Forward Consistency \u2014 ' + esc(altLabel) + ' (' + s.total + ' windows)</div>';
    h += '<table><thead><tr><th>Period</th><th>EOD</th><th>' + esc(altLabel) + '</th><th>Alpha</th></tr></thead><tbody>';
    for (var wi = 0; wi < wf.windows.length; wi++) {
      var w = wf.windows[wi];
      h += '<tr><td>' + w.startDate + ' \u2192 ' + w.endDate.slice(5) + '</td>';
      h += '<td>' + pct(w.eodCum, 1) + '</td>';
      h += '<td>' + pct(w.altCum, 1) + '</td>';
      h += '<td class="' + (w.win ? 'pos' : 'neg') + '">' + pct(w.alpha, 1) + (w.win ? ' +' : ' \u2212') + '</td></tr>';
    }
    h += '</tbody></table>';
    var vClass = s.verdict === 'CONSISTENT' ? 'rec-add' : s.verdict === 'EPISODIC' ? 'rec-keep' : 'rec-warn';
    var vDesc = s.verdict === 'CONSISTENT' ? 'Alpha is persistent and reliable'
      : s.verdict === 'EPISODIC' ? 'Alpha is real but regime-dependent'
      : 'Alpha concentrated in few windows \u2014 likely curve-fitted';
    h += '<div class="' + vClass + '" style="margin-top:8px"><strong>' + s.verdict + '</strong> \u2014 ';
    h += s.wins + '/' + s.total + ' windows (' + (s.winRate * 100).toFixed(1) + '%)';
    h += ' | Avg alpha: ' + pct(s.avgAlpha, 2);
    if (s.total >= 3) h += ' | Recent: ' + s.recentWins + '/' + Math.min(3, s.total) + ' wins';
    h += '<div style="margin-top:4px;font-size:12px;opacity:0.7">' + vDesc + '</div></div>';
    h += '</div>';
    return h;
  }

  var body = '';

  // Header
  body += '<div class="header">';
  body += '<h1>' + esc(r.name) + '</h1>';
  body += '<div class="meta">' + modeLabel + ' &nbsp;\u00B7&nbsp; ' + r.tradingDays + ' trading days &nbsp;\u00B7&nbsp; ' + dateRange(r.dateRange) + '</div>';
  body += '<div class="meta" style="margin-top:4px">Generated ' + esc(runDate) + ' &nbsp;\u00B7&nbsp; ID: ' + esc(r.id) + '</div>';
  body += '</div>';

  // EOD baseline
  body += '<div class="section">';
  body += '<div class="section-title">Baseline (EOD ' + esc(eodTime) + ')</div>';
  body += '<div class="baseline">Return: <span class="' + cls(r.eod.cumReturn) + '">' + pct(r.eod.cumReturn, 2) + '</span>';
  body += ' &nbsp;\u00B7&nbsp; Max Drawdown: <span class="neg">' + r.eod.maxDD.toFixed(2) + '%</span></div>';
  body += '</div>';

  if (mode === 'dual' || mode === 'single') {
    // Time-by-time table
    var times = r.times || {};
    var timeKeys = testTimes.length > 0 ? testTimes : Object.keys(times).sort();
    body += '<div class="section">';
    body += '<div class="section-title">Results by Time</div>';
    body += '<table><thead><tr><th>Time</th><th>Cum Return</th><th>vs EOD</th><th>Max Drawdown</th><th>DD vs EOD</th></tr></thead><tbody>';
    for (var i = 0; i < timeKeys.length; i++) {
      var time = timeKeys[i];
      if (!times[time]) continue;
      var t = times[time];
      var isBest = time === r.bestTime;
      var ddChg = t.maxDD - r.eod.maxDD;
      body += '<tr class="' + (isBest ? 'best' : '') + '">';
      body += '<td>' + time + (isBest ? ' <span class="badge">BEST</span>' : '') + '</td>';
      body += '<td>' + pct(t.cumReturn, 2) + '</td>';
      body += '<td class="' + cls(t.improvement) + '">' + pct(t.improvement, 2) + '</td>';
      body += '<td>' + t.maxDD.toFixed(2) + '%</td>';
      body += '<td class="' + ddCls2(ddChg) + '">' + pct(ddChg, 2) + '</td>';
      body += '</tr>';
    }
    body += '</tbody></table>';
    body += '</div>';

    // Recommendation
    var recClass = r.recommendation === 'ADD_MORNING' || r.recommendation === 'USE_MORNING' ? 'rec-add'
      : r.recommendation === 'STICK_EOD' ? 'rec-warn' : 'rec-keep';
    var recText = r.recommendation === 'ADD_MORNING' ? 'Consider adding intraday trade at ' + r.bestTime + ' (' + pct(r.bestImprovement, 1) + ' improvement)'
      : r.recommendation === 'USE_MORNING' ? 'Consider switching to ' + r.bestTime + ' (' + pct(r.bestImprovement, 1) + ' vs EOD)'
      : r.recommendation === 'STICK_EOD' ? 'Stick with EOD-only \u2014 ' + mode + '-time shows worse results'
      : r.recommendation === 'KEEP_EOD' ? 'Keep default EOD execution'
      : 'Marginal difference \u2014 EOD-only is simpler';
    body += '<div class="' + recClass + '">' + recText + '</div>';

    // Composite score breakdown
    if (r.compositeScores && r.bestTime && r.compositeScores[r.bestTime]) {
      var cs = r.compositeScores[r.bestTime];
      var wfPart = cs.wfScore !== null ? ' &middot; WF ' + cs.wfScore : '';
      body += '<div class="meta" style="margin-top:6px;font-size:12px">Selection score: <strong>' + cs.total + '/100</strong> (Return ' + cs.returnScore + ', DD ' + cs.ddScore + ', Neighbors ' + cs.neighborScore + wfPart + ')</div>';
    }

    // Walk-forward
    if (r.walkforward) {
      var wfLabel = mode === 'dual' ? 'Dual' : '@' + r.bestTime;
      body += buildWalkforwardSection(r.walkforward, wfLabel);
    }

    // Hint to run combined for tier assessment
    if (r.bestImprovement > 0) {
      body += '<div class="rec-keep" style="margin-top:12px;font-size:12px;opacity:0.8">Run <strong>combined</strong> mode with walk-forward for a full robustness tier assessment (peak shape + dual/single agreement + WF validation)</div>';
    }

  } else if (mode === 'combined') {
    // Robustness Tier badge
    if (analyzer.computeRobustnessTier) {
      var tier = analyzer.computeRobustnessTier(r, testTimes);
      var tierBg = { 1: 'rgba(63,185,80,0.15)', 2: 'rgba(88,166,255,0.15)', 3: 'rgba(210,153,34,0.15)', 4: 'rgba(248,81,73,0.15)' };
      var tierBorder = { 1: 'rgba(63,185,80,0.4)', 2: 'rgba(88,166,255,0.4)', 3: 'rgba(210,153,34,0.4)', 4: 'rgba(248,81,73,0.4)' };
      var tierColor = { 1: '#3fb950', 2: '#58a6ff', 3: '#d29922', 4: '#f85149' };
      body += '<div class="section" style="background:' + tierBg[tier.tier] + ';border:1px solid ' + tierBorder[tier.tier] + ';border-radius:8px;padding:16px">';
      body += '<div style="font-size:18px;font-weight:700;color:' + tierColor[tier.tier] + '">T' + tier.tier + ' \u2014 ' + tier.tierLabel + ' <span style="font-size:14px;font-weight:400;opacity:0.8">(score ' + tier.totalScore + '/9)</span></div>';
      body += '<div style="margin-top:8px;font-size:13px;color:#e6edf3">';
      body += 'Peak Shape: <strong>' + tier.peak.label + '</strong> (' + tier.peak.score + '/3) \u2014 ' + esc(tier.peak.detail);
      body += ' &nbsp;\u00B7&nbsp; Dual/Single: <strong>' + tier.agreement.label + '</strong> (' + tier.agreement.score + '/3) \u2014 ' + esc(tier.agreement.detail);
      body += ' &nbsp;\u00B7&nbsp; Walk-Forward: <strong>' + tier.walkforward.label + '</strong> (' + tier.walkforward.score + '/3) \u2014 ' + esc(tier.walkforward.detail);
      body += '</div></div>';
    }

    // Summary: best of each mode
    body += '<div class="section">';
    body += '<div class="section-title">Best of Each Mode</div>';
    var eodBase = r.eod.cumReturn;
    var dRelPct = eodBase !== 0 ? (r.dual.improvement / Math.abs(eodBase)) * 100 : 0;
    var sRelPct = eodBase !== 0 ? (r.single.improvement / Math.abs(eodBase)) * 100 : 0;
    body += '<table><thead><tr><th>Mode</th><th>Best Time</th><th>Return</th><th>vs EOD</th><th>% of EOD</th><th>Max DD</th><th>DD vs EOD</th></tr></thead><tbody>';
    body += '<tr><td>Dual (Intraday + EOD)</td><td>' + r.dual.bestTime + '</td>';
    body += '<td>' + pct(r.dual.bestReturn, 2) + '</td>';
    body += '<td class="' + cls(r.dual.improvement) + '">' + pct(r.dual.improvement, 2) + '</td>';
    body += '<td class="' + cls(dRelPct) + '">' + pct(dRelPct, 0) + '</td>';
    body += '<td>' + r.dual.bestDD.toFixed(2) + '%</td>';
    body += '<td class="' + ddCls2(r.dual.bestDD - r.eod.maxDD) + '">' + pct(r.dual.bestDD - r.eod.maxDD, 2) + '</td></tr>';
    body += '<tr><td>Single (Replace EOD)</td><td>' + r.single.bestTime + '</td>';
    body += '<td>' + pct(r.single.bestReturn, 2) + '</td>';
    body += '<td class="' + cls(r.single.improvement) + '">' + pct(r.single.improvement, 2) + '</td>';
    body += '<td class="' + cls(sRelPct) + '">' + pct(sRelPct, 0) + '</td>';
    body += '<td>' + r.single.bestDD.toFixed(2) + '%</td>';
    body += '<td class="' + ddCls2(r.single.bestDD - r.eod.maxDD) + '">' + pct(r.single.bestDD - r.eod.maxDD, 2) + '</td></tr>';
    body += '</tbody></table>';
    body += '</div>';

    // Dual breakdown
    if (r.dual.times && Object.keys(r.dual.times).length > 0) {
      var dualKeys = testTimes.length > 0 ? testTimes : Object.keys(r.dual.times).sort();
      body += '<div class="section">';
      body += '<div class="section-title">Dual \u2014 All Times (Intraday + EOD)</div>';
      body += '<table><thead><tr><th>Time</th><th>Cum Return</th><th>vs EOD</th><th>% of EOD</th><th>Max Drawdown</th><th>DD vs EOD</th></tr></thead><tbody>';
      for (var di = 0; di < dualKeys.length; di++) {
        var dt = dualKeys[di];
        if (!r.dual.times[dt]) continue;
        var dv = r.dual.times[dt];
        var dBest = dt === r.dual.bestTime;
        var dDDChg = dv.maxDD - r.eod.maxDD;
        var dRelPct2 = eodBase !== 0 ? (dv.improvement / Math.abs(eodBase)) * 100 : 0;
        body += '<tr class="' + (dBest ? 'best' : '') + '">';
        body += '<td>' + dt + (dBest ? ' <span class="badge">BEST</span>' : '') + '</td>';
        body += '<td>' + pct(dv.cumReturn, 2) + '</td>';
        body += '<td class="' + cls(dv.improvement) + '">' + pct(dv.improvement, 2) + '</td>';
        body += '<td class="' + cls(dRelPct2) + '">' + pct(dRelPct2, 0) + '</td>';
        body += '<td>' + dv.maxDD.toFixed(2) + '%</td>';
        body += '<td class="' + ddCls2(dDDChg) + '">' + pct(dDDChg, 2) + '</td></tr>';
      }
      body += '</tbody></table>';
      body += '</div>';
    }

    // Single breakdown
    if (r.single.times && Object.keys(r.single.times).length > 0) {
      var singleKeys = testTimes.length > 0 ? testTimes : Object.keys(r.single.times).sort();
      body += '<div class="section">';
      body += '<div class="section-title">Single \u2014 All Times (Replace EOD)</div>';
      body += '<table><thead><tr><th>Time</th><th>Cum Return</th><th>vs EOD</th><th>% of EOD</th><th>Max Drawdown</th><th>DD vs EOD</th></tr></thead><tbody>';
      for (var si = 0; si < singleKeys.length; si++) {
        var st = singleKeys[si];
        if (!r.single.times[st]) continue;
        var sv = r.single.times[st];
        var sBest = st === r.single.bestTime;
        var sDDChg = sv.maxDD - r.eod.maxDD;
        var sRelPct2 = eodBase !== 0 ? (sv.improvement / Math.abs(eodBase)) * 100 : 0;
        body += '<tr class="' + (sBest ? 'best' : '') + '">';
        body += '<td>' + st + (sBest ? ' <span class="badge">BEST</span>' : '') + '</td>';
        body += '<td>' + pct(sv.cumReturn, 2) + '</td>';
        body += '<td class="' + cls(sv.improvement) + '">' + pct(sv.improvement, 2) + '</td>';
        body += '<td class="' + cls(sRelPct2) + '">' + pct(sRelPct2, 0) + '</td>';
        body += '<td>' + sv.maxDD.toFixed(2) + '%</td>';
        body += '<td class="' + ddCls2(sDDChg) + '">' + pct(sDDChg, 2) + '</td></tr>';
      }
      body += '</tbody></table>';
      body += '</div>';
    }

    // Combined recommendation
    var dualBetter = r.dual.improvement >= r.single.improvement;
    var bestMode = dualBetter ? 'Dual' : 'Single';
    var bestImp = dualBetter ? r.dual.improvement : r.single.improvement;
    var cRecClass = bestImp > 5 ? 'rec-add' : bestImp < -5 ? 'rec-warn' : 'rec-keep';
    var cRecText = bestImp > 5 ? bestMode + ' mode shows ' + pct(bestImp, 1) + ' improvement'
      : bestImp < -5 ? 'Both modes show worse results \u2014 keep EOD'
      : 'Marginal difference \u2014 EOD-only is simpler';
    body += '<div class="' + cRecClass + '">' + cRecText + '</div>';

    // Composite score breakdowns
    var cParts = [];
    if (r.dual && r.dual.compositeScores && r.dual.bestTime && r.dual.compositeScores[r.dual.bestTime]) {
      var dcs = r.dual.compositeScores[r.dual.bestTime];
      var dwfP = dcs.wfScore !== null ? ' &middot; WF ' + dcs.wfScore : '';
      cParts.push('Dual @ ' + r.dual.bestTime + ': <strong>' + dcs.total + '/100</strong> (Ret ' + dcs.returnScore + ', DD ' + dcs.ddScore + ', Nbr ' + dcs.neighborScore + dwfP + ')');
    }
    if (r.single && r.single.compositeScores && r.single.bestTime && r.single.compositeScores[r.single.bestTime]) {
      var scs = r.single.compositeScores[r.single.bestTime];
      var swfP = scs.wfScore !== null ? ' &middot; WF ' + scs.wfScore : '';
      cParts.push('Single @ ' + r.single.bestTime + ': <strong>' + scs.total + '/100</strong> (Ret ' + scs.returnScore + ', DD ' + scs.ddScore + ', Nbr ' + scs.neighborScore + swfP + ')');
    }
    if (cParts.length > 0) {
      body += '<div class="meta" style="margin-top:6px;font-size:12px">' + cParts.join(' &nbsp;|&nbsp; ') + '</div>';
    }

    // Walk-forward for combined
    if (r.dual && r.dual.walkforward) {
      body += buildWalkforwardSection(r.dual.walkforward, 'Dual');
    }
    if (r.single && r.single.walkforward) {
      body += buildWalkforwardSection(r.single.walkforward, '@' + r.single.bestTime);
    }
  }

  return '<!DOCTYPE html>\n<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">\n'
    + '<title>' + esc(r.name) + ' \u2014 ' + modeLabel + '</title>\n'
    + '<style>\n'
    + '  * { margin: 0; padding: 0; box-sizing: border-box; }\n'
    + '  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; background: #0d1117; color: #e6edf3; padding: 32px; max-width: 900px; margin: 0 auto; line-height: 1.5; }\n'
    + '  .header { margin-bottom: 24px; padding-bottom: 16px; border-bottom: 1px solid #30363d; }\n'
    + '  .header h1 { font-size: 22px; font-weight: 600; margin-bottom: 6px; }\n'
    + '  .meta { font-size: 13px; color: #8b949e; }\n'
    + '  .section { margin-bottom: 24px; }\n'
    + '  .section-title { font-size: 12px; color: #8b949e; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; margin-bottom: 8px; }\n'
    + '  .baseline { font-size: 15px; }\n'
    + '  table { width: 100%; border-collapse: collapse; font-size: 13px; }\n'
    + '  th { text-align: left; padding: 8px 12px; border-bottom: 2px solid #30363d; color: #8b949e; font-weight: 600; font-size: 11px; text-transform: uppercase; }\n'
    + '  td { padding: 8px 12px; border-bottom: 1px solid #30363d; }\n'
    + '  tr.best { background: rgba(88, 166, 255, 0.08); }\n'
    + '  .badge { display: inline-block; background: #58a6ff; color: #0d1117; font-size: 10px; font-weight: 700; padding: 1px 6px; border-radius: 3px; margin-left: 6px; vertical-align: middle; }\n'
    + '  .pos { color: #3fb950; }\n'
    + '  .neg { color: #f85149; }\n'
    + '  .neutral { color: #8b949e; }\n'
    + '  .rec-add { margin-top: 16px; padding: 12px 16px; border-radius: 8px; font-size: 13px; font-weight: 500; background: rgba(63,185,80,0.1); color: #3fb950; border: 1px solid rgba(63,185,80,0.2); }\n'
    + '  .rec-keep { margin-top: 16px; padding: 12px 16px; border-radius: 8px; font-size: 13px; font-weight: 500; background: rgba(139,148,158,0.1); color: #8b949e; border: 1px solid rgba(139,148,158,0.2); }\n'
    + '  .rec-warn { margin-top: 16px; padding: 12px 16px; border-radius: 8px; font-size: 13px; font-weight: 500; background: rgba(248,81,73,0.1); color: #f85149; border: 1px solid rgba(248,81,73,0.2); }\n'
    + '  .footer { margin-top: 32px; padding-top: 16px; border-top: 1px solid #30363d; font-size: 11px; color: #484f58; }\n'
    + '</style>\n</head><body>\n'
    + body
    + '\n<div class="footer">Intraday Execution Analyzer &nbsp;\u00B7&nbsp; Generated ' + esc(runDate) + '</div>\n'
    + '</body></html>';
}

// ============================================================================
// ROUTE HANDLER
// ============================================================================

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  const json = (data, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(data));
  };

  try {
    // --- Serve frontend ---
    if (pathname === '/' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(FRONTEND_HTML);
      return;
    }

    // --- API: Config status (enhanced with masked key hints) ---
    if (pathname === '/api/config' && req.method === 'GET') {
      const cfg = analyzer.loadConfig();
      json({
        hasAlpacaKeys: analyzer.hasAlpacaKeys(),
        hasComposerKeys: analyzer.hasComposerKeys(),
        alpacaTimeframe: analyzer.CONFIG.ALPACA_TIMEFRAME,
        eodTime: analyzer.CONFIG.EOD_TIME,
        testTimes: analyzer.CONFIG.TEST_TIMES,
        maxIntradayDays: analyzer.CONFIG.MAX_INTRADAY_DAYS,
        dataSource: analyzer.CONFIG.dataSource,
        alpacaKeyHint: maskKey(cfg.apiKey),
        alpacaSecretHint: maskKey(cfg.apiSecret),
        composerKeyHint: maskKey(cfg.composerKeyId),
        composerSecretHint: maskKey(cfg.composerSecret),
      });
      return;
    }

    // --- API: Save API keys ---
    if (pathname === '/api/config' && req.method === 'POST') {
      const body = await parseBody(req);
      const updates = {};
      if (body.alpacaApiKey !== undefined) updates.apiKey = body.alpacaApiKey;
      if (body.alpacaApiSecret !== undefined) updates.apiSecret = body.alpacaApiSecret;
      if (body.composerKeyId !== undefined) updates.composerKeyId = body.composerKeyId;
      if (body.composerSecret !== undefined) updates.composerSecret = body.composerSecret;

      // Load existing, merge, save
      const existing = analyzer.loadConfig();
      const merged = { ...existing, ...updates };
      analyzer.saveConfig(merged);

      // Reload into runtime CONFIG
      analyzer.CONFIG.alpaca = merged;
      analyzer.CONFIG.composer = { keyId: merged.composerKeyId, secret: merged.composerSecret };
      analyzer.CONFIG.dataSource = merged.dataSource || 'auto';
      if (analyzer.hasAlpacaKeys()) {
        analyzer.CONFIG.MAX_INTRADAY_DAYS = analyzer.CONFIG.MAX_INTRADAY_DAYS_ALPACA;
      } else {
        analyzer.CONFIG.MAX_INTRADAY_DAYS = analyzer.CONFIG.MAX_INTRADAY_DAYS_YAHOO;
      }

      json({
        ok: true,
        hasAlpacaKeys: analyzer.hasAlpacaKeys(),
        hasComposerKeys: analyzer.hasComposerKeys(),
      });
      return;
    }

    // --- API: Lookup symphony by ID ---
    const symphonyMatch = pathname.match(/^\/api\/symphony\/([a-zA-Z0-9_-]+)$/);
    if (symphonyMatch && req.method === 'GET') {
      const id = symphonyMatch[1];
      try {
        const symphony = await analyzer.getSymphony(id);
        json({ id, name: symphony.name || id });
      } catch (e) {
        json({ error: 'Symphony not found: ' + e.message }, 404);
      }
      return;
    }

    // --- API: Portfolio strategies ---
    if (pathname === '/api/strategies/portfolio' && req.method === 'GET') {
      if (!analyzer.hasComposerKeys()) return json({ error: 'Composer API keys not configured' }, 400);
      const strategies = await analyzer.getComposerPortfolio();
      json({ strategies });
      return;
    }

    // --- API: Watchlist strategies ---
    if (pathname === '/api/strategies/watchlist' && req.method === 'GET') {
      if (!analyzer.hasComposerKeys()) return json({ error: 'Composer API keys not configured' }, 400);
      const strategies = await analyzer.getComposerWatchlist();
      json({ strategies });
      return;
    }

    // --- API: Drafts strategies ---
    if (pathname === '/api/strategies/drafts' && req.method === 'GET') {
      if (!analyzer.hasComposerKeys()) return json({ error: 'Composer API keys not configured' }, 400);
      const strategies = await analyzer.getComposerDrafts();
      json({ strategies });
      return;
    }

    // --- API: Run analysis (SSE stream) ---
    if (pathname === '/api/analyze' && req.method === 'POST') {
      const body = await parseBody(req);
      const { ids, mode = 'dual', walkforward = false, wfWindowSize, wfStepSize, dateStart, dateEnd } = body || {};

      if (!ids || !Array.isArray(ids) || ids.length === 0) {
        return json({ error: 'ids array required' }, 400);
      }
      if (analysisRunning) {
        return json({ error: 'Analysis already running' }, 409);
      }

      analysisRunning = true;

      // Set walk-forward config for this run
      analyzer.CONFIG.walkforward = !!walkforward;
      if (wfWindowSize) analyzer.CONFIG.wfWindowSize = parseInt(wfWindowSize) || 21;
      if (wfStepSize) analyzer.CONFIG.wfStepSize = parseInt(wfStepSize) || 21;

      // Custom date range (null = use all available data)
      analyzer.CONFIG.dateStart = dateStart && /^\d{4}-\d{2}-\d{2}$/.test(dateStart) ? dateStart : null;
      analyzer.CONFIG.dateEnd = dateEnd && /^\d{4}-\d{2}-\d{2}$/.test(dateEnd) ? dateEnd : null;

      sseHeaders(res);

      const closed = { value: false };
      req.on('close', () => { closed.value = true; });

      try {
        const intradayDays = analyzer.CONFIG.MAX_INTRADAY_DAYS;
        sseSend(res, 'start', { total: ids.length, mode });

        if (mode === 'combined') {
          // Combined runs both dual and single internally, so we run it as a batch
          sseSend(res, 'progress', { current: 1, total: ids.length, phase: 'combined' });
          const results = await analyzer.combinedAnalysis(ids, intradayDays, true);
          for (const r of results) {
            if (closed.value) break;
            // Attach robustness tier for client-side rendering
            if (!r.error && analyzer.computeRobustnessTier) {
              r.tier = analyzer.computeRobustnessTier(r, analyzer.CONFIG.TEST_TIMES);
            }
            sseSend(res, 'result', r);
            saveReport(r, 'combined');
          }
        } else {
          // For dual/single, analyze one at a time for streaming progress
          const fn = mode === 'single' ? analyzer.singleTimeAnalysis : analyzer.dualTimeAnalysis;
          for (let i = 0; i < ids.length; i++) {
            if (closed.value) break;
            sseSend(res, 'progress', { current: i + 1, total: ids.length, id: ids[i] });
            const results = await fn([ids[i]], intradayDays, true);
            sseSend(res, 'result', results[0]);
            saveReport(results[0], mode);
            analyzer.clearTickerDataCache();
          }
        }

        if (!closed.value) {
          sseSend(res, 'complete', { total: ids.length });
          res.end();
        }
      } catch (e) {
        if (!closed.value) {
          sseSend(res, 'error', { message: e.message });
          res.end();
        }
      } finally {
        analysisRunning = false;
        analyzer.CONFIG.walkforward = false;  // Reset after run
        analyzer.CONFIG.dateStart = null;     // Reset custom date range
        analyzer.CONFIG.dateEnd = null;
      }
      return;
    }

    // --- API: Live holdings ---
    if (pathname === '/api/live-holdings' && req.method === 'POST') {
      if (!analyzer.hasComposerKeys()) return json({ error: 'Composer API keys not configured' }, 400);
      const body = await parseBody(req);
      const { ids } = body || {};
      if (!ids || !Array.isArray(ids)) return json({ error: 'ids array required' }, 400);

      const results = [];
      for (const id of ids) {
        try {
          const holdings = await analyzer.getLiveSymphonyHoldings(id);
          results.push({ id, holdings });
        } catch (e) {
          results.push({ id, error: e.message });
        }
      }
      json({ results });
      return;
    }

    // --- API: Quotes ---
    if (pathname === '/api/quotes' && req.method === 'POST') {
      if (!analyzer.hasComposerKeys()) return json({ error: 'Composer API keys not configured' }, 400);
      const body = await parseBody(req);
      const { tickers } = body || {};
      if (!tickers || !Array.isArray(tickers)) return json({ error: 'tickers array required' }, 400);

      const quotes = await analyzer.getPublicQuotes(tickers);
      json({ quotes });
      return;
    }

    // --- API: Update settings (enhanced with testTimes + persistence) ---
    if (pathname === '/api/settings' && req.method === 'POST') {
      if (analysisRunning) {
        return json({ error: 'Cannot change settings while analysis is running' }, 409);
      }
      const body = await parseBody(req);
      const guiUpdates = {};

      if (body.alpacaTimeframe && ['15Min', '5Min'].includes(body.alpacaTimeframe)) {
        analyzer.CONFIG.ALPACA_TIMEFRAME = body.alpacaTimeframe;
        guiUpdates.alpacaTimeframe = body.alpacaTimeframe;
      }
      // Validate EOD time against current timeframe: 15-min only allows 15:45/16:00
      const effectiveTimeframe = body.alpacaTimeframe || analyzer.CONFIG.ALPACA_TIMEFRAME;
      const validEodTimes = effectiveTimeframe === '5Min'
        ? ['15:45', '15:50', '15:55', '16:00']
        : ['15:45', '16:00'];
      if (body.eodTime && validEodTimes.includes(body.eodTime)) {
        analyzer.CONFIG.EOD_TIME = body.eodTime;
        guiUpdates.eodTime = body.eodTime;
      } else if (body.eodTime && !validEodTimes.includes(body.eodTime)) {
        // Snap invalid EOD time to 15:45 (e.g., switching from 5min to 15min with 15:50 selected)
        analyzer.CONFIG.EOD_TIME = '15:45';
        guiUpdates.eodTime = '15:45';
      }
      if (body.testTimes && Array.isArray(body.testTimes) && body.testTimes.length > 0) {
        analyzer.CONFIG.TEST_TIMES = body.testTimes;
        guiUpdates.testTimes = body.testTimes;
      }

      // Persist to gui-settings.json
      if (Object.keys(guiUpdates).length > 0) {
        saveGUISettings(guiUpdates);
      }

      json({
        ok: true,
        alpacaTimeframe: analyzer.CONFIG.ALPACA_TIMEFRAME,
        eodTime: analyzer.CONFIG.EOD_TIME,
        testTimes: analyzer.CONFIG.TEST_TIMES,
      });
      return;
    }

    // 404
    json({ error: 'Not found' }, 404);

  } catch (e) {
    console.error('Request error:', e);
    json({ error: e.message }, 500);
  }
}

// ============================================================================
// FRONTEND HTML (embedded SPA)
// ============================================================================

const FRONTEND_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Intraday Execution Analyzer v2.0</title>
<style>
  :root {
    --bg: #0d1117;
    --surface: #161b22;
    --surface2: #1c2333;
    --border: #30363d;
    --text: #e6edf3;
    --text2: #8b949e;
    --accent: #58a6ff;
    --green: #3fb950;
    --red: #f85149;
    --yellow: #d29922;
    --highlight: #e94560;
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
  }

  /* Header */
  .header {
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    padding: 12px 24px;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .header h1 { font-size: 16px; font-weight: 600; }
  .header h1 span { color: var(--text2); font-weight: 400; font-size: 13px; margin-left: 8px; }
  .header-right { display: flex; align-items: center; gap: 12px; }
  .status-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
  .status-dot.green { background: var(--green); }
  .status-dot.red { background: var(--red); }
  .status-dot.yellow { background: var(--yellow); }
  .status-label { font-size: 12px; color: var(--text2); }
  .settings-btn {
    background: var(--surface2); border: 1px solid var(--border); color: var(--text);
    padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 13px;
  }
  .settings-btn:hover { border-color: var(--accent); }

  /* Layout */
  .layout { display: flex; height: calc(100vh - 49px); }

  /* Sidebar */
  .sidebar {
    width: 320px; min-width: 320px;
    background: var(--surface);
    border-right: 1px solid var(--border);
    display: flex; flex-direction: column;
    overflow: hidden;
  }
  .sidebar-section { padding: 12px 16px; border-bottom: 1px solid var(--border); }
  .sidebar-section label { font-size: 12px; color: var(--text2); text-transform: uppercase; letter-spacing: 0.5px; }

  .source-toggle { display: flex; gap: 0; margin-top: 8px; }
  .source-toggle button {
    flex: 1; padding: 6px; font-size: 13px; border: 1px solid var(--border);
    background: var(--bg); color: var(--text2); cursor: pointer;
  }
  .source-toggle button:first-child { border-radius: 6px 0 0 6px; }
  .source-toggle button:last-child { border-radius: 0 6px 6px 0; }
  .source-toggle button.active { background: var(--accent); color: #fff; border-color: var(--accent); }

  .strategy-list { flex: 1; overflow-y: auto; padding: 4px 0; }
  .strategy-item {
    display: flex; align-items: center; padding: 6px 16px; cursor: pointer;
    font-size: 13px; gap: 8px;
  }
  .strategy-item:hover { background: var(--surface2); }
  .strategy-item input[type="checkbox"] { accent-color: var(--accent); flex-shrink: 0; }
  .strategy-item .name { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .strategy-item .tag { color: var(--yellow); font-size: 10px; flex-shrink: 0; }
  .strategy-item .value { color: var(--text2); font-size: 12px; flex-shrink: 0; }

  .select-controls {
    padding: 8px 16px; border-bottom: 1px solid var(--border);
    display: flex; justify-content: space-between; align-items: center;
  }
  .select-controls button {
    background: none; border: none; color: var(--accent); cursor: pointer;
    font-size: 12px; padding: 2px 4px;
  }
  .select-controls button:hover { text-decoration: underline; }
  .select-controls .count { font-size: 12px; color: var(--text2); }

  /* Add by ID */
  .add-by-id {
    padding: 8px 16px; border-bottom: 1px solid var(--border);
    display: flex; gap: 6px;
  }
  .add-by-id input {
    flex: 1; padding: 6px 10px; background: var(--bg); border: 1px solid var(--border);
    color: var(--text); border-radius: 6px; font-size: 12px;
  }
  .add-by-id input::placeholder { color: var(--text2); }
  .add-by-id button {
    padding: 6px 10px; background: var(--surface2); border: 1px solid var(--border);
    color: var(--accent); border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 600;
    white-space: nowrap;
  }
  .add-by-id button:hover { border-color: var(--accent); }
  .add-by-id button:disabled { opacity: 0.4; cursor: not-allowed; }

  /* Controls */
  .controls { padding: 12px 16px; border-top: 1px solid var(--border); }
  .wf-toggle {
    display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text2);
    cursor: pointer; margin-bottom: 8px; user-select: none;
  }
  .wf-toggle input { accent-color: var(--accent); cursor: pointer; }
  .date-range-row { margin-bottom: 8px; }
  .date-range-toggle {
    display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text2);
    cursor: pointer; user-select: none;
  }
  .date-range-toggle input { accent-color: var(--accent); cursor: pointer; }
  .date-range-inputs {
    display: flex; align-items: center; gap: 6px; margin-top: 6px;
  }
  .date-input {
    flex: 1; padding: 5px 6px; background: var(--bg); border: 1px solid var(--border);
    color: var(--text); border-radius: 4px; font-size: 11px; font-family: inherit;
  }
  .date-input::-webkit-calendar-picker-indicator { filter: invert(0.8); }
  .date-sep { font-size: 11px; color: var(--text2); }
  .mode-select {
    width: 100%; padding: 8px 10px; background: var(--bg); border: 1px solid var(--border);
    color: var(--text); border-radius: 6px; font-size: 13px; margin-bottom: 8px;
  }
  .run-btn {
    width: 100%; padding: 10px; background: var(--accent); color: #fff; border: none;
    border-radius: 6px; font-size: 14px; font-weight: 600; cursor: pointer;
  }
  .run-btn:hover { opacity: 0.9; }
  .run-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .run-btn.running { opacity: 0.85; cursor: wait; }
  .spinner {
    display: inline-block; width: 14px; height: 14px;
    border: 2px solid rgba(255,255,255,0.3); border-top-color: #fff;
    border-radius: 50%; animation: spin 0.8s linear infinite;
    vertical-align: middle; margin-right: 6px;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* Main */
  .main { flex: 1; overflow-y: auto; padding: 20px 24px; }
  .main.empty { display: flex; align-items: center; justify-content: center; }
  .empty-state { text-align: center; color: var(--text2); }
  .empty-state h2 { font-size: 18px; margin-bottom: 8px; color: var(--text); }
  .empty-state p { font-size: 14px; line-height: 1.5; }

  /* Progress bar */
  .progress-bar {
    background: var(--surface); border-top: 1px solid var(--border);
    padding: 10px 24px; display: none; align-items: center; gap: 12px;
  }
  .progress-bar.active { display: flex; }
  .progress-track { flex: 1; height: 6px; background: var(--bg); border-radius: 3px; overflow: hidden; }
  .progress-fill { height: 100%; background: var(--accent); border-radius: 3px; transition: width 0.3s; width: 0%; }
  .progress-text { font-size: 13px; color: var(--text2); white-space: nowrap; min-width: 200px; }

  /* Summary table */
  .summary-section { margin-bottom: 24px; }
  .summary-section h3 { font-size: 14px; margin-bottom: 12px; color: var(--text2); text-transform: uppercase; letter-spacing: 0.5px; }

  .summary-table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .summary-table th {
    text-align: left; padding: 8px 12px; border-bottom: 2px solid var(--border);
    color: var(--text2); font-weight: 600; font-size: 11px; text-transform: uppercase;
    cursor: pointer; user-select: none; white-space: nowrap;
  }
  .summary-table th:hover { color: var(--accent); }
  .summary-table th .sort-arrow { margin-left: 4px; font-size: 10px; }
  .summary-table td { padding: 8px 12px; border-bottom: 1px solid var(--border); }
  .summary-table tr:hover { background: var(--surface2); }
  .summary-table tr.clickable { cursor: pointer; }
  .summary-table .num { text-align: right; font-variant-numeric: tabular-nums; }
  .pos { color: var(--green); }
  .neg { color: var(--red); }
  .neutral { color: var(--text2); }
  .check { color: var(--green); font-weight: bold; }

  /* Detail cards */
  .detail-card {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 8px; margin-bottom: 12px; overflow: hidden;
  }
  .detail-card.expanded .detail-body { display: block; }
  .detail-header {
    padding: 12px 16px; cursor: pointer; display: flex;
    justify-content: space-between; align-items: center;
  }
  .detail-header:hover { background: var(--surface2); }
  .detail-header .name { font-weight: 600; font-size: 14px; }
  .detail-header .meta { font-size: 12px; color: var(--text2); }
  .detail-header .arrow { color: var(--text2); transition: transform 0.2s; }
  .detail-card.expanded .detail-header .arrow { transform: rotate(90deg); }
  .detail-body { display: none; padding: 0 16px 16px; }
  .detail-table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 8px; }
  .detail-table th {
    text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--border);
    color: var(--text2); font-size: 11px;
  }
  .detail-table td { padding: 6px 10px; border-bottom: 1px solid var(--border); }
  .detail-table tr.best { background: rgba(88, 166, 255, 0.08); }
  .detail-info { font-size: 12px; color: var(--text2); margin-top: 4px; }
  .recommendation {
    margin-top: 8px; padding: 8px 12px; border-radius: 6px;
    font-size: 13px; font-weight: 500;
  }
  .recommendation.add { background: rgba(63, 185, 80, 0.1); color: var(--green); border: 1px solid rgba(63, 185, 80, 0.2); }
  .recommendation.keep { background: rgba(139, 148, 158, 0.1); color: var(--text2); border: 1px solid rgba(139, 148, 158, 0.2); }
  .recommendation.warning { background: rgba(248, 81, 73, 0.1); color: var(--red); border: 1px solid rgba(248, 81, 73, 0.2); }

  .error-card {
    background: var(--surface); border: 1px solid var(--border); border-left: 3px solid var(--red);
    border-radius: 8px; padding: 12px 16px; margin-bottom: 12px; font-size: 13px;
  }
  .error-card .name { font-weight: 600; }
  .error-card .msg { color: var(--red); margin-top: 4px; }

  /* Settings Modal — Tabbed */
  .modal-overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,0.6);
    display: none; align-items: center; justify-content: center; z-index: 100;
  }
  .modal-overlay.active { display: flex; }
  .modal {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 12px; padding: 24px; width: 520px; max-width: 90vw;
    max-height: 85vh; display: flex; flex-direction: column;
  }
  .modal h2 { font-size: 16px; margin-bottom: 12px; }

  .modal-tabs {
    display: flex; gap: 0; margin-bottom: 16px; border-bottom: 1px solid var(--border);
  }
  .modal-tabs button {
    flex: 1; padding: 8px 12px; font-size: 13px; background: none; border: none;
    color: var(--text2); cursor: pointer; border-bottom: 2px solid transparent;
  }
  .modal-tabs button.active { color: var(--accent); border-bottom-color: var(--accent); }
  .modal-tabs button:hover { color: var(--text); }

  .tab-content { display: none; overflow-y: auto; flex: 1; }
  .tab-content.active { display: block; }

  .modal-row { margin-bottom: 12px; }
  .modal-row label { display: block; font-size: 12px; color: var(--text2); margin-bottom: 4px; text-transform: uppercase; }
  .modal-row select, .modal-row input[type="text"], .modal-row input[type="password"] {
    width: 100%; padding: 8px 10px; background: var(--bg); border: 1px solid var(--border);
    color: var(--text); border-radius: 6px; font-size: 13px;
  }
  .modal-row .input-wrap {
    position: relative; display: flex; align-items: center;
  }
  .modal-row .input-wrap input { padding-right: 36px; }
  .modal-row .input-wrap .toggle-vis {
    position: absolute; right: 8px; background: none; border: none;
    color: var(--text2); cursor: pointer; font-size: 14px; padding: 2px;
  }
  .modal-row .hint { font-size: 11px; color: var(--text2); margin-top: 2px; }

  .modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }
  .modal-actions button {
    padding: 8px 16px; border-radius: 6px; font-size: 13px; cursor: pointer; border: 1px solid var(--border);
  }
  .modal-actions .cancel { background: var(--bg); color: var(--text); }
  .modal-actions .save { background: var(--accent); color: #fff; border-color: var(--accent); }

  .save-feedback {
    font-size: 12px; margin-top: 8px; padding: 6px 10px; border-radius: 4px; display: none;
  }
  .save-feedback.success { display: block; background: rgba(63,185,80,0.1); color: var(--green); }
  .save-feedback.error { display: block; background: rgba(248,81,73,0.1); color: var(--red); }

  /* Test times grid */
  .times-grid {
    display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px;
    max-height: 300px; overflow-y: auto; padding: 4px 0;
  }
  .times-grid label {
    display: flex; align-items: center; gap: 4px; font-size: 12px;
    color: var(--text); padding: 4px 6px; border-radius: 4px; cursor: pointer;
    text-transform: none; letter-spacing: 0;
  }
  .times-grid label:hover { background: var(--surface2); }
  .times-grid input[type="checkbox"] { accent-color: var(--accent); }
  .times-header {
    display: flex; justify-content: space-between; align-items: center;
    margin-bottom: 8px;
  }
  .times-header .times-count { font-size: 12px; color: var(--text2); }
  .times-header button {
    font-size: 12px; background: none; border: none; color: var(--accent);
    cursor: pointer; padding: 2px 4px;
  }
  .times-header button:hover { text-decoration: underline; }

  /* Config status bar in sidebar */
  .config-status { padding: 8px 16px; font-size: 11px; color: var(--text2); border-bottom: 1px solid var(--border); }
  .config-status .row { display: flex; align-items: center; gap: 6px; margin-bottom: 2px; }

  /* Search */
  .search-box {
    padding: 8px 16px; border-bottom: 1px solid var(--border);
  }
  .search-box input {
    width: 100%; padding: 6px 10px; background: var(--bg); border: 1px solid var(--border);
    color: var(--text); border-radius: 6px; font-size: 13px;
  }
  .search-box input::placeholder { color: var(--text2); }

  /* Scrollbar */
  ::-webkit-scrollbar { width: 8px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
  ::-webkit-scrollbar-thumb:hover { background: var(--text2); }
</style>
</head>
<body>

<div class="header">
  <h1>Intraday Execution Analyzer <span>v2.0</span></h1>
  <div class="header-right">
    <span class="status-dot" id="alpacaDot"></span>
    <span class="status-label" id="alpacaLabel">Alpaca</span>
    <span class="status-dot" id="composerDot"></span>
    <span class="status-label" id="composerLabel">Composer</span>
    <button class="settings-btn" onclick="openSettings()">Settings</button>
  </div>
</div>

<div class="layout">
  <div class="sidebar">
    <div class="sidebar-section">
      <label>Strategy Source</label>
      <div class="source-toggle">
        <button id="srcPortfolio" class="active" onclick="loadStrategies('portfolio')">Portfolio</button>
        <button id="srcWatchlist" onclick="loadStrategies('watchlist')">Watchlist</button>
        <button id="srcDrafts" onclick="loadStrategies('drafts')">Drafts</button>
      </div>
    </div>

    <div class="config-status" id="configStatus"></div>

    <div class="search-box">
      <input type="text" id="searchInput" placeholder="Filter strategies..." oninput="filterStrategies()">
    </div>

    <div class="add-by-id">
      <input type="text" id="addIdInput" placeholder="Enter Symphony ID..." onkeydown="if(event.key==='Enter')addById()">
      <button id="addIdBtn" onclick="addById()">+ Add</button>
    </div>

    <div class="select-controls">
      <div>
        <button onclick="selectAll()">Select All</button>
        <button onclick="selectNone()">Deselect All</button>
      </div>
      <span class="count" id="selectionCount">0 selected</span>
    </div>

    <div class="strategy-list" id="strategyList"></div>

    <div class="controls">
      <select class="mode-select" id="modeSelect">
        <option value="dual">Dual Time (Intraday + EOD)</option>
        <option value="single">Single Time (Replace EOD)</option>
        <option value="combined">Combined (Both Analyses)</option>
      </select>
      <label class="wf-toggle" title="Compute walk-forward consistency for the best time">
        <input type="checkbox" id="wfToggle" checked> Walk-Forward
      </label>
      <div class="date-range-row">
        <label class="date-range-toggle" title="Limit analysis to a specific date range">
          <input type="checkbox" id="dateRangeToggle" onchange="toggleDateRange()"> Custom Date Range
        </label>
        <div class="date-range-inputs" id="dateRangeInputs" style="display:none">
          <input type="date" id="dateStart" class="date-input" title="Start date">
          <span class="date-sep">to</span>
          <input type="date" id="dateEnd" class="date-input" title="End date">
        </div>
      </div>
      <button class="run-btn" id="runBtn" onclick="runAnalysis()" disabled>Run Analysis</button>
    </div>
  </div>

  <div class="main empty" id="mainArea">
    <div class="empty-state" id="emptyState">
      <h2>Select strategies to analyze</h2>
      <p>Load your portfolio, watchlist, or drafts from the sidebar,<br>select strategies, choose an analysis mode, and click Run.</p>
    </div>
    <div id="resultsArea" style="display:none"></div>
  </div>
</div>

<div class="progress-bar" id="progressBar">
  <div class="progress-track"><div class="progress-fill" id="progressFill"></div></div>
  <span class="progress-text" id="progressText">Ready</span>
</div>

<!-- Settings Modal (Tabbed) -->
<div class="modal-overlay" id="settingsModal">
  <div class="modal">
    <h2>Settings</h2>
    <div class="modal-tabs">
      <button class="active" onclick="switchTab('general')">General</button>
      <button onclick="switchTab('apikeys')">API Keys</button>
      <button onclick="switchTab('testtimes')">Test Times</button>
    </div>

    <!-- General Tab -->
    <div class="tab-content active" id="tab-general">
      <div class="modal-row">
        <label>Bar Size (Alpaca)</label>
        <select id="settingTimeframe" onchange="onTimeframeChange()">
          <option value="15Min">15-Min Bars (Fast)</option>
          <option value="5Min">5-Min Bars (Precise)</option>
        </select>
      </div>
      <div class="modal-row">
        <label>EOD Time</label>
        <select id="settingEod"></select>
      </div>
      <div class="modal-actions">
        <button class="cancel" onclick="closeSettings()">Cancel</button>
        <button class="save" onclick="saveGeneralSettings()">Save</button>
      </div>
    </div>

    <!-- API Keys Tab -->
    <div class="tab-content" id="tab-apikeys">
      <div class="modal-row">
        <label>Alpaca API Key</label>
        <div class="input-wrap">
          <input type="password" id="keyAlpacaKey" placeholder="PK...">
          <button class="toggle-vis" onclick="toggleVis(this)">Show</button>
        </div>
        <div class="hint" id="hintAlpacaKey"></div>
      </div>
      <div class="modal-row">
        <label>Alpaca API Secret</label>
        <div class="input-wrap">
          <input type="password" id="keyAlpacaSecret" placeholder="">
          <button class="toggle-vis" onclick="toggleVis(this)">Show</button>
        </div>
        <div class="hint" id="hintAlpacaSecret"></div>
      </div>
      <div class="modal-row">
        <label>Composer Key ID</label>
        <div class="input-wrap">
          <input type="password" id="keyComposerKeyId" placeholder="">
          <button class="toggle-vis" onclick="toggleVis(this)">Show</button>
        </div>
        <div class="hint" id="hintComposerKeyId"></div>
      </div>
      <div class="modal-row">
        <label>Composer Secret</label>
        <div class="input-wrap">
          <input type="password" id="keyComposerSecret" placeholder="">
          <button class="toggle-vis" onclick="toggleVis(this)">Show</button>
        </div>
        <div class="hint" id="hintComposerSecret"></div>
      </div>
      <div class="modal-actions">
        <button class="cancel" onclick="closeSettings()">Cancel</button>
        <button class="save" onclick="saveApiKeys()">Save API Keys</button>
      </div>
      <div class="save-feedback" id="apiKeysFeedback"></div>
    </div>

    <!-- Test Times Tab -->
    <div class="tab-content" id="tab-testtimes">
      <div class="times-header">
        <span class="times-count" id="timesCount">0 selected</span>
        <button onclick="selectAllTestTimes()">Select All</button>
        <button onclick="resetTestTimes()">Reset to Defaults</button>
      </div>
      <div class="times-grid" id="timesGrid"></div>
      <div class="modal-actions">
        <button class="cancel" onclick="closeSettings()">Cancel</button>
        <button class="save" onclick="saveTestTimes()">Save Times</button>
      </div>
      <div class="save-feedback" id="timesFeedback"></div>
    </div>
  </div>
</div>

<script>
// ============================================================================
// STATE
// ============================================================================

let strategies = [];
let manualStrategies = []; // Added via "Add by ID", persist across source switches
let selectedIds = new Set();
let currentSource = 'portfolio';
let config = {};
let allResults = [];
let sortCol = null;
let sortDir = 1;

const DEFAULT_TEST_TIMES = ['09:30', '09:35', '09:45', '10:00', '10:30', '11:00', '12:00', '13:00', '13:45'];

// ============================================================================
// INIT
// ============================================================================

async function init() {
  try {
    const resp = await fetch('/api/config');
    config = await resp.json();
    updateConfigUI();
    // Auto-load portfolio
    if (config.hasComposerKeys) {
      loadStrategies('portfolio');
    }
  } catch (e) {
    console.error('Failed to load config:', e);
  }
}

function updateConfigUI() {
  const aDot = document.getElementById('alpacaDot');
  const cDot = document.getElementById('composerDot');
  aDot.className = 'status-dot ' + (config.hasAlpacaKeys ? 'green' : 'red');
  cDot.className = 'status-dot ' + (config.hasComposerKeys ? 'green' : 'red');

  const testTimesCount = (config.testTimes || []).length;
  const status = document.getElementById('configStatus');
  status.innerHTML = [
    '<div class="row"><span class="status-dot ' + (config.hasAlpacaKeys ? 'green' : 'red') + '"></span> Alpaca: ' + (config.hasAlpacaKeys ? 'Connected' : 'Not configured') + '</div>',
    '<div class="row"><span class="status-dot ' + (config.hasComposerKeys ? 'green' : 'red') + '"></span> Composer: ' + (config.hasComposerKeys ? 'Connected' : 'Not configured') + '</div>',
    '<div class="row">Bars: ' + (config.alpacaTimeframe || '15Min') + ' | EOD: ' + (config.eodTime || '15:45') + ' | Times: ' + testTimesCount + '</div>',
  ].join('');

  // Settings modal - General tab
  document.getElementById('settingTimeframe').value = config.alpacaTimeframe || '15Min';
  buildEodOptions();

  // API Keys tab hints
  if (config.alpacaKeyHint) document.getElementById('hintAlpacaKey').textContent = 'Current: ' + config.alpacaKeyHint;
  if (config.alpacaSecretHint) document.getElementById('hintAlpacaSecret').textContent = 'Current: ' + config.alpacaSecretHint;
  if (config.composerKeyHint) document.getElementById('hintComposerKeyId').textContent = 'Current: ' + config.composerKeyHint;
  if (config.composerSecretHint) document.getElementById('hintComposerSecret').textContent = 'Current: ' + config.composerSecretHint;

  // Test times grid
  buildTimesGrid();
}

// ============================================================================
// TABS
// ============================================================================

function switchTab(tabName) {
  document.querySelectorAll('.modal-tabs button').forEach(function(btn) { btn.classList.remove('active'); });
  document.querySelectorAll('.tab-content').forEach(function(tc) { tc.classList.remove('active'); });

  var tabs = document.querySelectorAll('.modal-tabs button');
  var idx = tabName === 'general' ? 0 : tabName === 'apikeys' ? 1 : 2;
  tabs[idx].classList.add('active');
  document.getElementById('tab-' + tabName).classList.add('active');
}

// ============================================================================
// STRATEGIES
// ============================================================================

async function loadStrategies(source) {
  currentSource = source;
  document.getElementById('srcPortfolio').className = source === 'portfolio' ? 'active' : '';
  document.getElementById('srcWatchlist').className = source === 'watchlist' ? 'active' : '';
  document.getElementById('srcDrafts').className = source === 'drafts' ? 'active' : '';

  var list = document.getElementById('strategyList');
  list.innerHTML = '<div style="padding:16px;color:var(--text2);font-size:13px">Loading...</div>';

  try {
    var resp = await fetch('/api/strategies/' + source);
    var data = await resp.json();
    if (data.error) throw new Error(data.error);
    strategies = data.strategies || [];
    strategies.sort(function(a, b) { return (a.name || '').localeCompare(b.name || ''); });
    selectedIds.clear();
    renderStrategies();
    updateSelectionCount();
  } catch (e) {
    list.innerHTML = '<div style="padding:16px;color:var(--red);font-size:13px">Error: ' + escapeHtml(e.message) + '</div>';
  }
}

function getAllStrategies() {
  // Merge main strategies + manual strategies, dedup by id
  var ids = new Set(strategies.map(function(s) { return s.id; }));
  var combined = strategies.slice();
  manualStrategies.forEach(function(ms) {
    if (!ids.has(ms.id)) {
      combined.push(ms);
      ids.add(ms.id);
    }
  });
  return combined;
}

function renderStrategies() {
  var list = document.getElementById('strategyList');
  var filter = document.getElementById('searchInput').value.toLowerCase();
  var all = getAllStrategies();

  var filtered = filter
    ? all.filter(function(s) { return s.name.toLowerCase().includes(filter) || s.id.toLowerCase().includes(filter); })
    : all;

  if (filtered.length === 0) {
    list.innerHTML = '<div style="padding:16px;color:var(--text2);font-size:13px">No strategies found</div>';
    return;
  }

  list.innerHTML = filtered.map(function(s) {
    var checked = selectedIds.has(s.id) ? 'checked' : '';
    var val = '';
    var tag = s.manual ? '<span class="tag">Manual</span>' : '';
    return '<div class="strategy-item" onclick="toggleStrategy(\\'' + s.id + '\\')">' +
      '<input type="checkbox" ' + checked + ' onclick="event.stopPropagation(); toggleStrategy(\\'' + s.id + '\\')">' +
      '<span class="name" title="' + escapeHtml(s.name) + '">' + escapeHtml(s.name) + '</span>' +
      tag +
      '<span class="value">' + val + '</span></div>';
  }).join('');
}

function toggleStrategy(id) {
  if (selectedIds.has(id)) selectedIds.delete(id);
  else selectedIds.add(id);
  renderStrategies();
  updateSelectionCount();
}

function selectAll() {
  var filter = document.getElementById('searchInput').value.toLowerCase();
  var all = getAllStrategies();
  var filtered = filter
    ? all.filter(function(s) { return s.name.toLowerCase().includes(filter) || s.id.toLowerCase().includes(filter); })
    : all;
  filtered.forEach(function(s) { selectedIds.add(s.id); });
  renderStrategies();
  updateSelectionCount();
}

function selectNone() {
  selectedIds.clear();
  renderStrategies();
  updateSelectionCount();
}

function filterStrategies() {
  renderStrategies();
}

function updateSelectionCount() {
  document.getElementById('selectionCount').textContent = selectedIds.size + ' selected';
  document.getElementById('runBtn').disabled = selectedIds.size === 0;
}

// ============================================================================
// ADD BY ID
// ============================================================================

async function addById() {
  var input = document.getElementById('addIdInput');
  var id = input.value.trim();
  if (!id) return;

  var btn = document.getElementById('addIdBtn');
  btn.disabled = true;
  btn.textContent = '...';

  try {
    var resp = await fetch('/api/symphony/' + encodeURIComponent(id));
    var data = await resp.json();
    if (data.error) throw new Error(data.error);

    var name = data.name || id;
    // Check if already in lists
    var existing = getAllStrategies().find(function(s) { return s.id === id; });
    if (!existing) {
      manualStrategies.push({ id: id, name: name, manual: true });
    }
    selectedIds.add(id);
    input.value = '';
    renderStrategies();
    updateSelectionCount();
  } catch (e) {
    alert('Could not find symphony: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '+ Add';
  }
}

// ============================================================================
// DATE RANGE
// ============================================================================

function toggleDateRange() {
  var on = document.getElementById('dateRangeToggle').checked;
  document.getElementById('dateRangeInputs').style.display = on ? 'flex' : 'none';
  if (!on) {
    document.getElementById('dateStart').value = '';
    document.getElementById('dateEnd').value = '';
  }
}

// ============================================================================
// ANALYSIS
// ============================================================================

async function runAnalysis() {
  var ids = Array.from(selectedIds);
  if (ids.length === 0) return;

  var mode = document.getElementById('modeSelect').value;
  var btn = document.getElementById('runBtn');
  btn.disabled = true;
  btn.classList.add('running');
  btn.innerHTML = '<span class="spinner"></span>Running...';

  allResults = [];
  showResults();

  var progressBar = document.getElementById('progressBar');
  var progressFill = document.getElementById('progressFill');
  var progressText = document.getElementById('progressText');
  progressBar.classList.add('active');
  progressFill.style.width = '0%';
  progressText.textContent = 'Starting analysis...';

  try {
    var wfEnabled = document.getElementById('wfToggle').checked;
    var fetchBody = { ids: ids, mode: mode, walkforward: wfEnabled };
    if (document.getElementById('dateRangeToggle').checked) {
      var ds = document.getElementById('dateStart').value;
      var de = document.getElementById('dateEnd').value;
      if (ds) fetchBody.dateStart = ds;
      if (de) fetchBody.dateEnd = de;
    }
    var response = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fetchBody),
    });

    var reader = response.body.getReader();
    var decoder = new TextDecoder();
    var buffer = '';

    while (true) {
      var chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });

      // Parse SSE events from buffer
      var lines = buffer.split('\\n');
      buffer = lines.pop(); // Keep incomplete line in buffer

      var eventType = null;
      for (var li = 0; li < lines.length; li++) {
        var line = lines[li];
        if (line.startsWith('event: ')) {
          eventType = line.slice(7);
        } else if (line.startsWith('data: ') && eventType) {
          try {
            var evData = JSON.parse(line.slice(6));
            handleSSE(eventType, evData, ids.length);
          } catch (pe) {}
          eventType = null;
        }
      }
    }
  } catch (e) {
    console.error('Analysis error:', e);
    progressText.textContent = 'Error: ' + e.message;
  }

  btn.disabled = false;
  btn.classList.remove('running');
  btn.textContent = 'Run Analysis';
  setTimeout(function() { progressBar.classList.remove('active'); }, 3000);
}

function handleSSE(event, data, total) {
  var progressFill = document.getElementById('progressFill');
  var progressText = document.getElementById('progressText');

  switch (event) {
    case 'start':
      progressText.textContent = 'Starting ' + data.mode + ' analysis of ' + data.total + ' strategies...';
      break;

    case 'progress': {
      var pct = ((data.current - 1) / total * 100).toFixed(0);
      progressFill.style.width = pct + '%';
      var name = getStrategyName(data.id);
      progressText.textContent = 'Analyzing ' + (name || data.id || '...') + ' (' + data.current + '/' + total + ')';
      break;
    }

    case 'result':
      allResults.push(data);
      renderResults();
      progressFill.style.width = ((allResults.length / total) * 100).toFixed(0) + '%';
      break;

    case 'complete':
      progressFill.style.width = '100%';
      progressText.textContent = 'Complete! Analyzed ' + data.total + ' strategies';
      break;

    case 'error':
      progressText.textContent = 'Error: ' + data.message;
      break;
  }
}

function getStrategyName(id) {
  var all = getAllStrategies();
  var s = all.find(function(s) { return s.id === id; });
  return s ? s.name : id;
}

// ============================================================================
// RESULTS RENDERING
// ============================================================================

function showResults() {
  document.getElementById('mainArea').classList.remove('empty');
  document.getElementById('emptyState').style.display = 'none';
  document.getElementById('resultsArea').style.display = 'block';
}

function renderResults() {
  var area = document.getElementById('resultsArea');
  var mode = document.getElementById('modeSelect').value;
  var validResults = allResults.filter(function(r) { return !r.error; });
  var errorResults = allResults.filter(function(r) { return r.error; });

  var html = '';

  // Summary table
  if (validResults.length > 0) {
    html += '<div class="summary-section">';
    html += '<h3>Summary</h3>';

    if (mode === 'combined') {
      html += renderCombinedSummaryTable(validResults);
    } else {
      html += renderSummaryTable(validResults, mode);
    }
    html += '</div>';
  }

  // Error cards
  for (var ei = 0; ei < errorResults.length; ei++) {
    var r = errorResults[ei];
    html += '<div class="error-card">';
    html += '<div class="name">' + escapeHtml(r.name || r.id) + '</div>';
    html += '<div class="msg">' + escapeHtml(r.error) + '</div>';
    html += '</div>';
  }

  // Detail cards
  if (validResults.length > 0) {
    html += '<h3 style="font-size:14px;color:var(--text2);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:12px">Strategy Details</h3>';
    for (var di = 0; di < validResults.length; di++) {
      if (mode === 'combined') {
        html += renderCombinedDetailCard(validResults[di]);
      } else {
        html += renderDetailCard(validResults[di], mode);
      }
    }
  }

  area.innerHTML = html;
}

function renderSummaryTable(results, mode) {
  var cols = [
    { key: 'name', label: 'Strategy', cls: '' },
    { key: 'from', label: 'From', cls: 'num' },
    { key: 'bestTime', label: 'Best Time', cls: 'num' },
    { key: 'ddChg', label: 'DD Chg', cls: 'num' },
    { key: 'eod', label: 'EOD-Only', cls: 'num' },
    { key: 'best', label: 'Best', cls: 'num' },
    { key: 'diff', label: 'Difference', cls: 'num' },
    { key: 'pctImprove', label: '% Improve', cls: 'num' },
  ];

  // Build rows data
  var rows = results.map(function(r) {
    var eodRet = r.eod.cumReturn;
    var bestData = r.times[r.bestTime] || r.eod;
    var bestRet = bestData.cumReturn;
    var diff = r.bestImprovement;
    var pctImprove = eodRet !== 0 ? (diff / Math.abs(eodRet)) * 100 : 0;
    var ddChange = bestData.maxDD - r.eod.maxDD;
    return {
      id: r.id, name: r.name, from: fmtStartDate(r.dateRange), days: r.tradingDays,
      dateRange: r.dateRange, bestTime: r.bestTime,
      ddChg: ddChange, eod: eodRet, best: bestRet, diff: diff, pctImprove: pctImprove,
      highlight: pctImprove > 10, recommendation: r.recommendation,
    };
  });

  // Sort
  if (sortCol) {
    rows.sort(function(a, b) {
      var av = a[sortCol], bv = b[sortCol];
      if (typeof av === 'string') return sortDir * av.localeCompare(bv);
      return sortDir * ((av || 0) - (bv || 0));
    });
  }

  var html = '<table class="summary-table"><thead><tr>';
  for (var ci = 0; ci < cols.length; ci++) {
    var c = cols[ci];
    var arrow = sortCol === c.key ? (sortDir > 0 ? ' \\u25B2' : ' \\u25BC') : '';
    html += '<th class="' + c.cls + '" onclick="sortTable(\\'' + c.key + '\\')">' + c.label + '<span class="sort-arrow">' + arrow + '</span></th>';
  }
  html += '<th></th></tr></thead><tbody>';

  for (var ri = 0; ri < rows.length; ri++) {
    var r = rows[ri];
    html += '<tr class="clickable" onclick="scrollToCard(\\'' + r.id + '\\')">';
    html += '<td title="' + escapeHtml(r.name) + '" style="max-width:250px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escapeHtml(r.name) + '</td>';
    html += '<td class="num" title="' + r.days + ' trading days">' + r.from + '</td>';
    html += '<td class="num">' + r.bestTime + '</td>';
    html += '<td class="num ' + valClass(r.ddChg, true) + '">' + fmtNum(r.ddChg, 0) + '</td>';
    html += '<td class="num ' + valClass(r.eod) + '">' + fmtPct(r.eod, 0) + '</td>';
    html += '<td class="num ' + valClass(r.best) + '">' + fmtPct(r.best, 0) + '</td>';
    html += '<td class="num ' + valClass(r.diff) + '">' + fmtPct(r.diff, 0) + '</td>';
    html += '<td class="num ' + valClass(r.pctImprove) + '">' + fmtPct(r.pctImprove, 1) + '</td>';
    html += '<td>' + (r.highlight ? '<span class="check">\\u2713</span>' : '') + '</td>';
    html += '</tr>';
  }

  html += '</tbody></table>';

  // Summary counts
  var addMorning = rows.filter(function(r) { return r.recommendation === 'ADD_MORNING' || r.recommendation === 'USE_MORNING'; }).length;
  var stickEOD = rows.filter(function(r) { return r.recommendation === 'STICK_EOD' || r.recommendation === 'KEEP_EOD'; }).length;
  var marginal = rows.filter(function(r) { return r.recommendation === 'MARGINAL'; }).length;
  var highlighted = rows.filter(function(r) { return r.highlight; }).length;

  html += '<div style="margin-top:8px;font-size:12px;color:var(--text2)">';
  html += addMorning + ' should use intraday | ' + stickEOD + ' keep EOD | ' + marginal + ' marginal';
  if (highlighted > 0) html += ' | \\u2713 = >10% relative improvement (' + highlighted + ')';
  html += '</div>';

  return html;
}

function renderCombinedSummaryTable(results) {
  var cols = [
    { key: 'name', label: 'Strategy', cls: '' },
    { key: 'from', label: 'From', cls: 'num' },
    { key: 'eod', label: 'EOD-Only', cls: 'num' },
    { key: 'dualTime', label: 'Dual Best', cls: 'num' },
    { key: 'dualRet', label: 'Dual Return', cls: 'num' },
    { key: 'dualImp', label: 'Dual +/-', cls: 'num' },
    { key: 'singleTime', label: 'Single Best', cls: 'num' },
    { key: 'singleRet', label: 'Single Return', cls: 'num' },
    { key: 'singleImp', label: 'Single +/-', cls: 'num' },
    { key: 'tierScore', label: 'Tier', cls: 'num' },
  ];

  var rows = results.map(function(r) {
    var eod = r.eod.cumReturn;
    var dualRelImp = eod !== 0 ? (r.dual.improvement / Math.abs(eod)) * 100 : 0;
    var singleRelImp = eod !== 0 ? (r.single.improvement / Math.abs(eod)) * 100 : 0;
    return {
      id: r.id, name: r.name, from: fmtStartDate(r.dateRange), days: r.tradingDays,
      dateRange: r.dateRange, eod: eod,
      dualTime: r.dual.bestTime, dualRet: r.dual.bestReturn, dualImp: r.dual.improvement, dualRelImp: dualRelImp,
      singleTime: r.single.bestTime, singleRet: r.single.bestReturn, singleImp: r.single.improvement, singleRelImp: singleRelImp,
      tier: r.tier || null, tierScore: r.tier ? r.tier.totalScore : -1,
    };
  });

  if (sortCol) {
    rows.sort(function(a, b) {
      var av = a[sortCol], bv = b[sortCol];
      if (typeof av === 'string') return sortDir * av.localeCompare(bv);
      return sortDir * ((av || 0) - (bv || 0));
    });
  }

  var html = '<table class="summary-table"><thead><tr>';
  for (var ci = 0; ci < cols.length; ci++) {
    var c = cols[ci];
    var arrow = sortCol === c.key ? (sortDir > 0 ? ' \\u25B2' : ' \\u25BC') : '';
    html += '<th class="' + c.cls + '" onclick="sortTable(\\'' + c.key + '\\')">' + c.label + '<span class="sort-arrow">' + arrow + '</span></th>';
  }
  html += '</tr></thead><tbody>';

  for (var ri = 0; ri < rows.length; ri++) {
    var r = rows[ri];
    html += '<tr class="clickable" onclick="scrollToCard(\\'' + r.id + '\\')">';
    html += '<td title="' + escapeHtml(r.name) + '" style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escapeHtml(r.name) + '</td>';
    html += '<td class="num" title="' + r.days + ' trading days">' + r.from + '</td>';
    html += '<td class="num ' + valClass(r.eod) + '">' + fmtPct(r.eod, 0) + '</td>';
    html += '<td class="num">' + r.dualTime + '</td>';
    html += '<td class="num ' + valClass(r.dualRet) + '">' + fmtPct(r.dualRet, 0) + '</td>';
    html += '<td class="num ' + valClass(r.dualImp) + '">' + fmtPct(r.dualImp, 0) + '<br><span style="opacity:0.5;font-size:0.8em">(' + fmtPct(r.dualRelImp, 0) + ' rel)</span></td>';
    html += '<td class="num">' + r.singleTime + '</td>';
    html += '<td class="num ' + valClass(r.singleRet) + '">' + fmtPct(r.singleRet, 0) + '</td>';
    html += '<td class="num ' + valClass(r.singleImp) + '">' + fmtPct(r.singleImp, 0) + '<br><span style="opacity:0.5;font-size:0.8em">(' + fmtPct(r.singleRelImp, 0) + ' rel)</span></td>';
    if (r.tier) {
      var tColors = { 1: '#3fb950', 2: '#58a6ff', 3: '#d29922', 4: '#f85149' };
      var tColor = tColors[r.tier.tier] || '#8b949e';
      html += '<td class="num" style="font-weight:700;color:' + tColor + '">T' + r.tier.tier + '<br><span style="opacity:0.5;font-size:0.8em;font-weight:400">(' + r.tier.totalScore + '/9)</span></td>';
    } else {
      html += '<td class="num">-</td>';
    }
    html += '</tr>';
  }

  html += '</tbody></table>';
  return html;
}

function renderWalkforwardHTML(wf, altLabel) {
  if (!wf || !wf.summary || wf.summary.verdict === 'INSUFFICIENT_DATA') return '';
  var s = wf.summary;

  var html = '<div style="margin-top:16px">';
  html += '<div style="font-size:12px;color:var(--text2);font-weight:600;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px">Walk-Forward Consistency (' + s.total + ' windows)</div>';

  // Windows table
  html += '<table class="detail-table"><thead><tr>';
  html += '<th>Period</th><th>EOD</th><th>' + escapeHtml(altLabel) + '</th><th>Alpha</th>';
  html += '</tr></thead><tbody>';

  for (var wi = 0; wi < wf.windows.length; wi++) {
    var w = wf.windows[wi];
    html += '<tr>';
    html += '<td style="white-space:nowrap">' + w.startDate + ' \\u2192 ' + w.endDate.slice(5) + '</td>';
    html += '<td>' + fmtPct(w.eodCum, 1) + '</td>';
    html += '<td>' + fmtPct(w.altCum, 1) + '</td>';
    html += '<td class="' + (w.win ? 'pos' : 'neg') + '">' + fmtPct(w.alpha, 1) + (w.win ? ' +' : ' \\u2212') + '</td>';
    html += '</tr>';
  }
  html += '</tbody></table>';

  // Verdict
  var vClass = s.verdict === 'CONSISTENT' ? 'add' : s.verdict === 'EPISODIC' ? 'keep' : 'warning';
  var vDesc = s.verdict === 'CONSISTENT' ? 'Alpha is persistent and reliable'
    : s.verdict === 'EPISODIC' ? 'Alpha is real but regime-dependent'
    : 'Alpha concentrated in few windows \\u2014 likely curve-fitted';
  html += '<div class="recommendation ' + vClass + '" style="margin-top:8px">';
  html += '<strong>' + s.verdict + '</strong> \\u2014 ';
  html += s.wins + '/' + s.total + ' windows (' + (s.winRate * 100).toFixed(1) + '%)';
  html += ' | Avg alpha: ' + fmtPct(s.avgAlpha, 2);
  if (s.total >= 3) {
    html += ' | Recent: ' + s.recentWins + '/' + Math.min(3, s.total) + ' wins';
  }
  html += '<div style="margin-top:4px;font-size:12px;opacity:0.8">' + vDesc + '</div>';
  html += '</div></div>';

  return html;
}

function renderDetailCard(r, mode) {
  var eodTime = config.eodTime || '15:45';
  var testTimes = config.testTimes || [];

  var html = '<div class="detail-card" id="card-' + r.id + '">';
  html += '<div class="detail-header" onclick="this.parentElement.classList.toggle(\\'expanded\\')">';
  html += '<div><span class="name">' + escapeHtml(r.name) + '</span>';
  html += '<div class="detail-info">' + r.tradingDays + ' trading days | ' + fmtDateRange(r.dateRange) + '</div></div>';
  html += '<div style="display:flex;align-items:center;gap:12px">';
  html += '<span class="' + valClass(r.bestImprovement) + '" style="font-weight:600">' + fmtPct(r.bestImprovement, 1) + '</span>';
  html += '<span class="arrow">\\u25B6</span></div></div>';

  html += '<div class="detail-body">';

  // EOD baseline
  html += '<div style="margin-bottom:8px;font-size:13px">';
  html += '<strong>Baseline (EOD ' + eodTime + '):</strong> Return: ';
  html += '<span class="' + valClass(r.eod.cumReturn) + '">' + fmtPct(r.eod.cumReturn, 1) + '</span>';
  html += ' | Max DD: <span class="neg">' + r.eod.maxDD.toFixed(1) + '%</span>';
  html += '</div>';

  // Times table
  html += '<table class="detail-table"><thead><tr>';
  html += '<th>Time</th><th>Cum Return</th><th>vs EOD</th><th>Max Drawdown</th><th>DD vs EOD</th>';
  html += '</tr></thead><tbody>';

  for (var ti = 0; ti < testTimes.length; ti++) {
    var time = testTimes[ti];
    if (!r.times[time]) continue;
    var t = r.times[time];
    var isBest = time === r.bestTime;
    var ddChg = t.maxDD - r.eod.maxDD;
    html += '<tr class="' + (isBest ? 'best' : '') + '">';
    html += '<td>' + time + (isBest ? ' (BEST)' : '') + '</td>';
    html += '<td>' + fmtPct(t.cumReturn, 1) + '</td>';
    html += '<td class="' + valClass(t.improvement) + '">' + fmtPct(t.improvement, 1) + '</td>';
    html += '<td>' + t.maxDD.toFixed(1) + '%</td>';
    html += '<td class="' + valClass(ddChg, true) + '">' + fmtNum(ddChg, 1) + '</td>';
    html += '</tr>';
  }

  html += '</tbody></table>';

  // Recommendation
  var recClass = r.recommendation === 'ADD_MORNING' || r.recommendation === 'USE_MORNING' ? 'add'
    : r.recommendation === 'STICK_EOD' ? 'warning' : 'keep';
  var recText = r.recommendation === 'ADD_MORNING' ? 'Consider adding morning trade at ' + r.bestTime + ' (+' + r.bestImprovement.toFixed(1) + '% improvement)'
    : r.recommendation === 'USE_MORNING' ? 'Consider switching to ' + r.bestTime + ' (+' + r.bestImprovement.toFixed(1) + '% vs EOD)'
    : r.recommendation === 'STICK_EOD' ? 'Stick with EOD-only - dual-time shows worse results'
    : r.recommendation === 'KEEP_EOD' ? 'Keep default EOD execution'
    : 'Marginal difference - EOD-only is simpler';
  html += '<div class="recommendation ' + recClass + '">' + recText + '</div>';

  // Composite score breakdown
  if (r.compositeScores && r.bestTime && r.compositeScores[r.bestTime]) {
    var cs = r.compositeScores[r.bestTime];
    var wfPart = cs.wfScore !== null ? ' \\u00B7 WF ' + cs.wfScore : '';
    html += '<div style="margin-top:4px;font-size:11px;color:var(--text2,#8b949e)">Selection score: <strong>' + cs.total + '/100</strong> (Return ' + cs.returnScore + ', DD ' + cs.ddScore + ', Neighbors ' + cs.neighborScore + wfPart + ')</div>';
  }

  // Walk-forward section
  if (r.walkforward) {
    var wfLabel = mode === 'dual' ? 'Dual' : '@' + r.bestTime;
    html += renderWalkforwardHTML(r.walkforward, wfLabel);
  }

  html += '</div></div>';
  return html;
}

function renderCombinedDetailCard(r) {
  var eodTime = config.eodTime || '15:45';
  var testTimes = config.testTimes || [];

  var html = '<div class="detail-card" id="card-' + r.id + '">';
  html += '<div class="detail-header" onclick="this.parentElement.classList.toggle(\\'expanded\\')">';
  html += '<div><span class="name">' + escapeHtml(r.name) + '</span>';
  html += '<div class="detail-info">' + r.tradingDays + ' trading days | ' + fmtDateRange(r.dateRange) + '</div></div>';
  html += '<span class="arrow">\\u25B6</span></div>';

  html += '<div class="detail-body">';
  html += '<div style="margin-bottom:8px;font-size:13px">';
  html += '<strong>Baseline (EOD ' + eodTime + '):</strong> Return: ';
  html += '<span class="' + valClass(r.eod.cumReturn) + '">' + fmtPct(r.eod.cumReturn, 1) + '</span>';
  html += ' | Max DD: <span class="neg">' + r.eod.maxDD.toFixed(1) + '%</span>';
  html += '</div>';

  // Robustness Tier badge (uses pre-computed r.tier from SSE handler)
  if (r.tier) {
    var tier = r.tier;
    var tBg = { 1: 'rgba(63,185,80,0.12)', 2: 'rgba(88,166,255,0.12)', 3: 'rgba(210,153,34,0.12)', 4: 'rgba(248,81,73,0.12)' };
    var tBd = { 1: 'rgba(63,185,80,0.3)', 2: 'rgba(88,166,255,0.3)', 3: 'rgba(210,153,34,0.3)', 4: 'rgba(248,81,73,0.3)' };
    var tCl = { 1: '#3fb950', 2: '#58a6ff', 3: '#d29922', 4: '#f85149' };
    html += '<div style="margin-bottom:10px;padding:10px 12px;border-radius:6px;background:' + tBg[tier.tier] + ';border:1px solid ' + tBd[tier.tier] + '">';
    html += '<span style="font-weight:700;color:' + tCl[tier.tier] + '">T' + tier.tier + ' ' + tier.tierLabel + '</span>';
    html += ' <span style="font-size:12px;opacity:0.7">(' + tier.totalScore + '/9)</span>';
    html += ' <span style="font-size:11px;margin-left:8px">';
    html += 'Peak: ' + tier.peak.score + '/3';
    html += ' \\u00B7 Agreement: ' + tier.agreement.score + '/3';
    html += ' \\u00B7 WF: ' + tier.walkforward.score + '/3';
    html += '</span>';
    html += '<div style="margin-top:6px;font-size:11px;color:var(--text2,#8b949e);line-height:1.6">';
    html += '<div><strong>Peak Shape:</strong> ' + escapeHtml(tier.peak.label) + ' (' + tier.peak.score + '/3) \\u2014 ' + escapeHtml(tier.peak.detail) + '</div>';
    html += '<div><strong>Dual/Single:</strong> ' + escapeHtml(tier.agreement.label) + ' (' + tier.agreement.score + '/3) \\u2014 ' + escapeHtml(tier.agreement.detail) + '</div>';
    html += '<div><strong>Walk-Forward:</strong> ' + escapeHtml(tier.walkforward.label) + ' (' + tier.walkforward.score + '/3) \\u2014 ' + escapeHtml(tier.walkforward.detail) + '</div>';
    html += '</div>';
    html += '<div style="margin-top:6px;padding-top:6px;border-top:1px solid ' + tBd[tier.tier] + ';font-size:10px;opacity:0.5">';
    html += '<span style="color:#3fb950">T1 Robust (7-9)</span> \\u00B7 ';
    html += '<span style="color:#58a6ff">T2 Promising (5-6)</span> \\u00B7 ';
    html += '<span style="color:#d29922">T3 Speculative (3-4)</span> \\u00B7 ';
    html += '<span style="color:#f85149">T4 Avoid (0-2)</span>';
    html += '</div></div>';
  }

  // Summary: best of each mode
  html += '<table class="detail-table"><thead><tr>';
  html += '<th>Mode</th><th>Best Time</th><th>Return</th><th>vs EOD</th><th>% of EOD</th><th>Max DD</th><th>DD vs EOD</th>';
  html += '</tr></thead><tbody>';

  var eodRet = r.eod.cumReturn;
  var dualDDChg = r.dual.bestDD - r.eod.maxDD;
  var dualRelImp = eodRet !== 0 ? (r.dual.improvement / Math.abs(eodRet)) * 100 : 0;
  html += '<tr><td>Dual (Intraday + EOD)</td><td>' + r.dual.bestTime + '</td>';
  html += '<td>' + fmtPct(r.dual.bestReturn, 1) + '</td>';
  html += '<td class="' + valClass(r.dual.improvement) + '">' + fmtPct(r.dual.improvement, 1) + '</td>';
  html += '<td class="' + valClass(dualRelImp) + '">' + fmtPct(dualRelImp, 0) + '</td>';
  html += '<td>' + r.dual.bestDD.toFixed(1) + '%</td>';
  html += '<td class="' + valClass(dualDDChg, true) + '">' + fmtNum(dualDDChg, 1) + '</td></tr>';

  var singleDDChg = r.single.bestDD - r.eod.maxDD;
  var singleRelImp = eodRet !== 0 ? (r.single.improvement / Math.abs(eodRet)) * 100 : 0;
  html += '<tr><td>Single (Replace EOD)</td><td>' + r.single.bestTime + '</td>';
  html += '<td>' + fmtPct(r.single.bestReturn, 1) + '</td>';
  html += '<td class="' + valClass(r.single.improvement) + '">' + fmtPct(r.single.improvement, 1) + '</td>';
  html += '<td class="' + valClass(singleRelImp) + '">' + fmtPct(singleRelImp, 0) + '</td>';
  html += '<td>' + r.single.bestDD.toFixed(1) + '%</td>';
  html += '<td class="' + valClass(singleDDChg, true) + '">' + fmtNum(singleDDChg, 1) + '</td></tr>';

  html += '</tbody></table>';

  // Dual time breakdown
  if (r.dual.times && Object.keys(r.dual.times).length > 0) {
    html += '<div style="margin-top:12px;font-size:12px;color:var(--text2);font-weight:600;text-transform:uppercase;letter-spacing:0.5px">Dual - All Times (Intraday + EOD)</div>';
    html += '<table class="detail-table"><thead><tr>';
    html += '<th>Time</th><th>Cum Return</th><th>vs EOD</th><th>% of EOD</th><th>Max Drawdown</th><th>DD vs EOD</th>';
    html += '</tr></thead><tbody>';
    for (var di = 0; di < testTimes.length; di++) {
      var dt = testTimes[di];
      if (!r.dual.times[dt]) continue;
      var dv = r.dual.times[dt];
      var dIsBest = dt === r.dual.bestTime;
      var dDDChg2 = dv.maxDD - r.eod.maxDD;
      var dRelImp = eodRet !== 0 ? (dv.improvement / Math.abs(eodRet)) * 100 : 0;
      html += '<tr class="' + (dIsBest ? 'best' : '') + '">';
      html += '<td>' + dt + (dIsBest ? ' (BEST)' : '') + '</td>';
      html += '<td>' + fmtPct(dv.cumReturn, 1) + '</td>';
      html += '<td class="' + valClass(dv.improvement) + '">' + fmtPct(dv.improvement, 1) + '</td>';
      html += '<td class="' + valClass(dRelImp) + '">' + fmtPct(dRelImp, 0) + '</td>';
      html += '<td>' + dv.maxDD.toFixed(1) + '%</td>';
      html += '<td class="' + valClass(dDDChg2, true) + '">' + fmtNum(dDDChg2, 1) + '</td>';
      html += '</tr>';
    }
    html += '</tbody></table>';
  }

  // Single time breakdown
  if (r.single.times && Object.keys(r.single.times).length > 0) {
    html += '<div style="margin-top:12px;font-size:12px;color:var(--text2);font-weight:600;text-transform:uppercase;letter-spacing:0.5px">Single - All Times (Replace EOD)</div>';
    html += '<table class="detail-table"><thead><tr>';
    html += '<th>Time</th><th>Cum Return</th><th>vs EOD</th><th>% of EOD</th><th>Max Drawdown</th><th>DD vs EOD</th>';
    html += '</tr></thead><tbody>';
    for (var si = 0; si < testTimes.length; si++) {
      var st = testTimes[si];
      if (!r.single.times[st]) continue;
      var sv = r.single.times[st];
      var sIsBest = st === r.single.bestTime;
      var sDDChg2 = sv.maxDD - r.eod.maxDD;
      var sRelImp = eodRet !== 0 ? (sv.improvement / Math.abs(eodRet)) * 100 : 0;
      html += '<tr class="' + (sIsBest ? 'best' : '') + '">';
      html += '<td>' + st + (sIsBest ? ' (BEST)' : '') + '</td>';
      html += '<td>' + fmtPct(sv.cumReturn, 1) + '</td>';
      html += '<td class="' + valClass(sv.improvement) + '">' + fmtPct(sv.improvement, 1) + '</td>';
      html += '<td class="' + valClass(sRelImp) + '">' + fmtPct(sRelImp, 0) + '</td>';
      html += '<td>' + sv.maxDD.toFixed(1) + '%</td>';
      html += '<td class="' + valClass(sDDChg2, true) + '">' + fmtNum(sDDChg2, 1) + '</td>';
      html += '</tr>';
    }
    html += '</tbody></table>';
  }

  // Best overall
  var dualBetter = r.dual.improvement >= r.single.improvement;
  var bestMode = dualBetter ? 'Dual' : 'Single';
  var bestImp = dualBetter ? r.dual.improvement : r.single.improvement;
  var recClass = bestImp > 5 ? 'add' : bestImp < -5 ? 'warning' : 'keep';
  var recText = bestImp > 5 ? bestMode + ' mode shows ' + fmtPct(bestImp, 1) + ' improvement'
    : bestImp < -5 ? 'Both modes show worse results - keep EOD'
    : 'Marginal difference - EOD-only is simpler';
  html += '<div class="recommendation ' + recClass + '">' + recText + '</div>';

  // Composite score breakdowns for each mode
  var compParts = [];
  if (r.dual && r.dual.compositeScores && r.dual.bestTime && r.dual.compositeScores[r.dual.bestTime]) {
    var dcs = r.dual.compositeScores[r.dual.bestTime];
    var dwf = dcs.wfScore !== null ? ' \\u00B7 WF ' + dcs.wfScore : '';
    compParts.push('Dual @ ' + r.dual.bestTime + ': <strong>' + dcs.total + '/100</strong> (Ret ' + dcs.returnScore + ', DD ' + dcs.ddScore + ', Nbr ' + dcs.neighborScore + dwf + ')');
  }
  if (r.single && r.single.compositeScores && r.single.bestTime && r.single.compositeScores[r.single.bestTime]) {
    var scs = r.single.compositeScores[r.single.bestTime];
    var swf = scs.wfScore !== null ? ' \\u00B7 WF ' + scs.wfScore : '';
    compParts.push('Single @ ' + r.single.bestTime + ': <strong>' + scs.total + '/100</strong> (Ret ' + scs.returnScore + ', DD ' + scs.ddScore + ', Nbr ' + scs.neighborScore + swf + ')');
  }
  if (compParts.length > 0) {
    html += '<div style="margin-top:4px;font-size:11px;color:var(--text2,#8b949e)">' + compParts.join(' &nbsp;|&nbsp; ') + '</div>';
  }

  // Walk-forward sections
  if (r.dual && r.dual.walkforward) {
    html += renderWalkforwardHTML(r.dual.walkforward, 'Dual');
  }
  if (r.single && r.single.walkforward) {
    html += renderWalkforwardHTML(r.single.walkforward, '@' + r.single.bestTime);
  }

  html += '</div></div>';
  return html;
}

// ============================================================================
// TABLE SORTING
// ============================================================================

function sortTable(col) {
  if (sortCol === col) {
    sortDir = -sortDir;
  } else {
    sortCol = col;
    sortDir = col === 'name' ? 1 : -1; // Default descending for numbers
  }
  renderResults();
}

function scrollToCard(id) {
  var card = document.getElementById('card-' + id);
  if (card) {
    card.classList.add('expanded');
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

// ============================================================================
// SETTINGS — General
// ============================================================================

function openSettings() {
  // Reset to general tab
  switchTab('general');
  document.getElementById('settingsModal').classList.add('active');
}

function closeSettings() {
  document.getElementById('settingsModal').classList.remove('active');
  // Clear feedback messages
  document.getElementById('apiKeysFeedback').className = 'save-feedback';
  document.getElementById('apiKeysFeedback').textContent = '';
  document.getElementById('timesFeedback').className = 'save-feedback';
  document.getElementById('timesFeedback').textContent = '';
}

function onTimeframeChange() {
  // Regenerate test times grid and EOD options when timeframe changes
  buildEodOptions();
  buildTimesGrid();
}

function buildEodOptions() {
  var timeframe = document.getElementById('settingTimeframe').value || config.alpacaTimeframe || '15Min';
  var eodSelect = document.getElementById('settingEod');
  var currentVal = eodSelect.value || config.eodTime || '15:45';

  // 15-min mode: only 15:45 and 16:00 produce different prices
  // 5-min mode: all four options are meaningful
  var options = timeframe === '5Min'
    ? ['15:45', '15:50', '15:55', '16:00']
    : ['15:45', '16:00'];

  eodSelect.innerHTML = '';
  options.forEach(function(t) {
    var opt = document.createElement('option');
    opt.value = t;
    opt.textContent = t === '16:00' ? '16:00 (Market Close)' : t;
    eodSelect.appendChild(opt);
  });

  // Preserve current selection if still valid, otherwise snap to nearest
  if (options.includes(currentVal)) {
    eodSelect.value = currentVal;
  } else {
    // Snap 15:50 or 15:55 back to 15:45 when switching to 15-min mode
    eodSelect.value = '15:45';
  }
}

async function saveGeneralSettings() {
  var timeframe = document.getElementById('settingTimeframe').value;
  var eodTime = document.getElementById('settingEod').value;

  try {
    var resp = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alpacaTimeframe: timeframe, eodTime: eodTime }),
    });
    var data = await resp.json();
    config.alpacaTimeframe = data.alpacaTimeframe;
    config.eodTime = data.eodTime;
    if (data.testTimes) config.testTimes = data.testTimes;
    updateConfigUI();
    closeSettings();
  } catch (e) {
    alert('Failed to save settings: ' + e.message);
  }
}

// ============================================================================
// SETTINGS — API Keys
// ============================================================================

function toggleVis(btn) {
  var input = btn.parentElement.querySelector('input');
  if (input.type === 'password') {
    input.type = 'text';
    btn.textContent = 'Hide';
  } else {
    input.type = 'password';
    btn.textContent = 'Show';
  }
}

async function saveApiKeys() {
  var fb = document.getElementById('apiKeysFeedback');
  fb.className = 'save-feedback';
  fb.textContent = '';

  var body = {};
  var v;
  v = document.getElementById('keyAlpacaKey').value.trim();
  if (v) body.alpacaApiKey = v;
  v = document.getElementById('keyAlpacaSecret').value.trim();
  if (v) body.alpacaApiSecret = v;
  v = document.getElementById('keyComposerKeyId').value.trim();
  if (v) body.composerKeyId = v;
  v = document.getElementById('keyComposerSecret').value.trim();
  if (v) body.composerSecret = v;

  if (Object.keys(body).length === 0) {
    fb.className = 'save-feedback error';
    fb.textContent = 'No keys entered';
    return;
  }

  try {
    var resp = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    var data = await resp.json();
    if (data.error) throw new Error(data.error);

    config.hasAlpacaKeys = data.hasAlpacaKeys;
    config.hasComposerKeys = data.hasComposerKeys;

    // Clear inputs
    document.getElementById('keyAlpacaKey').value = '';
    document.getElementById('keyAlpacaSecret').value = '';
    document.getElementById('keyComposerKeyId').value = '';
    document.getElementById('keyComposerSecret').value = '';

    // Refresh config to get new hints
    var cfgResp = await fetch('/api/config');
    config = await cfgResp.json();
    updateConfigUI();

    fb.className = 'save-feedback success';
    fb.textContent = 'API keys saved successfully!';
  } catch (e) {
    fb.className = 'save-feedback error';
    fb.textContent = 'Error: ' + e.message;
  }
}

// ============================================================================
// SETTINGS — Test Times
// ============================================================================

function generateTimeSlots(timeframe) {
  var slots = [];
  var step = timeframe === '5Min' ? 5 : 15;
  // Market hours: 09:30 to 15:55 (for 5min) or 15:45 (for 15min)
  var startH = 9, startM = 30;
  var endH = 15, endM = timeframe === '5Min' ? 55 : 45;

  var h = startH, m = startM;
  while (h < endH || (h === endH && m <= endM)) {
    slots.push(String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0'));
    m += step;
    if (m >= 60) { h++; m -= 60; }
  }
  return slots;
}

function buildTimesGrid() {
  var timeframe = document.getElementById('settingTimeframe').value || config.alpacaTimeframe || '15Min';
  var slots = generateTimeSlots(timeframe);
  var currentTimes = new Set(config.testTimes || DEFAULT_TEST_TIMES);

  var grid = document.getElementById('timesGrid');
  var html = '';
  for (var i = 0; i < slots.length; i++) {
    var t = slots[i];
    var checked = currentTimes.has(t) ? 'checked' : '';
    html += '<label><input type="checkbox" value="' + t + '" ' + checked + ' onchange="updateTimesCount()"> ' + t + '</label>';
  }
  grid.innerHTML = html;
  updateTimesCount();
}

function updateTimesCount() {
  var checked = document.querySelectorAll('#timesGrid input[type="checkbox"]:checked');
  document.getElementById('timesCount').textContent = checked.length + ' selected';
}

function selectAllTestTimes() {
  var checkboxes = document.querySelectorAll('#timesGrid input[type="checkbox"]');
  checkboxes.forEach(function(cb) { cb.checked = true; });
  updateTimesCount();
}

function resetTestTimes() {
  var checkboxes = document.querySelectorAll('#timesGrid input[type="checkbox"]');
  var defaults = new Set(DEFAULT_TEST_TIMES);
  checkboxes.forEach(function(cb) {
    cb.checked = defaults.has(cb.value);
  });
  updateTimesCount();
}

async function saveTestTimes() {
  var fb = document.getElementById('timesFeedback');
  fb.className = 'save-feedback';
  fb.textContent = '';

  var checked = document.querySelectorAll('#timesGrid input[type="checkbox"]:checked');
  var times = [];
  checked.forEach(function(cb) { times.push(cb.value); });
  times.sort();

  if (times.length === 0) {
    fb.className = 'save-feedback error';
    fb.textContent = 'Select at least one time';
    return;
  }

  try {
    var timeframe = document.getElementById('settingTimeframe').value;
    var resp = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ testTimes: times, alpacaTimeframe: timeframe }),
    });
    var data = await resp.json();
    config.testTimes = data.testTimes;
    config.alpacaTimeframe = data.alpacaTimeframe;
    updateConfigUI();

    fb.className = 'save-feedback success';
    fb.textContent = 'Test times saved! (' + times.length + ' times)';
  } catch (e) {
    fb.className = 'save-feedback error';
    fb.textContent = 'Error: ' + e.message;
  }
}

// Close modal on overlay click
document.getElementById('settingsModal').addEventListener('click', function(e) {
  if (e.target === this) closeSettings();
});

// ============================================================================
// HELPERS
// ============================================================================

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtPct(val, decimals) {
  if (val == null || isNaN(val)) return '-';
  return (val >= 0 ? '+' : '') + val.toFixed(decimals) + '%';
}

function fmtNum(val, decimals) {
  if (val == null || isNaN(val)) return '-';
  return (val >= 0 ? '+' : '') + val.toFixed(decimals);
}

function valClass(val, invert) {
  if (val == null || isNaN(val)) return 'neutral';
  if (invert) return val < 0 ? 'pos' : val > 0 ? 'neg' : 'neutral';
  return val > 0 ? 'pos' : val < 0 ? 'neg' : 'neutral';
}

function fmtDate(ymd) {
  // "2024-02-12" → "Feb 12, 2024"
  if (!ymd) return '';
  var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var parts = ymd.split('-');
  if (parts.length !== 3) return ymd;
  return months[parseInt(parts[1],10)-1] + ' ' + parseInt(parts[2],10) + ', ' + parts[0];
}

function fmtDateRange(dateRange) {
  // "2024-02-12 to 2026-02-14" → "Feb 12, 2024 — Feb 14, 2026"
  if (!dateRange) return '';
  var parts = dateRange.split(' to ');
  if (parts.length !== 2) return dateRange;
  return fmtDate(parts[0]) + ' \\u2014 ' + fmtDate(parts[1]);
}

function fmtStartDate(dateRange) {
  // "2024-02-12 to 2026-02-14" → "Feb 12, 2024"
  if (!dateRange) return '';
  return fmtDate(dateRange.split(' to ')[0]);
}

// ============================================================================
// BOOT
// ============================================================================

init();
</script>
<div style="margin-top:32px;padding:16px 24px;border-top:1px solid #30363d;font-size:11px;color:#484f58;text-align:center;line-height:1.5">
  Please note: These results are based on historical backtesting and do not constitute financial advice. Past performance is not indicative of future results. Use at your own risk.
</div>
</body>
</html>`;

// ============================================================================
// START SERVER
// ============================================================================

const server = http.createServer(async (req, res) => {
  try {
    await handleRequest(req, res);
  } catch (e) {
    console.error('Unhandled error:', e);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const guiSettings = loadGUISettings();
  console.log(`\n  Intraday Execution Analyzer - Web GUI`);
  console.log(`  ======================================`);
  console.log(`  Server running at: http://localhost:${PORT}`);
  console.log(`  Alpaca keys:  ${analyzer.hasAlpacaKeys() ? 'Configured' : 'Not configured'}`);
  console.log(`  Composer keys: ${analyzer.hasComposerKeys() ? 'Configured' : 'Not configured'}`);
  console.log(`  Timeframe:    ${analyzer.CONFIG.ALPACA_TIMEFRAME}`);
  console.log(`  Test times:   ${analyzer.CONFIG.TEST_TIMES.length} configured`);
  console.log(`  Data source:  ${analyzer.CONFIG.dataSource}`);
  if (Object.keys(guiSettings).length > 0) {
    console.log(`  GUI settings: Loaded from gui-settings.json`);
  }
  console.log(`\n  Press Ctrl+C to stop\n`);
});
