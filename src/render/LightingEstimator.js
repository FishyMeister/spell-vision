import * as THREE from 'three';
import { LIGHTING } from '../config.js';

// Estimates scene lighting from the live webcam feed so inserted objects share
// the room's illumination instead of a hardcoded studio setup. Three outputs,
// all cheap enough to refresh continuously:
//
//   1. Ambient: the frame's mean color/brightness drives the ambient light, so
//      a warm dim room gives a warm dim object.
//   2. Key light: the luminance-weighted centroid of the frame says which side
//      the light comes from (a bright window on the left = key from the left);
//      the color of the brightest quartile sets its tint, and the contrast
//      between bright and mean sets its strength.
//   3. Environment map: the frame itself, heavily blurred, becomes an
//      equirect env map for PBR reflections — glossy surfaces pick up the
//      actual room colors. (three converts equirect → PMREM internally.)
//
// The webcam only sees ~one hemisphere of the room, so all of this is an
// approximation — but "approximately the room" beats "exactly a studio".
export class LightingEstimator {
  constructor(video, { mirror = true } = {}) {
    this.video = video;
    this.mirror = mirror;

    // Tiny analysis buffer: 32×18 is plenty to find the mean and the bright side.
    this._an = document.createElement('canvas');
    this._an.width = 32;
    this._an.height = 18;
    this._anCtx = this._an.getContext('2d', { willReadFrequently: true });

    // Env map buffer. Blur = draw through a tiny intermediate (8×4) so detail
    // is destroyed before upscaling; reflections should be soft room color, not
    // a readable mirror of the user's face.
    this._envSmall = document.createElement('canvas');
    this._envSmall.width = 8;
    this._envSmall.height = 4;
    this._envSmallCtx = this._envSmall.getContext('2d');
    this._env = document.createElement('canvas');
    this._env.width = 64;
    this._env.height = 32;
    this._envCtx = this._env.getContext('2d');

    this.envTexture = new THREE.CanvasTexture(this._env);
    this.envTexture.mapping = THREE.EquirectangularReflectionMapping;
    this.envTexture.colorSpace = THREE.SRGBColorSpace;

    // Estimated light state (read by SceneManager after update()).
    this.ambientColor = new THREE.Color(0x808080);
    this.ambientIntensity = 1.0;
    this.keyColor = new THREE.Color(0xffffff);
    this.keyIntensity = LIGHTING.keyMinIntensity;
    this.keyDir = new THREE.Vector3(0.3, 0.5, 1).normalize();

    this._lastSample = -Infinity;
    this._lastEnv = -Infinity;
  }

  _videoReady() {
    return this.video.readyState >= this.video.HAVE_CURRENT_DATA &&
      this.video.videoWidth > 0;
  }

  // Draw the video into ctx, flipped horizontally when mirrored so "light from
  // screen-left" means the same side the user sees on the backdrop plane.
  _drawVideo(ctx, w, h) {
    ctx.save();
    if (this.mirror) {
      ctx.translate(w, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(this.video, 0, 0, w, h);
    ctx.restore();
  }

  update(nowMs) {
    if (!this._videoReady()) return false;
    let changed = false;

    if (nowMs - this._lastSample >= LIGHTING.sampleMs) {
      this._lastSample = nowMs;
      this._analyze();
      changed = true;
    }

    if (nowMs - this._lastEnv >= LIGHTING.envMs) {
      this._lastEnv = nowMs;
      this._drawVideo(this._envSmallCtx, this._envSmall.width, this._envSmall.height);
      this._envCtx.imageSmoothingEnabled = true;
      this._envCtx.drawImage(this._envSmall, 0, 0, this._env.width, this._env.height);
      this.envTexture.needsUpdate = true; // re-runs the equirect→PMREM conversion
    }

    return changed;
  }

  _analyze() {
    const w = this._an.width;
    const h = this._an.height;
    this._drawVideo(this._anCtx, w, h);
    const px = this._anCtx.getImageData(0, 0, w, h).data;

    // Pass 1 — mean linear color + luminance-weighted centroid of the frame.
    // Lights live in linear space, so sRGB bytes are linearized (γ≈2.2) first.
    let r = 0, g = 0, b = 0;
    let lumSum = 0, cx = 0, cy = 0;
    const n = w * h;
    const lum = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const lr = Math.pow(px[i * 4] / 255, 2.2);
      const lg = Math.pow(px[i * 4 + 1] / 255, 2.2);
      const lb = Math.pow(px[i * 4 + 2] / 255, 2.2);
      r += lr; g += lg; b += lb;
      const L = (lum[i] = 0.2126 * lr + 0.7152 * lg + 0.0722 * lb);
      lumSum += L;
      cx += (i % w) * L;
      cy += ((i / w) | 0) * L;
    }
    r /= n; g /= n; b /= n;
    const meanLum = lumSum / n;

    // Pass 2 — the brightest quartile approximates the light source: its mean
    // color tints the key light, its excess over the frame mean sets strength.
    const sorted = Float32Array.from(lum).sort();
    const thresh = sorted[Math.floor(n * 0.75)];
    let br = 0, bg = 0, bb = 0, bn = 0, brightLum = 0;
    for (let i = 0; i < n; i++) {
      if (lum[i] < thresh) continue;
      br += Math.pow(px[i * 4] / 255, 2.2);
      bg += Math.pow(px[i * 4 + 1] / 255, 2.2);
      bb += Math.pow(px[i * 4 + 2] / 255, 2.2);
      brightLum += lum[i];
      bn++;
    }

    // --- Ambient ---
    // Normalize the mean color to a chromaticity (max channel = 1) and carry
    // magnitude in the intensity, so dark scenes dim the light rather than
    // turning it black (black light × any surface = invisible object).
    const maxC = Math.max(r, g, b, 1e-4);
    this.ambientColor.setRGB(r / maxC, g / maxC, b / maxC);
    this.ambientIntensity = THREE.MathUtils.clamp(
      Math.pow(meanLum, 0.6) * LIGHTING.ambientGain, 0.15, 3.0);

    // --- Key light ---
    if (bn > 0) {
      br /= bn; bg /= bn; bb /= bn;
      const maxB = Math.max(br, bg, bb, 1e-4);
      this.keyColor.setRGB(br / maxB, bg / maxB, bb / maxB);
      const contrast = Math.max(0, brightLum / bn - meanLum);
      this.keyIntensity = THREE.MathUtils.clamp(
        Math.pow(contrast, 0.7) * LIGHTING.keyGain,
        LIGHTING.keyMinIntensity, 2.5);
    }
    // Centroid offset from frame center, in [-1, 1] — the bright side of the
    // frame is where the key points *from*. Y flips (image y-down → world y-up).
    const ox = (cx / Math.max(lumSum, 1e-6)) / (w - 1) * 2 - 1;
    const oy = (cy / Math.max(lumSum, 1e-6)) / (h - 1) * 2 - 1;
    this.keyDir.set(ox, -oy, LIGHTING.zPush).normalize();
  }

  dispose() {
    this.envTexture.dispose();
  }
}
