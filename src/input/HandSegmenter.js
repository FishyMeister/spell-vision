import * as THREE from 'three';
import { FilesetResolver, ImageSegmenter } from 'tasks-vision';
import { SEGMENT } from '../config.js';

const WASM_PATH =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const MODEL_PATH =
  'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite';

// Per-pixel skin mask of the live feed, as a texture the wand occluder can
// sample. The occluder's capsules are guesses built from landmarks, and
// MediaPipe hallucinates positions for fingers it can't see — those capsules
// land over background pixels and eat the wand where there is no visible hand
// (holes in the shaft, or the whole wand vanishing near an open palm). The
// mask restores ground truth: capsules say "hand is in front of the wand
// HERE", the mask says whether the camera actually sees hand there. Occlusion
// happens only where both agree, so segmentation can only remove wrong
// occlusion — never add any.
export class HandSegmenter {
  constructor(video) {
    this.video = video;
    this.segmenter = null;
    this.enabled = SEGMENT.enabled;
    this.maskTexture = null; // THREE.DataTexture, 255 = skin, 0 = not
    this._data = null;
    this._lastVideoTime = -1;
    this._lastTs = 0; // monotonic timestamp cursor (same trap as HandTracker)

    // The model works at 256×256 internally, but segmenting the raw video
    // returns the mask at VIDEO resolution — a huge GPU→CPU readback per frame
    // (this alone cost ~half the frame budget). Segment a downscaled copy
    // instead: identical quality, ~16× less readback.
    this._in = document.createElement('canvas');
    this._inCtx = this._in.getContext('2d', { willReadFrequently: false });
  }

  async init() {
    const fileset = await FilesetResolver.forVisionTasks(WASM_PATH);
    this.segmenter = await ImageSegmenter.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_PATH, delegate: 'GPU' },
      runningMode: 'VIDEO',
      outputCategoryMask: true,
      outputConfidenceMasks: false,
    });
  }

  // Called every render frame; segments each new video frame once.
  update(nowMs) {
    if (!this.segmenter || !this.enabled) return;
    if (this.video.readyState < this.video.HAVE_CURRENT_DATA) return;
    if (this.video.currentTime === this._lastVideoTime) return;
    this._lastVideoTime = this.video.currentTime;

    const ts = Math.max(nowMs, this._lastTs + 1);
    this._lastTs = ts;

    const w = 256;
    const h = Math.max(2, Math.round(w * this.video.videoHeight / this.video.videoWidth) & ~1);
    if (this._in.width !== w || this._in.height !== h) {
      this._in.width = w;
      this._in.height = h;
    }
    this._inCtx.drawImage(this.video, 0, 0, w, h);

    let result;
    try {
      result = this.segmenter.segmentForVideo(this._in, ts);
    } catch (e) {
      return; // transient hiccup; keep the previous mask
    }

    const mask = result.categoryMask;
    if (mask) {
      const src = mask.getAsUint8Array(); // category index per pixel
      const w = mask.width;
      const h = mask.height;
      if (!this.maskTexture || this._data.length !== src.length) {
        this._data = new Uint8Array(src.length);
        this.maskTexture = new THREE.DataTexture(
          this._data, w, h, THREE.RedFormat, THREE.UnsignedByteType
        );
        this.maskTexture.minFilter = THREE.LinearFilter;
        this.maskTexture.magFilter = THREE.LinearFilter;
        this.maskTexture.flipY = false; // orientation handled in the shader
      }
      for (let i = 0; i < src.length; i++) {
        this._data[i] = SEGMENT.skinCategories.includes(src[i]) ? 255 : 0;
      }
      this.maskTexture.needsUpdate = true;
    }
    result.close();
  }

  dispose() {
    this.maskTexture?.dispose();
    this.segmenter?.close();
  }
}
