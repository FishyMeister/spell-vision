import { SceneManager } from './render/SceneManager.js';
import { HandTracker } from './input/HandTracker.js';
import { HandSegmenter } from './input/HandSegmenter.js';
import { LandmarkOverlay } from './input/LandmarkOverlay.js';
import { Wand } from './wand/Wand.js';
import { VoiceController } from './voice/VoiceController.js';
import { SpellManager } from './spells/SpellManager.js';
import { TRACKING } from './config.js';

// ---- Input mode ----
// ?src=Test.mp4 swaps the webcam for a clip that stands in for the live
// stream: same loop, same tracking, real-time speed. The composited canvas is
// recorded and auto-downloaded as .webm when the clip ends. Unmirrored by
// default so the output compares frame-for-frame against the source clip
// (and the VACE renders); add &mirror=1 for the selfie view.
const params = new URLSearchParams(location.search);
const fileSrc = params.get('src');
const mirror = fileSrc ? params.get('mirror') === '1' : true;

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

let sceneManager, handTracker, segmenter, wand, spellManager, voice, overlay;
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

  // 1) Input: webcam, or the clip standing in for it.
  if (fileSrc) {
    try {
      // The element has `autoplay` for the webcam; kill it here or the clip
      // plays (and burns its opening seconds) while the tracking model loads.
      video.autoplay = false;
      video.src = fileSrc;
      video.muted = true;
      await new Promise((res, rej) => {
        video.onloadeddata = () => res();
        video.onerror = () => rej(new Error(`can't load ${fileSrc}`));
      });
      setBadge(camBadge, true, 'clip');
    } catch (e) {
      setBadge(camBadge, false, 'clip');
      showError(`Could not load clip "${fileSrc}" — is it in the project root?`);
      return;
    }
  } else {
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
  }

  // 2) Scene + wand + spells. Clip mode renders at the clip's native size so
  // the recording matches the source frame-for-frame.
  sceneManager = new SceneManager(canvas, video, fileSrc
    ? { mirror, width: video.videoWidth, height: video.videoHeight }
    : {});
  wand = new Wand(sceneManager);
  spellManager = new SpellManager(sceneManager);
  overlay = new LandmarkOverlay(overlayCanvas);

  // 3) Hand tracking (model download can take a moment)
  handTracker = new HandTracker(video, { mirror });
  try {
    prompt.textContent = 'Loading hand tracking…';
    await handTracker.init();
    // Warm-up: the FIRST inference compiles the GPU delegate's shaders and
    // blocks the main thread for seconds. Eat that cost now, while nothing is
    // moving — not on the first live frame (which would freeze the canvas
    // while the clip plays on, hole-punching the start of the recording).
    handTracker.detectFrame(performance.now(), 0.05);
  } catch (e) {
    showError('Failed to load the hand-tracking model (check your connection).');
  }

  // Skin segmentation refines wand occlusion to the hand's true silhouette.
  // Loads in the background; until it's ready (or if it fails) the occluder
  // just runs unmasked, exactly as before.
  segmenter = new HandSegmenter(video);
  segmenter.init().then(() => {
    wand.setSegmenter(segmenter);
  }).catch(() => {
    console.warn('[segment] model failed to load; occluder runs unmasked');
  });

  if (fileSrc) {
    // Hands-off run: summon the wand (grab latches from the clip's own hand
    // pose), roll the clip from the top, record the canvas until it ends.
    // The clip has been held paused at frame 0 until now (autoplay disabled).
    wand.spawn();
    await video.play();
    startRecorder();
    video.addEventListener('ended', () => {
      stopRecorder();
      video.loop = true; // keep the app alive for interactive replay
      video.play();
    }, { once: true });
  }

  // 4) Voice (skipped in clip mode — no mic needed, keyboard still works)
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
  if (!fileSrc) voice.start();
  else logVoice('clip mode: voice disabled, keyboard only (W/1-4)', '#ffd27f');

  // Manual summon button — fallback when voice doesn't catch "wand".
  summonBtn.addEventListener('click', () => wand.spawn());

  // Keyboard fallbacks (handy if mic is unavailable; also for debugging).
  window.addEventListener('keydown', onKey);

  // Debug handle for console poking and headless verification.
  window.sv = { wand, handTracker, segmenter, sceneManager, spellManager };

  requestAnimationFrame(loop);
}

