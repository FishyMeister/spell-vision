# ✦ Spell Vision

Cast spells with your **hand** and your **voice**, in the browser. Summon a wand
by saying "wand", grab it with a pinch, point it, and speak an incantation to
emit a glowing, bloom-driven spell from the tip — in the stylized, emissive,
particle-driven spirit of *Hogwarts Legacy*.

100% client-side. No backend, no build step required. Open one URL and play.

---

## Run it locally

Because it uses ES modules, a webcam, and a microphone, you must serve it over
`http://localhost` (or `https`) — opening `index.html` via `file://` will not
work. Any static server is fine:

```bash
# Python (already on most machines)
python -m http.server 8000

# or Node
npx serve .

# or Vite, for live-reload during dev
npm create vite@latest   # then drop these files in, or just:
npx vite
```

Then open **http://localhost:8000** and click **Begin**.

> Everything (Three.js, MediaPipe, the model) loads from CDNs, so the first
> launch needs an internet connection. After that the only network use is the
> CDN assets.

### Browser requirements

- **Chrome or Edge on desktop** (recommended). Voice uses the Web Speech API,
  which is best supported in Chromium browsers. Firefox/Safari will run the
  visuals but voice may be unavailable — use the **keyboard fallback** below.
- Grant **camera** and **microphone** permission when prompted.
- A discrete or decent integrated GPU helps; MediaPipe runs on GPU/WASM.

---

## How to play

1. Say **"wand"** → a wand appears, floating in the center.
2. **Pinch** your thumb and index finger together to grab it. It now follows
   your hand and points where your fingers point.
3. Point it somewhere and say a spell name.

### Spells & trigger words

| Spell      | Type  | What it looks like                                   | Also triggers on        |
| ---------- | ----- | ---------------------------------------------------- | ----------------------- |
| **Incendio** | fire  | Sustained cone of buoyant, turbulent embers (white→orange→red) | "fire", "ignite"        |
| **Depulso**  | force | Camera-facing shockwave ring + blue-white radial blast | "expelliarmus", "push", "blast" |
| **Lumos**    | light | Steady white-gold orb + real point light + floating motes (toggle) | "light" |
| **Nox**      | —     | Turns the Lumos orb off                              | "dark"                  |
| **Diffindo** | slash | Fast, sharp cyan blade + streaking ribbon            | "slash", "cut", "sever" |

Unknown words are ignored (the last heard word is shown in the HUD for
feedback). The mic listens continuously and restarts itself automatically.

### Keyboard fallback (no mic needed)

| Key | Action          |
| --- | --------------- |
| `W` | Summon wand     |
| `1` | Incendio (fire) |
| `2` | Depulso (force) |
| `3` | Lumos (light)   |
| `4` | Diffindo (slash)|
| `D` | Toggle hand-tracking debug overlay |

---

## Where the tunable constants live

All the dials you'll actually want to touch are in **`src/config.js`**:

- `PARTICLES` — hard per-spell particle caps. **Lower these first** if a weak
  GPU struggles.
- `BLOOM` — `strength`, `radius`, `threshold`. This is what sells the "magic"
  glow; raise `threshold` if the webcam itself glows too much.
- `ONE_EURO` — landmark smoothing. Lower `minCutoff` = smoother but laggier;
  raise `beta` = snappier on fast motion.
- `WAND` — `length`, `pinchThreshold` (grab sensitivity), follow/rotation
  smoothing.
- `TRACKING` — `inferenceFps` (inference is throttled and decoupled from
  render), `inputWidth/Height` (lower = faster inference), grace time.
- `CAMERA` — fov and depth of the action/background planes.

Per-spell look & feel (colors, speeds, lifetimes, emission shapes) lives in
each effect under **`src/spells/effects/`**.

### Changing spell names (e.g. for a commercial build)

The spell names here are Warner Bros. IP — fine for a personal/portfolio
project. To swap them for generic words, edit **only**
`src/spells/spellConfig.js`: change each entry's `label` and `keywords`. Nothing
else references the names.

---

## Architecture

```
index.html ── importmap (three, three/addons, @mediapipe/tasks-vision)
└─ src/
   ├─ main.js                 orchestrator + render loop + HUD
   ├─ config.js               ★ global tunables
   ├─ render/SceneManager.js  renderer, camera, UnrealBloom, webcam plane,
   │                          screenToWorld()  (normalized → 3D)
   ├─ input/
   │   ├─ HandTracker.js      MediaPipe HandLandmarker, throttled, One-Euro
   │   └─ LandmarkOverlay.js  debug skeleton (D key)
   ├─ util/OneEuroFilter.js   adaptive jitter filter
   ├─ wand/Wand.js            mesh, pinch-to-grab, smoothed follow, tip+forward
   ├─ voice/VoiceController.js Web Speech API, continuous, keyword matching
   └─ spells/
       ├─ spellConfig.js      ★ spell names / trigger words (edit here)
       ├─ SpellManager.js     routes spells, keeps fire/orb glued to the wand
       ├─ ParticleEffect.js   base: CPU particle pool (ring buffer)
       ├─ materials.js        additive glow point shader + mesh material
       └─ effects/            Incendio · Force · Lumos · Diffindo
```

**Pipeline:** webcam → MediaPipe (≤30 fps, decoupled from render) → One-Euro
smoothing → wand follow/grab → wand tip + forward → spell particle emitters →
UnrealBloomPass → screen. The webcam is rendered as an in-scene plane so the
bloom pass composites correctly (bloom `threshold` keeps the normal feed from
glowing while bright additive spells exceed it).

## Performance notes

- Inference is capped at `TRACKING.inferenceFps` (30) and skips duplicate
  frames; rendering runs at display rate.
- MediaPipe input is captured at `inputWidth/Height` (480×360), below display
  resolution.
- Particle pools are fixed-size ring buffers; buffers only re-upload while
  particles are alive.
- Target: 60 fps on a mid-range laptop, ≥30 fps with a spell active. If you dip
  below that, lower `PARTICLES.*` and/or `BLOOM.radius`.

## Known limitations

- This build is **cam → wand → voice → spell**. No object creation, collision,
  or hit detection — that's a deliberate later phase.
- Voice quality depends on the browser's speech engine and mic; expect the
  occasional misheard incantation (it's ignored, never fatal).
- Mobile is best-effort: it shouldn't crash, but it isn't the target.
