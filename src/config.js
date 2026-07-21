// =============================================================================
//  GLOBAL TUNABLES  —  the knobs worth touching live here.
//  (Spell-specific look/feel lives in src/spells/spellConfig.js)
// =============================================================================

// ---- Camera / scene geometry -------------------------------------------------
export const CAMERA = {
  fov: 50,
  distance: 3.0,    // camera sits at +Z this far from the action plane (z=0)
  bgZ: -2.0,        // webcam plane depth (behind the action)
};

// ---- Hand tracking (MediaPipe) ----------------------------------------------
export const TRACKING = {
  inferenceFps: 60,        // cap only — actual rate is min(render fps, video fps).
                           //   Uncapped so every new camera frame is used; at 30
                           //   it added up to 33 ms of landmark age on top of the
                           //   camera's own latency
  inputWidth: 480,         // webcam capture width fed to inference (lower = faster)
  inputHeight: 360,
  numHands: 1,
  minHandDetectionConfidence: 0.5,
  minHandPresenceConfidence: 0.5,
  minTrackingConfidence: 0.5,
  handLostGraceMs: 500,    // keep wand "in hand" briefly through tracking dropouts
  depthScale: 0.9,         // MediaPipe per-landmark depth → world units. 1.0 = trust
                           //   it fully; lower damps depth noise (flatter hand)
};

// ---- One-Euro smoothing filter (per-landmark) -------------------------------
//  Lower minCutoff = smoother but laggier. Higher beta = snappier on fast moves.
//  Landmarks are normalized [0,1], so a fast hand swipe is ~1–3 units/s. beta
//  must be sized for that scale: cutoff = minCutoff + beta·|v|, and we want the
//  cutoff up near ~8 Hz during a swipe (τ≈20 ms) or the wand visibly trails the
//  hand — beta 0.04–0.12 left ~90 ms of lag at speed (the "wand floats off the
//  moving hand" bug). Rest jitter is governed by minCutoff alone.
export const ONE_EURO = {
  minCutoff: 1.6,
  beta: 3.0,
  dCutoff: 1.0,
};

// ---- Wand --------------------------------------------------------------------
export const WAND = {
  length: 0.62,            // world units (full shaft, handle → tip)
  gripOffset: 0.32,        // fraction of length that sits *below* the grip point,
                           //   i.e. pokes out the bottom of the fist (pinky side)
  thickness: 1.0,          // overall shaft girth multiplier
  lengthPerHand: 2.2,      // wand length as a multiple of the wrist→knuckle span
                           //   (measured in 3D), so it scales with the real hand size
  // --- Grip model: the wand lies along the palm diagonal (heel of palm → thumb-
  //     index web), reacting to how open/closed the hand is.
  gripBiasOpen: 0.3,       // anchor sink from web toward heel when the hand is OPEN
                           //   — deep enough that an open casting hand keeps the
                           //   wand over the palm instead of past the fingertips
  gripBiasClosed: 0.45,    // …and when it's a closed fist (wand sits deep inside)
  openDirBlend: 0.35,      // how far a straightened index finger steers the wand
                           //   toward a loose "pen grip" along that finger (0..1)
                           //   — too high and a casting flick (open hand, index
                           //   sideways) whips the wand right out of frame
  maxForwardZ: 0.6,        // max |z| of the wand axis (z=1 → straight at the
                           //   lens). Caps camera-pointing tilt at ~37° so the
                           //   wand can't go degenerate when the hand aims at
                           //   the camera (tip ballooning in front of the lens,
                           //   butt receding to the vanishing point)
  curlSmoothing: 10,       // per-second rate the open/closed state responds at
  // --- Hand occluder: an invisible (depth-only) mesh shaped like your hand —
  //     capsules along every finger bone + the palm — placed just in front of the
  //     wand. The wand is hidden behind your hand's real silhouette and only shows
  //     where it pokes out past it (tip above the fist, butt below) → "held" look.
  occluderZ: 0.08,             // bias each hand landmark this far toward the camera,
                               //   in front of the wand shaft (kept pixel-aligned)
  // Radii must hug the real skin silhouette: too fat and the wand is hidden
  // *past* the hand's edge (floating gap at the knuckles, butt end swallowed).
  occluderFingerRadius: 0.10,  // finger capsule radius as × the hand length
  occluderPalmRadius: 0.17,    // palm/wrist capsule radius as × the hand length
  occluderDebug: false,        // true = tint the hand mesh red so you can see its coverage
  pinchThreshold: 0.45,    // thumb-tip↔index-tip distance to "grab", as a fraction
                           //   of hand length — so it works at any camera distance
  fistGrabCurl: 0.72,      // …or grab by closing the hand: smoothed curl past this
  // Follow stiffness as per-second exponential rates (frame-rate independent:
  // k = 1 - exp(-rate·dt) per frame). Higher = stiffer. The old per-frame lerp
  // constants compounded with fps — at 20 fps the wand trailed the hand badly.
  positionRate: 80,        // near-rigid follow (τ≈12 ms) — One-Euro upstream
                           //   already smooths jitter; double-smoothing here
                           //   only added trailing lag
  rotationRate: 28,        // softer — palm-axis noise shows up as aim wobble
  scaleRate: 5,            // slow on purpose: hand-size estimate is noisy and
                           //   fast scale tracking makes the wand "breathe"
};

