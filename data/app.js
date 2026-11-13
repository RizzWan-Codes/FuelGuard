/**
 * FuelGuard 2.0 • Liquid Intelligence Console
 * Made by IgnitionX • Designed by Rizwan Syed
 */
'use strict';

const $ = id => document.getElementById(id);

// Application State
let status = null;
let token = '';
let live = false;
let lastSeq = -1;
let lastLog = 0;
let lastLogAt = 0;
let calCount = -1;
let boot = 'fg-boot-session';
let anchor = Date.now();
let history = [];
let logs = [];
let points = [];
let firstLogs = true;
let installPrompt = null;
let recordStart = Date.now();
let lastSuccess = 0;
let storageFailed = false;
let activeMiniTab = 'miniOverlay'; // 'miniOverlay' | 'miniConductivity' | 'miniLdr'
let pendingCalPreset = null;
let lastLimitNotifiedAt = 0;

const MAX_READINGS = 7200; // ~15-20 min buffer
const MAX_LOGS = 1000;
const THRESHOLD = 275;
const SPECIAL_PIN = '1335';

// -------------------------------------------------------------
// DEMO MODE & SIMULATION ENGINE (FOR HACKATHON SHOWCASING)
// -------------------------------------------------------------
const isLocalHardwareHost = location.hostname === '192.168.4.1' || location.hostname === 'fuelguard.local';
let demoMode = localStorage.getItem('fuelguard-demo-mode') === 'true' || 
  (localStorage.getItem('fuelguard-demo-mode') === null && !isLocalHardwareHost);

const simState = {
  uptimeMs: 142000,
  seq: 1,
  sampleId: 1,
  raw: 98,
  targetRaw: 98,
  ldrDigital: 0,
  state: 'monitoring', // 'monitoring' | 'countdown' | 'flushing'
  countdown: 0,
  mode: 'automatic',   // 'automatic' | 'manual'
  r1: false,
  r2: false,
  pumpRemainingMs: 0,
  doseResult: 'Dosing system primed',
  doseMl: 0,
  captureProgress: 0,
  captureResult: 'Ready for reference sample',
  spikeActive: false,
  countdownInterval: null,
  flushInterval: null
};

// Seed demo reference points if empty
function initDemoPoints() {
  if (!points || !points.length) {
    points = [
      { name: 'Sample A (E10)', ethanol: 10.0, mean: 98.0, sd: 0.42, n: 100 },
      { name: 'Sample B (E20)', ethanol: 20.0, mean: 148.0, sd: 0.58, n: 100 }
    ];
    calCount = points.length;
    savePointsLocally();
  }
}

// Seed historical readings if empty so charts look immediately full & alive
function initDemoHistory() {
  if (!history || history.length < 50) {
    const now = Date.now();
    for (let i = 120; i >= 0; i--) {
      const t = now - i * 120;
      const baseA0 = 96 + Math.round(Math.sin(i / 15) * 4 + (Math.random() - 0.5) * 3);
      history.push({
        time: t,
        ms: simState.uptimeMs - i * 120,
        bootId: boot,
        sampleId: 1,
        seq: 500 - i,
        raw: baseA0,
        ldr: 0,
        ethanol: 10.2,
        state: 'monitoring',
        mode: 'automatic',
        r1: false,
        r2: false
      });
    }
  }

  if (!logs || !logs.length) {
    const now = Date.now();
    logs.push(
      { id: 'init-1', time: now - 35000, ms: 107000, bootId: boot, sampleId: 1, level: 'info', text: 'FuelGuard 2.0 Core initialized • Dual-sensor optical & conductivity array online' },
      { id: 'init-2', time: now - 25000, ms: 117000, bootId: boot, sampleId: 1, level: 'info', text: 'Programmed Autonomous ESP Mode armed • Flush threshold limit 275 A0' },
      { id: 'init-3', time: now - 15000, ms: 127000, bootId: boot, sampleId: 1, level: 'info', text: 'Hydrocarbon baseline acquired: A0 98 counts (Petrol-like optical phase)' }
    );
  }
}

// Restore persistent session
try {
  const saved = JSON.parse(localStorage.getItem('fg-recording-v3') || 'null');
  if (saved) {
    history = saved.history || [];
    logs = saved.logs || [];
    recordStart = saved.recordStart || Date.now();
  }
  const savedPoints = JSON.parse(localStorage.getItem('fg-calibration-points-v3') || 'null');
  if (Array.isArray(savedPoints) && savedPoints.length) {
    points = savedPoints;
    calCount = points.length;
  }
} catch (e) {}

if (demoMode) {
  initDemoPoints();
  initDemoHistory();
}

function savePointsLocally() {
  try {
    localStorage.setItem('fg-calibration-points-v3', JSON.stringify(points));
  } catch (e) {}
}

function estimateEthanol(rawVal) {
  if (rawVal < 50 || points.length < 2) return null;
  const sorted = points.slice().sort((a, b) => a.mean - b.mean);
  for (let i = 1; i < sorted.length; i++) {
    const p1 = sorted[i - 1];
    const p2 = sorted[i];
    if (rawVal >= p1.mean && rawVal <= p2.mean) {
      if (Math.abs(p2.mean - p1.mean) < 0.01) return p1.ethanol;
      return p1.ethanol + ((rawVal - p1.mean) / (p2.mean - p1.mean)) * (p2.ethanol - p1.ethanol);
    }
  }
  if (rawVal < sorted[0].mean && sorted[0].mean - rawVal < 40) return sorted[0].ethanol;
  if (rawVal > sorted[sorted.length - 1].mean && rawVal - sorted[sorted.length - 1].mean < 40) {
    return sorted[sorted.length - 1].ethanol;
  }
  return null;
}

const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

const pretty = s => s.replaceAll('-', ' ').replace(/^./, c => c.toUpperCase());

// Audio chime (Web Audio API)
function chime(type = 'info') {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    
    if (type === 'alarm') {
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      osc.frequency.setValueAtTime(440, ctx.currentTime + 0.1);
      gain.gain.setValueAtTime(0.18, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
      osc.start();
      osc.stop(ctx.currentTime + 0.35);
    } else {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(587.33, ctx.currentTime); // D5
      osc.frequency.setValueAtTime(880, ctx.currentTime + 0.08); // A5
      gain.gain.setValueAtTime(0.12, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
      osc.start();
      osc.stop(ctx.currentTime + 0.3);
    }
  } catch (e) {}
}

// In-Page Visual Toast
function toast(text, isAlert = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (isAlert ? ' toast-alert' : '');
  el.textContent = text;
  $('toasts').append(el);
  while ($('toasts').children.length > 5) $('toasts').firstChild.remove();
  setTimeout(() => el.remove(), 5000);
}

// Native Browser & PWA Notification
async function notify(text, title = 'FuelGuard Alert', isAlert = false) {
  toast(text, isAlert);
  chime(isAlert ? 'alarm' : 'info');

  if (!window.isSecureContext || !('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    if ('serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) {
        await reg.showNotification(title, {
          body: text,
          icon: '/icon-192.png',
          badge: '/icon-192.png',
          vibrate: isAlert ? [200, 100, 200] : [100],
          data: { url: '/#overview' }
        });
        return;
      }
    }
    new Notification(title, { body: text, icon: '/icon-192.png' });
  } catch (e) {}
}

function browserLog(text, level = 'info') {
  logs.push({
    id: 'log-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
    time: Date.now(),
    ms: status?.uptimeMs || simState.uptimeMs || 0,
    bootId: boot,
    sampleId: status?.sampleId || simState.sampleId || 1,
    level,
    text
  });
  if (logs.length > MAX_LOGS) logs.shift();
  renderLogs();
}

// -------------------------------------------------------------
// SIMULATION ENGINE INTERNALS (TICK LOOP & ACTIONS)
// -------------------------------------------------------------
function simTick() {
  simState.uptimeMs += 120;
  simState.seq++;

  // Automatic state progression
  if (simState.state === 'countdown') {
    // Handled in countdown timer
  } else if (simState.state === 'flushing') {
    if (simState.pumpRemainingMs > 0) {
      simState.pumpRemainingMs = Math.max(0, simState.pumpRemainingMs - 120);
      // Gradually drop A0 as separated phase is flushed out
      if (simState.raw > 105) {
        simState.raw = Math.max(96, simState.raw - 12);
        if (simState.raw < THRESHOLD) {
          simState.ldrDigital = 0;
        }
      }
      if (simState.pumpRemainingMs === 0) {
        simState.r1 = false;
        simState.state = 'monitoring';
        simState.targetRaw = 96;
        simState.raw = 96;
        simState.ldrDigital = 0;
        simState.spikeActive = false;
        browserLog('Flush complete: separated phase purged. A0 returned to nominal', 'info');
        notify('Automated flush complete. Homogeneous phase restored.');
      }
    }
  } else {
    // Normal monitoring state: realistic subtle fluctuations
    if (simState.mode === 'manual' && (simState.r1 || simState.r2) && simState.pumpRemainingMs > 0) {
      simState.pumpRemainingMs = Math.max(0, simState.pumpRemainingMs - 120);
      if (simState.pumpRemainingMs === 0) {
        simState.r1 = false;
        simState.r2 = false;
        browserLog('Manual pump timer elapsed; actuators stopped', 'info');
      }
    }

    if (!simState.spikeActive) {
      const noise = (Math.random() - 0.5) * 3;
      simState.raw = Math.max(52, Math.min(180, Math.round(simState.targetRaw + noise)));
      simState.ldrDigital = 0;
    }
  }

  // Build simulated status response
  return {
    ok: true,
    bootId: boot,
    uptimeMs: simState.uptimeMs,
    seq: simState.seq,
    sampleId: simState.sampleId,
    raw: simState.raw,
    ldrDigital: simState.ldrDigital,
    ethanolEstimate: estimateEthanol(simState.raw) ?? 10.2,
    state: simState.state,
    countdown: simState.countdown,
    mode: simState.mode,
    r1: simState.r1,
    r2: simState.r2,
    pumpRemainingMs: simState.pumpRemainingMs,
    doseResult: simState.doseResult,
    doseMl: simState.doseMl,
    captureProgress: simState.captureProgress,
    captureResult: simState.captureResult,
    calibrationCount: points.length
  };
}

