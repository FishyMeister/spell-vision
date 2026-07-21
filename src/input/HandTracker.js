import { FilesetResolver, HandLandmarker } from 'tasks-vision';
import { Vec3Filter } from '../util/OneEuroFilter.js';
import { TRACKING, ONE_EURO } from '../config.js';

const WASM_PATH =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const MODEL_PATH =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

// Runs MediaPipe HandLandmarker on the webcam, throttled to TRACKING.inferenceFps,
// and smooths every landmark with a One-Euro filter. By default output landmarks
// are MIRRORED in x so they line up with the mirrored webcam plane on screen;
// pass { mirror: false } to keep raw video coords (used by the export tool).
export class HandTracker {
  constructor(video, { mirror = true } = {}) {
    this.video = video;
    this.mirror = mirror;
    this.landmarker = null;

    this.lastInferTime = 0;
    this.lastVideoTime = -1;
    this.lastSeenTime = 0;
    this.present = false;
    this._lastTs = 0; // monotonic timestamp cursor fed to MediaPipe

    // 21 landmarks, one Vec3 filter each.
    this.filters = Array.from({ length: 21 }, () => new Vec3Filter(ONE_EURO));
    this.smoothed = null; // [{x,y,z} * 21], mirrored
  }

  // Fresh smoothing/presence state without reloading the model (the export tool
  // calls this between runs so a previous clip's pose can't bleed into the next).
  reset() {
    this.filters = Array.from({ length: 21 }, () => new Vec3Filter(ONE_EURO));
    this.smoothed = null;
    this.present = false;
    this.lastInferTime = 0;
    this.lastVideoTime = -1;
    this.lastSeenTime = 0;
  }

  async init() {
    const fileset = await FilesetResolver.forVisionTasks(WASM_PATH);
    this.landmarker = await HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_PATH, delegate: 'GPU' },
      runningMode: 'VIDEO',
      numHands: TRACKING.numHands,
      minHandDetectionConfidence: TRACKING.minHandDetectionConfidence,
      minHandPresenceConfidence: TRACKING.minHandPresenceConfidence,
      minTrackingConfidence: TRACKING.minTrackingConfidence,
    });
  }

  // Called every render frame; only actually infers ~inferenceFps times/sec.
  update(nowMs) {
    if (!this.landmarker) return;
    if (this.video.readyState < this.video.HAVE_CURRENT_DATA) return;

    const minInterval = 1000 / TRACKING.inferenceFps;
    if (nowMs - this.lastInferTime < minInterval) return;
    if (this.video.currentTime === this.lastVideoTime) return; // no new frame
    this.lastInferTime = nowMs;
    this.lastVideoTime = this.video.currentTime;

    const dt = Math.min(0.05, Math.max(0.001, minInterval / 1000));
    this._infer(nowMs, dt);
  }

  // Offline variant for the export tool: no throttling, caller supplies the
  // media timestamp (must be monotonically increasing) and the true frame dt.
  detectFrame(timestampMs, dt) {
    if (!this.landmarker) return;
    this._infer(timestampMs, Math.min(0.2, Math.max(0.001, dt)));
  }

  _infer(nowMs, dt) {
    // VIDEO mode requires strictly increasing timestamps — and one violation
    // poisons MediaPipe's graph permanently (every later call errors out, so
    // tracking dies silently). Violations happen in practice: the warm-up call
    // stamps performance.now(), but the first rAF frame's timestamp is fixed
    // when the frame *starts*, so it can sit before the warm-up's time.
    const ts = Math.max(nowMs, this._lastTs + 1);
    this._lastTs = ts;

    let result;
    try {
      result = this.landmarker.detectForVideo(this.video, ts);
    } catch (e) {
      return; // transient inference hiccup; keep last smoothed pose
    }

    if (result && result.landmarks && result.landmarks.length > 0) {
      const raw = result.landmarks[0];
      const out = new Array(21);
      for (let i = 0; i < 21; i++) {
        // Mirror x to match the mirrored webcam plane (live mode only).
        const x = this.mirror ? 1 - raw[i].x : raw[i].x;
        const m = { x, y: raw[i].y, z: raw[i].z };
        out[i] = this.filters[i].filter(m, dt);
      }
      this.smoothed = out;
      this.present = true;
      this.lastSeenTime = nowMs;
    } else {
      // Hold the last pose briefly so brief dropouts don't drop the wand.
      if (nowMs - this.lastSeenTime > TRACKING.handLostGraceMs) {
        this.present = false;
        this.smoothed = null;
      }
    }
  }

  getHand() {
    return this.present ? this.smoothed : null;
  }
}
