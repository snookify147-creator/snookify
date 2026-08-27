# Snookify — AI Voice Command Engine: Integration Guide

## 1. Files
- `voice-engine.js` — recognition, TTS, NLP parser, action handlers, UI, self-demo.
- `voice-engine.css` — floating mic, pulse ring, confirm/undo banner, analytics card, demo highlight.

Neither file modifies `index.html`'s existing code. They read the app's existing globals at
runtime (`state`, `AB()`, `showTab`, `openAddFrameModal`, `confirmAddFrame`, `startSession`,
`openCanteenModal`, `addCanteenSelection`, `confirmAddCanteen`, `toggleProtectedMode`,
`saveState`, `renderTables`, `renderActiveTableList`), so every voice action goes through the
exact same validation, receipts, and audit logging as a manual tap.

## 2. Add two tags to `index.html`

In `<head>`, alongside the other stylesheets:
```html
<link rel="stylesheet" href="voice-engine.css">
```

Just before `</body>`, **after** the main application `<script>` block (the engine needs
`AB()`, `state`, `showTab`, etc. to already exist on `window`):
```html
<script src="voice-engine.js"></script>
```

That's it — the mic button, banners, and analytics card are injected by the script itself;
no HTML markup needs to be hand-added.

## 3. Optional: a manual "Self Demo" button
Anywhere in the UI (e.g. Setup screen):
```html
<button class="btn" onclick="SnookifyVoice.startAutomatedVoiceDemo()">🎬 Self Demo</button>
```
The same tour also triggers by voice: *"Snookify, self demo dikhao"*.

## 4. Supported voice commands (examples)
| Say | Intent |
|---|---|
| "Table 5, Ali ka frame add kar do" | `ACTION_START_FRAME` |
| "Table 3 pe Asad ke 2 frame add kar do" | `ACTION_START_FRAME` (loops per frame) |
| "Table 3 par 2 samosay add kar do" | `ACTION_ADD_CANTEEN` |
| "Today's cash summary dikhao" | `ACTION_GET_ANALYTICS` |
| "Protected mode on karo" | `ACTION_NAVIGATION_SECURITY` |
| "Dashboard dikhao" | `ACTION_NAVIGATION_SECURITY` (tab nav) |
| "Snookify, self demo dikhao" | Self-Demo Mode |

## 5. Tuning
Everything is live-editable via `SnookifyVoice.config` in the console or your own boot script:
```js
SnookifyVoice.config.noiseGateThreshold = 0.03; // louder club → raise this
SnookifyVoice.config.requireWakeWord = true;    // switch from push-to-talk to always-listening
SnookifyVoice.config.confirmBannerMs = 3000;    // longer cancel window before sensitive actions run
```

## 6. Known browser constraints (not a bug — Web Speech API itself)
- `SpeechRecognition` is Chrome/Edge/Safari (webkit-prefixed) only; Firefox has no support. The
  engine detects this and shows a one-time banner instead of failing silently.
- HTTPS (or `localhost`) is required for microphone access.
- The noise-gate opens a **second**, independent `getUserMedia()` stream purely for volume
  metering — `SpeechRecognition` doesn't expose raw audio, so this is the only reliable way to
  reject ambient club noise without an extra ML model.

## 7. Extending intents
Add a new branch in `parseVoiceCommand()` (returns `{ intent, entities }`) and a matching
`Actions.<INTENT_NAME>(entities)` handler that returns
`{ ok, summary, execute(), speakSuccess }`. The confirmation-banner / undo-toast / TTS plumbing
is fully generic and works for any new intent automatically — no changes needed elsewhere.