// Hackathon Simulator Controls
window.fuelGuardSim = {
  triggerSpike() {
    if (simState.state === 'flushing') {
      toast('Flush pump R1 is already running to clear chamber.');
      return;
    }
    simState.spikeActive = true;
    simState.raw = 345;
    simState.targetRaw = 345;
    simState.ldrDigital = 1;
    
    browserLog(`Limit reached! : 345 (Threshold ${THRESHOLD} exceeded by water contamination)`, 'warn');
    notify(`Limit reached! : 345 A0 counts. Water separation detected!`, 'Water Separation Alert ⚠️', true);

    if (simState.mode === 'automatic') {
      simState.state = 'countdown';
      simState.countdown = 3;
      browserLog('Automatic 3-second countdown initiated before purge', 'warn');

      let c = 3;
      if (simState.countdownInterval) clearInterval(simState.countdownInterval);
      simState.countdownInterval = setInterval(() => {
        c--;
        simState.countdown = c;
        if (c <= 0) {
          clearInterval(simState.countdownInterval);
          simState.countdownInterval = null;
          simState.state = 'flushing';
          simState.r1 = true;
          simState.pumpRemainingMs = 4500;
          browserLog('Automated Flush Initiated: Removal Pump R1 ON to purge lower aqueous layer', 'warn');
          notify('Pump R1 ON: Purging separated water layer from bottom of chamber.');
        }
      }, 1000);
    } else {
      toast('Manual mode active: pumps will not flush automatically. Switch to Auto or run R1 manually.', true);
    }
  },

  restoreClean() {
    if (simState.countdownInterval) {
      clearInterval(simState.countdownInterval);
      simState.countdownInterval = null;
    }
    simState.spikeActive = false;
    simState.state = 'monitoring';
    simState.targetRaw = 96;
    simState.raw = 96;
    simState.ldrDigital = 0;
    simState.r1 = false;
    simState.r2 = false;
    simState.pumpRemainingMs = 0;
    browserLog('Test specimen restored to clean petrol baseline (A0 ~96)', 'info');
    toast('Restored to clean petrol baseline (Nominal)');
  },

  runCommand() {
    const input = $('quickSimInput');
    if (!input) return;
    const cmd = input.value.trim();
    input.value = '';
    if (!cmd) return;

    if (cmd === SPECIAL_PIN) {
      token = 'pin-authorized-1335';
      updateAuthUI();
      notify('PIN 1335 verified! Manual controls unlocked.', 'Access Granted');
    } else if (cmd === '/spike' || cmd.toLowerCase() === 'spike') {
      this.triggerSpike();
    } else if (cmd === '/clean' || cmd.toLowerCase() === 'clean') {
      this.restoreClean();
    } else if (cmd === '/stop' || cmd.toLowerCase() === 'stop') {
      action('/api/stop', {});
    } else {
      toast(`Sim command accepted: "${cmd}"`);
      browserLog(`Operator command: ${cmd}`);
    }
  }
};

// Toggle Demo Mode Switch
function toggleDemoMode(forceState) {
  demoMode = forceState !== undefined ? Boolean(forceState) : !demoMode;
  localStorage.setItem('fuelguard-demo-mode', String(demoMode));
  updateDemoModeUI();
  if (demoMode) {
    initDemoPoints();
    initDemoHistory();
    setLive(true);
    toast('⚡ Demo Mode Enabled: Simulating ESP32 Telemetry');
  } else {
    toast('Hardware Mode: Connecting to physical ESP32 access point...');
  }
}

function updateDemoModeUI() {
  const topText = $('headerDemoText');
  if (topText) topText.textContent = demoMode ? 'Demo' : 'Hardware';

  const sfcTitle = $('sfcTitle');
  if (sfcTitle) sfcTitle.textContent = demoMode ? 'Demo Mode Active' : 'Hardware Mode';

  const sfcDesc = $('sfcDesc');
  if (sfcDesc) sfcDesc.textContent = demoMode 
    ? 'Simulating live ESP32 telemetry, phase separation & flush cycle.' 
    : 'Listening to physical ESP32 on 192.168.4.1 Wi-Fi AP.';

  const sfcBtn = $('toggleDemoSidebarBtn');
  if (sfcBtn) sfcBtn.textContent = demoMode ? 'Switch to Hardware' : 'Switch to Demo';

  const demoNotice = $('demoNoticeBanner');
  if (demoNotice) demoNotice.hidden = !demoMode;

  const conn = $('connection');
  if (conn) {
    if (demoMode) {
      conn.textContent = '⚡ DEMO SIMULATOR';
      conn.className = 'pill pill-demo';
    } else {
      conn.textContent = live ? '● LIVE HARDWARE' : '● OFFLINE';
      conn.className = 'pill' + (live ? ' pill-live' : ' bad');
    }
  }
}

// Global search bar handler
const globalSearch = $('globalSearch');
if (globalSearch) {
  globalSearch.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      const q = globalSearch.value.trim().toLowerCase();
      if (!q) return;
      if (q.includes('signal') || q.includes('graph')) location.hash = '#signals';
      else if (q.includes('control') || q.includes('pump') || q.includes('motor')) location.hash = '#control';
      else if (q.includes('calib') || q.includes('lab') || q.includes('ethanol')) location.hash = '#calibration';
      else if (q.includes('report') || q.includes('pdf')) location.hash = '#reports';
      else if (q.includes('log') || q.includes('event')) location.hash = '#logs';
      else if (q.includes('setting') || q.includes('pwa')) location.hash = '#settings';
      else if (q === '1335') {
        token = 'pin-authorized-1335';
        updateAuthUI();
        notify('PIN 1335 verified via search bar!');
      } else {
        toast(`Search: Jumped to ${q}`);
      }
    }
  });

  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      globalSearch.focus();
    } else if (e.key === '/' && document.activeElement !== globalSearch && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
      e.preventDefault();
      globalSearch.focus();
    }
  });
}

// HTTP API Request Engine
async function request(path, body) {
  // If demo mode is active, handle endpoints locally
  if (demoMode) {
    if (path.startsWith('/api/status')) {
      return simTick();
    }
    if (path.startsWith('/api/logs')) {
      return { ok: true, bootId: boot, latest: logs.length, events: logs.slice(-20) };
    }
    if (path.startsWith('/api/calibration')) {
      return { ok: true, points };
    }
    if (path.startsWith('/api/login')) {
      return { ok: true, token: 'pin-authorized-1335' };
    }
    if (path.startsWith('/api/mode')) {
      if (body?.mode) simState.mode = body.mode;
      browserLog(`System mode switched to: ${simState.mode.toUpperCase()}`);
      return simTick();
    }
    if (path.startsWith('/api/stop')) {
      simState.r1 = false;
      simState.r2 = false;
      simState.pumpRemainingMs = 0;
      if (simState.countdownInterval) {
        clearInterval(simState.countdownInterval);
        simState.countdownInterval = null;
      }
      simState.state = 'monitoring';
      browserLog('EMERGENCY STOP EXECUTED: All pump actuators shut down', 'warn');
      return simTick();
    }
    if (path.startsWith('/api/pump')) {
      const ch = Number(body?.channel || 1);
      const sec = Number(body?.seconds || 5);
      if (ch === 1) simState.r1 = true;
      if (ch === 2) simState.r2 = true;
      simState.pumpRemainingMs = sec * 1000;
      browserLog(`Manual Actuator: Pump R${ch} (${ch === 1 ? 'Flush' : 'Booster'}) started for ${sec}s`);
      return simTick();
    }
    if (path.startsWith('/api/booster')) {
      const ml = (Number(body?.petrolMl || 100) * Number(body?.ratio || 1.0)) / 1000;
      const sec = ml / Number(body?.flow || 1.0);
      simState.r2 = true;
      simState.pumpRemainingMs = Math.round(sec * 1000);
      simState.doseMl = ml;
      simState.doseResult = `Dispensing ${ml.toFixed(3)} mL additive (${sec.toFixed(1)}s run)`;
      browserLog(`Booster Dose: ${simState.doseResult}`);
      return simTick();
    }
    return { ok: true };
  }

  // Real Hardware Network Call
  const c = new AbortController();
  const timer = setTimeout(() => c.abort(), 1600);
  try {
    const headers = { 'X-FuelGuard': '1' };
    if (token) headers.Authorization = 'Bearer ' + token;
    if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded';

    const r = await fetch(path, {
      method: body ? 'POST' : 'GET',
      headers,
      body: body ? new URLSearchParams(body) : undefined,
      cache: 'no-store',
      signal: c.signal
    });
    const j = await r.json();
    if (!r.ok || j.ok === false) {
      if (r.status === 401) {
        token = '';
        $('authState').textContent = 'Locked. Unlock manual controls using Security PIN.';
        updateAuthUI();
      }
      throw new Error(j.error || 'Request failed');
    }
    return j;
  } finally {
    clearTimeout(timer);
  }
}

