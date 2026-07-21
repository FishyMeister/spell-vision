---
name: verify
description: Build/launch/drive recipe for verifying Spell Vision changes end-to-end in a headless browser (no webcam or build step needed).
---

# Verifying Spell Vision

Static ES-modules app — no build step. Serve the repo root over HTTP (import
maps + getUserMedia need it; `file://` won't work), then drive it with
Playwright Chromium using a fake/virtual camera.

## Recipe

1. Serve: any static server on the repo root (a 12-line `node:http` server is
   fine; python `http.server` also works).
2. Launch Chromium with:
   `--use-fake-ui-for-media-stream --use-fake-device-for-user-media --autoplay-policy=no-user-gesture-required`
   Note: on this machine the "fake device" resolves to the **DroidCam virtual
   camera** (dark feed with glowing "Start DroidCam" text), not Chromium's
   rolling-ball pattern. It's still a live video feed — fine for exercising
   render/lighting paths, but there is **no hand in it**. For real-hand
   behavior (grab, occlusion, placement) use **clip mode** instead:
   `index.html?src=Test.mp4` runs the live pipeline on a clip (no fake-cam
   flags needed) and auto-downloads the composited recording at clip end —
   catch it with Playwright's `download` event, then inspect frames with
   ffmpeg. The static server must support **Range requests** or `<video>`
   can't seek. `window.sv = {wand, handTracker, sceneManager, spellManager}`
   is exposed for state probing (e.g. `sv.wand.held`, `sv.handTracker.getHand()`).
3. `playwright` isn't installed globally — `npm i playwright` in the scratchpad
   (browsers are already cached in `~/AppData/Local/ms-playwright`).
4. Drive: click `#start-btn`, then wait for the render loop via
   `waitForFunction` on `#fps` matching `/\d+ fps/`. MediaPipe model download
   takes a few seconds on first load.
5. Hotkeys to drive features: `W` summon wand, `O` cycle object
   (wand/sphere/cube/cylinder), `M` cycle test material, `L` toggle lighting
   match, `G` toggle grain, `D` landmark overlay, `1-4` spells. Hotkey feedback
   appears as a transient top-center toast div.
6. Evidence: screenshots; collect `pageerror` + console errors and fail on any.
   The wand mesh is thin and dark — crop+zoom the frame center (ffmpeg
   `crop=...,scale=...:flags=neighbor`) to actually see it against dark feeds.

## Gotchas

- Headless runs at ~20 fps — normal, don't read it as a perf regression.
- Mask export renders bypass the composer (`sm.renderer.render`), so
  post-processing (grain/bloom) never contaminates masks — only the debug
  composite.
- MediaPipe VIDEO mode needs strictly increasing timestamps across export runs.
