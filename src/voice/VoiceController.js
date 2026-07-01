import { matchCommand } from '../spells/spellConfig.js';

// Web Speech API wrapper: continuous listening, auto-restart on end, keyword
// matching. Unknown words are ignored (no crash). Fires callbacks:
//   onWand()            — "wand" heard
//   onSpell(spell)      — a spell keyword heard (spell = config entry)
//   onHeard(word, known)— for HUD feedback
export class VoiceController {
  constructor() {
    this.onWand = () => {};
    this.onSpell = () => {};
    this.onHeard = () => {};
    this.onStatus = () => {};
    this.onEvent = () => {}; // (type, detail) — diagnostics hook

    this.supported =
      'SpeechRecognition' in window || 'webkitSpeechRecognition' in window;
    this.recognition = null;
    this.running = false;
    this.wantRunning = false;
    this._lastFire = 0;
  }

  _emit(type, detail) {
    this.onEvent(type, detail);
  }

  start() {
    this._emit('supported', this.supported);
    if (!this.supported) {
      this.onStatus(false, 'Speech recognition not supported in this browser.');
      return;
    }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = true; // react fast to partial results
    rec.lang = 'en-US';
    rec.maxAlternatives = 1;

    rec.onresult = (e) => this._handleResult(e);
    rec.onerror = (e) => {
      this._emit('error', e.error);
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        this.wantRunning = false;
        this.onStatus(false, 'Microphone permission denied — voice is off.');
      } else if (e.error === 'network') {
        // Chrome's Web Speech API needs to reach Google's servers.
        this.onStatus(false, 'Voice service unreachable (network). Will keep retrying.');
      }
      // 'no-speech' / 'aborted' → transient; let onend restart quietly.
    };
    rec.onend = () => {
      this.running = false;
      this._emit('end');
      this.onStatus(false);
      if (this.wantRunning) {
        // Restart; small delay avoids tight error loops.
        setTimeout(() => this._safeStart(), 300);
      }
    };
    rec.onstart = () => {
      this.running = true;
      this._emit('start');
      this.onStatus(true);
    };

    this.recognition = rec;
    this.wantRunning = true;
    this._safeStart();
  }

  _safeStart() {
    if (!this.recognition || this.running) return;
    try {
      this.recognition.start();
    } catch (_) {
      // Already starting; ignore.
    }
  }

  _handleResult(e) {
    let transcript = '';
    let isFinal = false;
    for (let i = e.resultIndex; i < e.results.length; i++) {
      transcript += e.results[i][0].transcript + ' ';
      if (e.results[i].isFinal) isFinal = true;
    }
    transcript = transcript.trim();
    if (!transcript) return;

    this._emit('transcript', { text: transcript, isFinal });

    const cmd = matchCommand(transcript);
    if (!cmd) {
      // Show the last word so the user gets feedback even on a miss.
      const last = transcript.split(/\s+/).pop();
      this.onHeard(last, false);
      return;
    }

    // Debounce: interim + final results can fire the same word repeatedly.
    const now = performance.now();
    if (now - this._lastFire < 600) return;
    this._lastFire = now;

    if (cmd.kind === 'wand') {
      this.onHeard('wand', true);
      this.onWand();
    } else {
      this.onHeard(cmd.spell.label, true);
      this.onSpell(cmd.spell);
    }
  }

  stop() {
    this.wantRunning = false;
    if (this.recognition) this.recognition.stop();
  }
}