async function action(path, data = {}) {
  try {
    if (!live && !demoMode) throw new Error('Device disconnected; controls disabled');
    const j = await request(path, data);
    if (j && j.raw !== undefined) {
      status = j;
      renderStatus();
    }
    return j;
  } catch (e) {
    toast(e.message, true);
    return null;
  }
}

function setLive(value) {
  live = value;
  $('offline').hidden = value || demoMode;
  updateDemoModeUI();
  document.querySelectorAll('[data-live]').forEach(el => el.disabled = !value && !demoMode);
  updateAuthUI();
}

// Update authentication badges and buttons
function updateAuthUI() {
  const isAuth = Boolean(token);
  const curMode = demoMode ? simState.mode : status?.mode;
  const isManual = curMode === 'manual';

  const canRun = (live || demoMode) && isAuth && isManual && !Boolean(status?.capturing);
  if ($('r1On')) $('r1On').disabled = !canRun;
  if ($('r2On')) $('r2On').disabled = !canRun;
  
  if (isAuth) {
    $('authState').textContent = 'PIN 1335 verified. Manual motor control active for this session.';
    $('openAuthModalBtn').textContent = 'PIN Verified ✓';
    $('openAuthModalBtn').classList.add('badge-teal');
  } else {
    $('authState').textContent = 'Manual motor override is optional. Requires Security PIN (1335).';
    $('openAuthModalBtn').textContent = 'Enter PIN';
    $('openAuthModalBtn').classList.remove('badge-teal');
  }

  $('modeOptAuto').classList.toggle('active', curMode === 'automatic');
  $('modeOptManual').classList.toggle('active', isManual);
}

// Render Real-Time Telemetry & Status
function renderStatus() {
  if (!status) return;
  const s = status;
  const isLimit = s.raw >= THRESHOLD;

  // Header Mode Pill
  $('modeHeaderBadge').textContent = s.mode === 'automatic' ? 'AUTONOMOUS ESP' : 'MANUAL OVERRIDE';
  $('modeHeaderBadge').classList.toggle('bad', s.mode === 'manual');

  // Hero Mode & State Badges (preserved for backward compatibility)
  if ($('modeBadge')) $('modeBadge').textContent = s.mode === 'automatic' ? 'PROGRAMMED AUTONOMOUS ESP' : 'MANUAL OPERATOR OVERRIDE';
  if ($('stateBadge')) {
    $('stateBadge').textContent = isLimit ? `LIMIT REACHED! : ${s.raw}` : pretty(s.state).toUpperCase();
    $('stateBadge').classList.toggle('bad', isLimit);
  }

  // Sample ID & Clock
  if ($('sampleBadge')) $('sampleBadge').textContent = 'SAMPLE ' + String(s.sampleId).padStart(3, '0');
  $('clock').textContent = new Date().toLocaleTimeString();
  if ($('phaseState')) $('phaseState').textContent = 'PHASE: ' + (s.raw < 50 ? 'EMPTY' : isLimit ? 'SEPARATED / FLUSH' : 'MONITORING');

  // Banner
  if (isLimit) {
    if ($('headline')) {
      $('headline').textContent = `Limit reached! : ${s.raw}`;
      $('headline').style.color = 'var(--coral)';
    }
    $('limitAlertBanner').hidden = false;
    $('limitAlertText').textContent = `Limit reached! : ${s.raw} A0 counts (Threshold ${THRESHOLD} exceeded)`;
    
    // Dispatch alert notification once every 12 seconds if limit is sustained
    if (Date.now() - lastLimitNotifiedAt > 12000) {
      lastLimitNotifiedAt = Date.now();
      notify(`Limit reached! : ${s.raw} (Threshold ${THRESHOLD} exceeded)`, 'Limit Alert ⚠️', true);
    }
  } else {
    if ($('headline')) {
      $('headline').textContent = pretty(s.state);
      $('headline').style.color = '';
    }
    $('limitAlertBanner').hidden = true;
  }

  const sensorConflict = (s.raw >= 50) && (
    (s.raw < THRESHOLD && s.ldrDigital === 1) ||
    (s.raw >= THRESHOLD && s.ldrDigital === 0)
  );

  if ($('decision')) {
    $('decision').textContent = isLimit
      ? `Conductivity limit reached! : ${s.raw}. Immediate action: ${s.state === 'countdown' ? 'Automatic flush initiates in ' + s.countdown + ' s.' : s.state === 'flushing' ? 'Removal pump R1 is currently purging lower phase.' : 'Exceeded threshold of ' + THRESHOLD + ' counts.'}`
      : (s.raw < 50
        ? 'Chamber empty (A0 < 50). Dip electrodes into fuel specimen to begin monitoring. Empty readings are excluded from report statistics.'
        : sensorConflict
          ? 'Sensor divergence: Optical LDR indicates water refraction while conductivity is below threshold. Inspect optical alignment.'
          : 'Baseline conductivity within nominal range. Continuous 100ms hardware sampling active.');
  }

  // Dashboard Callout & Trend Badges (Shopeers Layout)
  const heroA0 = $('heroA0Display');
  if (heroA0) heroA0.textContent = `${s.raw} A0 Counts`;

  const heroTrend = $('heroTrendBadge');
  if (heroTrend) {
    if (isLimit) {
      heroTrend.textContent = '⚠️ Phase Separation Spike';
      heroTrend.className = 'trend-badge trend-down';
    } else if (s.raw < 50) {
      heroTrend.textContent = 'Chamber Empty (A0 < 50)';
      heroTrend.className = 'trend-badge trend-neutral';
    } else {
      heroTrend.textContent = '● Nominal Petrol Phase';
      heroTrend.className = 'trend-badge trend-up';
    }
  }

  // Metric 1: Conductivity Proxy
  $('rawValue').textContent = s.raw;
  $('meter').style.width = Math.min(100, (100 * s.raw / 1023)) + '%';
  $('meter').style.background = isLimit ? 'var(--coral)' : 'var(--teal)';
  
  const condTag = $('condStatusTag');
  if (condTag) {
    if (isLimit) {
      condTag.textContent = `Limit : ${s.raw}`;
      condTag.className = 'trend-badge trend-down';
    } else if (s.raw < 50) {
      condTag.textContent = 'Empty';
      condTag.className = 'trend-badge trend-neutral';
    } else {
      condTag.textContent = '+0.4% Nominal';
      condTag.className = 'trend-badge trend-up';
    }
  }
  $('thresholdLabel').textContent = isLimit ? `Action Limit Exceeded! : ${s.raw} (Threshold: ${THRESHOLD})` : `Action threshold: ≥ ${THRESHOLD} counts`;

  // Metric 2: Optical Signal
  $('ldrValue').textContent = s.ldrDigital ? 'HIGH · 1' : 'LOW · 0';
  $('ldrDot').classList.toggle('water-state', Boolean(s.ldrDigital));
  $('ldrPhaseText').textContent = s.raw < 50 ? 'No sample present' : (s.ldrDigital ? 'Water-like phase' : 'Petrol-like phase');
  $('ldrLabel').textContent = s.raw < 50 ? 'Optical baseline only' : (s.ldrDigital ? 'Water-like optical refraction index' : 'Hydrocarbon optical refraction index');

  const ldrTrend = $('ldrTrendBadge');
  if (ldrTrend) {
    if (s.ldrDigital) {
      ldrTrend.textContent = '⚠️ Aqueous Layer';
      ldrTrend.className = 'trend-badge trend-down';
    } else {
      ldrTrend.textContent = 'D7 Sensor';
      ldrTrend.className = 'trend-badge trend-neutral';
    }
  }

  // Metric 3: Ethanol Estimation
  const est = (s.ethanolEstimate !== null && Number.isFinite(s.ethanolEstimate))
    ? s.ethanolEstimate
    : estimateEthanol(s.raw);

  if (est !== null && Number.isFinite(est)) {
    $('ethanolValue').textContent = est.toFixed(1);
    $('calTag').textContent = `~E${Math.round(est)}% Approx`;
    $('calTag').className = 'trend-badge trend-up';
    $('estimateHint').textContent = 'Interpolated from calibrated references';
    $('ethanolMeter').style.width = Math.min(100, Math.max(0, est)) + '%';
  } else {
    $('ethanolValue').textContent = '—';
    $('calTag').textContent = points.length < 2 ? 'Need ≥2 points' : 'Out of range';
    $('calTag').className = 'trend-badge trend-neutral';
    $('estimateHint').textContent = s.raw < 50 ? 'Add sample to measure' : 'Calibrate reference samples in Lab';
    $('ethanolMeter').style.width = '0%';
  }

  // Metric 4: Actuator Status
  for (let i = 1; i <= 2; i++) {
    const el = $('pump' + i);
    el.textContent = `R${i} (${i === 1 ? 'Flush' : 'Booster'}): ` + (s['r' + i] ? 'ON' : 'OFF');
    el.classList.toggle('on', Boolean(s['r' + i]));
  }

  const pSummary = $('pumpSummaryValue');
  if (pSummary) {
    pSummary.textContent = s.r1 ? 'R1 Active' : s.r2 ? 'R2 Active' : 'Pumps Idle';
  }

  const pMode = $('pumpModeTag');
  if (pMode) {
    pMode.textContent = s.mode === 'automatic' ? 'ESP Auto' : 'Manual Mode';
  }

  $('pumpRemaining').textContent = s.pumpRemainingMs
    ? `${Math.ceil(s.pumpRemainingMs / 1000)} s timeout remaining`
    : 'Both pumps idle';

  // Navigation log badge
  const navLog = $('navLogCount');
  if (navLog) navLog.textContent = logs.length;

  // Observation sample count widget
  const actCount = $('activityCount');
  if (actCount) actCount.textContent = (history.length || 1240) + ' Samples';

  // Radial Purity Gauge calculation & animation
  const purity = isLimit ? 18.2 : s.raw < 50 ? 0.0 : 99.4;
  const gaugeText = $('gaugePct');
  if (gaugeText) gaugeText.textContent = purity.toFixed(1) + '%';
  
  const gaugePath = $('gaugePath');
  if (gaugePath) {
    const arcLen = 235.6;
    const offset = arcLen * (1 - purity / 100);
    gaugePath.style.strokeDashoffset = offset;
    gaugePath.style.stroke = isLimit ? 'var(--coral)' : purity > 80 ? 'var(--teal)' : 'var(--amber)';
  }

  const gaugeStatus = $('gaugeStatusText');
  if (gaugeStatus) {
    gaugeStatus.textContent = isLimit 
      ? 'Phase Separation Alert! Purging Lower Phase' 
      : 'On track • Zero phase separation';
    gaugeStatus.style.color = isLimit ? 'var(--coral)' : 'var(--teal-dark)';
  }

  // Radar sphere widget
  const sphere = $('simulatorSphere');
  if (sphere) {
    sphere.classList.toggle('alert-state', isLimit);
  }

  // Diagnostic Rules Table rows
  const d1 = $('diagRule1');
  if (d1) {
    d1.textContent = s.raw < 50 ? 'Empty Chamber' : 'Nominal';
    d1.className = 'badge ' + (s.raw < 50 ? 'badge-amber' : 'badge-teal');
  }
  const d2 = $('diagRule2');
  if (d2) {
    d2.textContent = isLimit ? 'TRIGGERED' : 'Armed';
    d2.className = 'badge ' + (isLimit ? 'badge-amber' : 'badge-teal');
  }
  const d3 = $('diagRule3');
  if (d3) {
    d3.textContent = s.ldrDigital ? 'Water (1)' : 'Petrol (0)';
    d3.className = 'badge ' + (s.ldrDigital ? 'badge-amber' : 'badge-teal');
  }

  // Modal Live Preview
  if (!$('calModal').hidden) {
    $('calModalLiveA0').textContent = s.raw + ' A0';
    $('calModalStability').textContent = s.raw < 50
      ? '⚠️ Electrodes not submerged (A0 < 50)'
      : '✓ Sensor submerged & communicating';
    $('calModalStability').style.color = s.raw < 50 ? 'var(--coral)' : 'var(--teal-dark)';
  }

  // Diagnostic Conflict text
  $('conflict').textContent = s.raw < 50
    ? 'No sample detected. Place probe into test blend.'
    : sensorConflict
      ? 'Optical and conductivity signals diverge. Check optical sensor alignment.'
      : 'Live sensor telemetry coherent. Monitoring active.';

  // Dose & Calibration status
  $('doseNote').textContent = `${s.doseResult} • Last requested dose: ${s.doseMl.toFixed(3)} mL`;
  $('calProgress').value = s.captureProgress;
  $('calProgressPct').textContent = s.captureProgress + '%';
  $('calResult').textContent = s.captureResult;

  // Recording info
  $('recordingInfo').textContent = `${history.length} observations in memory • Scope started ${new Date(recordStart).toLocaleTimeString()} • Buffer limit: ${MAX_READINGS}`;

  // Update diagnostic preview in Report Studio
  updateReportPreview();
  updateAuthUI();
}

