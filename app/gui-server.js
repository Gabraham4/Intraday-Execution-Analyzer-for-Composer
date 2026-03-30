#!/usr/bin/env node
/**
 * Intraday Execution Analyzer - Web GUI Server
 *
 * Zero-dependency web server that wraps the CLI analyzer with a browser dashboard.
 * Uses only Node.js built-in http module.
 *
 * Usage: node gui-server.js [--port=3100]
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const analyzer = require('./intraday-analyzer-alpaca-v2.0.js');

const PORT = parseInt(process.argv.find(a => a.startsWith('--port='))?.split('=')[1] || process.env.PORT || '3100', 10);

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
  if (saved.baselineSource === 'composer') {
    analyzer.CONFIG.composerBaseline = true;
  }
  if (saved.executionThreshold) {
    const et = parseFloat(saved.executionThreshold);
    analyzer.CONFIG.executionThreshold = et > 0 ? et : null;
  }
  if (saved.takeProfitThreshold) {
    const tp = parseFloat(saved.takeProfitThreshold);
    analyzer.CONFIG.takeProfitThreshold = tp !== 0 ? tp : null;
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

const REPORTS_DIR = path.join(APP_DIR, '..', 'reports');

function sanitizeFilename(name) {
  return name.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, ' ').trim();
}

function saveReport(result, mode) {
  try {
    if (!result || result.error || !result.name) return;
    if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
    // Include settings in filename so different configs don't overwrite each other
    const isComposerBaseline = analyzer.CONFIG.composerBaseline;
    const eod = isComposerBaseline ? 'composer' : ((analyzer.CONFIG && analyzer.CONFIG.EOD_TIME) || '15:45');
    const tf = (analyzer.CONFIG && analyzer.CONFIG.ALPACA_TIMEFRAME) || '15Min';
    const wf = (analyzer.CONFIG && analyzer.CONFIG.walkforward) ? 'wf' : 'nowf';
    const ds = analyzer.CONFIG.dateStart || '';
    const de = analyzer.CONFIG.dateEnd || '';
    const datePart = (ds || de) ? ' ' + (ds || 'start') + '_' + (de || 'end') : '';
    const settings = tf + ' ' + eod.replace(':', '') + ' ' + wf + datePart;
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
    : mode === 'cash' ? 'Cash (Go to Cash Midday)'
    : 'Combined (Dual + Single + Cash)';

  function esc(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function pct(v, d) { if (v == null || isNaN(v)) return '-'; return (v >= 0 ? '+' : '') + v.toFixed(d) + '%'; }
  function cls(v) { if (v == null) return 'neutral'; return v > 0 ? 'pos' : v < 0 ? 'neg' : 'neutral'; }
  function ddCls(dd, baseDD) { if (dd == null || baseDD == null) return 'neutral'; return dd < baseDD ? 'pos' : dd > baseDD ? 'neg' : 'neutral'; }
  function ddCls2(chg) { if (chg == null) return 'neutral'; return chg < 0 ? 'pos' : chg > 0 ? 'neg' : 'neutral'; }
  function ann(cumRet) { // Annualize a cumulative return using the strategy's trading days
    if (cumRet == null || !r.tradingDays || r.tradingDays <= 0) return null;
    var years = r.tradingDays / 252;
    if (years <= 0) return null;
    return (Math.pow(1 + cumRet / 100, 1 / years) - 1) * 100;
  }
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

  function buildSingleWfPanel(wf, altLabel) {
    var s = wf.summary;
    var hasRegime = wf.windows.length > 0 && wf.windows[0].regime;
    var h = '';
    h += '<table><thead><tr><th>Period</th><th>EOD</th><th>' + esc(altLabel) + '</th><th>Alpha</th>';
    if (hasRegime) h += '<th>SPY</th><th>Regime</th>';
    h += '</tr></thead><tbody>';
    for (var wi = 0; wi < wf.windows.length; wi++) {
      var w = wf.windows[wi];
      h += '<tr><td>' + w.startDate + ' \u2192 ' + w.endDate.slice(5) + '</td>';
      h += '<td>' + pct(w.eodCum, 1) + '</td>';
      h += '<td>' + pct(w.altCum, 1) + '</td>';
      h += '<td class="' + (w.win ? 'pos' : 'neg') + '">' + pct(w.alpha, 1) + (w.win ? ' +' : ' \u2212') + '</td>';
      if (hasRegime) {
        var regColor = w.regime === 'bull' ? '#3fb950' : w.regime === 'bear' ? '#f85149' : '#d29922';
        h += '<td class="' + (w.spyReturn >= 0 ? 'pos' : 'neg') + '">' + (w.spyReturn != null ? pct(w.spyReturn, 1) : '\u2014') + '</td>';
        h += '<td style="color:' + regColor + ';font-size:11px">' + (w.regime || '') + '</td>';
      }
      h += '</tr>';
    }
    h += '</tbody></table>';
    // Regime summary: alpha by regime
    if (hasRegime) {
      var regimes = { bull: { wins: 0, total: 0, alphaSum: 0 }, bear: { wins: 0, total: 0, alphaSum: 0 }, sideways: { wins: 0, total: 0, alphaSum: 0 } };
      for (var ri = 0; ri < wf.windows.length; ri++) {
        var rw = wf.windows[ri];
        if (rw.regime && regimes[rw.regime]) {
          regimes[rw.regime].total++;
          if (rw.win) regimes[rw.regime].wins++;
          regimes[rw.regime].alphaSum += rw.alpha;
        }
      }
      h += '<div style="font-size:11px;margin-top:6px;color:#8b949e">Regime breakdown: ';
      var parts = [];
      for (var rk in regimes) {
        var rr = regimes[rk];
        if (rr.total > 0) {
          var clr = rk === 'bull' ? '#3fb950' : rk === 'bear' ? '#f85149' : '#d29922';
          parts.push('<span style="color:' + clr + '">' + rk + '</span>: ' + rr.wins + '/' + rr.total + ' wins, avg ' + (rr.alphaSum / rr.total).toFixed(1) + '%');
        }
      }
      h += parts.join(' | ') + '</div>';
    }
    var vClass = s.verdict === 'CONSISTENT' ? 'rec-add' : s.verdict === 'EPISODIC' ? 'rec-keep' : 'rec-warn';
    var vDesc = s.verdict === 'CONSISTENT' ? 'Alpha is persistent and reliable'
      : s.verdict === 'EPISODIC' ? 'Alpha is real but regime-dependent'
      : 'Alpha concentrated in few windows \u2014 likely curve-fitted';
    // Annualize robustness check alpha
    var rcComp = 1;
    for (var rci = 0; rci < wf.windows.length; rci++) rcComp *= (1 + wf.windows[rci].alpha / 100);
    var rcCum2 = (rcComp - 1) * 100;
    var rcYrs = (wf.windows.length * 21) / 252;
    var rcAnn2 = rcYrs > 0 ? (Math.pow(1 + rcCum2 / 100, 1 / rcYrs) - 1) * 100 : null;
    h += '<div class="' + vClass + '" style="margin-top:8px"><strong>' + s.verdict + '</strong> \u2014 ';
    h += s.wins + '/' + s.total + ' windows (' + (s.winRate * 100).toFixed(1) + '%)';
    h += ' | Avg alpha: ' + pct(s.avgAlpha, 2);
    if (rcAnn2 != null) h += ' | Ann alpha: ' + pct(rcAnn2, 1);
    if (s.total >= 3) h += ' | Recent: ' + s.recentWins + '/' + Math.min(3, s.total) + ' wins';
    h += '<div style="margin-top:4px;font-size:12px;opacity:0.7">' + vDesc + '</div></div>';
    return h;
  }

  function buildWalkforwardSection(wf, altLabel, allWfResults, bestTime, compositeScores) {
    if (!wf || !wf.summary || wf.summary.verdict === 'INSUFFICIENT_DATA') return '';

    // Collect times that have valid WF data
    var wfTimes = [];
    if (allWfResults && typeof allWfResults === 'object') {
      var sortedKeys = Object.keys(allWfResults).sort();
      for (var ki = 0; ki < sortedKeys.length; ki++) {
        var t = sortedKeys[ki];
        var twf = allWfResults[t];
        if (twf && twf.summary && twf.summary.verdict !== 'INSUFFICIENT_DATA') {
          wfTimes.push(t);
        }
      }
    }
    var hasTabs = wfTimes.length > 1;
    var uid = 'wf_' + Math.random().toString(36).slice(2, 8);

    var h = '<div class="section">';
    h += '<div class="section-title">Robustness Check (post-hoc slicing)</div>';

    if (hasTabs) {
      // Tab bar
      h += '<div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:10px">';
      for (var ti = 0; ti < wfTimes.length; ti++) {
        var t = wfTimes[ti];
        var twf = allWfResults[t];
        var isBest = t === bestTime;
        var vDot = twf.summary.verdict === 'CONSISTENT' ? '#3fb950' : twf.summary.verdict === 'EPISODIC' ? '#d29922' : '#f85149';
        var cs = compositeScores && compositeScores[t];
        var wfScoreLabel = cs ? (cs.robustnessScore !== null || cs.wfScore !== null ? ' (' + cs.total + ')' : '') : '';
        var activeStyle = isBest
          ? 'background:#58a6ff;color:#0d1117;font-weight:600'
          : 'background:#21262d;color:#8b949e';
        h += '<button class="wf-tab" data-uid="' + uid + '" data-time="' + t + '" '
          + 'style="border:1px solid #30363d;border-radius:4px;padding:3px 8px;font-size:11px;cursor:pointer;'
          + activeStyle + '" '
          + 'onclick="switchWfTab(this,\'' + uid + '\',\'' + t + '\')">'
          + '<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:' + vDot + ';margin-right:4px;vertical-align:middle"></span>'
          + t + (isBest ? ' BEST' : '') + wfScoreLabel
          + '</button>';
      }
      h += '</div>';

      // Panels for each time
      for (var ti = 0; ti < wfTimes.length; ti++) {
        var t = wfTimes[ti];
        var twf = allWfResults[t];
        var isBest = t === bestTime;
        var tabAltLabel = '@' + t;
        h += '<div class="wf-panel" data-uid="' + uid + '" data-time="' + t + '" style="' + (isBest ? '' : 'display:none') + '">';
        h += buildSingleWfPanel(twf, tabAltLabel);
        h += '</div>';
      }
    } else {
      // Single time — render directly
      h += buildSingleWfPanel(wf, altLabel);
    }

    h += '</div>';
    return h;
  }

  function buildOOSWalkforwardSection(oos) {
    if (!oos || !oos.summary || oos.summary.verdict === 'INSUFFICIENT_DATA') return '';
    var s = oos.summary;
    var h = '<div class="section">';
    h += '<div class="section-title">Walk-Forward Test (true OOS)</div>';

    // Windows table
    h += '<table><thead><tr><th>Training Period</th><th>Chosen</th><th>Test Period</th><th>OOS Alpha</th><th>Win?</th></tr></thead><tbody>';
    for (var i = 0; i < oos.windows.length; i++) {
      var w = oos.windows[i];
      var cls2 = w.win ? 'pos' : 'neg';
      h += '<tr><td style="white-space:nowrap;font-size:12px">' + w.trainStart + ' \u2192 ' + w.trainEnd.slice(5) + '</td>';
      h += '<td>' + w.trainBestTime + '</td>';
      h += '<td style="white-space:nowrap;font-size:12px">' + w.testStart + ' \u2192 ' + w.testEnd.slice(5) + '</td>';
      h += '<td class="' + cls2 + '">' + pct(w.testAlpha, 1) + '</td>';
      h += '<td class="' + cls2 + '">' + (w.win ? '+' : '\u2212') + '</td></tr>';
    }
    h += '</tbody></table>';

    // Verdict & summary
    var vColor = s.verdict === 'OOS_CONFIRMED' ? '#3fb950' : s.verdict === 'OOS_DEGRADED' ? '#d29922' : '#f85149';
    h += '<div style="margin-top:10px;font-size:13px">';
    h += '<span style="color:' + vColor + ';font-weight:700">' + s.verdict.replace('OOS_', '') + '</span> &mdash; ';
    h += s.wins + '/' + s.total + ' windows (' + (s.oosWinRate * 100).toFixed(1) + '%)';
    h += ' &middot; Avg alpha: ' + pct(s.oosAvgAlpha, 2);
    if (s.oosAnnAlpha != null) h += ' &middot; Annualized: ' + pct(s.oosAnnAlpha, 1);
    h += '</div>';

    h += '<div style="margin-top:6px;font-size:12px;color:var(--text2,#8b949e)">';
    h += 'Most selected: <strong>' + s.oosBestTime + '</strong> (' + s.oosBestTimeCount + '/' + s.total + ' windows)';
    if (s.degradationRatio != null) {
      var dLabel = s.degradationRatio >= 0.75 ? 'EXCELLENT' : s.degradationRatio >= 0.50 ? 'ACCEPTABLE' : s.degradationRatio >= 0.25 ? 'SIGNIFICANT' : 'SEVERE';
      var dColor = s.degradationRatio >= 0.50 ? '#3fb950' : s.degradationRatio >= 0.25 ? '#d29922' : '#f85149';
      h += ' &middot; Degradation ratio: <span style="color:' + dColor + '">' + s.degradationRatio.toFixed(2) + ' (' + dLabel + ')</span>';
    }
    h += '</div>';

    // Neighbor peak
    if (oos.neighborPeak && Object.keys(oos.neighborPeak).length > 0) {
      h += '<div style="margin-top:10px;font-size:12px;color:var(--text2,#8b949e)">Robustness Peak:</div>';
      var peakTimes = Object.keys(oos.neighborPeak).sort();
      h += '<div style="font-family:monospace;font-size:12px;margin-top:4px">';
      for (var pi = 0; pi < peakTimes.length; pi++) {
        var pt = peakTimes[pi];
        var pp = oos.neighborPeak[pt];
        var fullBTStr = pp.fullBTImprovement != null ? pct(pp.fullBTImprovement, 1) : 'n/a';
        var oosStr = pp.isCandidate && pp.timesChosen > 0 ? pct(pp.oosAvgAlpha, 1) + ' (' + pp.timesChosen + 'x)' : (pp.isCandidate ? 'never chosen' : 'not tested');
        var marker = pp.isOOSBest ? ' \u25C0 OOS BEST' : '';
        h += pt + ': BT ' + fullBTStr + ' / OOS ' + oosStr + marker + '<br>';
      }
      h += '</div>';
    }

    h += '</div>';
    return h;
  }

  function buildCandidateOOSPanel(candidateOOS, time) {
    if (!candidateOOS || !candidateOOS.windows || candidateOOS.windows.length === 0) return '';
    var hasRegime = candidateOOS.windows[0].regime;
    var h = '<table><thead><tr><th>Test Period</th><th>OOS Alpha</th><th>Win?</th><th>Training Chose</th>';
    if (hasRegime) h += '<th>SPY</th><th>Regime</th>';
    h += '</tr></thead><tbody>';
    for (var i = 0; i < candidateOOS.windows.length; i++) {
      var w = candidateOOS.windows[i];
      var c2 = w.win ? 'pos' : 'neg';
      h += '<tr><td style="white-space:nowrap;font-size:12px">' + w.testStart + ' \u2192 ' + w.testEnd.slice(5) + '</td>';
      h += '<td class="' + c2 + '">' + pct(w.testAlpha, 1) + '</td>';
      h += '<td class="' + c2 + '">' + (w.win ? '+' : '\u2212') + '</td>';
      h += '<td style="font-size:11px;color:#8b949e">' + (w.chosenInTraining || '\u2014') + '</td>';
      if (hasRegime) {
        var regColor = w.regime === 'bull' ? '#3fb950' : w.regime === 'bear' ? '#f85149' : '#d29922';
        h += '<td class="' + (w.spyReturn >= 0 ? 'pos' : 'neg') + '">' + (w.spyReturn != null ? pct(w.spyReturn, 1) : '\u2014') + '</td>';
        h += '<td style="color:' + regColor + ';font-size:11px">' + (w.regime || '') + '</td>';
      }
      h += '</tr>';
    }
    h += '</tbody></table>';
    h += '<div style="font-size:12px;margin-top:6px;color:#8b949e">';
    // Annualize per-candidate OOS alpha
    var cComp = 1;
    for (var ci = 0; ci < candidateOOS.windows.length; ci++) cComp *= (1 + candidateOOS.windows[ci].testAlpha / 100);
    var cCum = (cComp - 1) * 100;
    var cYears = (candidateOOS.windows.length * 21) / 252;
    var cAnn = cYears > 0 ? (Math.pow(1 + cCum / 100, 1 / cYears) - 1) * 100 : null;
    h += (candidateOOS.winRate * 100).toFixed(0) + '% win rate | Avg alpha: ' + pct(candidateOOS.avgAlpha, 2);
    if (cAnn != null) h += ' | Ann alpha: ' + pct(cAnn, 1);
    if (candidateOOS.timesChosenInTraining > 0) h += ' | Chosen in training: ' + candidateOOS.timesChosenInTraining + 'x';
    h += '</div>';
    return h;
  }

  function buildUnifiedWfSection(allWfResults, oosWalkforward, compositeScores, bestTime) {
    var hasT1 = allWfResults && typeof allWfResults === 'object' && Object.keys(allWfResults).length > 0;
    var hasT2 = oosWalkforward && oosWalkforward.perCandidateOOS && Object.keys(oosWalkforward.perCandidateOOS).length > 0;
    if (!hasT1 && !hasT2) return '';

    var candidateTimes = [];
    var seen = {};
    if (hasT1) { for (var k in allWfResults) { if (allWfResults[k] && allWfResults[k].summary && allWfResults[k].summary.verdict !== 'INSUFFICIENT_DATA' && !seen[k]) { candidateTimes.push(k); seen[k] = 1; } } }
    if (hasT2) { for (var k in oosWalkforward.perCandidateOOS) { if (!seen[k]) { candidateTimes.push(k); seen[k] = 1; } } }
    candidateTimes.sort();
    if (candidateTimes.length === 0) return '';

    var uid = 'uwf_' + Math.random().toString(36).slice(2, 8);
    var heading = hasT1 && hasT2 ? 'Walk-Forward Analysis' : hasT1 ? 'Robustness Check (post-hoc slicing)' : 'Walk-Forward Test (true OOS)';
    var h = '<div class="section"><div class="section-title">' + heading + '</div>';

    // Tab bar
    if (candidateTimes.length > 1) {
      h += '<div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:10px">';
      for (var i = 0; i < candidateTimes.length; i++) {
        var t = candidateTimes[i];
        var cs = compositeScores && compositeScores[t];
        var isBest = t === bestTime;
        var vDot = '#8b949e';
        if (hasT1 && allWfResults[t] && allWfResults[t].summary) {
          var v = allWfResults[t].summary.verdict;
          vDot = v === 'CONSISTENT' ? '#3fb950' : v === 'EPISODIC' ? '#d29922' : '#f85149';
        }
        var scoreLabel = cs ? ' (' + cs.total + ')' : '';
        var activeStyle = isBest ? 'background:#58a6ff;color:#0d1117;font-weight:600' : 'background:#21262d;color:#8b949e';
        h += '<button class="wf-tab" data-uid="' + uid + '" data-time="' + t + '" '
          + 'style="border:1px solid #30363d;border-radius:4px;padding:3px 8px;font-size:11px;cursor:pointer;' + activeStyle + '" '
          + 'onclick="switchWfTab(this,\'' + uid + '\',\'' + t + '\')">'
          + '<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:' + vDot + ';margin-right:4px;vertical-align:middle"></span>'
          + t + (isBest ? ' BEST' : '') + scoreLabel + '</button>';
      }
      h += '</div>';
    }

    // Panels
    for (var i = 0; i < candidateTimes.length; i++) {
      var t = candidateTimes[i];
      var isBest = t === bestTime;
      var showStyle = candidateTimes.length > 1 ? (isBest ? '' : 'display:none') : '';
      h += '<div class="wf-panel" data-uid="' + uid + '" data-time="' + t + '" style="' + showStyle + '">';

      // Score summary
      var cs = compositeScores && compositeScores[t];
      if (cs) {
        h += '<div style="font-size:12px;margin-bottom:8px;color:#8b949e">Score: <strong style="color:#e6edf3">' + cs.total + '/100</strong>';
        h += ' \u2014 Return ' + cs.returnScore + ' | DD ' + cs.ddScore + ' | Neighbors ' + cs.neighborScore;
        if (cs.robustnessScore !== null) h += ' | RC ' + cs.robustnessScore;
        if (cs.wfScore !== null) h += ' | OOS ' + cs.wfScore;
        h += '</div>';
      }

      // Tier 1
      if (hasT1 && allWfResults[t] && allWfResults[t].summary && allWfResults[t].summary.verdict !== 'INSUFFICIENT_DATA') {
        h += '<div style="font-size:11px;font-weight:600;text-transform:uppercase;color:#8b949e;margin-bottom:4px">Robustness Check (post-hoc slicing)</div>';
        h += buildSingleWfPanel(allWfResults[t], '@' + t);
      }

      // Tier 2
      if (hasT2 && oosWalkforward.perCandidateOOS[t]) {
        h += '<div style="font-size:11px;font-weight:600;text-transform:uppercase;color:#8b949e;margin:8px 0 4px">Walk-Forward Test (true OOS)</div>';
        h += buildCandidateOOSPanel(oosWalkforward.perCandidateOOS[t], t);
      }

      h += '</div>';
    }

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
  var eodSource = eodTime === '16:00' ? 'Yahoo daily close' : eodTime === '16:00a' ? 'Alpaca bar close' : 'Alpaca ' + esc(eodTime) + ' bar open';
  var blLabel = r.baselineSource === 'composer' ? 'Baseline (Composer Backtest / Xignite)' : 'Baseline (' + eodSource + ')';
  body += '<div class="section-title">' + blLabel + '</div>';
  var cumFmt = ' (' + pct(r.eod.cumReturn, 1) + ' cum.)';
  var annVal = r.eod.annReturn != null ? r.eod.annReturn : ann(r.eod.cumReturn);
  body += '<div class="baseline">Return: <span class="' + cls(r.eod.cumReturn) + '">' + pct(annVal, 1) + ' ann.' + cumFmt + '</span>';
  body += ' &nbsp;\u00B7&nbsp; Max Drawdown: <span class="neg">' + r.eod.maxDD.toFixed(2) + '%</span></div>';
  body += '</div>';

  if (mode === 'dual' || mode === 'single' || mode === 'cash') {
    // Time-by-time table
    // Holdings reliability badge
    if (r.holdingsReliability) {
      var hr = r.holdingsReliability;
      var hrColor = hr.verdict === 'HIGH' ? '#3fb950' : hr.verdict === 'MODERATE' ? '#d29922' : '#f85149';
      var hrBg = hr.verdict === 'HIGH' ? 'rgba(63,185,80,0.1)' : hr.verdict === 'MODERATE' ? 'rgba(210,153,34,0.1)' : 'rgba(248,81,73,0.1)';
      body += '<div style="padding:10px 14px;border-radius:6px;background:' + hrBg + ';border:1px solid ' + hrColor + '30;margin-bottom:16px">';
      body += '<div style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:#8b949e;margin-bottom:4px">Holdings Reliability vs Composer</div>';
      body += '<span style="font-size:20px;font-weight:700;color:' + hrColor + '">' + hr.score + '/100 ' + hr.verdict + '</span>';
      body += '<div style="margin-top:4px;font-size:12px;color:#8b949e">';
      body += 'Ticker overlap: ' + (hr.avgTickerOverlap * 100).toFixed(0) + '% &middot; Weight overlap: ' + (hr.avgWeightOverlap * 100).toFixed(0) + '% &middot; Exact match: ' + (hr.exactMatchRate * 100).toFixed(0) + '% &middot; ' + hr.daysChecked + ' days checked';
      body += '</div>';
      if (hr.verdict === 'LOW' || hr.verdict === 'UNRELIABLE') {
        body += '<div style="margin-top:6px;font-size:11px;color:' + hrColor + '">&#9888; Yahoo/Alpaca holdings diverge significantly from Composer. Intraday results may not be reliable for this strategy.</div>';
      }
      body += '</div>';
    }

    var times = r.times || {};
    var timeKeys = testTimes.length > 0 ? testTimes : Object.keys(times).sort();
    body += '<div class="section">';
    body += '<div class="section-title">Results by Time</div>';
    var eodAnnReport = r.eod.annReturn != null ? r.eod.annReturn : ann(r.eod.cumReturn);
    body += '<table><thead><tr><th>Time</th><th>Ann Return</th><th>Cum Return</th><th>vs EOD</th><th>Max Drawdown</th><th>DD vs EOD</th></tr></thead><tbody>';
    for (var i = 0; i < timeKeys.length; i++) {
      var time = timeKeys[i];
      if (!times[time]) continue;
      var t = times[time];
      var isBest = time === r.bestTime;
      var ddChg = t.maxDD - r.eod.maxDD;
      var annVal2 = t.annReturn != null ? t.annReturn : ann(t.cumReturn);
      var annDiffReport = annVal2 != null && eodAnnReport != null ? annVal2 - eodAnnReport : t.improvement;
      body += '<tr class="' + (isBest ? 'best' : '') + '">';
      body += '<td>' + time + (isBest ? ' <span class="badge">BEST</span>' : '') + '</td>';
      body += '<td>' + pct(annVal2, 1) + '</td>';
      body += '<td>' + pct(t.cumReturn, 1) + '</td>';
      body += '<td class="' + cls(annDiffReport) + '">' + pct(annDiffReport, 1) + '</td>';
      body += '<td>' + t.maxDD.toFixed(2) + '%</td>';
      body += '<td class="' + ddCls2(ddChg) + '">' + pct(ddChg, 2) + '</td>';
      body += '</tr>';
    }
    body += '</tbody></table>';
    body += '</div>';

    // Recommendation
    var stCS = (r.compositeScores && r.bestTime) ? r.compositeScores[r.bestTime] : null;
    var stScr = stCS ? ' (score ' + stCS.total + '/100)' : '';
    var recClass = r.recommendation === 'ADD_MORNING' || r.recommendation === 'USE_MORNING' || r.recommendation === 'GO_CASH' ? 'rec-add'
      : r.recommendation === 'STICK_EOD' ? 'rec-warn' : 'rec-keep';
    var recText = r.recommendation === 'ADD_MORNING' ? 'Consider adding intraday trade at ' + r.bestTime + stScr + ' (' + pct(r.bestImprovement, 1) + ' improvement)'
      : r.recommendation === 'USE_MORNING' ? 'Consider switching to ' + r.bestTime + stScr + ' (' + pct(r.bestImprovement, 1) + ' vs EOD)'
      : r.recommendation === 'GO_CASH' ? 'Consider going to cash at ' + r.bestTime + stScr + ' (' + pct(r.bestImprovement, 1) + ' improvement vs EOD-only)'
      : r.recommendation === 'STICK_EOD' ? 'Stick with EOD-only \u2014 ' + mode + '-time shows worse results'
      : r.recommendation === 'KEEP_EOD' ? 'Keep default EOD execution'
      : 'Marginal difference \u2014 EOD-only is simpler';
    body += '<div class="' + recClass + '">' + recText + '</div>';

    // Composite score breakdown
    if (r.compositeScores && r.bestTime && r.compositeScores[r.bestTime]) {
      var cs = r.compositeScores[r.bestTime];
      var rcPart = cs.robustnessScore !== null ? ' &middot; RC ' + cs.robustnessScore : '';
      var oosPart = cs.wfScore !== null ? ' &middot; OOS ' + cs.wfScore : '';
      body += '<div class="meta" style="margin-top:6px;font-size:12px">Selection score: <strong>' + cs.total + '/100</strong> (Return ' + cs.returnScore + ', DD ' + cs.ddScore + ', Neighbors ' + cs.neighborScore + rcPart + oosPart + ')</div>';
    }

    // Walk-forward
    body += buildUnifiedWfSection(r.allWalkforwardResults, r.oosWalkforward, r.compositeScores, r.bestTime);

    // Hint to run combined for full composite analysis
    if (r.bestImprovement > 0) {
      body += '<div class="rec-keep" style="margin-top:12px;font-size:12px;opacity:0.8">Run <strong>combined</strong> mode with walk-forward for full composite scoring (Return + DD + Neighbors + WF)</div>';
    }

  } else if (mode === 'combined') {

    // Holdings reliability badge (combined mode)
    var hrData = r.dual?.holdingsReliability || r.holdingsReliability;
    if (hrData) {
      var hrC = hrData.verdict === 'HIGH' ? '#3fb950' : hrData.verdict === 'MODERATE' ? '#d29922' : '#f85149';
      var hrBg2 = hrData.verdict === 'HIGH' ? 'rgba(63,185,80,0.1)' : hrData.verdict === 'MODERATE' ? 'rgba(210,153,34,0.1)' : 'rgba(248,81,73,0.1)';
      body += '<div style="padding:10px 14px;border-radius:6px;background:' + hrBg2 + ';border:1px solid ' + hrC + '30;margin-bottom:16px">';
      body += '<div style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:#8b949e;margin-bottom:4px">Holdings Reliability vs Composer</div>';
      body += '<span style="font-size:20px;font-weight:700;color:' + hrC + '">' + hrData.score + '/100 ' + hrData.verdict + '</span>';
      body += '<div style="margin-top:4px;font-size:12px;color:#8b949e">';
      body += 'Ticker overlap: ' + (hrData.avgTickerOverlap * 100).toFixed(0) + '% &middot; Weight overlap: ' + (hrData.avgWeightOverlap * 100).toFixed(0) + '% &middot; Exact match: ' + (hrData.exactMatchRate * 100).toFixed(0) + '% &middot; ' + hrData.daysChecked + ' days checked';
      body += '</div>';
      if (hrData.verdict === 'LOW' || hrData.verdict === 'UNRELIABLE') {
        body += '<div style="margin-top:6px;font-size:11px;color:' + hrC + '">&#9888; Yahoo/Alpaca holdings diverge significantly from Composer. Intraday results may not be reliable for this strategy.</div>';
      }
      body += '</div>';
    }

    // Summary: best of each mode
    body += '<div class="section">';
    body += '<div class="section-title">Best of Each Mode</div>';
    var eodAnnRpt = r.eod.annReturn != null ? r.eod.annReturn : ann(r.eod.cumReturn);
    var dualAnnBest = r.dual.bestAnnReturn != null ? r.dual.bestAnnReturn : ann(r.dual.bestReturn);
    var singleAnnBest = r.single.bestAnnReturn != null ? r.single.bestAnnReturn : ann(r.single.bestReturn);
    var dAnnDiff = dualAnnBest != null && eodAnnRpt != null ? dualAnnBest - eodAnnRpt : 0;
    var sAnnDiff = singleAnnBest != null && eodAnnRpt != null ? singleAnnBest - eodAnnRpt : 0;
    var dRelPct = eodAnnRpt != null && eodAnnRpt !== 0 ? (dAnnDiff / Math.abs(eodAnnRpt)) * 100 : 0;
    var sRelPct = eodAnnRpt != null && eodAnnRpt !== 0 ? (sAnnDiff / Math.abs(eodAnnRpt)) * 100 : 0;
    body += '<table><thead><tr><th>Mode</th><th>Best Time</th><th>Ann Return</th><th>vs EOD</th><th>% of EOD</th><th>Max DD</th><th>DD vs EOD</th></tr></thead><tbody>';
    body += '<tr><td>Dual (Intraday + EOD)</td><td>' + r.dual.bestTime + '</td>';
    body += '<td>' + pct(dualAnnBest, 1) + '</td>';
    body += '<td class="' + cls(dAnnDiff) + '">' + pct(dAnnDiff, 1) + '</td>';
    body += '<td class="' + cls(dRelPct) + '">' + pct(dRelPct, 0) + '</td>';
    body += '<td>' + r.dual.bestDD.toFixed(2) + '%</td>';
    body += '<td class="' + ddCls2(r.dual.bestDD - r.eod.maxDD) + '">' + pct(r.dual.bestDD - r.eod.maxDD, 2) + '</td></tr>';
    body += '<tr><td>Single (Replace EOD)</td><td>' + r.single.bestTime + '</td>';
    body += '<td>' + pct(singleAnnBest, 1) + '</td>';
    body += '<td class="' + cls(sAnnDiff) + '">' + pct(sAnnDiff, 1) + '</td>';
    body += '<td class="' + cls(sRelPct) + '">' + pct(sRelPct, 0) + '</td>';
    body += '<td>' + r.single.bestDD.toFixed(2) + '%</td>';
    body += '<td class="' + ddCls2(r.single.bestDD - r.eod.maxDD) + '">' + pct(r.single.bestDD - r.eod.maxDD, 2) + '</td></tr>';
    if (r.cash) {
      var cashAnnBest = r.cash.bestAnnReturn != null ? r.cash.bestAnnReturn : ann(r.cash.bestReturn);
      var cAnnDiff = cashAnnBest != null && eodAnnRpt != null ? cashAnnBest - eodAnnRpt : 0;
      var cRelPct = eodAnnRpt != null && eodAnnRpt !== 0 ? (cAnnDiff / Math.abs(eodAnnRpt)) * 100 : 0;
      body += '<tr><td>Cash (Go to Cash Midday)</td><td>' + r.cash.bestTime + '</td>';
      body += '<td>' + pct(cashAnnBest, 1) + '</td>';
      body += '<td class="' + cls(cAnnDiff) + '">' + pct(cAnnDiff, 1) + '</td>';
      body += '<td class="' + cls(cRelPct) + '">' + pct(cRelPct, 0) + '</td>';
      body += '<td>' + r.cash.bestDD.toFixed(2) + '%</td>';
      body += '<td class="' + ddCls2(r.cash.bestDD - r.eod.maxDD) + '">' + pct(r.cash.bestDD - r.eod.maxDD, 2) + '</td></tr>';
    }
    body += '</tbody></table>';
    body += '</div>';

    // Composite score boxes + recommendation (prominently after summary, before all-times)
    var dualCS = (r.dual && r.dual.compositeScores && r.dual.bestTime) ? r.dual.compositeScores[r.dual.bestTime] : null;
    var singleCS = (r.single && r.single.compositeScores && r.single.bestTime) ? r.single.compositeScores[r.single.bestTime] : null;
    var cashCSc = (r.cash && r.cash.compositeScores && r.cash.bestTime) ? r.cash.compositeScores[r.cash.bestTime] : null;
    var getQL = analyzer.getCompositeQuality;
    var dualTotal = dualCS ? dualCS.total : 0;
    var singleTotal = singleCS ? singleCS.total : 0;
    var cashTotal = cashCSc ? cashCSc.total : 0;
    var eodAbs = Math.abs(r.eod.cumReturn);
    var dualRelPct = eodAbs > 1 ? (r.dual.improvement / eodAbs) * 100 : r.dual.improvement * 10;
    var singleRelPct = eodAbs > 1 ? (r.single.improvement / eodAbs) * 100 : r.single.improvement * 10;
    var cashRelPct = r.cash ? (eodAbs > 1 ? (r.cash.improvement / eodAbs) * 100 : r.cash.improvement * 10) : -Infinity;
    var dualViable = dualRelPct >= 10;
    var singleViable = singleRelPct >= 10;
    var cashViable = cashRelPct >= 10;

    // Build candidates and pick best by score
    var candidates = [];
    if (dualViable) candidates.push({ mode: 'Dual', score: dualTotal, imp: r.dual.improvement, rel: dualRelPct, time: r.dual.bestTime });
    if (singleViable) candidates.push({ mode: 'Single', score: singleTotal, imp: r.single.improvement, rel: singleRelPct, time: r.single.bestTime });
    if (cashViable) candidates.push({ mode: 'Cash', score: cashTotal, imp: r.cash.improvement, rel: cashRelPct, time: r.cash.bestTime });
    candidates.sort(function(a, b) { return b.score - a.score; });
    var bestMode = candidates.length > 0 ? candidates[0].mode : null;
    var bestScore = candidates.length > 0 ? candidates[0].score : 0;
    var bestImp = candidates.length > 0 ? candidates[0].imp : 0;
    var bestRel = candidates.length > 0 ? candidates[0].rel : 0;
    var bestTime = candidates.length > 0 ? candidates[0].time : '';

    if (!bestMode) {
      body += '<div class="rec-warn">NOT RECOMMENDED \u2014 Improvement too small relative to EOD returns</div>';
    } else {
      // Build mode card function
      function modeCard(modeId, label, timeStr, cs, isBest) {
        if (!cs) return '';
        var q = getQL(cs.total);
        var selStyle = isBest ? 'outline:2px solid #58a6ff;outline-offset:-2px;' : 'opacity:0.7;';
        return '<div class="mode-card" data-mode="' + modeId + '" onclick="switchModeTab(\'' + modeId + '\')" '
          + 'style="flex:1;min-width:200px;padding:10px 12px;border-radius:6px;background:' + q.bgColor + ';border:1px solid ' + q.borderColor + ';line-height:1.6;cursor:pointer;transition:all 0.15s;' + selStyle + '">'
          + '<div style="font-weight:600;text-transform:uppercase;font-size:10px;letter-spacing:0.5px;color:var(--text2,#8b949e)">' + label + ' @ ' + timeStr + '</div>'
          + '<span style="font-size:20px;font-weight:700;color:' + q.htmlColor + '">' + q.label + ' ' + cs.total + '</span><span style="font-size:12px;opacity:0.6">/100</span>'
          + '<div style="margin-top:4px;font-size:11px;color:var(--text2,#8b949e)">'
          + 'Return ' + cs.returnScore + ' &middot; DD ' + cs.ddScore + ' &middot; Neighbors ' + cs.neighborScore
          + (cs.robustnessScore !== null ? ' &middot; RC ' + cs.robustnessScore : '')
          + (cs.wfScore !== null ? ' &middot; OOS ' + cs.wfScore : '')
          + '</div></div>';
      }

      if (dualCS || singleCS || cashCSc) {
        body += '<div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap">';
        body += modeCard('dual', 'Dual', r.dual.bestTime, dualCS, bestMode === 'Dual');
        body += modeCard('single', 'Single', r.single.bestTime, singleCS, bestMode === 'Single');
        body += modeCard('cash', 'Cash', r.cash ? r.cash.bestTime : '', cashCSc, bestMode === 'Cash');
        body += '</div>';
      }
      var cRecClass = bestScore >= 55 ? 'rec-add' : 'rec-keep';
      var cRecText;
      if (bestScore >= 55) {
        cRecText = 'USE ' + bestMode.toUpperCase() + ' @ ' + bestTime + ' (' + pct(bestImp, 1) + ', ' + (bestRel >= 0 ? '+' : '') + bestRel.toFixed(0) + '% relative)';
      } else {
        cRecText = bestMode + ' mode marginal (' + pct(bestImp, 1) + ', ' + (bestRel >= 0 ? '+' : '') + bestRel.toFixed(0) + '% relative) \u2014 proceed with caution';
      }
      body += '<div class="' + cRecClass + '">' + cRecText + '</div>';
    }

    // Helper to build a mode's time table
    function buildTimeTable(modeData, modeTitle) {
      if (!modeData || !modeData.times || Object.keys(modeData.times).length === 0) return '';
      var keys = testTimes.length > 0 ? testTimes : Object.keys(modeData.times).sort();
      var h = '<div class="section">';
      h += '<div class="section-title">' + modeTitle + '</div>';
      h += '<table><thead><tr><th>Time</th><th>Ann Return</th><th>Cum Return</th><th>vs EOD</th><th>% of EOD</th><th>Max Drawdown</th><th>DD vs EOD</th></tr></thead><tbody>';
      for (var i = 0; i < keys.length; i++) {
        var t = keys[i];
        if (!modeData.times[t]) continue;
        var v = modeData.times[t];
        var isBest = t === modeData.bestTime;
        var ddChg = v.maxDD - r.eod.maxDD;
        var vAnn = v.annReturn != null ? v.annReturn : ann(v.cumReturn);
        var vAnnDiff = vAnn != null && eodAnnRpt != null ? vAnn - eodAnnRpt : 0;
        var relPct = eodAnnRpt != null && eodAnnRpt !== 0 ? (vAnnDiff / Math.abs(eodAnnRpt)) * 100 : 0;
        h += '<tr class="' + (isBest ? 'best' : '') + '">';
        h += '<td>' + t + (isBest ? ' <span class="badge">BEST</span>' : '') + '</td>';
        h += '<td>' + pct(vAnn, 1) + '</td>';
        h += '<td>' + pct(v.cumReturn, 1) + '</td>';
        h += '<td class="' + cls(vAnnDiff) + '">' + pct(vAnnDiff, 1) + '</td>';
        h += '<td class="' + cls(relPct) + '">' + pct(relPct, 0) + '</td>';
        h += '<td>' + v.maxDD.toFixed(2) + '%</td>';
        h += '<td class="' + ddCls2(ddChg) + '">' + pct(ddChg, 2) + '</td></tr>';
      }
      h += '</tbody></table></div>';
      return h;
    }

    // Mode panels — each contains backtest table + walk-forward section
    var defaultMode = bestMode ? bestMode.toLowerCase() : 'dual';
    var modes = [
      { id: 'dual', data: r.dual, title: 'Dual \u2014 All Times (Intraday + EOD)' },
      { id: 'single', data: r.single, title: 'Single \u2014 All Times (Replace EOD)' },
      { id: 'cash', data: r.cash, title: 'Cash \u2014 All Times (Go to Cash Midday, Re-enter EOD)' }
    ];
    for (var mi = 0; mi < modes.length; mi++) {
      var md = modes[mi];
      if (!md.data) continue;
      var showPanel = md.id === defaultMode ? '' : 'display:none';
      body += '<div class="mode-panel" data-mode="' + md.id + '" style="' + showPanel + '">';
      body += buildTimeTable(md.data, md.title);
      body += buildUnifiedWfSection(md.data.allWalkforwardResults, md.data.oosWalkforward, md.data.compositeScores, md.data.bestTime);
      body += '</div>';
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
    + '<script>\n'
    + 'function switchModeTab(mode) {\n'
    + '  var cards = document.querySelectorAll(".mode-card");\n'
    + '  for (var i = 0; i < cards.length; i++) {\n'
    + '    if (cards[i].getAttribute("data-mode") === mode) {\n'
    + '      cards[i].style.opacity = "1"; cards[i].style.outline = "2px solid #58a6ff"; cards[i].style.outlineOffset = "-2px";\n'
    + '    } else {\n'
    + '      cards[i].style.opacity = "0.7"; cards[i].style.outline = "none";\n'
    + '    }\n'
    + '  }\n'
    + '  var panels = document.querySelectorAll(".mode-panel");\n'
    + '  for (var i = 0; i < panels.length; i++) {\n'
    + '    panels[i].style.display = panels[i].getAttribute("data-mode") === mode ? "" : "none";\n'
    + '  }\n'
    + '}\n'
    + 'function switchWfTab(btn, uid, time) {\n'
    + '  var tabs = document.querySelectorAll(\'.wf-tab[data-uid="\' + uid + \'"]\');\n'
    + '  for (var i = 0; i < tabs.length; i++) {\n'
    + '    if (tabs[i].getAttribute("data-time") === time) {\n'
    + '      tabs[i].style.background = "#58a6ff"; tabs[i].style.color = "#0d1117"; tabs[i].style.fontWeight = "600";\n'
    + '    } else {\n'
    + '      tabs[i].style.background = "#21262d"; tabs[i].style.color = "#8b949e"; tabs[i].style.fontWeight = "normal";\n'
    + '    }\n'
    + '  }\n'
    + '  var panels = document.querySelectorAll(\'.wf-panel[data-uid="\' + uid + \'"]\');\n'
    + '  for (var i = 0; i < panels.length; i++) {\n'
    + '    panels[i].style.display = panels[i].getAttribute("data-time") === time ? "" : "none";\n'
    + '  }\n'
    + '}\n'
    + '</script>\n'
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
        baselineSource: analyzer.CONFIG.composerBaseline ? 'composer' : 'simulated',
        executionThreshold: analyzer.CONFIG.executionThreshold ? String(analyzer.CONFIG.executionThreshold) : '0',
        takeProfitThreshold: analyzer.CONFIG.takeProfitThreshold ? String(analyzer.CONFIG.takeProfitThreshold) : '0',
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
      const { ids, mode = 'dual', walkforward = false, oosWalkforward = false,
              composerBaseline = false,
              wfWindowSize, wfStepSize, oosTrainWindowSize, wfMaxCandidates,
              dateStart, dateEnd } = body || {};

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
      analyzer.CONFIG.oosWalkforward = !!oosWalkforward;
      analyzer.CONFIG.composerBaseline = !!composerBaseline;
      if (oosTrainWindowSize) analyzer.CONFIG.oosTrainWindowSize = parseInt(oosTrainWindowSize) || 63;
      if (wfMaxCandidates) analyzer.CONFIG.wfMaxCandidates = parseInt(wfMaxCandidates) || 10;

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
          // Run combined one strategy at a time for streaming progress
          for (let i = 0; i < ids.length; i++) {
            if (closed.value) break;
            sseSend(res, 'progress', { current: i + 1, total: ids.length, id: ids[i], phase: 'combined' });
            const results = await analyzer.combinedAnalysis([ids[i]], intradayDays, true);
            const r = results[0];
            if (r) {
              sseSend(res, 'result', r);
              saveReport(r, 'combined');
            }
          }
        } else {
          // For dual/single/cash, analyze one at a time for streaming progress
          const fn = mode === 'cash' ? analyzer.cashTimeAnalysis
            : mode === 'single' ? analyzer.singleTimeAnalysis : analyzer.dualTimeAnalysis;
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
        analyzer.CONFIG.oosWalkforward = false;
        analyzer.CONFIG.composerBaseline = false;
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

      const oldTimeframe = analyzer.CONFIG.ALPACA_TIMEFRAME;
      if (body.alpacaTimeframe && ['15Min', '5Min'].includes(body.alpacaTimeframe)) {
        analyzer.CONFIG.ALPACA_TIMEFRAME = body.alpacaTimeframe;
        guiUpdates.alpacaTimeframe = body.alpacaTimeframe;
      }
      // Validate EOD time against current timeframe: 15-min only allows 15:45/16:00
      const effectiveTimeframe = body.alpacaTimeframe || analyzer.CONFIG.ALPACA_TIMEFRAME;
      const validEodTimes = effectiveTimeframe === '5Min'
        ? ['15:45', '15:50', '15:55', '16:00', '16:00a']
        : ['15:45', '16:00', '16:00a'];
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
      } else if (body.alpacaTimeframe && body.alpacaTimeframe !== oldTimeframe) {
        // Timeframe changed without explicit test times — auto-regenerate
        const step = body.alpacaTimeframe === '5Min' ? 5 : 15;
        const endM = body.alpacaTimeframe === '5Min' ? 55 : 45;
        const newTimes = [];
        let h = 9, m = 30;
        while (h < 15 || (h === 15 && m <= endM)) {
          newTimes.push(String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0'));
          m += step;
          if (m >= 60) { h++; m -= 60; }
        }
        analyzer.CONFIG.TEST_TIMES = newTimes;
        guiUpdates.testTimes = newTimes;
        console.log(`Timeframe changed ${oldTimeframe} → ${body.alpacaTimeframe}: regenerated ${newTimes.length} test times`);
      }

      // Baseline source setting
      if (body.baselineSource && ['simulated', 'composer'].includes(body.baselineSource)) {
        analyzer.CONFIG.composerBaseline = body.baselineSource === 'composer';
        guiUpdates.baselineSource = body.baselineSource;
      }

      // Execution threshold setting
      if (body.executionThreshold !== undefined) {
        const et = parseFloat(body.executionThreshold);
        analyzer.CONFIG.executionThreshold = et > 0 ? et : null;
        guiUpdates.executionThreshold = body.executionThreshold;
      }

      // Take-profit threshold setting
      if (body.takeProfitThreshold !== undefined) {
        const tp = parseFloat(body.takeProfitThreshold);
        analyzer.CONFIG.takeProfitThreshold = tp !== 0 ? tp : null;
        guiUpdates.takeProfitThreshold = body.takeProfitThreshold;
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
        baselineSource: analyzer.CONFIG.composerBaseline ? 'composer' : 'simulated',
        executionThreshold: analyzer.CONFIG.executionThreshold ? String(analyzer.CONFIG.executionThreshold) : '0',
        takeProfitThreshold: analyzer.CONFIG.takeProfitThreshold ? String(analyzer.CONFIG.takeProfitThreshold) : '0',
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
<title>Intraday Execution Analyzer v2.1.2</title>
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
  <h1>Intraday Execution Analyzer <span>v2.1.2</span></h1>
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
        <option value="cash">Cash (Go to Cash Midday)</option>
        <option value="combined">Combined (All Three Modes)</option>
      </select>
      <label class="wf-toggle" title="Tier 1: Walk-forward consistency check">
        <input type="checkbox" id="wfToggle" checked> Robustness Check
      </label>
      <label class="wf-toggle" title="Walk-Forward Test: True out-of-sample (slower, top 10 candidates)">
        <input type="checkbox" id="oosWfToggle"> Walk-Forward Test
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
        <label>EOD Baseline</label>
        <select id="settingBaseline" onchange="onBaselineChange()">
          <option value="simulated">Custom Yahoo EOD (simulated strategy evaluation)</option>
          <option value="composer">Composer Backtest (exact Xignite prices via API)</option>
        </select>
        <div class="hint" id="baselineHint">Composer Backtest uses Composer's actual holdings and Xignite prices. Requires Composer API keys.</div>
      </div>
      <div class="modal-row" id="eodTimeRow">
        <label>EOD Time</label>
        <select id="settingEod"></select>
        <div class="hint">Only applies to Custom Yahoo mode. Composer Backtest uses Composer's own trading window.</div>
      </div>
      <div class="modal-row">
        <label>Execution Threshold</label>
        <select id="settingExecThreshold">
          <option value="0">None (always execute)</option>
          <option value="0.03">3% min allocation change</option>
          <option value="0.05">5% min allocation change (matches n8n)</option>
          <option value="0.10">10% min allocation change</option>
        </select>
        <div class="hint">Minimum allocation change to trigger intraday "Run Now". Matches the n8n workflow's skip rule. Below this threshold, the morning execution is skipped and holdings drift to EOD.</div>
      </div>
      <div class="modal-row">
        <label>Take-Profit Filter</label>
        <select id="settingTakeProfit">
          <option value="0">Off (execute regardless of P&L)</option>
          <option value="0.005">0.5% portfolio gain</option>
          <option value="0.01">1% portfolio gain</option>
          <option value="0.02">2% portfolio gain</option>
          <option value="0.03">3% portfolio gain</option>
          <option value="-0.01">-1% (also execute on red days > -1%)</option>
          <option value="-0.02">-2% (also execute on red days > -2%)</option>
        </select>
        <div class="hint">Only execute intraday "Run Now" when the portfolio is up by at least this much since yesterday's close. Filters out flat/red days to focus intraday trades on profitable momentum.</div>
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
    '<div class="row">Bars: ' + (config.alpacaTimeframe || '15Min') + ' | EOD: ' + (config.baselineSource === 'composer' ? 'Composer Backtest' : (config.eodTime || '15:45') + (config.eodTime === '16:00a' ? ' (Alpaca)' : config.eodTime === '16:00' ? ' (Yahoo)' : ' (Alpaca)')) + ' | Times: ' + testTimesCount + '</div>',
  ].join('');

  // Settings modal - General tab
  document.getElementById('settingTimeframe').value = config.alpacaTimeframe || '15Min';
  buildEodOptions();
  document.getElementById('settingBaseline').value = config.baselineSource || 'simulated';
  document.getElementById('settingExecThreshold').value = config.executionThreshold || '0';
  document.getElementById('settingTakeProfit').value = config.takeProfitThreshold || '0';
  onBaselineChange();

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
    var oosEnabled = document.getElementById('oosWfToggle') ? document.getElementById('oosWfToggle').checked : false;
    var cbEnabled = config.baselineSource === 'composer';
    var fetchBody = { ids: ids, mode: mode, walkforward: wfEnabled, oosWalkforward: oosEnabled, composerBaseline: cbEnabled };
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

    var eventType = null;
    while (true) {
      var chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });

      // Parse SSE events from buffer
      var lines = buffer.split('\\n');
      buffer = lines.pop(); // Keep incomplete line in buffer
      for (var li = 0; li < lines.length; li++) {
        var line = lines[li];
        if (line.startsWith('event: ')) {
          eventType = line.slice(7);
        } else if (line.startsWith('data: ') && eventType) {
          try {
            var evData = JSON.parse(line.slice(6));
            handleSSE(eventType, evData, ids.length);
          } catch (pe) {
            console.error('SSE parse/handle error:', pe, 'event:', eventType, 'data length:', line.length);
          }
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

  function annualize(cumRet, days) {
    if (cumRet == null || !days || days <= 0) return null;
    var years = days / 252;
    if (years <= 0) return null;
    return (Math.pow(1 + cumRet / 100, 1 / years) - 1) * 100;
  }

  // Build rows data
  var rows = results.map(function(r) {
    var bestData = r.times[r.bestTime] || r.eod;
    var eodAnn = r.eod.annReturn != null ? r.eod.annReturn : annualize(r.eod.cumReturn, r.tradingDays);
    var bestAnn = bestData.annReturn != null ? bestData.annReturn : annualize(bestData.cumReturn, r.tradingDays);
    var diff = bestAnn != null && eodAnn != null ? bestAnn - eodAnn : r.bestImprovement;
    var pctImprove = eodAnn != null && eodAnn !== 0 ? (diff / Math.abs(eodAnn)) * 100 : 0;
    var ddChange = bestData.maxDD - r.eod.maxDD;
    return {
      id: r.id, name: r.name, from: fmtStartDate(r.dateRange), days: r.tradingDays,
      dateRange: r.dateRange, bestTime: r.bestTime,
      ddChg: ddChange, eod: eodAnn, best: bestAnn, diff: diff, pctImprove: pctImprove,
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
  function annualize(cumRet, days) {
    if (cumRet == null || !days || days <= 0) return null;
    var years = days / 252;
    if (years <= 0) return null;
    return (Math.pow(1 + cumRet / 100, 1 / years) - 1) * 100;
  }

  var cols = [
    { key: 'name', label: 'Strategy', cls: '' },
    { key: 'from', label: 'From', cls: 'num' },
    { key: 'eod', label: 'EOD-Only', cls: 'num' },
    { key: 'dualTime', label: 'Dual Best', cls: 'num' },
    { key: 'dualRet', label: 'Dual Return', cls: 'num' },
    { key: 'dualRelImp', label: 'Dual +/-', cls: 'num' },
    { key: 'dualScore', label: 'Dual Score', cls: 'num' },
    { key: 'singleTime', label: 'Single Best', cls: 'num' },
    { key: 'singleRet', label: 'Single Return', cls: 'num' },
    { key: 'singleRelImp', label: 'Single +/-', cls: 'num' },
    { key: 'singleScore', label: 'Single Score', cls: 'num' },
    { key: 'cashTime', label: 'Cash Best', cls: 'num' },
    { key: 'cashRet', label: 'Cash Return', cls: 'num' },
    { key: 'cashRelImp', label: 'Cash +/-', cls: 'num' },
    { key: 'cashScore', label: 'Cash Score', cls: 'num' },
  ];

  var getQL = function(s) {
    if (s >= 75) return { label: 'STRONG', htmlColor: '#3fb950' };
    if (s >= 55) return { label: 'GOOD', htmlColor: '#58a6ff' };
    if (s >= 40) return { label: 'MARGINAL', htmlColor: '#d29922' };
    return { label: 'WEAK', htmlColor: '#f85149' };
  };

  var rows = results.map(function(r) {
    var eodAnn = r.eod.annReturn != null ? r.eod.annReturn : annualize(r.eod.cumReturn, r.tradingDays);
    var dualAnn = r.dual.bestAnnReturn != null ? r.dual.bestAnnReturn : annualize(r.dual.bestReturn, r.tradingDays);
    var singleAnn = r.single.bestAnnReturn != null ? r.single.bestAnnReturn : annualize(r.single.bestReturn, r.tradingDays);
    var cashAnn = (r.cash && r.cash.bestAnnReturn != null) ? r.cash.bestAnnReturn : (r.cash ? annualize(r.cash.bestReturn, r.tradingDays) : null);
    var dualRelImp = eodAnn != null && eodAnn !== 0 ? ((dualAnn - eodAnn) / Math.abs(eodAnn)) * 100 : 0;
    var singleRelImp = eodAnn != null && eodAnn !== 0 ? ((singleAnn - eodAnn) / Math.abs(eodAnn)) * 100 : 0;
    var cashRelImp = eodAnn != null && eodAnn !== 0 && cashAnn != null ? ((cashAnn - eodAnn) / Math.abs(eodAnn)) * 100 : 0;
    var dcs = (r.dual && r.dual.compositeScores && r.dual.bestTime) ? r.dual.compositeScores[r.dual.bestTime] : null;
    var scs = (r.single && r.single.compositeScores && r.single.bestTime) ? r.single.compositeScores[r.single.bestTime] : null;
    var ccs = (r.cash && r.cash.compositeScores && r.cash.bestTime) ? r.cash.compositeScores[r.cash.bestTime] : null;
    return {
      id: r.id, name: r.name, from: fmtStartDate(r.dateRange), days: r.tradingDays,
      dateRange: r.dateRange, eod: eodAnn,
      dualTime: r.dual.bestTime, dualRet: dualAnn, dualRelImp: dualRelImp,
      dualScore: dcs ? dcs.total : 0, dualViable: dualRelImp >= 10,
      singleTime: r.single.bestTime, singleRet: singleAnn, singleRelImp: singleRelImp,
      singleScore: scs ? scs.total : 0, singleViable: singleRelImp >= 10,
      cashTime: r.cash ? r.cash.bestTime : '-', cashRet: cashAnn, cashRelImp: cashRelImp,
      cashScore: ccs ? ccs.total : 0, cashViable: cashRelImp >= 10,
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
    html += '<td class="num" style="color:#e6edf3">' + fmtPct(r.eod, 0) + '</td>';
    html += '<td class="num">' + r.dualTime + '</td>';
    html += '<td class="num" style="color:#e6edf3">' + fmtPct(r.dualRet, 0) + '</td>';
    html += '<td class="num ' + valClass(r.dualRelImp) + '">' + fmtPct(r.dualRelImp, 0) + '</td>';
    if (r.dualScore > 0 && r.dualViable) {
      var dql = getQL(r.dualScore);
      html += '<td class="num" style="font-weight:700;color:' + dql.htmlColor + '">' + r.dualScore + '<br><span style="opacity:0.5;font-size:0.8em;font-weight:400">' + dql.label + '</span></td>';
    } else {
      html += '<td class="num" style="color:#f85149;font-size:0.8em">Not Recommended</td>';
    }
    html += '<td class="num">' + r.singleTime + '</td>';
    html += '<td class="num" style="color:#e6edf3">' + fmtPct(r.singleRet, 0) + '</td>';
    html += '<td class="num ' + valClass(r.singleRelImp) + '">' + fmtPct(r.singleRelImp, 0) + '</td>';
    if (r.singleScore > 0 && r.singleViable) {
      var sql = getQL(r.singleScore);
      html += '<td class="num" style="font-weight:700;color:' + sql.htmlColor + '">' + r.singleScore + '<br><span style="opacity:0.5;font-size:0.8em;font-weight:400">' + sql.label + '</span></td>';
    } else {
      html += '<td class="num" style="color:#f85149;font-size:0.8em">Not Recommended</td>';
    }
    html += '<td class="num">' + (r.cashTime || '-') + '</td>';
    html += '<td class="num" style="color:#e6edf3">' + fmtPct(r.cashRet, 0) + '</td>';
    html += '<td class="num ' + valClass(r.cashRelImp) + '">' + fmtPct(r.cashRelImp, 0) + '</td>';
    if (r.cashScore > 0 && r.cashViable) {
      var cql = getQL(r.cashScore);
      html += '<td class="num" style="font-weight:700;color:' + cql.htmlColor + '">' + r.cashScore + '<br><span style="opacity:0.5;font-size:0.8em;font-weight:400">' + cql.label + '</span></td>';
    } else {
      html += '<td class="num" style="color:#f85149;font-size:0.8em">Not Recommended</td>';
    }
    html += '</tr>';
  }

  html += '</tbody></table>';
  return html;
}

function renderSingleWfPanel(wf, altLabel) {
  if (!wf || !wf.summary || wf.summary.verdict === 'INSUFFICIENT_DATA') return '';
  var s = wf.summary;
  var html = '';

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

  // Summary line
  var vColor = s.verdict === 'CONSISTENT' ? '#3fb950' : s.verdict === 'EPISODIC' ? '#d29922' : '#f85149';
  html += '<div style="margin-top:8px;font-size:12px;color:var(--text2,#8b949e)">';
  // Annualize robustness check alpha
  var rcComp2 = 1;
  for (var rci2 = 0; rci2 < wf.windows.length; rci2++) rcComp2 *= (1 + wf.windows[rci2].alpha / 100);
  var rcCum3 = (rcComp2 - 1) * 100;
  var rcYrs2 = (wf.windows.length * 21) / 252;
  var rcAnn3 = rcYrs2 > 0 ? (Math.pow(1 + rcCum3 / 100, 1 / rcYrs2) - 1) * 100 : null;
  html += '<span style="color:' + vColor + ';font-weight:600">' + s.verdict + '</span> \\u2014 ';
  html += s.wins + '/' + s.total + ' windows (' + (s.winRate * 100).toFixed(1) + '%)';
  html += ' | Avg alpha: ' + fmtPct(s.avgAlpha, 2);
  if (rcAnn3 != null) html += ' | Ann alpha: ' + fmtPct(rcAnn3, 1);
  if (s.total >= 3) {
    html += ' | Recent: ' + s.recentWins + '/' + Math.min(3, s.total) + ' wins';
  }
  html += '</div>';

  return html;
}

function renderWalkforwardHTML(wf, altLabel, sectionLabel, allWfResults, bestTime, compositeScores) {
  if (!wf || !wf.summary || wf.summary.verdict === 'INSUFFICIENT_DATA') return '';
  var heading = sectionLabel ? sectionLabel + ' Robustness Check (post-hoc slicing)' : 'Robustness Check (post-hoc slicing)';

  // Collect times that have valid WF results
  var wfTimes = [];
  if (allWfResults && typeof allWfResults === 'object') {
    var sortedKeys = Object.keys(allWfResults).sort();
    for (var ki = 0; ki < sortedKeys.length; ki++) {
      var t = sortedKeys[ki];
      var twf = allWfResults[t];
      if (twf && twf.summary && twf.summary.verdict !== 'INSUFFICIENT_DATA') {
        wfTimes.push(t);
      }
    }
  }
  var hasTabs = wfTimes.length > 1;
  var uid = 'wf_' + Math.random().toString(36).slice(2, 8);

  var html = '<div style="margin-top:16px">';
  html += '<div style="font-size:12px;color:var(--text2);font-weight:600;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px">' + heading + '</div>';

  // Tab bar (only if multiple times have WF data)
  if (hasTabs) {
    html += '<div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:10px">';
    for (var ti = 0; ti < wfTimes.length; ti++) {
      var t = wfTimes[ti];
      var twf = allWfResults[t];
      var isBest = t === bestTime;
      var vDot = twf.summary.verdict === 'CONSISTENT' ? '#3fb950' : twf.summary.verdict === 'EPISODIC' ? '#d29922' : '#f85149';
      var cs = compositeScores && compositeScores[t];
      var wfScoreLabel = cs ? (cs.robustnessScore !== null || cs.wfScore !== null ? ' (' + cs.total + ')' : '') : '';
      var activeStyle = isBest
        ? 'background:var(--accent,#58a6ff);color:#0d1117;font-weight:600'
        : 'background:var(--bg2,#21262d);color:var(--text2,#8b949e)';
      html += '<button class="wf-tab" data-uid="' + uid + '" data-time="' + t + '" '
        + 'style="border:1px solid var(--border,#30363d);border-radius:4px;padding:3px 8px;font-size:11px;cursor:pointer;'
        + activeStyle + '" '
        + 'onclick="switchWfTab(this,\\'' + uid + '\\',\\'' + t + '\\')">'
        + '<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:' + vDot + ';margin-right:4px;vertical-align:middle"></span>'
        + t + (isBest ? ' BEST' : '') + wfScoreLabel
        + '</button>';
    }
    html += '</div>';

    // Render a panel for each time (hidden except best)
    for (var ti = 0; ti < wfTimes.length; ti++) {
      var t = wfTimes[ti];
      var twf = allWfResults[t];
      var isBest = t === bestTime;
      var tabAltLabel = sectionLabel ? sectionLabel + ' @' + t : '@' + t;
      html += '<div class="wf-panel" data-uid="' + uid + '" data-time="' + t + '" style="' + (isBest ? '' : 'display:none') + '">';
      html += renderSingleWfPanel(twf, tabAltLabel);
      html += '</div>';
    }
  } else {
    // Single time — render directly as before
    html += renderSingleWfPanel(wf, altLabel);
  }

  html += '</div>';
  return html;
}

function renderOOSWalkforwardHTML(oos) {
  if (!oos || !oos.summary || oos.summary.verdict === 'INSUFFICIENT_DATA') return '';
  var s = oos.summary;
  var html = '<div style="margin-top:16px">';
  html += '<div style="font-size:12px;color:var(--text2);font-weight:600;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px">Walk-Forward Test (true OOS)</div>';

  // Windows table
  html += '<table class="detail-table"><thead><tr><th>Training Period</th><th>Chosen</th><th>Test Period</th><th>OOS Alpha</th><th>Win?</th></tr></thead><tbody>';
  for (var i = 0; i < oos.windows.length; i++) {
    var w = oos.windows[i];
    var cls2 = w.win ? 'pos' : 'neg';
    html += '<tr>';
    html += '<td style="white-space:nowrap;font-size:12px">' + w.trainStart + ' \\u2192 ' + w.trainEnd.slice(5) + '</td>';
    html += '<td>' + w.trainBestTime + '</td>';
    html += '<td style="white-space:nowrap;font-size:12px">' + w.testStart + ' \\u2192 ' + w.testEnd.slice(5) + '</td>';
    html += '<td class="' + cls2 + '">' + fmtPct(w.testAlpha, 1) + '</td>';
    html += '<td class="' + cls2 + '">' + (w.win ? '+' : '\\u2212') + '</td>';
    html += '</tr>';
  }
  html += '</tbody></table>';

  // Summary
  var vColor = s.verdict === 'OOS_CONFIRMED' ? '#3fb950' : s.verdict === 'OOS_DEGRADED' ? '#d29922' : '#f85149';
  html += '<div style="margin-top:8px;font-size:12px;color:var(--text2,#8b949e)">';
  html += '<span style="color:' + vColor + ';font-weight:600">' + s.verdict.replace('OOS_', '') + '</span> \\u2014 ';
  html += s.wins + '/' + s.total + ' (' + (s.oosWinRate * 100).toFixed(1) + '%)';
  html += ' | Avg alpha: ' + fmtPct(s.oosAvgAlpha, 2);
  if (s.oosAnnAlpha != null) html += ' | Ann: ' + fmtPct(s.oosAnnAlpha, 1);
  html += '<br>Most selected: <strong>' + s.oosBestTime + '</strong> (' + s.oosBestTimeCount + '/' + s.total + ')';
  if (s.degradationRatio != null) {
    var dLabel = s.degradationRatio >= 0.75 ? 'EXCELLENT' : s.degradationRatio >= 0.50 ? 'ACCEPTABLE' : s.degradationRatio >= 0.25 ? 'SIGNIFICANT' : 'SEVERE';
    var dColor = s.degradationRatio >= 0.50 ? '#3fb950' : s.degradationRatio >= 0.25 ? '#d29922' : '#f85149';
    html += ' | Degradation: <span style="color:' + dColor + '">' + s.degradationRatio.toFixed(2) + ' (' + dLabel + ')</span>';
  }
  html += '</div>';

  // Neighbor peak
  if (oos.neighborPeak && Object.keys(oos.neighborPeak).length > 0) {
    var peakTimes = Object.keys(oos.neighborPeak).sort();
    html += '<div style="margin-top:8px;font-family:monospace;font-size:11px">';
    for (var pi = 0; pi < peakTimes.length; pi++) {
      var pt = peakTimes[pi];
      var pp = oos.neighborPeak[pt];
      var ftStr = pp.fullBTImprovement != null ? fmtPct(pp.fullBTImprovement, 1) : 'n/a';
      var osStr = pp.isCandidate && pp.timesChosen > 0 ? fmtPct(pp.oosAvgAlpha, 1) + ' (' + pp.timesChosen + 'x)' : (pp.isCandidate ? 'never chosen' : 'not tested');
      var marker = pp.isOOSBest ? ' \\u25C0 OOS BEST' : '';
      html += pt + ': BT ' + ftStr + ' / OOS ' + osStr + marker + '<br>';
    }
    html += '</div>';
  }

  html += '</div>';
  return html;
}

function renderCandidateOOSPanelLive(candidateOOS, time) {
  if (!candidateOOS || !candidateOOS.windows || candidateOOS.windows.length === 0) return '';
  var h = '<table class="detail-table"><thead><tr><th>Test Period</th><th>OOS Alpha</th><th>Win?</th><th>Training Chose</th></tr></thead><tbody>';
  for (var i = 0; i < candidateOOS.windows.length; i++) {
    var w = candidateOOS.windows[i];
    var c2 = w.win ? 'pos' : 'neg';
    h += '<tr><td style="white-space:nowrap;font-size:12px">' + w.testStart + ' \\u2192 ' + w.testEnd.slice(5) + '</td>';
    h += '<td class="' + c2 + '">' + fmtPct(w.testAlpha, 1) + '</td>';
    h += '<td class="' + c2 + '">' + (w.win ? '+' : '\\u2212') + '</td>';
    h += '<td style="font-size:11px;color:var(--text2,#8b949e)">' + (w.chosenInTraining || '\\u2014') + '</td></tr>';
  }
  h += '</tbody></table>';
  h += '<div style="font-size:12px;margin-top:6px;color:var(--text2,#8b949e)">';
  // Annualize per-candidate OOS alpha
  var cComp = 1;
  for (var ci = 0; ci < candidateOOS.windows.length; ci++) cComp *= (1 + candidateOOS.windows[ci].testAlpha / 100);
  var cCum = (cComp - 1) * 100;
  var cYears = (candidateOOS.windows.length * 21) / 252;
  var cAnn = cYears > 0 ? (Math.pow(1 + cCum / 100, 1 / cYears) - 1) * 100 : null;
  h += (candidateOOS.winRate * 100).toFixed(0) + '% win rate | Avg alpha: ' + fmtPct(candidateOOS.avgAlpha, 2);
  if (cAnn != null) h += ' | Ann alpha: ' + fmtPct(cAnn, 1);
  if (candidateOOS.timesChosenInTraining > 0) h += ' | Chosen in training: ' + candidateOOS.timesChosenInTraining + 'x';
  h += '</div>';
  return h;
}

function renderUnifiedWfHTML(allWfResults, oosWalkforward, compositeScores, bestTime) {
  var hasT1 = allWfResults && typeof allWfResults === 'object' && Object.keys(allWfResults).length > 0;
  var hasT2 = oosWalkforward && oosWalkforward.perCandidateOOS && Object.keys(oosWalkforward.perCandidateOOS).length > 0;
  if (!hasT1 && !hasT2) return '';

  var candidateTimes = [];
  var seen = {};
  if (hasT1) { for (var k in allWfResults) { if (allWfResults[k] && allWfResults[k].summary && allWfResults[k].summary.verdict !== 'INSUFFICIENT_DATA' && !seen[k]) { candidateTimes.push(k); seen[k] = 1; } } }
  if (hasT2) { for (var k in oosWalkforward.perCandidateOOS) { if (!seen[k]) { candidateTimes.push(k); seen[k] = 1; } } }
  candidateTimes.sort();
  if (candidateTimes.length === 0) return '';

  var uid = 'uwf_' + Math.random().toString(36).slice(2, 8);
  var heading = hasT1 && hasT2 ? 'Walk-Forward Analysis' : hasT1 ? 'Robustness Check (post-hoc slicing)' : 'Walk-Forward Test (true OOS)';
  var html = '<div style="margin-top:16px"><div style="font-size:12px;color:var(--text2);font-weight:600;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px">' + heading + '</div>';

  // Tab bar
  if (candidateTimes.length > 1) {
    html += '<div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:10px">';
    for (var i = 0; i < candidateTimes.length; i++) {
      var t = candidateTimes[i];
      var cs = compositeScores && compositeScores[t];
      var isBest = t === bestTime;
      var vDot = 'var(--text2,#8b949e)';
      if (hasT1 && allWfResults[t] && allWfResults[t].summary) {
        var v = allWfResults[t].summary.verdict;
        vDot = v === 'CONSISTENT' ? '#3fb950' : v === 'EPISODIC' ? '#d29922' : '#f85149';
      }
      var scoreLabel = cs ? ' (' + cs.total + ')' : '';
      var activeStyle = isBest ? 'background:var(--accent,#58a6ff);color:#0d1117;font-weight:600' : 'background:var(--bg2,#21262d);color:var(--text2,#8b949e)';
      html += '<button class="wf-tab" data-uid="' + uid + '" data-time="' + t + '" '
        + 'style="border:1px solid var(--border,#30363d);border-radius:4px;padding:3px 8px;font-size:11px;cursor:pointer;' + activeStyle + '" '
        + 'onclick="switchWfTab(this,\\'' + uid + '\\',\\'' + t + '\\')">'
        + '<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:' + vDot + ';margin-right:4px;vertical-align:middle"></span>'
        + t + (isBest ? ' BEST' : '') + scoreLabel + '</button>';
    }
    html += '</div>';
  }

  // Panels
  for (var i = 0; i < candidateTimes.length; i++) {
    var t = candidateTimes[i];
    var isBest = t === bestTime;
    var showStyle = candidateTimes.length > 1 ? (isBest ? '' : 'display:none') : '';
    html += '<div class="wf-panel" data-uid="' + uid + '" data-time="' + t + '" style="' + showStyle + '">';

    var cs = compositeScores && compositeScores[t];
    if (cs) {
      html += '<div style="font-size:12px;margin-bottom:8px;color:var(--text2,#8b949e)">Score: <strong style="color:var(--text1,#e6edf3)">' + cs.total + '/100</strong>';
      html += ' \\u2014 Return ' + cs.returnScore + ' | DD ' + cs.ddScore + ' | Neighbors ' + cs.neighborScore;
      if (cs.robustnessScore !== null) html += ' | RC ' + cs.robustnessScore;
      if (cs.wfScore !== null) html += ' | OOS ' + cs.wfScore;
      html += '</div>';
    }

    if (hasT1 && allWfResults[t] && allWfResults[t].summary && allWfResults[t].summary.verdict !== 'INSUFFICIENT_DATA') {
      html += '<div style="font-size:11px;font-weight:600;text-transform:uppercase;color:var(--text2,#8b949e);margin-bottom:4px">Robustness Check (post-hoc slicing)</div>';
      html += renderSingleWfPanel(allWfResults[t], '@' + t);
    }

    if (hasT2 && oosWalkforward.perCandidateOOS[t]) {
      html += '<div style="font-size:11px;font-weight:600;text-transform:uppercase;color:var(--text2,#8b949e);margin:8px 0 4px">Walk-Forward Test (true OOS)</div>';
      html += renderCandidateOOSPanelLive(oosWalkforward.perCandidateOOS[t], t);
    }

    html += '</div>';
  }

  html += '</div>';
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
  function annualizeGui(cumRet, days) {
    if (cumRet == null || !days || days <= 0) return null;
    var years = days / 252;
    if (years <= 0) return null;
    return (Math.pow(1 + cumRet / 100, 1 / years) - 1) * 100;
  }

  html += '<div style="margin-bottom:8px;font-size:13px">';
  var eodAnnGui = r.eod.annReturn != null ? r.eod.annReturn : annualizeGui(r.eod.cumReturn, r.tradingDays);
  var cumFmtGui = ' (' + fmtPct(r.eod.cumReturn, 1) + ' cum.)';
  var blLabel2 = r.baselineSource === 'composer' ? 'Baseline (Composer Backtest / Xignite):' : 'Baseline (' + (eodTime === '16:00' ? 'Yahoo close' : eodTime === '16:00a' ? 'Alpaca close' : 'Alpaca ' + eodTime + ' open') + '):';
  html += '<strong>' + blLabel2 + '</strong> Return: ';
  html += '<span class="' + valClass(r.eod.cumReturn) + '">' + fmtPct(eodAnnGui, 1) + ' ann.' + cumFmtGui + '</span>';
  html += ' | Max DD: <span class="neg">' + r.eod.maxDD.toFixed(1) + '%</span>';
  html += '</div>';

  // Times table
  html += '<table class="detail-table"><thead><tr>';
  html += '<th>Time</th><th>Ann Return</th><th>Cum Return</th><th>vs EOD</th><th>Max Drawdown</th><th>DD vs EOD</th>';
  html += '</tr></thead><tbody>';

  for (var ti = 0; ti < testTimes.length; ti++) {
    var time = testTimes[ti];
    if (!r.times[time]) continue;
    var t = r.times[time];
    var isBest = time === r.bestTime;
    var ddChg = t.maxDD - r.eod.maxDD;
    var annGui = t.annReturn != null ? t.annReturn : annualizeGui(t.cumReturn, r.tradingDays);
    var annDiffGui = annGui != null && eodAnnGui != null ? annGui - eodAnnGui : t.improvement;
    html += '<tr class="' + (isBest ? 'best' : '') + '">';
    html += '<td>' + time + (isBest ? ' (BEST)' : '') + '</td>';
    html += '<td>' + fmtPct(annGui, 1) + '</td>';
    html += '<td>' + fmtPct(t.cumReturn, 1) + '</td>';
    html += '<td class="' + valClass(annDiffGui) + '">' + fmtPct(annDiffGui, 1) + '</td>';
    html += '<td>' + t.maxDD.toFixed(1) + '%</td>';
    html += '<td class="' + valClass(ddChg, true) + '">' + fmtNum(ddChg, 1) + '</td>';
    html += '</tr>';
  }

  html += '</tbody></table>';

  // Recommendation
  var dcCS = (r.compositeScores && r.bestTime) ? r.compositeScores[r.bestTime] : null;
  var dcScr = dcCS ? ' (score ' + dcCS.total + '/100)' : '';
  var recClass = r.recommendation === 'ADD_MORNING' || r.recommendation === 'USE_MORNING' ? 'add'
    : r.recommendation === 'STICK_EOD' ? 'warning' : 'keep';
  var recText = r.recommendation === 'ADD_MORNING' ? 'Consider adding morning trade at ' + r.bestTime + dcScr + ' (+' + r.bestImprovement.toFixed(1) + '% improvement)'
    : r.recommendation === 'USE_MORNING' ? 'Consider switching to ' + r.bestTime + dcScr + ' (+' + r.bestImprovement.toFixed(1) + '% vs EOD)'
    : r.recommendation === 'STICK_EOD' ? 'Stick with EOD-only - shows worse results'
    : r.recommendation === 'KEEP_EOD' ? 'Keep default EOD execution'
    : 'Marginal difference - EOD-only is simpler';
  html += '<div class="recommendation ' + recClass + '">' + recText + '</div>';

  // Composite score breakdown
  if (r.compositeScores && r.bestTime && r.compositeScores[r.bestTime]) {
    var cs = r.compositeScores[r.bestTime];
    var rcPart = cs.robustnessScore !== null ? ' \\u00B7 RC ' + cs.robustnessScore : '';
    var oosPart = cs.wfScore !== null ? ' \\u00B7 OOS ' + cs.wfScore : '';
    var wfPart = rcPart + oosPart;
    html += '<div style="margin-top:4px;font-size:11px;color:var(--text2,#8b949e)">Selection score: <strong>' + cs.total + '/100</strong> (Return ' + cs.returnScore + ', DD ' + cs.ddScore + ', Neighbors ' + cs.neighborScore + wfPart + ')</div>';
  }

  // Walk-forward section
  html += renderUnifiedWfHTML(r.allWalkforwardResults, r.oosWalkforward, r.compositeScores, r.bestTime);

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

  function annualizeGui2(cumRet, days) {
    if (cumRet == null || !days || days <= 0) return null;
    var years = days / 252;
    if (years <= 0) return null;
    return (Math.pow(1 + cumRet / 100, 1 / years) - 1) * 100;
  }

  html += '<div class="detail-body">';
  html += '<div style="margin-bottom:8px;font-size:13px">';
  var eodAnnGui2 = r.eod.annReturn != null ? r.eod.annReturn : annualizeGui2(r.eod.cumReturn, r.tradingDays);
  var cumFmtGui2 = ' (' + fmtPct(r.eod.cumReturn, 1) + ' cum.)';
  var blLabel2 = r.baselineSource === 'composer' ? 'Baseline (Composer Backtest / Xignite):' : 'Baseline (' + (eodTime === '16:00' ? 'Yahoo close' : eodTime === '16:00a' ? 'Alpaca close' : 'Alpaca ' + eodTime + ' open') + '):';
  html += '<strong>' + blLabel2 + '</strong> Return: ';
  html += '<span class="' + valClass(r.eod.cumReturn) + '">' + fmtPct(eodAnnGui2, 1) + ' ann.' + cumFmtGui2 + '</span>';
  html += ' | Max DD: <span class="neg">' + r.eod.maxDD.toFixed(1) + '%</span>';
  html += '</div>';

  // Determine recommendation first
  var dcsData = (r.dual && r.dual.compositeScores && r.dual.bestTime) ? r.dual.compositeScores[r.dual.bestTime] : null;
  var scsData = (r.single && r.single.compositeScores && r.single.bestTime) ? r.single.compositeScores[r.single.bestTime] : null;
  var ccsData = (r.cash && r.cash.compositeScores && r.cash.bestTime) ? r.cash.compositeScores[r.cash.bestTime] : null;
  var getQL2 = function(s) {
    if (s >= 75) return { label: 'STRONG', htmlColor: '#3fb950', bgColor: 'rgba(63,185,80,0.12)', borderColor: 'rgba(63,185,80,0.3)' };
    if (s >= 55) return { label: 'GOOD', htmlColor: '#58a6ff', bgColor: 'rgba(88,166,255,0.12)', borderColor: 'rgba(88,166,255,0.3)' };
    if (s >= 40) return { label: 'MARGINAL', htmlColor: '#d29922', bgColor: 'rgba(210,153,34,0.12)', borderColor: 'rgba(210,153,34,0.3)' };
    return { label: 'WEAK', htmlColor: '#f85149', bgColor: 'rgba(248,81,73,0.12)', borderColor: 'rgba(248,81,73,0.3)' };
  };
  var eodAbs2 = Math.abs(r.eod.cumReturn);
  var dRelPct = eodAbs2 > 1 ? (r.dual.improvement / eodAbs2) * 100 : r.dual.improvement * 10;
  var sRelPct = eodAbs2 > 1 ? (r.single.improvement / eodAbs2) * 100 : r.single.improvement * 10;
  var cRelPct = r.cash ? (eodAbs2 > 1 ? (r.cash.improvement / eodAbs2) * 100 : r.cash.improvement * 10) : -Infinity;
  var dv2 = dRelPct >= 10;
  var sv2 = sRelPct >= 10;
  var cv2 = cRelPct >= 10;

  // Build candidates and pick best by score
  var cands2 = [];
  if (dv2) cands2.push({ mode: 'Dual', score: dcsData ? dcsData.total : 0, imp: r.dual.improvement, rel: dRelPct, time: r.dual.bestTime });
  if (sv2) cands2.push({ mode: 'Single', score: scsData ? scsData.total : 0, imp: r.single.improvement, rel: sRelPct, time: r.single.bestTime });
  if (cv2) cands2.push({ mode: 'Cash', score: ccsData ? ccsData.total : 0, imp: r.cash.improvement, rel: cRelPct, time: r.cash.bestTime });
  cands2.sort(function(a, b) { return b.score - a.score; });
  var bm2 = cands2.length > 0 ? cands2[0].mode : null;
  var bs2 = cands2.length > 0 ? cands2[0].score : 0;
  var bi2 = cands2.length > 0 ? cands2[0].imp : 0;
  var br2 = cands2.length > 0 ? cands2[0].rel : 0;
  var bt2 = cands2.length > 0 ? cands2[0].time : '';

  if (!bm2) {
    // NOT RECOMMENDED — show prominently, skip score boxes
    html += '<div class="recommendation warning">NOT RECOMMENDED - Improvement too small relative to EOD returns</div>';
  } else {
    // Show score boxes then recommendation
    // Clickable mode cards
    function liveModeCard(modeId, label, timeStr, csData, isBest) {
      if (!csData) return '';
      var q = getQL2(csData.total);
      var selStyle = isBest ? 'outline:2px solid #58a6ff;outline-offset:-2px;' : 'opacity:0.7;';
      return '<div class="mode-card" data-mode="' + modeId + '" onclick="switchModeTab(\\\'' + modeId + '\\\')" '
        + 'style="flex:1;min-width:180px;padding:10px 12px;border-radius:6px;background:' + q.bgColor + ';border:1px solid ' + q.borderColor + ';line-height:1.6;cursor:pointer;transition:all 0.15s;' + selStyle + '">'
        + '<div style="font-weight:600;text-transform:uppercase;font-size:10px;letter-spacing:0.5px;color:var(--text2,#8b949e)">' + label + ' @ ' + timeStr + '</div>'
        + '<span style="font-size:20px;font-weight:700;color:' + q.htmlColor + '">' + q.label + ' ' + csData.total + '</span><span style="font-size:12px;opacity:0.6">/100</span>'
        + '<div style="margin-top:4px;font-size:11px;color:var(--text2,#8b949e)">'
        + 'Return ' + csData.returnScore + ' \\u00B7 DD ' + csData.ddScore + ' \\u00B7 Neighbors ' + csData.neighborScore
        + (csData.robustnessScore !== null ? ' \\u00B7 RC ' + csData.robustnessScore : '')
        + (csData.wfScore !== null ? ' \\u00B7 OOS ' + csData.wfScore : '')
        + '</div></div>';
    }

    if (dcsData || scsData || ccsData) {
      html += '<div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap">';
      html += liveModeCard('dual', 'Dual', r.dual.bestTime, dcsData, bm2 === 'Dual');
      html += liveModeCard('single', 'Single', r.single.bestTime, scsData, bm2 === 'Single');
      html += liveModeCard('cash', 'Cash', r.cash ? r.cash.bestTime : '', ccsData, bm2 === 'Cash');
      html += '</div>';
    }
    var recClass = bs2 >= 55 ? 'add' : 'keep';
    var recText;
    if (bs2 >= 55) {
      recText = 'USE ' + bm2.toUpperCase() + ' @ ' + bt2 + ' (' + fmtPct(bi2, 1) + ', +' + br2.toFixed(0) + '% relative)';
    } else {
      recText = bm2 + ' mode marginal (' + fmtPct(bi2, 1) + ', +' + br2.toFixed(0) + '% relative) \\u2014 proceed with caution';
    }
    html += '<div class="recommendation ' + recClass + '">' + recText + '</div>';
  }

  var eodAnnGui3 = r.eod.annReturn != null ? r.eod.annReturn : annualizeGui2(r.eod.cumReturn, r.tradingDays);

  // Helper to build a mode's time table for live GUI
  function buildLiveTimeTable(modeData, modeTitle) {
    if (!modeData || !modeData.times || Object.keys(modeData.times).length === 0) return '';
    var h = '<div style="margin-top:12px;font-size:12px;color:var(--text2);font-weight:600;text-transform:uppercase;letter-spacing:0.5px">' + modeTitle + '</div>';
    h += '<table class="detail-table"><thead><tr>';
    h += '<th>Time</th><th>Ann Return</th><th>Cum Return</th><th>vs EOD</th><th>% of EOD</th><th>Max Drawdown</th><th>DD vs EOD</th>';
    h += '</tr></thead><tbody>';
    for (var i = 0; i < testTimes.length; i++) {
      var t = testTimes[i];
      if (!modeData.times[t]) continue;
      var v = modeData.times[t];
      var isBest = t === modeData.bestTime;
      var ddChg = v.maxDD - r.eod.maxDD;
      var vAnn = v.annReturn != null ? v.annReturn : annualizeGui2(v.cumReturn, r.tradingDays);
      var vAnnDiff = vAnn != null && eodAnnGui3 != null ? vAnn - eodAnnGui3 : 0;
      var relImp = eodAnnGui3 != null && eodAnnGui3 !== 0 ? (vAnnDiff / Math.abs(eodAnnGui3)) * 100 : 0;
      h += '<tr class="' + (isBest ? 'best' : '') + '">';
      h += '<td>' + t + (isBest ? ' (BEST)' : '') + '</td>';
      h += '<td>' + fmtPct(vAnn, 1) + '</td>';
      h += '<td>' + fmtPct(v.cumReturn, 1) + '</td>';
      h += '<td class="' + valClass(vAnnDiff) + '">' + fmtPct(vAnnDiff, 1) + '</td>';
      h += '<td class="' + valClass(relImp) + '">' + fmtPct(relImp, 0) + '</td>';
      h += '<td>' + v.maxDD.toFixed(1) + '%</td>';
      h += '<td class="' + valClass(ddChg, true) + '">' + fmtNum(ddChg, 1) + '</td>';
      h += '</tr>';
    }
    h += '</tbody></table>';
    return h;
  }

  // Mode panels — click cards to switch
  var defaultMode2 = bm2 ? bm2.toLowerCase() : 'dual';
  var liveModes = [
    { id: 'dual', data: r.dual, title: 'Dual - All Times (Intraday + EOD)' },
    { id: 'single', data: r.single, title: 'Single - All Times (Replace EOD)' },
    { id: 'cash', data: r.cash, title: 'Cash - All Times (Go to Cash Midday, Re-enter EOD)' }
  ];
  for (var mi = 0; mi < liveModes.length; mi++) {
    var md = liveModes[mi];
    if (!md.data) continue;
    var showPanel = md.id === defaultMode2 ? '' : 'display:none';
    html += '<div class="mode-panel" data-mode="' + md.id + '" style="' + showPanel + '">';
    html += buildLiveTimeTable(md.data, md.title);
    html += renderUnifiedWfHTML(md.data.allWalkforwardResults, md.data.oosWalkforward, md.data.compositeScores, md.data.bestTime);
    html += '</div>';
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

function switchModeTab(mode) {
  var cards = document.querySelectorAll('.mode-card');
  for (var i = 0; i < cards.length; i++) {
    if (cards[i].getAttribute('data-mode') === mode) {
      cards[i].style.opacity = '1';
      cards[i].style.outline = '2px solid #58a6ff';
      cards[i].style.outlineOffset = '-2px';
    } else {
      cards[i].style.opacity = '0.7';
      cards[i].style.outline = 'none';
    }
  }
  var panels = document.querySelectorAll('.mode-panel');
  for (var i = 0; i < panels.length; i++) {
    panels[i].style.display = panels[i].getAttribute('data-mode') === mode ? '' : 'none';
  }
}

function switchWfTab(btn, uid, time) {
  // Update tab buttons
  var tabs = document.querySelectorAll('.wf-tab[data-uid="' + uid + '"]');
  for (var i = 0; i < tabs.length; i++) {
    if (tabs[i].getAttribute('data-time') === time) {
      tabs[i].style.background = 'var(--accent,#58a6ff)';
      tabs[i].style.color = '#0d1117';
      tabs[i].style.fontWeight = '600';
    } else {
      tabs[i].style.background = 'var(--bg2,#21262d)';
      tabs[i].style.color = 'var(--text2,#8b949e)';
      tabs[i].style.fontWeight = 'normal';
    }
  }
  // Show/hide panels
  var panels = document.querySelectorAll('.wf-panel[data-uid="' + uid + '"]');
  for (var i = 0; i < panels.length; i++) {
    panels[i].style.display = panels[i].getAttribute('data-time') === time ? '' : 'none';
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

function onBaselineChange() {
  var val = document.getElementById('settingBaseline').value;
  var eodRow = document.getElementById('eodTimeRow');
  if (val === 'composer') {
    eodRow.style.opacity = '0.4';
    eodRow.style.pointerEvents = 'none';
  } else {
    eodRow.style.opacity = '1';
    eodRow.style.pointerEvents = 'auto';
  }
}

function buildEodOptions() {
  var timeframe = document.getElementById('settingTimeframe').value || config.alpacaTimeframe || '15Min';
  var eodSelect = document.getElementById('settingEod');
  var currentVal = eodSelect.value || config.eodTime || '15:45';

  // 15-min mode: only 15:45 and 16:00 produce different prices
  // 5-min mode: all four options are meaningful
  // 16:00a = Alpaca bar close (same source as intraday data)
  var options = timeframe === '5Min'
    ? ['15:45', '15:50', '15:55', '16:00', '16:00a']
    : ['15:45', '16:00', '16:00a'];

  eodSelect.innerHTML = '';
  var eodLabels = {
    '15:45': '15:45 — Alpaca bar open (Composer starts executing)',
    '15:50': '15:50 — Alpaca bar open (mid-execution window)',
    '15:55': '15:55 — Alpaca bar open (near end of window)',
    '16:00': '16:00 — Yahoo daily close (official market close)',
    '16:00a': '16:00 — Alpaca bar close (Alpaca market close)'
  };
  options.forEach(function(t) {
    var opt = document.createElement('option');
    opt.value = t;
    opt.textContent = eodLabels[t] || t;
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
  var baselineSource = document.getElementById('settingBaseline').value;
  var execThreshold = document.getElementById('settingExecThreshold').value;
  var takeProfit = document.getElementById('settingTakeProfit').value;

  try {
    var resp = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alpacaTimeframe: timeframe, eodTime: eodTime, baselineSource: baselineSource, executionThreshold: execThreshold, takeProfitThreshold: takeProfit }),
    });
    var data = await resp.json();
    config.alpacaTimeframe = data.alpacaTimeframe;
    config.eodTime = data.eodTime;
    config.baselineSource = data.baselineSource || 'simulated';
    config.executionThreshold = data.executionThreshold || '0';
    config.takeProfitThreshold = data.takeProfitThreshold || '0';
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
