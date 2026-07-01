import { SceneManager } from './render/SceneManager.js';
import { HandTracker } from './input/HandTracker.js';
import { LandmarkOverlay } from './input/LandmarkOverlay.js';
import { Wand } from './wand/Wand.js';
import { VoiceController } from './voice/VoiceController.js';
import { SpellManager } from './spells/SpellManager.js';
import { TRACKING } from './config.js';

// ---- DOM ----
const video = document.getElementById('input-video');
const canvas = document.getElementById('three-canvas');
const overlayCanvas = document.getElementById('overlay-canvas');
const startScreen = document.getElementById('start-screen');
const startBtn = document.getElementById('start-btn');
const summonBtn = document.getElementById('summon-btn');
const errorBanner = document.getElementById('error-banner');

const camBadge = document.getElementById('cam-status');
const micBadge = document.getElementById('mic-status');
const handBadge = document.getElementById('hand-status');
const fpsBadge = document.getElementById('fps');
const heardWord = document.getElementById('heard-word');
const chips = Object.fromEntries(
  [...document.querySelectorAll('.spell-chip')].map((el) => [el.dataset.type, el])
);

// Contextual prompt ("say wand", "pinch to grab", …).
const prompt = document.createElement('div');
prompt.id = 'prompt';
Object.assign(prompt.style, {
  position: 'fixed',
  bottom: '88px',
  left: '0',
  right: '0',
  textAlign: 'center',
  fontSize: '20px',
  fontWeight: '600',
  color: '#cfe0ff',
  textShadow: '0 0 16px rgba(127,214,255,0.5)',
  pointerEvents: 'none',
  zIndex: '5',
  transition: 'opacity 0.3s',
});
document.body.appendChild(prompt);

// --- Voice diagnostics panel (toggle with V) ---------------------------------
// Shows the live state of the Web Speech pipeline so it's obvious where voice
// breaks: whether it's supported, listening, erroring, and what it hears.
const voiceLog = document.createElement('div');
voiceLog.id = 'voice-log';
Object.assign(voiceLog.style, {
  position: 'fixed',
  top: '60px',
  right: '12px',
  width: '320px',
  maxHeight: '40vh',
  overflowY: 'auto',
  padding: '10px 12px',
  background: 'rgba(5,8,16,0.82)',
  border: '1px solid rgba(127,214,255,0.35)',
  borderRadius: '10px',
  font: '12px/1.5 ui-monospace, "Cascadia Code", Consolas, monospace',
  color: '#cfe0ff',
  whiteSpace: 'pre-wrap',
  zIndex: '10',
  pointerEvents: 'none',
  display: 'block', // shown by default while debugging; hide with V
});
document.body.appendChild(voiceLog);

let voiceLogVisible = true;
function toggleVoiceLog() {
  voiceLogVisible = !voiceLogVisible;
  voiceLog.style.display = voiceLogVisible ? 'block' : 'none';
}

function logVoice(line, color = '#cfe0ff') {
  const ts = new Date().toLocaleTimeString();
  console.log(`[voice] ${line}`);
  const row = document.createElement('div');
  row.style.color = color;
  row.textContent = `${ts}  ${line}`;
  voiceLog.prepend(row);
  while (voiceLog.childElementCount > 40) voiceLog.lastChild.remove();
}

let sceneManager, handTracker, wand, spellManager, voice, overlay;
let lastTime = performance.now();
let fpsAccum = 0, fpsFrames = 0;

function showError(msg) {
  errorBanner.textContent = msg;
  errorBanner.classList.remove('hidden');
}

function setBadge(el, on, label) {
  el.classList.toggle('on', on);
  el.classList.toggle('off', !on);
  if (label) el.textContent = label;
}

function flashChip(type) {
  const el = chips[type] || chips[type === 'lightoff' ? 'light' : type];
  if (!el) return;
  el.classList.add('active');
  setTimeout(() => el.classList.remove('active'), 600);
}

// --- startup (must be behind a user gesture for mic/cam) ---
startBtn.addEventListener('click', start, { once: true });