// ---- Skin segmentation for wand occlusion (toggle with S) --------------------
//  The occluder capsules are landmark guesses; the segmentation mask is what
//  the camera actually sees. The wand is hidden only where both agree, so the
//  occluder can no longer eat the wand against the background.
export const SEGMENT = {
  enabled: true,
  skinCategories: [2, 3],  // selfie_multiclass: 2 = body skin, 3 = face skin
};

// ---- Contact shadow (soft darkening of the hand around the grip) -------------
//  A real held object shades the skin it presses against; without that the wand
//  reads as pasted on top of the hand. An elliptical soft shadow, aligned with
//  the wand's screen axis, is drawn at the grip point — masked to skin pixels
//  (needs the segmenter), so it can never darken the wall behind the hand.
export const CONTACT_SHADOW = {
  enabled: true,
  strength: 0.33,   // peak darkening at the grip center (0..1)
  size: 1.05,       // footprint along the wand, as × hand length
  aspect: 0.6,      // footprint across the wand, as a fraction of `size`
  lightPush: 0.1,   // how far the shadow slides away from the key light, × hand
                    //   length — sells "the wand blocks the light", not a decal
};

// ---- Lighting match (webcam → scene lights, toggle with L) -------------------
//  Estimated every sampleMs from the live feed; see render/LightingEstimator.js.
export const LIGHTING = {
  enabled: true,
  sampleMs: 250,        // ambient/key re-estimate cadence
  envMs: 500,           // reflection env-map refresh cadence (costs a PMREM rebuild)
  ambientGain: 2.4,     // ambient intensity per unit of scene brightness
  keyGain: 1.8,         // key intensity per unit of bright-vs-mean contrast
  keyMinIntensity: 0.25,
  zPush: 0.6,           // how frontal the estimated key light is (higher = flatter)
};

// ---- Photometric realism (toggle grain with G) --------------------------------
export const REALISM = {
  grain: true,
  grainAmount: 0.05,    // display-referred grain amplitude; webcam noise ≈ 0.03–0.07
  envIntensity: 0.9,    // how strongly PBR materials reflect the webcam env map
};

// ---- Debug test objects (cycle with O, materials with M) ----------------------
//  Basic shapes held with the same grip logic as the wand, for judging the
//  realism stack on clean surfaces (a matte sphere is the classic light probe).
export const TEST_OBJECTS = ['wand', 'sphere', 'cube', 'cylinder'];
export const TEST_MATERIALS = ['matte', 'glossy', 'mirror'];

// ---- Particle budget ---------------------------------------------------------
//  Hard caps per effect. Lower these first if a weak GPU struggles.
export const PARTICLES = {
  incendio: 2200,
  force: 1400,
  diffindo: 1600,
  lumos: 500,
};

// ---- Bloom (the "magic" glow). Tune until spells read as emissive. ----------
//  Threshold ≥ 1.0 keeps bloom off the webcam video entirely: the composer
//  renders to a half-float buffer, so only additive spell particles and
//  emissive materials exceed 1.0 — a bright wall in the feed (≤ 1.0) can't
//  bloom the whole frame into fog anymore.
export const BLOOM = {
  strength: 1.15,
  radius: 0.55,
  threshold: 1.0,
};
