import * as THREE from 'three';
import { SceneManager } from '../render/SceneManager.js';
import { HandTracker } from '../input/HandTracker.js';
import { Wand } from '../wand/Wand.js';

// Offline exporter: steps through a recorded clip frame by frame, runs the
// exact same hand-tracking + wand pipeline as the live app (un-mirrored, so
// everything stays in raw video pixel space), and downloads a ZIP of
//   frames/frame_%04d.jpg   raw video frames
//   masks/mask_%04d.png     wand silhouette (white = wand, black = keep),
//                           already hand-occluded via the depth occluder
//   composite/comp_%04d.jpg the crude live-style render, for debugging
//   meta.json               fps / size / counts
// which colab/SpellVision_VACE.ipynb feeds to Wan VACE for photoreal insertion.

const MAX_RENDER_WIDTH = 960; // masks/frames don't need more; VACE runs at ≤832

// ?debug — draw the tracked landmarks + wand anchor onto the exported raw
// frames, to diagnose grip placement without touching the masks.
const DEBUG_LANDMARKS = new URLSearchParams(location.search).has('debug');

const video = document.getElementById('input-video');
const fileInput = document.getElementById('video-file');
const processBtn = document.getElementById('process-btn');
const statusEl = document.getElementById('status');
const progressEl = document.getElementById('progress');

let handTracker = null; // created once; the model download is slow
let running = false;
// MediaPipe VIDEO mode demands strictly increasing timestamps for the lifetime
// of the landmarker, so this cursor never rewinds — even across export runs.
let tsCursor = 0;
// Each run renders into a fresh canvas (a WebGL context can't be cleanly
// re-wrapped by a new renderer), swapped into the page in place of the old one.
let currentCanvas = document.getElementById('three-canvas');

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle('err', isError);
}

function seek(v, t) {
  return new Promise((resolve, reject) => {
    const onSeeked = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new Error('video seek failed')); };
    const cleanup = () => {
      v.removeEventListener('seeked', onSeeked);
      v.removeEventListener('error', onError);
    };
    v.addEventListener('seeked', onSeeked);
    v.addEventListener('error', onError);
    v.currentTime = t;
  });
}

// Strip the data-URL header; JSZip takes the raw base64 payload.
function dataUrlBase64(dataUrl) {
  return dataUrl.slice(dataUrl.indexOf(',') + 1);
}

fileInput.addEventListener('change', async () => {
  const file = fileInput.files[0];
  if (!file) return;
  if (video.src) URL.revokeObjectURL(video.src);
  video.src = URL.createObjectURL(file);
  try {
    await new Promise((res, rej) => {
      video.onloadedmetadata = res;
      video.onerror = () => rej(new Error('cannot decode this video'));
    });
    processBtn.disabled = false;
    setStatus(
      `Loaded ${file.name} — ${video.videoWidth}×${video.videoHeight}, ` +
      `${video.duration.toFixed(1)}s. Ready to process.`
    );
  } catch (e) {
    processBtn.disabled = true;
    setStatus(`Could not load video: ${e.message}`, true);
  }
});

processBtn.addEventListener('click', async () => {
  if (running) return;
  running = true;
  processBtn.disabled = true;
  try {
    await processClip(fileInput.files[0]);
  } catch (e) {
    console.error(e);
    setStatus(`Export failed: ${e.message}`, true);
  } finally {
    running = false;
    processBtn.disabled = false;
    progressEl.hidden = true;
  }
});

