/* ==========================================================================
   SNOOKIFY — AI & DIRECT VOICE COMMAND ENGINE
   --------------------------------------------------------------------------
   Drop-in module. Does NOT modify existing app code — it calls the app's
   real global functions (showTab, AB(), openAddFrameModal, confirmAddFrame,
   openCanteenModal, addCanteenSelection, confirmAddCanteen, startSession,
   toggleProtectedMode, saveState, renderTables, renderActiveTableList …)
   exactly the way a staff member tapping the UI would, so every voice
   action stays 100% compatible with existing state shape, validation and
   receipts/audit logging already built into those functions.

   Load order required in index.html (see INTEGRATION.md):
     <link rel="stylesheet" href="voice-engine.css">
     ...
     <script src="voice-engine.js"></script>   <!-- after the main app script -->

   Public surface (all namespaced under window.SnookifyVoice):
     SnookifyVoice.init()
     SnookifyVoice.parseVoiceCommand(transcript)   // exposed for unit testing
     SnookifyVoice.startAutomatedVoiceDemo()
     SnookifyVoice.config                          // tweak thresholds live
   ========================================================================== */
(function (global) {
  'use strict';

  /* ------------------------------------------------------------------------
     0. CONFIG
     ------------------------------------------------------------------------ */
  const CONFIG = {
    lang: 'en-PK',                 // recognition locale; Web Speech handles Roman Urdu as English-script phonetics fine
    ttsLang: 'en-US',              // most Android/desktop voices pronounce Roman Urdu names clearest under an EN voice
    ttsRate: 1.02,
    ttsPitch: 1.0,
    requireWakeWord: false,        // true = passive "Snookify, ..." always-listening mode; false = push-to-talk only
    wakeWord: 'snookify',
    pushToTalkKey: ' ',            // Spacebar
    noiseGateThreshold: 0.018,     // RMS 0..1 — raise this in loud/noisy clubs, lower it in quiet ones
    noiseGateSampleMs: 60,
    confirmBannerMs: 2000,         // pre-execution cancel window
    undoWindowMs: 5000,            // post-execution undo window
    sensitiveIntents: ['ACTION_START_FRAME', 'ACTION_ADD_CANTEEN', 'ACTION_NAVIGATION_SECURITY'],
  };

  /* ------------------------------------------------------------------------
     1. TEXT-TO-SPEECH
     ------------------------------------------------------------------------ */
  const TTS = {
    voice: null,
    _pickVoice() {
      if (this.voice || !('speechSynthesis' in window)) return;
      const voices = speechSynthesis.getVoices();
      this.voice =
        voices.find(v => /en-PK|ur-PK|Urdu/i.test(v.lang + v.name)) ||
        voices.find(v => v.lang === CONFIG.ttsLang) ||
        voices.find(v => /en-/i.test(v.lang)) ||
        voices[0] || null;
    },
    speak(text, { interrupt = true } = {}) {
      if (!('speechSynthesis' in window) || !text) return;
      this._pickVoice();
      if (interrupt) speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = (this.voice && this.voice.lang) || CONFIG.ttsLang;
      if (this.voice) u.voice = this.voice;
      u.rate = CONFIG.ttsRate;
      u.pitch = CONFIG.ttsPitch;
      speechSynthesis.speak(u);
      return new Promise(resolve => { u.onend = resolve; u.onerror = resolve; });
    },
    stop() { if ('speechSynthesis' in window) speechSynthesis.cancel(); }
  };
  if ('speechSynthesis' in window) {
    speechSynthesis.onvoiceschanged = () => { TTS.voice = null; TTS._pickVoice(); };
  }

  /* ------------------------------------------------------------------------
     2. VOICE ACTIVITY DETECTION / NOISE GATE
     ------------------------------------------------------------------------
     Runs a *second*, independent getUserMedia() stream purely for level
     metering (SpeechRecognition owns its own internal mic feed and does not
     expose raw audio). While a recognition session is active we sample RMS
     volume; if the peak never crosses noiseGateThreshold, the transcript is
     treated as ambient club noise (crowd, music, cue breaks) and discarded
     even if the recognizer produced a spurious result. */
  const VAD = {
    ctx: null, analyser: null, dataArr: null, stream: null, sampling: false, peak: 0,
    async start() {
      if (this.ctx) return true;
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        const src = this.ctx.createMediaStreamSource(this.stream);
        this.analyser = this.ctx.createAnalyser();
        this.analyser.fftSize = 512;
        this.dataArr = new Uint8Array(this.analyser.frequencyBinCount);
        src.connect(this.analyser);
        return true;
      } catch (e) {
        console.warn('[SnookifyVoice] VAD mic unavailable, noise gate disabled:', e.message);
        return false;
      }
    },
    beginSample() {
      this.peak = 0;
      if (!this.analyser) return;
      this.sampling = true;
      const loop = () => {
        if (!this.sampling) return;
        this.analyser.getByteTimeDomainData(this.dataArr);
        let sumSq = 0;
        for (let i = 0; i < this.dataArr.length; i++) {
          const v = (this.dataArr[i] - 128) / 128;
          sumSq += v * v;
        }
        const rms = Math.sqrt(sumSq / this.dataArr.length);
        if (rms > this.peak) this.peak = rms;
        requestAnimationFrame(loop);
      };
      loop();
    },
    endSample() { this.sampling = false; return this.peak; },
    passedGate() { return !this.analyser || this.peak >= CONFIG.noiseGateThreshold; }
  };

  /* ------------------------------------------------------------------------
     3. SPEECH RECOGNITION ENGINE
     ------------------------------------------------------------------------ */
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const Recognition = {
    rec: null,
    listening: false,
    pushToTalkActive: false,

    supported() { return !!SR; },

    init() {
      if (!SR) { console.warn('[SnookifyVoice] Web Speech API not supported in this browser.'); return; }
      this.rec = new SR();
      this.rec.lang = CONFIG.lang;
      this.rec.continuous = CONFIG.requireWakeWord;   // passive wake-word mode stays open; PTT mode is one-shot
      this.rec.interimResults = true;
      this.rec.maxAlternatives = 3;

      this.rec.onstart = () => { this.listening = true; VAD.beginSample(); UI.setMicState('listening'); };
      this.rec.onaudiostart = () => VAD.beginSample();

      this.rec.onresult = (evt) => {
        const result = evt.results[evt.results.length - 1];
        const transcript = result[0].transcript.trim();
        UI.setInterimTranscript(transcript);
        if (result.isFinal) this._handleFinal(transcript);
      };

      this.rec.onerror = (evt) => {
        if (evt.error === 'no-speech' || evt.error === 'aborted') return;
        console.warn('[SnookifyVoice] recognition error:', evt.error);
        UI.flashMicError();
      };

      this.rec.onend = () => {
        this.listening = false;
        VAD.endSample();
        UI.setMicState('idle');
        if (CONFIG.requireWakeWord && !this._manualStop) {
          // passive mode auto-restarts so "Snookify, ..." always works
          try { this.rec.start(); } catch (_) {}
        }
      };
    },

    _handleFinal(transcript) {
      const peak = VAD.endSample();
      if (!VAD.passedGate()) {
        console.debug('[SnookifyVoice] discarded — below noise gate (peak', peak.toFixed(3), ')');
        return;
      }
      let text = transcript;
      if (CONFIG.requireWakeWord) {
        const wake = new RegExp(CONFIG.wakeWord, 'i');
        if (!wake.test(text)) return;
        text = text.replace(wake, '').replace(/^[,\s]+/, '');
      }
      Engine.handleTranscript(text);
    },

    startPushToTalk() {
      if (!this.rec || this.listening) return;
      this._manualStop = false;
      VAD.start().then(() => { try { this.rec.start(); } catch (_) {} });
    },
    stopPushToTalk() {
      if (!this.rec) return;
      this._manualStop = true;
      try { this.rec.stop(); } catch (_) {}
    },
    startPassive() {
      if (!this.rec) return;
      this._manualStop = false;
      VAD.start().then(() => { try { this.rec.start(); } catch (_) {} });
    }
  };

  /* ------------------------------------------------------------------------
     4. NLP — LIGHTWEIGHT INTENT PARSER
     ------------------------------------------------------------------------
     parseVoiceCommand(transcript) -> { intent, entities, raw, confidence }
     Handles casual Roman Urdu / English code-switching. Deliberately
     regex + keyword based (no model download) so it runs instantly on any
     POS terminal, including offline. */
  const WORD_NUM = {
    ek: 1, aik: 1, one: 1, single: 1,
    do: 2, teen: 3, three: 3, char: 4, four: 4, chaar: 4,
    panch: 5, paanch: 5, five: 5, che: 6, chey: 6, six: 6,
    sath: 7, saat: 7, seven: 7, aath: 8, eight: 8, nau: 9, nine: 9, dus: 10, das: 10, ten: 10,
    two: 2, double: 2
  };

  function wordsToNumber(str) {
    if (!str) return null;
    const digit = str.match(/\d+/);
    if (digit) return parseInt(digit[0], 10);
    const w = str.toLowerCase().trim();
    return WORD_NUM.hasOwnProperty(w) ? WORD_NUM[w] : null;
  }

  // Words that should never be mistaken for a player's name.
  const STOPWORDS = new Set([
    'table', 'frame', 'frames', 'add', 'kar', 'kardo', 'karde', 'de', 'do', 'dikhao', 'dikha',
    'karo', 'par', 'pe', 'pr', 'per', 'ka', 'ke', 'ki', 'aur', 'ek', 'aik', 'today', 'summary',
    'cash', 'shift', 'mode', 'on', 'off', 'protected', 'security', 'snookify', 'bhai', 'yaar',
    'le', 'ko', 'se', 'for', 'the', 'a', 'an', 'of', 'to', 'best', 'single', 'double', 'series'
  ]);

  function extractTableNumber(text) {
    let m = text.match(/table\s*(?:number|no\.?|#)?\s*(\d+)/i);
    if (m) return parseInt(m[1], 10);
    m = text.match(/(\d+)\s*(?:number|no\.?)?\s*(?:wal[ae]|table)/i);
    if (m) return parseInt(m[1], 10);
    return null;
  }

  function extractPlayerName(text) {
    // Pattern A: "<Name> ka/ke/ki" — dominant Roman-Urdu possessive construction.
    let m = text.match(/\b([A-Za-z]+)\s+k[ae]i?\b/i);
    if (m && !STOPWORDS.has(m[1].toLowerCase())) return capitalize(m[1]);
    // Pattern B: "for <Name>" / "player <Name>" / "customer <Name>"
    m = text.match(/\b(?:for|player|customer|naam)\s+([A-Za-z]+)\b/i);
    if (m && !STOPWORDS.has(m[1].toLowerCase())) return capitalize(m[1]);
    // Pattern C: fallback — first capitalized token in the transcript that isn't a stopword.
    const tokens = text.split(/\s+/);
    for (const tok of tokens) {
      const clean = tok.replace(/[^A-Za-z]/g, '');
      if (clean.length > 1 && /^[A-Z]/.test(clean) && !STOPWORDS.has(clean.toLowerCase())) {
        return capitalize(clean);
      }
    }
    return null;
  }

  function extractFrameCount(text) {
    const m = text.match(/(\d+|ek|aik|do|teen|char|chaar|panch|paanch)\s*frames?/i);
    if (m) return wordsToNumber(m[1]) || 1;
    return 1;
  }

  function extractMultiplier(text) {
    if (/\bdouble\b/i.test(text)) return 'double';
    if (/\bsingle\b/i.test(text)) return 'single';
    return null;
  }

  function extractSeriesTarget(text) {
    const m = text.match(/best\s*of\s*(\d+)/i);
    return m ? parseInt(m[1], 10) : null;
  }

  function extractCanteenItem(text) {
    // "<qty> <item words...>" e.g. "2 samosay", "ek chai", "3 cold drinks"
    const m = text.match(/(\d+|ek|aik|do|teen|char|chaar|panch|paanch)\s+([a-z\s]+?)(?:\s+table|\s+add|$)/i);
    if (m) {
      return { qty: wordsToNumber(m[1]) || 1, itemQuery: m[2].trim() };
    }
    // fallback: any noun-ish phrase after "add"/"order"
    const m2 = text.match(/(?:add|order|de do)\s+([a-z\s]+?)(?:\s+table|$)/i);
    if (m2) return { qty: 1, itemQuery: m2[1].trim() };
    return null;
  }

  function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase(); }

  const NAV_TARGETS = {
    dashboard: 'dashboard', home: 'dashboard',
    'active table': 'activeTables', tables: 'activeTables',
    cafe: 'cafeStock', canteen: 'cafeStock', 'cue shop': 'cueShop',
    receipts: 'receipts', expenses: 'expenses', reports: 'reports',
    summary: 'masterSummary', 'z report': 'zReport', setup: 'setup',
    udhaar: 'udhaar', players: 'players', security: 'security'
  };

  function parseVoiceCommand(transcriptRaw) {
    const text = (transcriptRaw || '').trim();
    const lower = text.toLowerCase();
    if (!text) return { intent: 'NONE', entities: {}, raw: text, confidence: 0 };

    // --- ACTION_NAVIGATION_SECURITY -----------------------------------------
    if (/\bprotected\s*mode\b/.test(lower) || /\bsecurity\b/.test(lower)) {
      const turnOn = /\bon\b|\bkaro\b|\benable\b|\bactivate\b/.test(lower) && !/\boff\b|\bkaro\s*band\b|\bdisable\b/.test(lower);
      const turnOff = /\boff\b|\bband\b|\bdisable\b|\bdeactivate\b/.test(lower);
      return {
        intent: 'ACTION_NAVIGATION_SECURITY',
        entities: { action: 'PROTECTED_MODE', value: turnOff ? false : (turnOn ? true : null) },
        raw: text, confidence: 0.9
      };
    }
    if (/\bshift\b.*\b(close|end|band)\b|\bclose\s*shift\b/.test(lower)) {
      return { intent: 'ACTION_NAVIGATION_SECURITY', entities: { action: 'CLOSE_SHIFT' }, raw: text, confidence: 0.85 };
    }
    for (const key of Object.keys(NAV_TARGETS)) {
      if (lower.includes(key) && /\b(open|jao|jump|dikhao|show|switch|le chalo)\b/.test(lower)) {
        return { intent: 'ACTION_NAVIGATION_SECURITY', entities: { action: 'GOTO_TAB', tab: NAV_TARGETS[key] }, raw: text, confidence: 0.8 };
      }
    }

    // --- ACTION_GET_ANALYTICS -----------------------------------------------
    if (/\b(cash|collection|revenue|total|kamai|kamaya|analytics|summary|kitna|profit|shift total|z report)\b/.test(lower)
        && !/\bframe\b|\btable\b/.test(lower)) {
      let metric = 'ALL';
      if (/\bcash\b/.test(lower)) metric = 'CASH';
      else if (/\bonline\b/.test(lower)) metric = 'ONLINE';
      else if (/\bprofit\b/.test(lower)) metric = 'PROFIT';
      else if (/\bcafe\b/.test(lower)) metric = 'CAFE';
      else if (/\bexpense/.test(lower)) metric = 'EXPENSES';
      else if (/\budhaar\b/.test(lower)) metric = 'UDHAAR';
      return { intent: 'ACTION_GET_ANALYTICS', entities: { metric }, raw: text, confidence: 0.85 };
    }

    // --- ACTION_ADD_CANTEEN --------------------------------------------------
    if (/\b(cafe|canteen|chai|samosa|samosay|cold drink|coke|order|snack)\b/.test(lower) || /\badd\b.*\btable\b.*\b(item|order)\b/.test(lower)) {
      const tableNumber = extractTableNumber(lower);
      const item = extractCanteenItem(lower);
      return {
        intent: 'ACTION_ADD_CANTEEN',
        entities: { tableNumber, item: item ? item.itemQuery : null, quantity: item ? item.qty : 1 },
        raw: text, confidence: tableNumber && item ? 0.85 : 0.5
      };
    }

    // --- ACTION_START_FRAME (default for "table N ... frame ... add") -------
    if (/\bframe\b/.test(lower) && /\btable\b/.test(lower)) {
      return {
        intent: 'ACTION_START_FRAME',
        entities: {
          tableNumber: extractTableNumber(lower),
          playerName: extractPlayerName(text),
          frameCount: extractFrameCount(lower),
          multiplier: extractMultiplier(lower),
          seriesTarget: extractSeriesTarget(lower)
        },
        raw: text, confidence: 0.75
      };
    }

    return { intent: 'UNKNOWN', entities: {}, raw: text, confidence: 0.2 };
  }

  /* ------------------------------------------------------------------------
     5. ACTION HANDLERS — call the app's REAL functions
     ------------------------------------------------------------------------ */
  function findTableByNumber(num) {
    try { return AB().tables.find(t => t.id === num || t.name === `Table ${num}`); }
    catch (_) { return null; }
  }

  function snapshotState() {
    try { return JSON.stringify(global.state); } catch (_) { return null; }
  }
  function restoreState(snap) {
    if (!snap || !global.state) return false;
    try {
      const restored = JSON.parse(snap);
      Object.keys(global.state).forEach(k => delete global.state[k]);
      Object.assign(global.state, restored);
      if (typeof saveState === 'function') saveState();
      if (typeof renderTables === 'function') renderTables();
      if (typeof renderActiveTableList === 'function') renderActiveTableList();
      return true;
    } catch (e) { console.warn('[SnookifyVoice] undo failed:', e); return false; }
  }

  const Actions = {
    ACTION_START_FRAME(entities) {
      const { tableNumber, playerName, multiplier, seriesTarget } = entities;
      if (!tableNumber) return { ok: false, speak: 'Table number samajh nahi aaya, dobara boliye.' };
      const t = findTableByNumber(tableNumber);
      if (!t) return { ok: false, speak: `Table ${tableNumber} nahi mila.` };
      if (!playerName) return { ok: false, speak: `Player ka naam nahi mila, ${t.name} ke liye dobara boliye.` };

      return {
        ok: true,
        summary: `Table ${tableNumber} · ${playerName} · ${multiplier || 'single'}${seriesTarget ? ' · Best of ' + seriesTarget : ''}`,
        execute() {
          if (t.status !== 'live') {
            // Fresh session — frame-billed, opens Frame #1 immediately.
            startSession(t.id, 'frame', playerName, '', null);
          } else {
            // Table already live — close the open frame under this player via the real modal flow.
            openAddFrameModal(t.id);
            const nameInput = document.getElementById('frameCustNameInput');
            if (nameInput) nameInput.value = playerName;
            if (multiplier && typeof setAddFrameModalMultiplier === 'function') setAddFrameModalMultiplier(multiplier);
            confirmAddFrame();
          }
          if (seriesTarget && typeof applySeriesTagSelection === 'function') {
            try { applySeriesTagSelection(t.id, seriesTarget); } catch (_) {}
          }
          if (typeof renderTables === 'function') renderTables();
        },
        speakSuccess: `Done! Table ${tableNumber} par ${playerName} ka frame add kar diya gaya hai.`
      };
    },

    ACTION_ADD_CANTEEN(entities) {
      const { tableNumber, item, quantity } = entities;
      if (!tableNumber) return { ok: false, speak: 'Kaunsa table hai, batayen.' };
      const t = findTableByNumber(tableNumber);
      if (!t) return { ok: false, speak: `Table ${tableNumber} nahi mila.` };
      if (t.status !== 'live') return { ok: false, speak: `Table ${tableNumber} abhi active nahi hai.` };
      if (!item) return { ok: false, speak: 'Item ka naam samajh nahi aaya.' };

      const stockItem = AB().stock.find(s => s.name.toLowerCase().includes(item.toLowerCase()) || item.toLowerCase().includes(s.name.toLowerCase()));
      if (!stockItem) return { ok: false, speak: `${item} catalog mein nahi mila.` };

      return {
        ok: true,
        summary: `Table ${tableNumber} · ${quantity} × ${stockItem.name}`,
        execute() {
          openCanteenModal(t.id);
          addCanteenSelection(stockItem.id);
          // addCanteenSelection defaults qty to whatever the row input shows (usually 1) —
          // bump the just-added selection's qty to match the spoken quantity.
          try {
            const ctx = global.canteenModalContext;
            if (ctx && ctx.selections && ctx.selections.length) {
              const sel = ctx.selections[ctx.selections.length - 1];
              if (sel && quantity > 1) {
                sel.qty = Math.min(quantity, sel.qty + stockItem.stock);
                if (typeof renderCanteenSelectedList === 'function') renderCanteenSelectedList();
              }
            }
          } catch (_) {}
          confirmAddCanteen();
        },
        speakSuccess: `Theek hai! ${quantity} ${stockItem.name} table ${tableNumber} ke bill mein add ho gaya.`
      };
    },

    ACTION_GET_ANALYTICS(entities) {
      const map = {
        CASH: '#mCashCollections', ONLINE: '#mOnlineCollections', PROFIT: '#mNetProfit',
        CAFE: '#mCafeSales', EXPENSES: '#mExpenses', UDHAAR: '#mUdhaar'
      };
      const read = (sel) => { const el = document.querySelector(sel); return el ? el.textContent.trim() : null; };

      let speak, cardHtml;
      if (entities.metric === 'ALL' ) {
        const total = read('#mTotalRevenue'), cash = read('#mCashCollections'), online = read('#mOnlineCollections'), profit = read('#mNetProfit');
        speak = `Aaj ka total revenue ${total || 'unavailable'} hai. Cash ${cash || '—'}, online ${online || '—'}, aur net profit ${profit || '—'} hai.`;
        cardHtml = `<div><b>Total Revenue</b> ${total}</div><div><b>Cash</b> ${cash}</div><div><b>Online</b> ${online}</div><div><b>Net Profit</b> ${profit}</div>`;
      } else {
        const val = read(map[entities.metric]) || 'unavailable';
        speak = `Aaj ka ${entities.metric.toLowerCase()} figure ${val} hai.`;
        cardHtml = `<div><b>${entities.metric}</b> ${val}</div>`;
      }
      return {
        ok: true, summary: 'Analytics card', execute() { UI.showAnalyticsCard(cardHtml); }, speakSuccess: speak
      };
    },

    ACTION_NAVIGATION_SECURITY(entities) {
      if (entities.action === 'GOTO_TAB') {
        return {
          ok: true, summary: `Open ${entities.tab}`,
          execute() { const navEl = document.querySelector(`.nav-item[data-tab="${entities.tab}"]`); showTab(entities.tab, navEl); },
          speakSuccess: `${entities.tab} khol diya.`
        };
      }
      if (entities.action === 'PROTECTED_MODE') {
        if (entities.value === null) return { ok: false, speak: 'On karna hai ya off, saaf boliye.' };
        return {
          ok: true, summary: `Protected mode ${entities.value ? 'ON' : 'OFF'}`,
          execute() {
            const toggle = document.getElementById('protectedModeToggle');
            if (toggle) toggle.checked = entities.value;
            toggleProtectedMode(entities.value);
          },
          speakSuccess: `Protected mode ${entities.value ? 'on' : 'off'} kar diya gaya hai.`
        };
      }
      if (entities.action === 'CLOSE_SHIFT') {
        return {
          ok: true, summary: 'Close current shift',
          execute() { if (typeof shutdownShift === 'function') shutdownShift(); else if (typeof openShiftLoginScreen === 'function') showTab('setup'); },
          speakSuccess: 'Shift band karne ka process shuru kar diya hai.'
        };
      }
      return { ok: false, speak: 'Yeh command samajh nahi aaya.' };
    }
  };

  /* ------------------------------------------------------------------------
     6. ENGINE — glues parser + actions + confirmation banner + TTS
     ------------------------------------------------------------------------ */
  const Engine = {
    handleTranscript(transcript) {
      UI.setInterimTranscript('');
      const parsed = parseVoiceCommand(transcript);
      if (parsed.intent === 'NONE') return;
      if (parsed.intent === 'UNKNOWN' || parsed.confidence < 0.4) {
        TTS.speak('Samajh nahi aaya, dobara boliye.');
        UI.flashMicError();
        return;
      }
      const handler = Actions[parsed.intent];
      const result = handler ? handler(parsed.entities) : { ok: false, speak: 'Yeh command abhi supported nahi hai.' };

      if (!result.ok) {
        TTS.speak(result.speak || 'Kuch missing hai, dobara boliye.');
        UI.showError(result.speak);
        return;
      }

      if (CONFIG.sensitiveIntents.includes(parsed.intent)) {
        UI.showConfirmBanner(result.summary, {
          onConfirmOrTimeout: () => this._execute(result),
          onCancel: () => TTS.speak('Cancel kar diya.')
        });
      } else {
        this._execute(result);
      }
    },

    _execute(result) {
      const snap = snapshotState();
      try { result.execute(); } catch (e) { console.error('[SnookifyVoice] action failed:', e); TTS.speak('Command execute nahi ho saka.'); return; }
      TTS.speak(result.speakSuccess);
      UI.showUndoToast(result.summary, () => {
        if (restoreState(snap)) TTS.speak('Undo ho gaya.');
      });
    }
  };

  /* ------------------------------------------------------------------------
     7. UI — floating mic, pulse ring, confirmation banner, analytics card
     ------------------------------------------------------------------------ */
  const UI = {
    els: {},

    build() {
      const mic = document.createElement('button');
      mic.id = 'snookifyVoiceMic';
      mic.className = 'sv-mic';
      mic.setAttribute('aria-label', 'Hold to speak a voice command');
      mic.innerHTML = `
        <span class="sv-mic-ring"></span>
        <span class="sv-mic-ring sv-mic-ring-2"></span>
        <svg class="sv-mic-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3Z"/>
          <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
          <line x1="12" y1="19" x2="12" y2="23"/>
          <line x1="8" y1="23" x2="16" y2="23"/>
        </svg>`;
      document.body.appendChild(mic);
      this.els.mic = mic;

      const interim = document.createElement('div');
      interim.id = 'snookifyVoiceInterim';
      interim.className = 'sv-interim';
      document.body.appendChild(interim);
      this.els.interim = interim;

      const banner = document.createElement('div');
      banner.id = 'snookifyVoiceBanner';
      banner.className = 'sv-banner';
      document.body.appendChild(banner);
      this.els.banner = banner;

      const card = document.createElement('div');
      card.id = 'snookifyVoiceCard';
      card.className = 'sv-analytics-card';
      document.body.appendChild(card);
      this.els.card = card;

      // Push-to-talk: press & hold mic, or hold Spacebar (ignored while typing in a field).
      const start = (e) => { e.preventDefault(); Recognition.startPushToTalk(); mic.classList.add('sv-active'); };
      const stop = () => { Recognition.stopPushToTalk(); mic.classList.remove('sv-active'); };
      mic.addEventListener('mousedown', start);
      mic.addEventListener('touchstart', start, { passive: false });
      ['mouseup', 'mouseleave', 'touchend'].forEach(ev => mic.addEventListener(ev, stop));

      document.addEventListener('keydown', (e) => {
        if (e.key !== CONFIG.pushToTalkKey) return;
        const tag = (document.activeElement && document.activeElement.tagName) || '';
        if (/INPUT|TEXTAREA|SELECT/.test(tag)) return;
        if (Recognition.pushToTalkActive) return;
        Recognition.pushToTalkActive = true;
        e.preventDefault();
        Recognition.startPushToTalk();
        mic.classList.add('sv-active');
      });
      document.addEventListener('keyup', (e) => {
        if (e.key !== CONFIG.pushToTalkKey) return;
        Recognition.pushToTalkActive = false;
        Recognition.stopPushToTalk();
        mic.classList.remove('sv-active');
      });
    },

    setMicState(state) {
      if (!this.els.mic) return;
      this.els.mic.classList.toggle('sv-listening', state === 'listening');
    },
    flashMicError() {
      if (!this.els.mic) return;
      this.els.mic.classList.add('sv-error');
      setTimeout(() => this.els.mic.classList.remove('sv-error'), 500);
    },
    setInterimTranscript(text) {
      if (!this.els.interim) return;
      this.els.interim.textContent = text;
      this.els.interim.classList.toggle('sv-show', !!text);
    },
    showError(msg) {
      this.showConfirmBanner(msg || 'Command samajh nahi aayi', { errorOnly: true });
    },

    showConfirmBanner(summary, { onConfirmOrTimeout, onCancel, errorOnly } = {}) {
      const el = this.els.banner;
      let remaining = CONFIG.confirmBannerMs / 1000;
      el.innerHTML = `
        <span class="sv-banner-text">${errorOnly ? '⚠️ ' : '🎙️ '}${summary}${errorOnly ? '' : ` — executing in <b id="svCountdown">${remaining}</b>s`}</span>
        ${errorOnly ? '' : `<button class="sv-banner-cancel" id="svCancelBtn">Cancel</button>`}
      `;
      el.classList.add('sv-show');
      if (errorOnly) { setTimeout(() => el.classList.remove('sv-show'), 2200); return; }

      let cancelled = false;
      const countdownEl = document.getElementById('svCountdown');
      const timer = setInterval(() => {
        remaining -= 1;
        if (countdownEl) countdownEl.textContent = Math.max(remaining, 0);
        if (remaining <= 0) {
          clearInterval(timer);
          el.classList.remove('sv-show');
          if (!cancelled && onConfirmOrTimeout) onConfirmOrTimeout();
        }
      }, 1000);

      document.getElementById('svCancelBtn').addEventListener('click', () => {
        cancelled = true;
        clearInterval(timer);
        el.classList.remove('sv-show');
        if (onCancel) onCancel();
      });
    },

    showUndoToast(summary, onUndo) {
      const el = this.els.banner;
      el.innerHTML = `<span class="sv-banner-text">✅ ${summary}</span><button class="sv-banner-cancel sv-undo" id="svUndoBtn">Undo</button>`;
      el.classList.add('sv-show', 'sv-success');
      const done = () => { el.classList.remove('sv-show', 'sv-success'); };
      const t = setTimeout(done, CONFIG.undoWindowMs);
      document.getElementById('svUndoBtn').addEventListener('click', () => {
        clearTimeout(t); done(); onUndo();
      });
    },

    showAnalyticsCard(html) {
      const el = this.els.card;
      el.innerHTML = `<div class="sv-card-close" id="svCardClose">✕</div>${html}`;
      el.classList.add('sv-show');
      document.getElementById('svCardClose').addEventListener('click', () => el.classList.remove('sv-show'));
      setTimeout(() => el.classList.remove('sv-show'), 8000);
    },

    highlight(selector) {
      const el = typeof selector === 'string' ? document.querySelector(selector) : selector;
      if (!el) return null;
      el.classList.add('sv-demo-highlight');
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return () => el.classList.remove('sv-demo-highlight');
    }
  };

  /* ------------------------------------------------------------------------
     8. AUTOMATED INTERACTIVE SELF-DEMO MODE (sandboxed — no real state writes)
     ------------------------------------------------------------------------ */
  const Demo = {
    running: false,
    steps: [
      {
        narration: 'Welcome to Snookify. Let me show you how voice commands work — this is a safe demo, no real data will change.',
        target: '#snookifyVoiceMic', ms: 3500
      },
      {
        narration: 'To start a frame, hold the mic or the spacebar and say something like: Table 5, Ali ka frame add kar do.',
        target: '.nav-item[data-tab="activeTables"]', ms: 4200
      },
      {
        narration: 'You can also say Single or Double, or Best of 3, to tag how the frame is billed.',
        target: '#activeTables', ms: 3800
      },
      {
        narration: 'For the cafe, just say: Table 3 par 2 samosay add kar do — it finds the item and adds it to that table bill.',
        target: '.nav-item[data-tab="cafeStock"]', ms: 4200
      },
      {
        narration: 'Ask for numbers anytime — Today\'s cash summary dikhao — and I will read out the live figures.',
        target: '.nav-item[data-tab="dashboard"]', ms: 4000
      },
      {
        narration: 'And for security, just say Protected mode on karo, and I will lock things down instantly.',
        target: '.nav-item[data-tab="security"]', ms: 3800
      },
      {
        narration: 'That is the full tour. Hold the mic button any time to try it yourself.',
        target: '#snookifyVoiceMic', ms: 3200
      }
    ],

    async run() {
      if (this.running) return;
      this.running = true;
      document.body.classList.add('sv-demo-active');
      UI.showConfirmBanner('Self-Demo Mode — sandboxed, no real data affected', { errorOnly: true });
      for (const step of this.steps) {
        if (!this.running) break;
        const clear = UI.highlight(step.target);
        TTS.speak(step.narration);
        await new Promise(r => setTimeout(r, step.ms));
        if (clear) clear();
      }
      document.body.classList.remove('sv-demo-active');
      this.running = false;
    },
    stop() { this.running = false; document.body.classList.remove('sv-demo-active'); }
  };

  /* ------------------------------------------------------------------------
     9. WAKE-WORD DEMO TRIGGER + BOOTSTRAP
     ------------------------------------------------------------------------ */
  function checkDemoTrigger(transcript) {
    return /snookify[, ]+self\s*demo\s*dikhao/i.test(transcript);
  }
  const _origHandle = Engine.handleTranscript.bind(Engine);
  Engine.handleTranscript = function (transcript) {
    if (checkDemoTrigger(transcript)) { Demo.run(); return; }
    _origHandle(transcript);
  };

  function init() {
    UI.build();
    if (Recognition.supported()) Recognition.init();
    else UI.showConfirmBanner('Voice not supported in this browser — try Chrome/Edge', { errorOnly: true });
    if (CONFIG.requireWakeWord) Recognition.startPassive();
  }

  global.SnookifyVoice = {
    init,
    parseVoiceCommand,
    startAutomatedVoiceDemo: () => Demo.run(),
    stopAutomatedVoiceDemo: () => Demo.stop(),
    config: CONFIG
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

})(window);