// ---- Canvas recorder (clip mode) ----------------------------------------
// Captures the composited WebGL canvas — exactly what's on screen, realism
// stack included — and downloads it as .webm when the clip finishes.
let recorder = null;
let recChunks = [];

function startRecorder() {
  const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
    .find((m) => MediaRecorder.isTypeSupported(m));
  recorder = new MediaRecorder(canvas.captureStream(30), {
    mimeType: mime,
    videoBitsPerSecond: 12_000_000,
  });
  recChunks = [];
  recorder.ondataavailable = (e) => { if (e.data.size) recChunks.push(e.data); };
  recorder.onstop = () => {
    const blob = new Blob(recChunks, { type: 'video/webm' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'live_composite.webm';
    a.click();
    toast('composite saved: live_composite.webm');
  };
  recorder.start();
  console.log(`[rec] started at clip t=${video.currentTime.toFixed(2)}s`);
  toast('recording composite…');
}

function stopRecorder() {
  if (recorder && recorder.state !== 'inactive') recorder.stop();
  recorder = null;
}

const SPELL_KEYS = { Digit1: 'fire', Digit2: 'force', Digit3: 'light', Digit4: 'slash' };

// Transient feedback for the realism-debug hotkeys (O/M/L/G).
const toastEl = document.createElement('div');
Object.assign(toastEl.style, {
  position: 'fixed',
  top: '18px',
  left: '0',
  right: '0',
  textAlign: 'center',
  fontSize: '16px',
  fontWeight: '600',
  color: '#cfe0ff',
  textShadow: '0 0 12px rgba(127,214,255,0.6)',
  pointerEvents: 'none',
  zIndex: '6',
  opacity: '0',
  transition: 'opacity 0.25s',
});
document.body.appendChild(toastEl);
let toastTimer;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.style.opacity = '1';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.style.opacity = '0'; }, 1400);
}

function onKey(e) {
  if (e.code === 'KeyD') {
    overlay.toggle();
  } else if (e.code === 'KeyV') {
    toggleVoiceLog();
  } else if (e.code === 'KeyW') {
    wand.spawn();
  } else if (e.code === 'KeyO') {
    toast(`object: ${wand.cycleObject()}`);
  } else if (e.code === 'KeyM') {
    toast(`material: ${wand.cycleMaterial()}`);
  } else if (e.code === 'KeyL') {
    const on = sceneManager.setLightingMatch(!sceneManager.lightingMatch);
    toast(`lighting match: ${on ? 'on' : 'off'}`);
  } else if (e.code === 'KeyG') {
    const on = sceneManager.setGrain(!sceneManager.grainPass.enabled);
    toast(`grain: ${on ? 'on' : 'off'}`);
  } else if (e.code === 'KeyS') {
    segmenter.enabled = !segmenter.enabled;
    toast(`occlusion mask: ${segmenter.enabled ? 'on' : 'off'}`);
  } else if (SPELL_KEYS[e.code] && wand?.spawned) {
    const type = SPELL_KEYS[e.code];
    spellManager.cast({ type }, wand);
    flashChip(type);
  }
}

let lastPrompt = null;
function updatePrompt(hand) {
  let msg = '';
  if (!hand) msg = 'Show your hand to the camera ✋';
  else if (!wand.spawned) msg = 'Say “wand” to summon your wand';
  else if (!wand.held) msg = 'Pinch thumb + index to grab the wand';
  else msg = 'Point, then say a spell';
  if (msg !== lastPrompt) {
    lastPrompt = msg;
    prompt.textContent = msg; // only touch the DOM on change — this runs per frame
  }
}

function loop(now) {
  const dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;

  handTracker.update(now);
  segmenter.update(now);
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