// Update PDF preview summary in Report tab
function updateReportPreview() {
  const summary = stats(reportRows());
  $('pdfMeanA0').textContent = summary.raw !== null ? summary.raw.toFixed(1) + ' counts' : 'N/A';
  $('pdfEstEthanol').textContent = summary.ethanol !== null ? summary.ethanol.toFixed(1) + ' %' : 'N/A';
  
  const highA0 = summary.valid.some(p => p.raw >= THRESHOLD);
  const waterOpt = summary.valid.some(p => p.ldr === 1);
  
  if (highA0 || waterOpt) {
    $('pdfVehicleSafety').textContent = '⚠️ UNSAFE FOR VEHICLE';
    $('pdfVehicleSafety').style.color = 'var(--coral)';
    $('pdfPhaseStatus').textContent = 'Phase Separation Detected';
    $('pdfPhaseStatus').style.color = 'var(--coral)';
  } else if (summary.valid.length > 5) {
    $('pdfVehicleSafety').textContent = '✓ WITHIN BENCH LIMITS';
    $('pdfVehicleSafety').style.color = 'var(--teal-dark)';
    $('pdfPhaseStatus').textContent = 'Homogeneous Phase';
    $('pdfPhaseStatus').style.color = 'var(--teal-dark)';
  } else {
    $('pdfVehicleSafety').textContent = 'Pending Data';
    $('pdfVehicleSafety').style.color = '';
    $('pdfPhaseStatus').textContent = 'Pending Data';
    $('pdfPhaseStatus').style.color = '';
  }

  const flushEvents = logs.filter(e => e.text.includes('Flush stopped') || e.text.includes('Pump 1 ON') || e.text.includes('purged'));
  $('pdfFlushStatus').textContent = flushEvents.length ? 'Flush Executed' : 'No Flush Required';
}

// Polling Loop (~120ms cycle time)
async function poll() {
  const started = performance.now();
  try {
    const s = await request('/api/status?active=1');
    lastSuccess = Date.now();

    if (!live && !demoMode) {
      if (status) {
        browserLog('Connection to FuelGuard restored', 'info');
        notify('Device connection restored');
      }
      setLive(true);
    } else if (demoMode) {
      setLive(true);
    }

    // Reboot detection
    if (boot !== s.bootId) {
      if (boot && !demoMode) {
        token = '';
        browserLog('Device reboot detected; session re-anchored', 'warn');
        notify('FuelGuard device restarted');
      }
      boot = s.bootId;
      anchor = Date.now() - s.uptimeMs;
      lastSeq = -1;
      lastLog = 0;
      firstLogs = true;
      calCount = -1;
    }

    status = s;

    // Push telemetry into history ring buffer
    if (s.seq !== lastSeq) {
      history.push({
        time: anchor + s.uptimeMs,
        ms: s.uptimeMs,
        bootId: boot,
        sampleId: s.sampleId,
        seq: s.seq,
        raw: s.raw,
        ldr: s.ldrDigital,
        ethanol: s.ethanolEstimate,
        state: s.state,
        mode: s.mode,
        r1: s.r1,
        r2: s.r2
      });
      lastSeq = s.seq;
      if (history.length > MAX_READINGS) history.splice(0, history.length - MAX_READINGS);
    }

    renderStatus();
    requestAnimationFrame(drawCharts);

    // Heartbeat during manual mode
    if (token && s.mode === 'manual' && !demoMode) {
      await request('/api/heartbeat', {});
    }

    // Event log sync (every 1s)
    if (!demoMode && Date.now() - lastLogAt > 1000) {
      lastLogAt = Date.now();
      const result = await request('/api/logs?after=' + lastLog);
      if (result.bootId === boot) {
        if (result.lost) browserLog('Log buffer overflow on device: some entries dropped', 'warn');
        for (const e of result.events) {
          if (!logs.some(x => x.bootId === boot && x.id === e.id)) {
            logs.push({ ...e, bootId: boot, time: anchor + e.ms });
            if (!firstLogs) {
              const isAlert = e.level === 'warn' || e.level === 'error' || e.text.includes('Limit reached');
              notify(e.text, `Event (${e.level.toUpperCase()})`, isAlert);
            }
          }
        }
        lastLog = result.latest;
        firstLogs = false;
        logs = logs.slice(-MAX_LOGS);
        renderLogs();
      }
    }

    // Calibration points sync
    if (!demoMode && calCount !== s.calibrationCount) {
      const j = await request('/api/calibration');
      points = j.points || [];
      calCount = s.calibrationCount;
      renderCalibration();
    }
  } catch (e) {
    if (!demoMode && Date.now() - lastSuccess > 2200 && live) {
      setLive(false);
      browserLog('Connection lost; readings are stale', 'warn');
      notify('FuelGuard disconnected', 'Connection Alert', true);
    }
    if (!status && !demoMode) setLive(false);
  } finally {
    const elapsed = performance.now() - started;
    setTimeout(poll, Math.max(20, 120 - elapsed));
  }
}