async function start() {
  startScreen.classList.add('hidden');

  // 1) Webcam
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: TRACKING.inputWidth },
        height: { ideal: TRACKING.inputHeight },
        facingMode: 'user',
      },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    await new Promise((res) => {
      if (video.readyState >= 2) res();
      else video.onloadeddata = () => res();
    });
    setBadge(camBadge, true, 'cam');
  } catch (e) {
    setBadge(camBadge, false, 'cam');
    showError('Camera access is required. Allow it and reload the page.');
    return;
  }

  // 2) Scene + wand + spells
  sceneManager = new SceneManager(canvas, video);
  wand = new Wand(sceneManager);
  spellManager = new SpellManager(sceneManager);
  overlay = new LandmarkOverlay(overlayCanvas);

  // 3) Hand tracking (model download can take a moment)
  handTracker = new HandTracker(video);
  try {
    prompt.textContent = 'Loading hand tracking…';
    await handTracker.init();
  } catch (e) {
    showError('Failed to load the hand-tracking model (check your connection).');
  }

  // 4) Voice
  voice = new VoiceController();
  logVoice(`SpeechRecognition supported: ${voice.supported}`, voice.supported ? '#66ffa6' : '#ff6b6b');
  if (!voice.supported) {
    logVoice('Use Chrome or Edge, or fall back to the keyboard (W/1-4).', '#ffd27f');
  }
  voice.onStatus = (active, msg) => {
    setBadge(micBadge, active, 'mic');
    if (msg) showError(msg);
  };
  voice.onEvent = (type, detail) => {
    if (type === 'start') logVoice('listening… (mic live)', '#66ffa6');
    else if (type === 'end') logVoice('recognition ended (auto-restarting)', '#8a93a8');
    else if (type === 'error') logVoice(`ERROR: ${detail}`, '#ff6b6b');
    else if (type === 'transcript') {
      const tag = detail.isFinal ? 'final' : 'interim';
      logVoice(`heard (${tag}): "${detail.text}"`, detail.isFinal ? '#cfe0ff' : '#8a93a8');
    }
  };
  voice.onHeard = (word, known) => {
    heardWord.textContent = word;
    heardWord.classList.toggle('unknown', !known);
    if (known) logVoice(`✓ matched command: ${word}`, '#66ffa6');
  };
  voice.onWand = () => {
    if (wand) wand.spawn();
  };
  voice.onSpell = (spell) => {
    if (!wand || !wand.spawned) return; // need a wand first
    spellManager.cast(spell, wand);
    flashChip(spell.type);
  };
  voice.start();

  // Manual summon button — fallback when voice doesn't catch "wand".
  summonBtn.addEventListener('click', () => wand.spawn());

  // Keyboard fallbacks (handy if mic is unavailable; also for debugging).
  window.addEventListener('keydown', onKey);

  requestAnimationFrame(loop);
}

const SPELL_KEYS = { Digit1: 'fire', Digit2: 'force', Digit3: 'light', Digit4: 'slash' };

function onKey(e) {
  if (e.code === 'KeyD') {
    overlay.toggle();
  } else if (e.code === 'KeyV') {
    toggleVoiceLog();
  } else if (e.code === 'KeyW') {
    wand.spawn();
  } else if (SPELL_KEYS[e.code] && wand?.spawned) {
    const type = SPELL_KEYS[e.code];
    spellManager.cast({ type }, wand);
    flashChip(type);
  }
}

function updatePrompt(hand) {
  let msg = '';
  if (!hand) msg = 'Show your hand to the camera ✋';
  else if (!wand.spawned) msg = 'Say “wand” to summon your wand';
  else if (!wand.held) msg = 'Pinch thumb + index to grab the wand';
  else msg = 'Point, then say a spell';
  prompt.textContent = msg;
}

function loop(now) {
  const dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;

  handTracker.update(now);
  const hand = handTracker.getHand();
  setBadge(handBadge, !!hand, 'hand');

  wand.update(hand, dt);
  spellManager.update(dt, wand);
  overlay.draw(hand);
  updatePrompt(hand);

  sceneManager.render();

  // FPS readout (twice a second).
  fpsAccum += dt;
  fpsFrames++;
  if (fpsAccum >= 0.5) {
    fpsBadge.textContent = `${Math.round(fpsFrames / fpsAccum)} fps`;
    fpsAccum = 0;
    fpsFrames = 0;
  }

  requestAnimationFrame(loop);
}