async function processClip(file) {
  const fps = Math.max(8, Math.min(30, Number(document.getElementById('fps').value) || 16));
  const maxFrames = Math.max(9, Math.min(161, Number(document.getElementById('max-frames').value) || 81));
  const startTime = Math.max(0, Number(document.getElementById('start-time').value) || 0);
  const forceGrab = document.getElementById('force-grab').checked;
  const includeComposite = document.getElementById('include-composite').checked;

  // Render at the clip's own aspect so MediaPipe's normalized coords, the
  // video plane, and the captured pixels all line up 1:1.
  const scale = Math.min(1, MAX_RENDER_WIDTH / video.videoWidth);
  const W = Math.round((video.videoWidth * scale) / 2) * 2;
  const H = Math.round((video.videoHeight * scale) / 2) * 2;

  if (!handTracker) {
    setStatus('Loading hand-tracking model…');
    handTracker = new HandTracker(video, { mirror: false });
    await handTracker.init();
  }
  handTracker.reset();

  // Fresh canvas + scene per run: cheap, and guarantees no state leaks.
  const canvas = currentCanvas.cloneNode(false);
  currentCanvas.replaceWith(canvas);
  currentCanvas = canvas;
  const sm = new SceneManager(canvas, video, {
    mirror: false,
    width: W,
    height: H,
    preserveDrawingBuffer: true,
  });
  const wand = new Wand(sm);

  // Everything the mask pass toggles, prepared once.
  const whiteMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const wandMeshes = [];
  wand.group.traverse((o) => {
    if (o.isMesh) wandMeshes.push([o, o.material]);
  });

  const grab = document.createElement('canvas');
  grab.width = W;
  grab.height = H;
  const grabCtx = grab.getContext('2d');

  const dt = 1 / fps;
  const usable = Math.max(0, video.duration - startTime - dt);
  const frameCount = Math.min(maxFrames, Math.max(1, Math.floor(usable * fps)));

  const zip = new JSZip();
  const framesDir = zip.folder('frames');
  const masksDir = zip.folder('masks');
  const compDir = includeComposite ? zip.folder('composite') : null;

  progressEl.hidden = false;
  let handFrames = 0;

  for (let i = 0; i < frameCount; i++) {
    const t = startTime + i * dt;
    await seek(video, t);

    // Track + drive the wand exactly like the live loop.
    tsCursor += Math.max(1, Math.round(dt * 1000));
    handTracker.detectFrame(tsCursor, dt);
    const hand = handTracker.getHand();
    if (hand) {
      handFrames++;
      if (!wand.spawned) wand.spawn();
      if (forceGrab) wand.held = true;
    }
    wand.update(hand, dt);
    if (hand) wand.snapToTarget(); // no follow-lag at offline step rates
    // No floating idle wand in exports — a wand hovering mid-air would poison
    // the masks. It only exists once it's in the hand.
    wand.group.visible = wand.spawned && wand.held;

    const id = String(i).padStart(4, '0');

    // 1) Raw frame, straight off the video element.
    grabCtx.drawImage(video, 0, 0, W, H);
    if (DEBUG_LANDMARKS && hand) {
      grabCtx.fillStyle = '#00ff66';
      for (const p of hand) grabCtx.fillRect(p.x * W - 2, p.y * H - 2, 4, 4);
      // Wand anchor (web↔heel blend) and grip axis endpoints, in cyan/blue.
      const px = (a, b) => ({ x: ((a.x + b.x) / 2) * W, y: ((a.y + b.y) / 2) * H });
      const web = px(hand[2], hand[5]);
      const heel = px(hand[0], hand[17]);
      grabCtx.strokeStyle = '#00ccff';
      grabCtx.beginPath(); grabCtx.moveTo(heel.x, heel.y); grabCtx.lineTo(web.x, web.y); grabCtx.stroke();
      grabCtx.fillStyle = '#0066ff';
      grabCtx.fillRect(web.x - 3, web.y - 3, 6, 6);
      console.log(
        `f${id} scale=${wand.scale.toFixed(3)} pos=(${wand.position.x.toFixed(2)},` +
        `${wand.position.y.toFixed(2)},${wand.position.z.toFixed(2)})`
      );
    }
    framesDir.file(`frame_${id}.jpg`, dataUrlBase64(grab.toDataURL('image/jpeg', 0.92)), { base64: true });

    // 2) Mask: black background, wand painted flat white, hand occluder still
    //    writing depth — so fingers covering the wand stay black and the mask
    //    is exactly the *visible* wand silhouette. Rendered without bloom.
    sm.bgPlane.visible = false;
    for (const [mesh] of wandMeshes) mesh.material = whiteMat;
    sm.renderer.setClearColor(0x000000, 1);
    sm.renderer.render(sm.scene, sm.camera);
    masksDir.file(`mask_${id}.png`, dataUrlBase64(canvas.toDataURL('image/png')), { base64: true });
    for (const [mesh, mat] of wandMeshes) mesh.material = mat;
    sm.bgPlane.visible = true;

    // 3) Crude composite (also serves as the on-screen preview).
    sm.render();
    if (compDir) {
      compDir.file(`comp_${id}.jpg`, dataUrlBase64(canvas.toDataURL('image/jpeg', 0.92)), { base64: true });
    }

    progressEl.value = (i + 1) / frameCount;
    setStatus(`Processing frame ${i + 1}/${frameCount}…`);
  }

  if (handFrames === 0) {
    throw new Error('no hand was detected in any frame — check lighting/framing');
  }

  zip.file('meta.json', JSON.stringify({
    source: file.name,
    fps,
    frameCount,
    width: W,
    height: H,
    startTime,
    handFrames,
    maskConvention: 'white = regenerate (wand), black = keep original',
  }, null, 2));

  setStatus('Building ZIP…');
  const blob = await zip.generateAsync({ type: 'blob' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `spellvision_vace_${Date.now()}.zip`;
  a.click();
  URL.revokeObjectURL(a.href);

  setStatus(
    `Done — ${frameCount} frames (hand in ${handFrames}). ` +
    `Upload the ZIP + a wand reference image in the Colab notebook.`
  );

  // Free GPU resources from this run's scene.
  sm.renderer.dispose();
}