// Windowed History for Charts
function visibleHistory() {
  const end = history.length ? history[history.length - 1].time : Date.now();
  const dur = Number($('window').value) * 1000;
  return history.filter(p => p.time >= end - dur);
}

const HEIGHT_MAP = {
  miniChart: 230,
  overlayChart: 260,
  conductivityChart: 220,
  ldrChart: 220
};

// -------------------------------------------------------------
// LIGHT-THEME NEO-BRUTALIST CANVAS CHART ENGINE
// -------------------------------------------------------------
function chart(canvas, rows, kind) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.floor(canvas.clientWidth || canvas.parentElement?.clientWidth || 800);
  const h = HEIGHT_MAP[canvas.id] || Number(canvas.dataset.baseHeight) || 220;
  canvas.dataset.baseHeight = String(h);

  const targetW = Math.round(w * dpr);
  const targetH = Math.round(h * dpr);

  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW;
    canvas.height = targetH;
    canvas.style.height = h + 'px';
  }

  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // Light Theme Clean White Background
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);

  const l = 46;
  const r = kind === 'overlay' ? 44 : 16;
  const t = 16;
  const b = 28;
  const pw = w - l - r;
  const ph = h - t - b;

  ctx.font = '700 10px -apple-system, sans-serif';
  ctx.lineWidth = 1;

  // Grid Lines & Axis Labels
  for (let i = 0; i <= 4; i++) {
    const yVal = t + (ph * i) / 4;
    ctx.strokeStyle = '#f1f5f9';
    ctx.beginPath();
    ctx.moveTo(l, yVal);
    ctx.lineTo(w - r, yVal);
    ctx.stroke();

    ctx.fillStyle = '#94a3b8';
    const label = kind === 'ldr'
      ? (1 - i / 4).toFixed(1)
      : String(Math.round(1023 * (1 - i / 4)));
    ctx.fillText(label, 6, yVal + 3.5);
  }

  // Right Axis for Overlay (LDR 0/1: 0 Petrol, 1 Water)
  if (kind === 'overlay') {
    ctx.fillStyle = '#d97706';
    ctx.fillText('1 Water', w - r + 4, t + 4);
    ctx.fillText('0 Petrol', w - r + 4, t + ph + 3);
  }

  if (!rows || !rows.length) {
    ctx.fillStyle = '#94a3b8';
    ctx.font = '700 12px sans-serif';
    ctx.fillText('Waiting for sensor observations...', l + 20, t + ph / 2);
    return;
  }

  const start = rows[0].time;
  const end = Math.max(start + 1000, rows[rows.length - 1].time);
  const x = v => l + ((v - start) / (end - start)) * pw;
  const y = (v, max) => t + ph * (1 - Math.min(max, Math.max(0, v)) / max);

  // Threshold marker at 275 (High Visibility Red Dashed Limit Line)
  if (kind !== 'ldr') {
    const yThresh = y(THRESHOLD, 1023);
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = '#dc2626';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(l, yThresh);
    ctx.lineTo(w - r, yThresh);
    ctx.stroke();
    ctx.setLineDash([]);

    // Limit badge tag
    ctx.fillStyle = '#dc2626';
    ctx.font = '800 9px sans-serif';
    ctx.fillText('LIMIT 275', l + 6, yThresh - 5);
  }

  // Area Fill under A0 line (matches the soft gradient fill in the Shopeers reference image)
  if (kind !== 'ldr') {
    const grad = ctx.createLinearGradient(0, t, 0, t + ph);
    grad.addColorStop(0, 'rgba(37, 99, 235, 0.16)');
    grad.addColorStop(1, 'rgba(37, 99, 235, 0.0)');

    ctx.fillStyle = grad;
    ctx.beginPath();
    let startedArea = false;
    for (const row of rows) {
      const px = x(row.time);
      const py = y(row.raw, 1023);
      if (!startedArea) {
        ctx.moveTo(px, t + ph);
        ctx.lineTo(px, py);
        startedArea = true;
      } else {
        ctx.lineTo(px, py);
      }
    }
    if (startedArea && rows.length > 0) {
      ctx.lineTo(x(rows[rows.length - 1].time), t + ph);
      ctx.closePath();
      ctx.fill();
    }
  }

  // Trace rendering function
  function trace(field, max, color, step = false) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    let prev = null;

    for (const row of rows) {
      const px = x(row.time);
      const py = y(row[field], max);

      if (!prev || row.time - prev.time > 1500 || row.bootId !== prev.bootId) {
        ctx.moveTo(px, py);
      } else {
        if (step) ctx.lineTo(px, y(prev[field], max));
        ctx.lineTo(px, py);
      }
      prev = row;
    }
    ctx.stroke();
  }

  // Draw traces: Electric blue for raw A0, warm amber step line for LDR
  if (kind !== 'ldr') {
    trace('raw', 1023, '#2563eb', false);
  }
  if (kind !== 'raw') {
    trace('ldr', 1, '#f59e0b', true);
  }

  // Time stamps on bottom
  ctx.fillStyle = '#64748b';
  ctx.font = '700 10px sans-serif';
  ctx.fillText(new Date(start).toLocaleTimeString(), l, h - 8);
  const endText = new Date(end).toLocaleTimeString();
  ctx.fillText(endText, w - r - ctx.measureText(endText).width, h - 8);
}

// Draw all visible charts
function drawCharts() {
  const rows = visibleHistory();

  // Overview mini chart
  const mini = $('miniChart');
  if (mini && mini.offsetParent) {
    const targetKind = activeMiniTab === 'miniConductivity' ? 'raw' : activeMiniTab === 'miniLdr' ? 'ldr' : 'overlay';
    chart(mini, rows, targetKind);
  }

  // Signals tab charts
  for (const [id, kind] of [
    ['overlayChart', 'overlay'],
    ['conductivityChart', 'raw'],
    ['ldrChart', 'ldr']
  ]) {
    const el = $(id);
    if (el && el.offsetParent) chart(el, rows, kind);
  }

  // Update stat badges in Signals tab
  if (status) {
    $('condStatBadge').textContent = `A0: ${status.raw}`;
    $('ldrStatBadge').textContent = `LDR: ${status.ldrDigital ? '1 (Water)' : '0 (Petrol)'}`;
  }
}

// Render Event Journal Table
function renderLogs() {
  const f = $('logFilter').value;
  const filtered = logs.slice().reverse().filter(e => {
    if (f === 'warn') return e.level === 'warn' || e.level === 'error' || e.text.includes('Limit reached');
    if (f === 'error') return e.level === 'error';
    if (f === 'info') return e.level === 'info';
    return true;
  });

  if (!filtered.length) {
    $('logRows').innerHTML = '<tr><td colspan="4">No matching events logged.</td></tr>';
    return;
  }

  $('logRows').innerHTML = filtered.map(e => `
    <tr>
      <td><strong>${escapeHtml(new Date(e.time).toLocaleTimeString())}</strong> <small class="muted">${new Date(e.time).toLocaleDateString()}</small></td>
      <td class="level-${escapeHtml(e.level)}">${escapeHtml(e.level.toUpperCase())}</td>
      <td><span class="badge">#${e.sampleId}</span></td>
      <td>${escapeHtml(e.text)}</td>
    </tr>
  `).join('');
}

// Render Calibration Points Table
function renderCalibration() {
  $('calCountBadge').textContent = `${points.length} Point${points.length === 1 ? '' : 's'}`;
  if (!points.length) {
    $('calRows').innerHTML = '<tr><td colspan="6">No reference samples saved yet.</td></tr>';
    return;
  }

  $('calRows').innerHTML = points.map((p, i) => `
    <tr>
      <td><strong>${escapeHtml(p.name)}</strong></td>
      <td><span class="badge badge-teal">E${p.ethanol.toFixed(1)}</span></td>
      <td><strong>${p.mean.toFixed(1)}</strong> A0</td>
      <td>&plusmn;${p.sd.toFixed(2)}</td>
      <td>${p.n} readings</td>
      <td><button class="secondary" data-delete="${i}" style="padding: 3px 8px; font-size: 11px;">Delete</button></td>
    </tr>
  `).join('');
}

// Navigation Drawer Controls (Mobile Drawer / Desktop Persistent)
function toggleDrawer(open) {
  const shouldOpen = open !== undefined ? open : !$('drawer').classList.contains('open');
  $('drawer').classList.toggle('open', shouldOpen);
  $('shade').hidden = !shouldOpen;
  $('menu').classList.toggle('is-active', shouldOpen);
  $('menu').setAttribute('aria-expanded', String(shouldOpen));
  if (shouldOpen) $('closeMenu').focus();
}

function route() {
  const id = location.hash.slice(1) || 'overview';
  document.querySelectorAll('.page').forEach(p => p.hidden = p.id !== id);
  if (!document.querySelector('.page:not([hidden])')) $('overview').hidden = false;
  
  // Highlight active link in sidebar
  document.querySelectorAll('.drawer-link').forEach(link => {
    const isAct = link.getAttribute('href') === '#' + id;
    link.classList.toggle('active', isAct);
  });

  if (window.innerWidth < 1024) {
    toggleDrawer(false);
  }
  window.scrollTo(0, 0);
  drawCharts();
}

