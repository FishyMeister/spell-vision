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
  inferenceFps: 30,        // MediaPipe runs at most this often; render is decoupled
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
export const ONE_EURO = {
  minCutoff: 1.6,
  beta: 0.04,
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
  gripBiasOpen: 0.22,      // anchor sink from web toward heel when the hand is OPEN
  gripBiasClosed: 0.45,    // …and when it's a closed fist (wand sits deep inside)
  openDirBlend: 0.5,       // how far a straightened index finger steers the wand
                           //   toward a loose "pen grip" along that finger (0..1)
  curlSmoothing: 10,       // per-second rate the open/closed state responds at
  // --- Hand occluder: an invisible (depth-only) mesh shaped like your hand —
  //     capsules along every finger bone + the palm — placed just in front of the
  //     wand. The wand is hidden behind your hand's real silhouette and only shows
  //     where it pokes out past it (tip above the fist, butt below) → "held" look.
  occluderZ: 0.08,             // bias each hand landmark this far toward the camera,
                               //   in front of the wand shaft (kept pixel-aligned)
  // Radii must hug the real skin silhouette: too fat and the wand is hidden
  // *past* the hand's edge (floating gap at the knuckles, butt end swallowed).
  occluderFingerRadius: 0.12,  // finger capsule radius as × the hand length
  occluderPalmRadius: 0.21,    // palm/wrist capsule radius as × the hand length
  occluderDebug: false,        // true = tint the hand mesh red so you can see its coverage
  pinchThreshold: 0.45,    // thumb-tip↔index-tip distance to "grab", as a fraction
                           //   of hand length — so it works at any camera distance
  fistGrabCurl: 0.72,      // …or grab by closing the hand: smoothed curl past this
  positionLerp: 0.45,      // 0..1 per frame — higher = stiffer follow
  rotationSlerp: 0.35,     // 0..1 per frame — orientation smoothing
};

// ---- Particle budget ---------------------------------------------------------
//  Hard caps per effect. Lower these first if a weak GPU struggles.
export const PARTICLES = {
  incendio: 2200,
  force: 1400,
  diffindo: 1600,
  lumos: 500,
};

// ---- Bloom (the "magic" glow). Tune until spells read as emissive. ----------
export const BLOOM = {
  strength: 1.15,
  radius: 0.55,
  threshold: 0.62,
};