// Event Listeners for Nav Drawer
$('menu').onclick = () => toggleDrawer();
$('closeMenu').onclick = $('shade').onclick = () => toggleDrawer(false);

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (window.innerWidth < 1024) toggleDrawer(false);
    closeModals();
  }
});

window.addEventListener('hashchange', route);
window.addEventListener('resize', drawCharts);
$('window').onchange = drawCharts;
$('logFilter').onchange = renderLogs;
$('clearLogsBtn').onclick = () => {
  logs = [];
  renderLogs();
  toast('Event journal view cleared');
};

// Overview Mini Chart Tabs
document.querySelectorAll('[data-chart-tab]').forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll('[data-chart-tab]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeMiniTab = btn.dataset.chartTab;
    drawCharts();
  };
});

// Demo Mode Toggle Listeners
if ($('headerDemoToggle')) {
  $('headerDemoToggle').onclick = () => toggleDemoMode();
}
if ($('toggleDemoSidebarBtn')) {
  $('toggleDemoSidebarBtn').onclick = () => toggleDemoMode();
}
if ($('triggerSpikeBtn')) {
  $('triggerSpikeBtn').onclick = () => window.fuelGuardSim.triggerSpike();
}
if ($('restoreCleanBtn')) {
  $('restoreCleanBtn').onclick = () => window.fuelGuardSim.restoreClean();
}

// Control Room & Mode Actions
$('autoMode').onclick = async () => {
  const res = await action('/api/mode', { mode: 'automatic' });
  if (res) notify('Programmed Autonomous ESP Mode Activated', 'Mode Switch');
};

$('manualMode').onclick = async () => {
  if (!token) {
    openAuthModal();
    return;
  }
  const res = await action('/api/mode', { mode: 'manual' });
  if (res) notify('Manual Operator Override Activated', 'Mode Switch', true);
};

// Emergency Stop
document.querySelectorAll('.stop').forEach(b => {
  b.onclick = async () => {
    await action('/api/stop', {});
    notify('Emergency stop executed: all pumps stopped', 'Emergency Stop', true);
  };
});

// Manual Pump Runs
for (let i = 1; i <= 2; i++) {
  $('r' + i + 'On').onclick = async () => {
    const sec = $('manualSeconds').value;
    const res = await action('/api/pump', {
      channel: i,
      on: 1,
      seconds: sec,
      bootId: boot,
      sampleId: status?.sampleId
    });
    if (res) notify(`Pump R${i} (${i === 1 ? 'Removal' : 'Booster'}) started for ${sec}s`, 'Pump Started');
  };
}

// Booster Dose Calculator
$('doseForm').onsubmit = e => {
  e.preventDefault();
  action('/api/booster', {
    ...Object.fromEntries(new FormData(e.target)),
    bootId: boot,
    sampleId: status?.sampleId
  });
};

// Modal Visibility Helpers
function openAuthModal() {
  const m = $('authModal');
  m.hidden = false;
  m.classList.add('open');
  m.style.display = 'flex';
  $('modalPasswordInput').value = '';
  setTimeout(() => $('modalPasswordInput').focus(), 50);
}

function closeAuthModal() {
  const m = $('authModal');
  m.hidden = true;
  m.classList.remove('open');
  m.style.display = 'none';
}

function openCalModal(name, ethanol) {
  pendingCalPreset = { name, ethanol: Number(ethanol) };
  $('calModalTitle').textContent = `Calibrate Reference: ${name}`;
  $('calModalSampleDesc').innerHTML = `Sample: <strong>${escapeHtml(name)}</strong> (Known E${Number(ethanol).toFixed(1)}%)`;
  const m = $('calModal');
  m.hidden = false;
  m.classList.add('open');
  m.style.display = 'flex';
}

function closeCalModal() {
  const m = $('calModal');
  m.hidden = true;
  m.classList.remove('open');
  m.style.display = 'none';
  pendingCalPreset = null;
}

function openDownloadModal() {
  const m = $('downloadModal');
  if (!m) return;
  m.removeAttribute('hidden');
  m.classList.add('open');
  m.style.setProperty('display', 'flex', 'important');
}

function closeDownloadModal() {
  const m = $('downloadModal');
  if (!m) return;
  m.classList.remove('open');
  m.style.setProperty('display', 'none', 'important');
}

window.openDownloadModal = openDownloadModal;
window.closeDownloadModal = closeDownloadModal;
window.triggerAppInstall = triggerAppInstall;

async function triggerAppInstall() {
  if (installPrompt) {
    try {
      await installPrompt.prompt();
      const outcome = await installPrompt.userChoice;
      if (outcome && outcome.outcome === 'accepted') {
        toast('FuelGuard App installed successfully! 🎉');
        if ($('install')) $('install').hidden = true;
        closeDownloadModal();
      }
    } catch (e) {
      toast('Installation prompt dismissed or cancelled.');
    }
    installPrompt = null;
  } else {
    toast('Tap your browser menu (Share or ⋮) and choose "Add to Home Screen" to install.');
  }
}

function closeModals() {
  closeAuthModal();
  closeCalModal();
  closeDownloadModal();
}

// Download App Buttons & Modal Handlers
if ($('downloadAppBtn')) $('downloadAppBtn').onclick = () => openDownloadModal();
if ($('drawerDownloadAppBtn')) $('drawerDownloadAppBtn').onclick = () => {
  if (window.innerWidth < 1024) toggleDrawer(false);
  openDownloadModal();
};
if ($('modalInstallTriggerBtn')) $('modalInstallTriggerBtn').onclick = triggerAppInstall;
if ($('closeDownloadModal')) $('closeDownloadModal').onclick = closeDownloadModal;
if ($('closeDownloadModalBtn')) $('closeDownloadModalBtn').onclick = closeDownloadModal;
if ($('downloadModal')) $('downloadModal').onclick = e => {
  if (e.target === $('downloadModal')) closeDownloadModal();
};

// Modal Buttons & Backdrop Click Listeners
$('openAuthModalBtn').onclick = openAuthModal;
$('closeAuthModal').onclick = closeAuthModal;
$('cancelAuthModalBtn').onclick = closeAuthModal;
$('closeCalModal').onclick = closeCalModal;
$('cancelCalModalBtn').onclick = closeCalModal;

$('calModal').onclick = e => {
  if (e.target === $('calModal')) closeCalModal();
};
$('authModal').onclick = e => {
  if (e.target === $('authModal')) closeAuthModal();
};

$('authModalForm').onsubmit = async e => {
  e.preventDefault();
  const enteredPin = $('modalPasswordInput').value.trim();
  if (enteredPin !== SPECIAL_PIN) {
    toast('Incorrect Security PIN. Access denied.', true);
    notify('Incorrect Security PIN entered', 'Access Denied', true);
    return;
  }
  closeAuthModal();

  if (demoMode) {
    token = 'pin-authorized-1335';
  } else {
    const j = await action('/api/login', { password: 'fuelguard123' });
    if (j && j.token) token = j.token;
    else token = 'pin-authorized-1335';
  }
  updateAuthUI();
  notify('PIN 1335 verified! Manual motor controls unlocked.', 'Access Granted');
};

// Calibration Presets
document.querySelectorAll('.preset-btn').forEach(btn => {
  btn.onclick = () => {
    $('calNameInput').value = btn.dataset.presetName;
    $('calEthanolInput').value = btn.dataset.presetEth;
    toast(`Preset selected: ${btn.dataset.presetName}`);
  };
});

// Calibration Wizard
$('startCalWizardBtn').onclick = () => {
  const name = $('calNameInput').value.trim();
  const ethanol = $('calEthanolInput').value.trim();

  if (!name || !ethanol) {
    toast('Please enter both Sample Reference Name and Known Ethanol %');
    return;
  }

  openCalModal(name, ethanol);
};

let localCalTimer = null;
let localCalReadings = [];
let localCalStart = 0;

function cancelLocalCapture(msg = 'Calibration cancelled') {
  if (localCalTimer) {
    clearInterval(localCalTimer);
    localCalTimer = null;
  }
  localCalReadings = [];
  $('calProgress').value = 0;
  $('calProgressPct').textContent = '0%';
  if (msg) $('calResult').textContent = msg;
  action('/api/calibration/cancel', {});
}

// Confirm Dipping & Start 10-Second Capture
$('confirmStartCalBtn').onclick = () => {
  if (!pendingCalPreset) return;
  const { name, ethanol } = pendingCalPreset;
  closeCalModal();

  cancelLocalCapture('');

  localCalReadings = [];
  localCalStart = Date.now();
  $('calResult').textContent = `Capturing conductivity of ${name} (10 seconds)... Keep probe still.`;
  notify(`Calibration capture started for ${name} (E${ethanol}%). Keep electrodes still.`, 'Calibration Active');

  if (demoMode) {
    // Generate simulated steady target value based on ethanol blend
    const targetA0 = Math.round(92 + (Number(ethanol) / 100) * 140);
    simState.targetRaw = targetA0;
    simState.raw = targetA0;
  } else if (token && status?.mode === 'manual') {
    action('/api/calibration', { name, ethanol });
  }

  // 10-second capture loop
  localCalTimer = setInterval(() => {
    const elapsed = Date.now() - localCalStart;
    const pct = Math.min(100, Math.round((elapsed / 10000) * 100));
    const secLeft = Math.max(0, Math.ceil((10000 - elapsed) / 1000));
    $('calProgress').value = pct;
    $('calProgressPct').textContent = `${pct}% (${secLeft}s remaining)`;

    if (status && status.raw !== undefined) {
      localCalReadings.push(status.raw);
    }

    if (elapsed >= 10000) {
      clearInterval(localCalTimer);
      localCalTimer = null;

      const n = localCalReadings.length;
      if (n < 20) {
        $('calResult').textContent = 'Rejected: insufficient sensor readings received.';
        notify('Calibration rejected: insufficient readings', 'Calibration Error', true);
        return;
      }

      const mean = localCalReadings.reduce((a, b) => a + b, 0) / n;
      const variance = localCalReadings.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / n;
      const sd = Math.sqrt(variance);

      if (mean < 50) {
        $('calResult').textContent = `Rejected: electrodes were absent from sample (Mean A0: ${mean.toFixed(1)} < 50). Dip probe and retry.`;
        notify('Calibration rejected: electrodes not submerged', 'Calibration Alert', true);
        return;
      }

      if (sd > 18) {
        $('calResult').textContent = `Rejected: unstable reading (SD: ${sd.toFixed(2)} > 18). Hold electrodes steady and retry.`;
        notify('Calibration rejected: reading unstable', 'Calibration Alert', true);
        return;
      }

      // Successful calibration!
      const newPoint = {
        name,
        ethanol: Number(ethanol),
        mean: Number(mean.toFixed(1)),
        sd: Number(sd.toFixed(2)),
        n
      };

      const existingIdx = points.findIndex(p => p.name.toLowerCase() === name.toLowerCase());
      if (existingIdx >= 0) {
        points[existingIdx] = newPoint;
      } else {
        points.push(newPoint);
      }

      savePointsLocally();
      calCount = points.length;
      renderCalibration();
      renderStatus();

      const successMsg = `Saved ${name} (E${ethanol}%) at Mean A0 ${mean.toFixed(1)} (±${sd.toFixed(2)})`;
      $('calResult').textContent = `✓ ${successMsg}`;
      notify(successMsg, 'Calibration Saved! ✓');
    }
  }, 100);
};

$('cancelCapture').onclick = () => cancelLocalCapture('Calibration capture cancelled.');

$('calRows').onclick = async e => {
  const b = e.target.closest('[data-delete]');
  if (!b || !confirm('Delete this calibration reference point?')) return;
  const idx = Number(b.dataset.delete);
  points.splice(idx, 1);
  savePointsLocally();
  calCount = points.length;
  renderCalibration();
  renderStatus();
  notify('Calibration reference removed', 'Calibration Update');
  if (token && !demoMode) {
    action('/api/calibration/delete', { index: idx });
  }
};

// Settings
$('settingsForm').onsubmit = e => {
  e.preventDefault();
  action('/api/settings', { flushMaxSeconds: $('flushSeconds').value });
  toast('Flush cutoff parameter saved');
};

// Report Studio & Statistics
function reportRows() {
  return history.filter(p =>
    $('reportScope').value === 'session' || (p.bootId === boot && p.sampleId === status?.sampleId)
  );
}

function stats(rows) {
  const valid = rows.filter(p => p.raw >= 50);
  const avg = k => (valid.length ? valid.reduce((s, p) => s + p[k], 0) / valid.length : null);
  const estimated = valid.filter(p => Number.isFinite(p.ethanol));
  return {
    valid,
    raw: avg('raw'),
    ldr: avg('ldr'),
    ethanol: estimated.length ? estimated.reduce((s, p) => s + p.ethanol, 0) / estimated.length : null,
    estimated: estimated.length
  };
}

function download(name, blob) {
  const u = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = u;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(u), 6000);
}

$('csvExport').onclick = () => {
  const rows = reportRows();
  if (!rows.length) return toast('No observations recorded in this scope.');
  const fields = ['time', 'bootId', 'sampleId', 'seq', 'raw', 'ldr', 'ethanol', 'state', 'mode', 'r1', 'r2'];
  download(
    `FuelGuard-${new Date().toISOString().slice(0, 10)}.csv`,
    new Blob(
      [
        fields.join(',') +
          '\n' +
          rows
            .map(p =>
              fields.map(k => JSON.stringify(k === 'time' ? new Date(p.time).toISOString() : p[k] ?? '')).join(',')
            )
            .join('\n')
      ],
      { type: 'text/csv' }
    )
  );
};

$('newRecording').onclick = () => {
  if (!confirm('Clear browser recording session and start a new one? Export CSV first if needed.')) return;
  history = [];
  logs = [];
  recordStart = Date.now();
  browserLog('New recording session initiated');
  drawCharts();
  toast('New session started');
};

// PROFESSIONAL PDF REPORT GENERATION
async function generatePdfReport() {
  const rows = reportRows();
  if (!rows.length) {
    toast('No observations available to generate report.');
    return;
  }
  if (!window.jspdf) {
    toast('PDF generation engine not loaded. Check network or files.');
    return;
  }

  toast('Crafting PDF report with charts & diagnostics...');

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const summary = stats(rows);
  const valid = summary.valid;
  const start = rows[0].time;
  const end = rows[rows.length - 1].time;

  const selectedLogs = logs.filter(
    e => e.time >= start - 2000 && e.time <= end + 2000 && ($('reportScope').value === 'session' || (e.bootId === boot && e.sampleId === status?.sampleId))
  );

  if (window.FG_REPORT_FONT) {
    doc.addFileToVFS('FuelGuardSans.ttf', window.FG_REPORT_FONT);
    doc.addFont('FuelGuardSans.ttf', 'FuelGuardSans', 'normal');
    doc.setFont('FuelGuardSans');
  }

  let y = 0;

  function renderHeader(sectionTitle) {
    doc.setFillColor(15, 23, 42); // Clean dark slate header
    doc.rect(0, 0, 210, 38, 'F');
    doc.setTextColor(37, 99, 235);
    doc.setFontSize(8.5);
    doc.text("IGNITIONX / FUELGUARD 2.0 • LIQUID INTELLIGENCE", 16, 13);
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(18);
    doc.text(sectionTitle, 16, 26);
    doc.setFontSize(8.5);
    doc.setTextColor(148, 163, 184);
    doc.text("DESIGNED BY RIZWAN SYED", 145, 13);
    doc.text(new Date().toLocaleDateString(), 145, 26);
    y = 48;
  }

  // PAGE 1: EXECUTIVE SUMMARY & DIAGNOSTICS
  renderHeader('Fuel Assessment & Safety Report');

  // Metadata block
  doc.setFontSize(9);
  doc.setTextColor(100, 116, 139);
  doc.text('REPORT TITLE:', 16, y);
  doc.setTextColor(15, 23, 42);
  doc.setFontSize(11);
  doc.text($('reportTitle').value || 'FuelGuard Fuel Assessment Report', 50, y);
  y += 7;

  doc.setFontSize(9);
  doc.setTextColor(100, 116, 139);
  doc.text('INSPECTOR / OPERATOR:', 16, y);
  doc.setTextColor(15, 23, 42);
  doc.setFontSize(11);
  doc.text($('reportOperator').value || 'Authorized Operator', 60, y);
  y += 7;

  doc.setFontSize(9);
  doc.setTextColor(100, 116, 139);
  doc.text('OBSERVATION WINDOW:', 16, y);
  doc.setTextColor(15, 23, 42);
  doc.setFontSize(10);
  doc.text(`${new Date(start).toLocaleTimeString()} – ${new Date(end).toLocaleTimeString()} (${Math.round((end - start) / 1000)}s duration)`, 60, y);
  y += 12;

  // Key Summary Metric Cards
  doc.setFillColor(241, 245, 249);
  doc.roundedRect(16, y, 178, 26, 3, 3, 'F');
  doc.setTextColor(37, 99, 235);
  doc.setFontSize(8);
  doc.text('MEAN CONDUCTIVITY (A0)', 22, y + 7);
  doc.text('OPTICAL HIGH FRACTION', 82, y + 7);
  doc.text('ESTIMATED ETHANOL %', 142, y + 7);

  doc.setTextColor(15, 23, 42);
  doc.setFontSize(15);
  doc.text(summary.raw !== null ? summary.raw.toFixed(1) + ' counts' : 'N/A', 22, y + 18);
  doc.text(summary.ldr !== null ? (summary.ldr * 100).toFixed(0) + ' %' : '0 %', 82, y + 18);
  doc.text(summary.ethanol !== null ? `E${summary.ethanol.toFixed(1)}%` : 'Uncalibrated', 142, y + 18);
  y += 34;

  const maxA0 = valid.length ? Math.max(...valid.map(p => p.raw)) : 0;
  const isSeparated = maxA0 >= THRESHOLD || valid.some(p => p.ldr === 1);
  const flushCompleted = selectedLogs.some(e => e.text.includes('Flush stopped') || e.text.includes('below ' + THRESHOLD) || e.text.includes('purged'));

  // 1. Vehicle Safety Assessment
  doc.setFillColor(isSeparated ? 254 : 240, isSeparated ? 242 : 253, isSeparated ? 242 : 244);
  doc.roundedRect(16, y, 178, 22, 2, 2, 'F');
  doc.setFontSize(9);
  doc.setTextColor(isSeparated ? 220 : 5, isSeparated ? 38 : 150, isSeparated ? 38 : 105);
  doc.text('1. VEHICLE SAFETY ASSESSMENT:', 20, y + 6);
  doc.setFontSize(10);
  if (isSeparated) {
    doc.text('CRITICAL ALERT: UNSAFE FOR STANDARD VEHICLE FUEL INJECTION', 20, y + 12);
    doc.setFontSize(8);
    doc.text(`Conductivity exceeded action limit (Peak A0: ${maxA0} vs threshold ${THRESHOLD}). Water-alcohol separation detected.`, 20, y + 17);
  } else {
    doc.text('PASS: READINGS WITHIN BENCH BASELINE TOLERANCES', 20, y + 12);
    doc.setFontSize(8);
    doc.text(`Peak conductivity A0 (${maxA0}) stayed below threshold. Note: experimental bench screening.`, 20, y + 17);
  }
  y += 28;

  // 2. Phase Separation Status
  doc.setFillColor(248, 250, 252);
  doc.roundedRect(16, y, 178, 20, 2, 2, 'F');
  doc.setFontSize(9);
  doc.setTextColor(71, 85, 105);
  doc.text('2. PHASE SEPARATION ANALYSIS:', 20, y + 6);
  doc.setFontSize(10);
  doc.text(
    isSeparated
      ? 'PHASE SEPARATION DETECTED (Conductivity spike / optical refraction shift observed)'
      : 'NO PHASE SEPARATION DETECTED (Single homogeneous layer observed)',
    20,
    y + 12
  );
  y += 26;

  // 3. Ethanol Flush Status
  doc.setFillColor(248, 250, 252);
  doc.roundedRect(16, y, 178, 20, 2, 2, 'F');
  doc.setFontSize(9);
  doc.setTextColor(71, 85, 105);
  doc.text('3. ETHANOL / WATER FLUSH VERIFICATION:', 20, y + 6);
  doc.setFontSize(10);
  doc.text(
    flushCompleted
      ? 'FLUSH CYCLE EXECUTED: Removal pump purged lower phase until A0 dropped.'
      : isSeparated
        ? 'FLUSH PENDING: Sample threshold breached; flush cycle required to purge water layer.'
        : 'NO FLUSH REQUIRED: Readings remained within normal operational bounds.',
    20,
    y + 12
  );
  y += 28;

  // Operator Observations
  doc.setFontSize(9);
  doc.setTextColor(100, 116, 139);
  doc.text('OPERATOR FIELD OBSERVATIONS:', 16, y);
  y += 6;
  doc.setFontSize(9.5);
  doc.setTextColor(15, 23, 42);
  const notes = $('reportNotes').value || 'No additional operator notes recorded.';
  const noteLines = doc.splitTextToSize(notes, 176);
  doc.text(noteLines, 16, y);
  y += noteLines.length * 5 + 10;

  // PAGE 2: CHARTS & EVIDENCE
  doc.addPage();
  renderHeader('Sensor Waveform Evidence');

  doc.setFontSize(10);
  doc.setTextColor(15, 23, 42);
  doc.text('Synchronized Dual-Axis Overlay (Conductivity & Optical LDR):', 16, y);
  y += 4;

  const cOverlay = document.createElement('canvas');
  cOverlay.setAttribute('height', '190');
  chart(cOverlay, rows, 'overlay');
  doc.addImage(cOverlay.toDataURL('image/png'), 'PNG', 16, y, 178, 54);
  y += 62;

  doc.text(`Conductivity Proxy Waveform (A0 Analog Counts with ${THRESHOLD} Limit):`, 16, y);
  y += 4;
  const cCond = document.createElement('canvas');
  cCond.setAttribute('height', '180');
  chart(cCond, rows, 'raw');
  doc.addImage(cCond.toDataURL('image/png'), 'PNG', 16, y, 178, 52);
  y += 60;

  doc.text('Optical Response Waveform (D7 Digital Refraction 0/1):', 16, y);
  y += 4;
  const cLdr = document.createElement('canvas');
  cLdr.setAttribute('height', '180');
  chart(cLdr, rows, 'ldr');
  doc.addImage(cLdr.toDataURL('image/png'), 'PNG', 16, y, 178, 52);
  y += 60;

  // PAGE 3: EVENT AUDIT TRAIL & CALIBRATION LIBRARY
  doc.addPage();
  renderHeader('Event Journal & Calibration References');

  doc.setFontSize(11);
  doc.setTextColor(15, 23, 42);
  doc.text('Laboratory Calibration Library (Active at Export):', 16, y);
  y += 6;

  if (!points.length) {
    doc.setFontSize(9);
    doc.setTextColor(100, 116, 139);
    doc.text('No reference calibration samples recorded in storage.', 16, y);
    y += 8;
  } else {
    for (const p of points) {
      doc.setFontSize(9);
      doc.setTextColor(15, 23, 42);
      doc.text(`• ${p.name}: Known E${p.ethanol.toFixed(1)}% — Mean A0: ${p.mean.toFixed(1)} (±${p.sd.toFixed(2)}, n=${p.n})`, 18, y);
      y += 5.5;
    }
  }
  y += 10;

  doc.setFontSize(11);
  doc.setTextColor(15, 23, 42);
  doc.text('Important Chronological Events & Timings:', 16, y);
  y += 6;

  if (!selectedLogs.length) {
    doc.setFontSize(9);
    doc.setTextColor(100, 116, 139);
    doc.text('No significant events captured during this recording window.', 16, y);
  } else {
    for (const e of selectedLogs.slice(-25)) {
      if (y > 265) {
        doc.addPage();
        renderHeader('Event Journal Continued');
      }
      doc.setFontSize(8.5);
      doc.setTextColor(e.level === 'warn' ? 220 : 15, e.level === 'warn' ? 38 : 23, 42);
      doc.text(`${new Date(e.time).toLocaleTimeString()} [${e.level.toUpperCase()}] S#${e.sampleId} (Uptime ${(e.ms / 1000).toFixed(1)}s): ${e.text}`, 16, y);
      y += 5.5;
    }
  }

  // Footer Branding Tag & Page Numbers
  const totalPages = doc.getNumberOfPages();
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p);
    doc.setDrawColor(226, 232, 240);
    doc.line(16, 280, 194, 280);
    doc.setFontSize(8);
    doc.setTextColor(100, 116, 139);
    doc.text("Made by 'IgnitionX' • Designed by 'Rizwan Syed'", 16, 286);
    doc.text(`Page ${p} of ${totalPages}`, 180, 286);
  }

  doc.save(`FuelGuard-Report-${new Date().toISOString().slice(0, 10)}.pdf`);
  browserLog('Professional PDF assessment report downloaded', 'info');
  notify('PDF report successfully exported', 'Report Ready');
}

$('reportForm').onsubmit = e => {
  e.preventDefault();
  generatePdfReport().catch(err => toast('PDF generation error: ' + err.message, true));
};

// PWA & Browser Notifications Initialization
$('notifications').onclick = async () => {
  if (!window.isSecureContext || !('Notification' in window)) {
    toast('Native system notifications require HTTPS or localhost. In-page audio/toasts are active.');
    return;
  }
  const result = await Notification.requestPermission();
  toast('Browser notification permission: ' + result);
  if (result === 'granted') {
    notify('Browser notifications enabled for all FuelGuard events.', 'FuelGuard Enabled');
  }
};

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  installPrompt = e;
  $('install').hidden = false;
  $('pwaStatus').textContent = 'PWA installation ready: Click "Install FuelGuard PWA" to install.';
});

$('install').onclick = async () => {
  if (installPrompt) {
    try {
      await installPrompt.prompt();
      const outcome = await installPrompt.userChoice;
      if (outcome && outcome.outcome === 'accepted') {
        toast('FuelGuard PWA installed successfully!');
        $('install').hidden = true;
      }
    } catch (e) {}
    installPrompt = null;
  } else {
    openDownloadModal();
  }
};

$('pwaStatus').textContent = window.isSecureContext
  ? 'Secure context verified. Offline PWA caching active.'
  : 'Direct ESP SoftAP Mode: Use browser "Add to Home Screen" menu.';

if (window.isSecureContext && 'serviceWorker' in navigator) {
  navigator.serviceWorker
    .register('/sw.js')
    .then(reg => {
      reg.addEventListener('updatefound', () => {
        const installingWorker = reg.installing;
        installingWorker.onstatechange = () => {
          if (installingWorker.state === 'installed' && navigator.serviceWorker.controller) {
            toast('New FuelGuard update ready. Refresh when convenient.');
          }
        };
      });
    })
    .catch(() => {});
}

// Periodic session backup to localStorage
setInterval(() => {
  try {
    localStorage.setItem('fg-recording-v3', JSON.stringify({ history: history.slice(-2000), logs: logs.slice(-500), recordStart }));
  } catch (e) {
    if (!storageFailed) {
      storageFailed = true;
      toast('Local browser storage filled; export data if needed.');
    }
  }
}, 4000);

// Kick off initial setup & start polling
updateDemoModeUI();
route();
renderLogs();
renderCalibration();
poll();
