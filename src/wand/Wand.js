import * as THREE from 'three';
import { WAND, REALISM, CONTACT_SHADOW, TEST_OBJECTS, TEST_MATERIALS } from '../config.js';

// Landmark indices we care about.
const WRIST = 0;
const THUMB_MCP = 2;
const THUMB_TIP = 4;
const INDEX_MCP = 5;
const INDEX_PIP = 6;
const INDEX_TIP = 8;
const MIDDLE_MCP = 9;
const PINKY_MCP = 17;

// [MCP, PIP, TIP] per finger — used to measure how curled each finger is.
const FINGER_JOINTS = [
  [5, 6, 8],     // index
  [9, 10, 12],   // middle
  [13, 14, 16],  // ring
  [17, 18, 20],  // pinky
];

const UP = new THREE.Vector3(0, 1, 0);

// PBR materials for the debug test shapes (config.TEST_MATERIALS). A matte
// mid-gray sphere is the classic on-set lighting probe: any mismatch between
// estimated and real light is obvious on it. Mirror is the env-map probe.
function makeTestMaterial(kind) {
  const common = { envMapIntensity: REALISM.envIntensity };
  switch (kind) {
    case 'glossy':
      return new THREE.MeshStandardMaterial({
        ...common, color: 0x8a2f2a, roughness: 0.25, metalness: 0.0,
      });
    case 'mirror':
      return new THREE.MeshStandardMaterial({
        ...common, color: 0xffffff, roughness: 0.08, metalness: 1.0,
      });
    default: // matte
      return new THREE.MeshStandardMaterial({
        ...common, color: 0x8f8f8f, roughness: 0.9, metalness: 0.0,
      });
  }
}

// Procedural polished-wood texture matching wand.webp's warm chestnut. Lathe
// UVs put u around the circumference and v along the length, so lengthwise
// grain = vertical streaks on the canvas (v runs bottom→top with flipY).
function makeWoodTexture() {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const ctx = c.getContext('2d');

  // Base: darker at the handle (canvas bottom = v 0 = butt), lighter up the shaft.
  const base = ctx.createLinearGradient(0, 256, 0, 0);
  base.addColorStop(0, '#4a2a14');
  base.addColorStop(0.45, '#6b3d1c');
  base.addColorStop(1, '#8a5426');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, 256, 256);

  // Lengthwise grain streaks, dark and light.
  for (let i = 0; i < 70; i++) {
    const x = Math.random() * 256;
    const dark = Math.random() < 0.6;
    ctx.fillStyle = dark
      ? `rgba(30, 16, 8, ${0.05 + Math.random() * 0.13})`
      : `rgba(196, 124, 58, ${0.04 + Math.random() * 0.1})`;
    ctx.fillRect(x, 0, 0.5 + Math.random() * 2.5, 256);
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping; // hide the u seam where the lathe closes
  return tex;
}

// MediaPipe hand skeleton: bone segments as [a, b] landmark index pairs. The
// occluder lays a capsule along each of these plus a sphere at each joint.
const BONES = [
  [0, 1], [1, 2], [2, 3], [3, 4],         // thumb
  [0, 5], [5, 6], [6, 7], [7, 8],         // index
  [5, 9], [9, 10], [10, 11], [11, 12],    // middle
  [9, 13], [13, 14], [14, 15], [15, 16],  // ring
  [13, 17], [17, 18], [18, 19], [19, 20], // pinky
  [0, 17],                                 // palm base edge
  [0, 9], [0, 13],                         // palm-fill diagonals (wrist → knuckles)
];
// Landmarks that form the meaty palm/fist (get the fat "palm" radius).
const PALM_JOINTS = new Set([0, 1, 2, 5, 9, 13, 17]);

export class Wand {
  constructor(sceneManager) {
    this.sm = sceneManager;
    this.spawned = false;
    this.held = false;

    // The group carries the grip transform; the visible object inside it is
    // swappable (wand or a debug test shape) — grip/occlusion/scale logic is
    // identical for all of them.
    this.group = new THREE.Group();
    this.group.visible = false;
    sceneManager.add(this.group);
    this._visuals = {};
    this._objectKind = null;
    this._materialKind = TEST_MATERIALS[0];
    this._tipLocal = new THREE.Vector3();
    this.setObject('wand');

    this.occluder = this._buildOccluder();
    this.occluder.visible = false;
    sceneManager.add(this.occluder);

    this._shadow = this._buildContactShadow();
    sceneManager.add(this._shadow);

    // Smoothed transform state.
    this.position = new THREE.Vector3(0, -0.15, 0);
    this.quaternion = new THREE.Quaternion();
    this.scale = 1; // smoothed; tracks hand size so the wand stays proportional

    // Smoothed grip state: 0 = open hand, 1 = closed fist.
    this.curl = 0;
    this._indexCurl = 0; // index finger alone — steers the wand axis

    // Scratch.
    this._targetPos = new THREE.Vector3();
    this._targetQuat = new THREE.Quaternion();
    this._forward = new THREE.Vector3(0, 1, 0);
    this._tip = new THREE.Vector3();
    this._a = new THREE.Vector3();
    this._b = new THREE.Vector3();
    this._mid = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._web = new THREE.Vector3();
    this._heel = new THREE.Vector3();
    this._openDir = new THREE.Vector3();
    // Last confident screen-plane wand direction (unit Vector2). When the axis
    // points nearly at the lens its x/y component is pure noise, so the clamp
    // falls back on this instead of amplifying that noise.
    this._xyDir = new THREE.Vector2(0, 1);
    this._xyTmp = new THREE.Vector2();
    // Landmarks in world space: at the hand's true depth (for wand placement)
    // and biased toward the camera (for the occluder).
    this._lm = Array.from({ length: 21 }, () => new THREE.Vector3());
    this._lmOcc = Array.from({ length: 21 }, () => new THREE.Vector3());
    this._flatLm = { x: 0, y: 0, z: 0 };
    this._targetScale = 1;
    this._handLen = 0.1;
    this._idleT = 0;
  }

  // Depth-only mesh shaped like the hand (joint spheres + bone capsules). It
  // writes depth but no color, sitting just in front of the wand, so the wand is
  // hidden behind the hand's real silhouette and the webcam's hand pixels show
  // through. Geometry is reused; only transforms change per frame.
  //
  // When a segmentation mask is available (setSegmenter), fragments over pixels
  // the camera does NOT see as skin are discarded: capsules from hallucinated
  // landmarks (hidden fingers) land over background and would otherwise punch
  // holes in the wand there. Capsules supply depth; the mask supplies the true
  // silhouette; occlusion needs both.
  _buildOccluder() {
    const g = new THREE.Group();
    const dbg = WAND.occluderDebug;
    const mat = this._occMat = new THREE.ShaderMaterial({
      uniforms: {
        uMask: { value: null },
        uEnabled: { value: 0 },
        uMirror: { value: 0 },
        uResolution: { value: new THREE.Vector2(1, 1) },
      },
      vertexShader: /* glsl */ `
        void main() {
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D uMask;
        uniform float uEnabled;
        uniform float uMirror;
        uniform vec2 uResolution;
        void main() {
          if (uEnabled > 0.5) {
            // The webcam plane fills the frame exactly, so screen fraction ==
            // video UV. Mask rows run top-down vs gl_FragCoord bottom-up; the
            // mask is unmirrored while the selfie view is flipped.
            vec2 uv = gl_FragCoord.xy / uResolution;
            uv.y = 1.0 - uv.y;
            if (uMirror > 0.5) uv.x = 1.0 - uv.x;
            if (texture2D(uMask, uv).r < 0.5) discard;
          }
          gl_FragColor = vec4(1.0, 0.0, 0.27, 0.45); // only visible in debug
        }
      `,
      transparent: dbg,
    });
    mat.colorWrite = dbg; // debug: paint the coverage red
    g.renderOrder = -5; // after the webcam plane, before the wand

    const sphereGeo = new THREE.SphereGeometry(1, 10, 8);
    // Unit cylinder along +Y, height 1 centered at origin → scale to each bone.
    const cylGeo = new THREE.CylinderGeometry(1, 1, 1, 10, 1);

    this._occJoints = Array.from({ length: 21 }, () => {
      const m = new THREE.Mesh(sphereGeo, mat);
      m.renderOrder = -5;
      g.add(m);
      return m;
    });
    this._occBones = BONES.map(() => {
      const m = new THREE.Mesh(cylGeo, mat);
      m.renderOrder = -5;
      g.add(m);
      return m;
    });
    return g;
  }

  // Soft elliptical darkening of the skin around the grip — the shadow the wand
  // presses into the hand. Drawn straight over the video (depth ignored), under
  // everything else, and masked to skin pixels so it can never darken the
  // background; without the segmenter mask it stays hidden entirely.
  _buildContactShadow() {
    const mat = this._shadowMat = new THREE.ShaderMaterial({
      uniforms: {
        uMask: { value: null },
        uMirror: { value: 0 },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uStrength: { value: CONTACT_SHADOW.strength },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        uniform sampler2D uMask;
        uniform float uMirror;
        uniform vec2 uResolution;
        uniform float uStrength;
        void main() {
          // Elliptical falloff over the unit plane, densest at the grip point.
          float d = length((vUv - 0.5) * 2.0);
          float fall = smoothstep(1.0, 0.12, d);
          // Same screen-space mask lookup as the occluder (see _buildOccluder).
          vec2 uv = gl_FragCoord.xy / uResolution;
          uv.y = 1.0 - uv.y;
          if (uMirror > 0.5) uv.x = 1.0 - uv.x;
          float skin = texture2D(uMask, uv).r;
          float a = uStrength * fall * skin;
          if (a < 0.004) discard;
          gl_FragColor = vec4(0.0, 0.0, 0.0, a);
        }
      `,
      transparent: true,
      depthWrite: false,
      depthTest: false,
    });
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    m.renderOrder = -6; // over the webcam plane (-10), under occluder + wand
    m.visible = false;
    return m;
  }

  // Fit the contact shadow to this frame's grip: centered on the grip point,
  // long axis along the wand's screen direction, nudged away from the key light.
  _updateContactShadow() {
    const seg = this._segmenter;
    const on = CONTACT_SHADOW.enabled && seg?.enabled && seg.maskTexture;
    this._shadow.visible = !!on;
    if (!on) return;

    const u = this._shadowMat.uniforms;
    u.uMask.value = seg.maskTexture;
    u.uMirror.value = this.sm.mirror ? 1 : 0;
    this.sm.renderer.getDrawingBufferSize(u.uResolution.value);
    // A closed fist presses the wand into the skin; an open hand barely does.
    u.uStrength.value = CONTACT_SHADOW.strength *
      THREE.MathUtils.lerp(0.55, 1.0, this.curl);

    const handLen = this._handLen;
    this._shadow.position.copy(this.position);
    // Slide away from the key light in the screen plane (light from the right
    // → shadow leans left), so it reads as shading, not a sticker.
    const key = this.sm.key.position;
    const kMag = Math.hypot(key.x, key.y);
    if (kMag > 1e-4) {
      const push = CONTACT_SHADOW.lightPush * handLen / kMag;
      this._shadow.position.x -= key.x * push;
      this._shadow.position.y -= key.y * push;
    }
    this._shadow.position.z += 0.02;

    this._shadow.rotation.z = Math.atan2(this._xyDir.y, this._xyDir.x);
    const len = handLen * CONTACT_SHADOW.size;
    this._shadow.scale.set(len, len * CONTACT_SHADOW.aspect, 1);
  }

  // World positions of all 21 landmarks for this frame, with true per-landmark
  // depth from MediaPipe. _lmOcc is the same hand slid toward the camera along
  // each view ray (stays pixel-aligned) so the occluder sits in front of the
  // wand shaft — making occlusion 3D-correct: fingers nearer the camera than
  // the shaft hide it, while wand parts pointing at the camera stay visible.
  _updateLandmarks(hand) {
    // Occluder landmarks are flattened to the hand's MEAN depth: per-landmark
    // depth noise slides points along their view rays, smearing the occluder
    // capsules radially (worst near the frame edges) — the smear plants
    // capsules over background pixels beside the hand and eats the wand shaft
    // there, visually detaching it from the fist. x/y stay pixel-aligned, so
    // the silhouette is unaffected; only the noisy per-capsule depth goes.
    let meanZ = 0;
    for (let i = 0; i < 21; i++) meanZ += hand[i].z;
    meanZ /= 21;
    for (let i = 0; i < 21; i++) {
      this.sm.landmarkToWorld(hand[i], 0, this._lm[i]);
      this._flatLm.x = hand[i].x;
      this._flatLm.y = hand[i].y;
      this._flatLm.z = meanZ;
      this.sm.landmarkToWorld(this._flatLm, WAND.occluderZ, this._lmOcc[i]);
    }
  }

  // Attach the skin segmenter whose mask gates the occluder (see _buildOccluder).
  setSegmenter(segmenter) {
    this._segmenter = segmenter;
  }

  // Fit the hand-shaped occluder to the live 3D landmarks.
  _updateOccluder() {
    const seg = this._segmenter;
    const u = this._occMat.uniforms;
    u.uMask.value = seg?.maskTexture || null;
    u.uEnabled.value = seg?.enabled && seg.maskTexture ? 1 : 0;
    u.uMirror.value = this.sm.mirror ? 1 : 0;
    this.sm.renderer.getDrawingBufferSize(u.uResolution.value);

    const lm = this._lmOcc;
    const handLen = this._handLen; // set in update() from the raw landmarks
    // Radii slim as the hand opens ONLY when the mask is unavailable: slimming
    // was the defense against hallucinated-finger capsules eating the wand over
    // background pixels, and the mask solves that outright. With the mask on,
    // slim capsules just open gaps between fingers that wand fragments poke
    // through (stray dark shards on the palm); full radii + mask give a clean
    // silhouette with zero over-reach.
    const maskOn = u.uEnabled.value > 0;
    const gripK = maskOn ? 1.0 : THREE.MathUtils.lerp(0.55, 1.0, this.curl);
    const finger = handLen * WAND.occluderFingerRadius * gripK;
    const palm = handLen * WAND.occluderPalmRadius * gripK;

    // Joint spheres round off the capsule ends and fill the palm.
    for (let i = 0; i < 21; i++) {
      const m = this._occJoints[i];
      m.position.copy(lm[i]);
      m.scale.setScalar(PALM_JOINTS.has(i) ? palm : finger);
    }

    // Bone capsules between connected landmarks.
    for (let k = 0; k < BONES.length; k++) {
      const [a, b] = BONES[k];
      const la = lm[a];
      const lb = lm[b];
      const len = la.distanceTo(lb) || 1e-3;
      this._mid.addVectors(la, lb).multiplyScalar(0.5);
      this._dir.subVectors(lb, la).multiplyScalar(1 / len);
      const r = PALM_JOINTS.has(a) && PALM_JOINTS.has(b) ? palm : finger;
      const m = this._occBones[k];
      m.position.copy(this._mid);
      m.quaternion.setFromUnitVectors(UP, this._dir);
      m.scale.set(r, len, r);
    }

    this.occluder.visible = true;
  }

  // Wand body modeled on wand.webp: acorn pommel with a butt bead, barrel grip,
  // ornate collar where the grip meets the shaft, then a long taper broken by a
  // cluster of turned rings. One lathe profile builds all of it; the old plain
  // cylinder read as a featureless black stub on camera.
  _buildMesh() {
    const g = new THREE.Group();
    const L = WAND.length;
    const t = WAND.thickness;
    // The grip point (origin) sits partway up the shaft so the wand passes
    // *through* the fist: `back` pokes out the bottom, `front` is the business end.
    const back = L * WAND.gripOffset;
    const front = L - back;

    // Profile: x = radius, y = position along the wand (butt → tip).
    const pts = [];
    const P = (y, r) => pts.push(new THREE.Vector2(Math.max(r, 0) * t, y));
    const y0 = -back;

    // Butt bead + acorn pommel.
    P(y0, 0);
    P(y0 + 0.001, 0.0045);
    P(y0 + 0.007, 0.006);
    P(y0 + 0.011, 0.0035); // bead neck
    P(y0 + 0.013, 0.011);
    P(y0 + 0.024, 0.0185);
    P(y0 + 0.040, 0.0205); // dome widest point
    P(y0 + 0.054, 0.017);
    P(y0 + 0.057, 0.0195); // lip ring under the grip
    P(y0 + 0.063, 0.0195);
    P(y0 + 0.067, 0.015);

    // Grip barrel (the carved section on the reference).
    P(y0 + 0.078, 0.0163);
    P(y0 + 0.120, 0.0172);
    P(y0 + 0.158, 0.0158);
    P(y0 + 0.166, 0.014);

    // Ornate collar band at the top of the grip (lands ≈ at the grip origin).
    P(y0 + 0.170, 0.0185);
    P(y0 + 0.176, 0.0205);
    P(y0 + 0.188, 0.0205);
    P(y0 + 0.194, 0.0175);
    P(y0 + 0.198, 0.0125);

    // Shaft: smooth taper interrupted by turned rings, like the reference.
    const rAt = (y) => THREE.MathUtils.lerp(0.0105, 0.0045, y / front);
    P(0.012, rAt(0.012));
    for (const ry of [0.045, 0.08, 0.11, 0.135]) {
      P(ry - 0.007, rAt(ry - 0.007));
      P(ry - 0.003, rAt(ry) + 0.0032);
      P(ry + 0.003, rAt(ry) + 0.0032);
      P(ry + 0.007, rAt(ry + 0.007));
    }
    P(front - 0.02, rAt(front - 0.02));
    P(front - 0.003, 0.004);
    P(front, 0);

    const bodyMat = new THREE.MeshStandardMaterial({
      map: makeWoodTexture(),
      roughness: 0.38, // varnished wood: soft sheen, picks up the env map
      metalness: 0.0,
      envMapIntensity: REALISM.envIntensity,
    });
    g.add(new THREE.Mesh(new THREE.LatheGeometry(pts, 48), bodyMat));

    // Emissive tip nub — the anchor spells emit from, gives a subtle glow.
    const tipGeo = new THREE.SphereGeometry(0.005 * t, 12, 12);
    tipGeo.translate(0, front - 0.002, 0);
    this.tipMat = new THREE.MeshStandardMaterial({
      color: 0xfff0d0,
      emissive: 0x886644,
      emissiveIntensity: 1.2,
    });
    g.add(new THREE.Mesh(tipGeo, this.tipMat));

    g.userData.tipLocal = new THREE.Vector3(0, front, 0);
    return g;
  }

  // A basic shape held at the grip point — clean surfaces for judging the
  // lighting/realism stack without the wand's own detail in the way. Spheres
  // and cubes sit half-proud of the fist (like a gripped ball); the cylinder
  // lies along the wand axis like a plain rod.
  _buildShape(kind) {
    const g = new THREE.Group();
    const mat = makeTestMaterial(this._materialKind);
    let mesh, tipY;
    if (kind === 'sphere') {
      mesh = new THREE.Mesh(new THREE.SphereGeometry(0.1, 48, 32), mat);
      mesh.position.y = 0.1;
      tipY = 0.2;
    } else if (kind === 'cube') {
      mesh = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.15, 0.15), mat);
      mesh.position.y = 0.1;
      tipY = 0.18;
    } else { // cylinder
      const L = WAND.length * 0.9;
      const back = L * WAND.gripOffset;
      const geo = new THREE.CylinderGeometry(0.028, 0.028, L, 32);
      geo.translate(0, L / 2 - back, 0);
      mesh = new THREE.Mesh(geo, mat);
      tipY = L - back;
    }
    g.add(mesh);
    g.userData.tipLocal = new THREE.Vector3(0, tipY, 0);
    return g;
  }

  // Swap the held object. Visuals are built lazily and cached; only visibility
  // and the tip anchor change on a swap, so it's safe to hammer the hotkey.
  setObject(kind) {
    if (!TEST_OBJECTS.includes(kind)) kind = 'wand';
    this._objectKind = kind;
    if (!this._visuals[kind]) {
      this._visuals[kind] = kind === 'wand' ? this._buildMesh() : this._buildShape(kind);
      this.group.add(this._visuals[kind]);
    }
    for (const k of Object.keys(this._visuals)) {
      this._visuals[k].visible = k === kind;
    }
    this._tipLocal.copy(this._visuals[kind].userData.tipLocal);
    return kind;
  }

  cycleObject() {
    const i = TEST_OBJECTS.indexOf(this._objectKind);
    return this.setObject(TEST_OBJECTS[(i + 1) % TEST_OBJECTS.length]);
  }

  // Cycle the PBR material on the test shapes (the wand keeps its own look).
  cycleMaterial() {
    const i = TEST_MATERIALS.indexOf(this._materialKind);
    this._materialKind = TEST_MATERIALS[(i + 1) % TEST_MATERIALS.length];
    const mat = makeTestMaterial(this._materialKind);
    const old = new Set();
    for (const kind of TEST_OBJECTS) {
      if (kind === 'wand' || !this._visuals[kind]) continue;
      this._visuals[kind].traverse((o) => {
        if (o.isMesh) {
          old.add(o.material);
          o.material = mat;
        }
      });
    }
    for (const m of old) m.dispose();
    return this._materialKind;
  }

  spawn() {
    this.spawned = true;
    this.group.visible = true;
    if (!this.held) {
      // Appear floating in the center, waiting to be grabbed.
      this.position.set(0, -0.15, 0);
      this.quaternion.setFromUnitVectors(UP, new THREE.Vector3(0, 1, 0));
    }
  }

  // Apparent hand size in world units at the z=0 action plane, measured from the
  // *raw normalized* landmarks. The world-space wrist→knuckle distance is
  // unusable for this: MediaPipe's per-landmark depth is noisy, and
  // landmarkToWorld slides each landmark along its own view ray, so depth noise
  // leaks into the world x/y separation and balloons the wand + occluder
  // (worst with a fist pointing at the camera). Screen-space spans can only
  // foreshorten, never inflate — take the larger of wrist→middle-knuckle and
  // the knuckle line (index↔pinky MCP, ~0.8× of the former anatomically), so
  // whichever axis lies closer to the screen plane reads true.
  _handSize(hand) {
    const aspect = this.sm.camera.aspect;
    const toWorld = this.sm._frustumHeightAt(0);
    const d = (a, b) => Math.hypot((a.x - b.x) * aspect, a.y - b.y) * toWorld;
    const spanA = d(hand[WRIST], hand[MIDDLE_MCP]);
    const spanB = d(hand[INDEX_MCP], hand[PINKY_MCP]) * 1.25;
    return Math.max(spanA, spanB) || 0.1;
  }

  // 0 = finger straight, 1 = fully curled into the palm. Angle (in 3D) between
  // the proximal segment (MCP→PIP) and the rest of the finger (PIP→TIP).
  _fingerCurl([mcp, pip, tip]) {
    this._a.subVectors(this._lm[pip], this._lm[mcp]);
    this._b.subVectors(this._lm[tip], this._lm[pip]);
    const d = this._a.length() * this._b.length();
    if (d < 1e-8) return 0;
    const cos = this._a.dot(this._b) / d;
    return THREE.MathUtils.clamp((1 - cos) / 1.6, 0, 1);
  }

  update(hand, dt) {
    if (!this.spawned) return;

    if (hand) {
      this._updateLandmarks(hand);
      const lm = this._lm;

      const handLen = this._handLen = this._handSize(hand);

      // Grip state: per-finger curl, smoothed over time.
      const idxCurl = this._fingerCurl(FINGER_JOINTS[0]);
      let curlSum = idxCurl;
      for (let i = 1; i < FINGER_JOINTS.length; i++) {
        curlSum += this._fingerCurl(FINGER_JOINTS[i]);
      }
      const k = Math.min(1, dt * WAND.curlSmoothing);
      this.curl += (curlSum / FINGER_JOINTS.length - this.curl) * k;
      this._indexCurl += (idxCurl - this._indexCurl) * k;

      // Grab by pinching OR by closing the hand around the wand. Pinch distance
      // is hand-relative so it works at any distance from the camera.
      const pinch = lm[THUMB_TIP].distanceTo(lm[INDEX_TIP]) / handLen;
      if (!this.held && (pinch < WAND.pinchThreshold || this.curl > WAND.fistGrabCurl)) {
        this.held = true;
      }
      // (We latch on grab so the user can open their hand to cast.)

      if (this.held) {
        // A held wand lies along the fist's tunnel. Two independent estimates
        // of that axis, averaged so one noisy landmark can't swing the aim:
        //  1. palm diagonal — heel of the palm (wrist↔pinky-knuckle midpoint)
        //     out through the thumb-index web;
        //  2. knuckle line — pinky knuckle → index knuckle, which is the
        //     anatomical axis curled fingers wrap around.
        // All points carry real depth, so the wand tilts toward/away from the
        // camera and foreshortens like a true 3D object.
        this._web.addVectors(lm[THUMB_MCP], lm[INDEX_MCP]).multiplyScalar(0.5);
        this._heel.addVectors(lm[WRIST], lm[PINKY_MCP]).multiplyScalar(0.5);
        this._forward.subVectors(this._web, this._heel);
        if (this._forward.lengthSq() > 1e-8) this._forward.normalize();
        else this._forward.set(0, 1, 0);
        this._dir.subVectors(lm[INDEX_MCP], lm[PINKY_MCP]);
        if (this._dir.lengthSq() > 1e-8) {
          this._forward.add(this._dir.normalize()).normalize();
        }

        // As the index finger straightens (half-open "pen" grip), tip the wand
        // toward the index's proximal phalanx, like a wand held loosely between
        // thumb and finger; a closed fist uses the pure tunnel axis.
        this._openDir.subVectors(lm[INDEX_PIP], lm[INDEX_MCP]);
        if (this._openDir.lengthSq() > 1e-8) {
          this._openDir.normalize();
          const openness = (1 - this._indexCurl) * WAND.openDirBlend;
          this._forward.lerp(this._openDir, openness).normalize();
        }

        // Clamp how steeply the wand may pitch toward/away from the camera.
        // When the hand points at the lens the estimated axis does too, and a
        // near-camera wand goes degenerate on screen: the tip blows up huge in
        // front of the lens while the butt recedes to the vanishing point,
        // reading as a detached stick floating near the shoulder. Foreshortening
        // up to ~37° still sells the 3D pose; beyond that stability wins.
        //
        // The screen-plane direction carries inertia: near the clamp the raw
        // x/y component is a sliver of noise, and normalizing it directly makes
        // the on-screen wand swing at random. _xyDir tracks the direction only
        // as fast as its magnitude earns trust.
        const zMax = WAND.maxForwardZ;
        const xyMag = Math.hypot(this._forward.x, this._forward.y);
        if (xyMag > 1e-6) {
          this._xyTmp.set(this._forward.x / xyMag, this._forward.y / xyMag);
          this._xyDir.lerp(this._xyTmp, Math.min(1, xyMag * xyMag * 4)).normalize();
        }
        if (Math.abs(this._forward.z) > zMax) {
          const xyTarget = Math.sqrt(1 - zMax * zMax);
          this._forward.x = this._xyDir.x * xyTarget;
          this._forward.y = this._xyDir.y * xyTarget;
          this._forward.z = Math.sign(this._forward.z) * zMax;
        }
        this._targetQuat.setFromUnitVectors(UP, this._forward);

        // Anchor at the web, sunk toward the heel along the wand's own axis —
        // deeper inside a closed fist, shallower when the hand opens and the
        // wand just rests in the web.
        const bias = THREE.MathUtils.lerp(
          WAND.gripBiasOpen, WAND.gripBiasClosed, this.curl
        );
        this._targetPos.copy(this._web).lerp(this._heel, bias);

        // Scale to the hand's true size.
        this._targetScale = (handLen * WAND.lengthPerHand) / WAND.length;
      }
    }

    if (this.held) {
      // Exponential smoothing with dt-based gains so follow stiffness is the
      // same at any frame rate (a fixed per-frame lerp lags harder as fps drops).
      const kPos = 1 - Math.exp(-WAND.positionRate * dt);
      const kRot = 1 - Math.exp(-WAND.rotationRate * dt);
      this.position.lerp(this._targetPos, kPos);
      this.quaternion.slerp(this._targetQuat, kRot);
      if (this._targetScale) {
        const kScale = 1 - Math.exp(-WAND.scaleRate * dt);
        this.scale += (this._targetScale - this.scale) * kScale;
      }
    } else {
      // Idle bob while waiting to be grabbed.
      this._idleT += dt;
      this.position.set(0, -0.15 + Math.sin(this._idleT * 1.5) * 0.04, 0);
      this.quaternion.setFromAxisAngle(
        new THREE.Vector3(0, 0, 1),
        Math.sin(this._idleT * 0.8) * 0.25 + 0.35
      );
    }

    this.group.position.copy(this.position);
    this.group.quaternion.copy(this.quaternion);
    this.group.scale.setScalar(this.scale);
    this.group.updateMatrixWorld();

    // Hide the wand mid-section behind the fingers so it looks gripped, and
    // shade the skin around the grip so the wand sits IN the hand, not on it.
    if (this.held) {
      if (hand) {
        this._updateOccluder();
        this._updateContactShadow();
      }
    } else {
      this.occluder.visible = false;
      this._shadow.visible = false;
    }
  }

  // Jump straight to the current grip target, no smoothing. The follow lerps
  // above assume a ~60 fps loop; offline exporters stepping at clip fps call
  // this after update() so the wand stays rigidly planted in the hand.
  snapToTarget() {
    if (!this.held) return;
    this.position.copy(this._targetPos);
    this.quaternion.copy(this._targetQuat);
    if (this._targetScale) this.scale = this._targetScale;
    this.group.position.copy(this.position);
    this.group.quaternion.copy(this.quaternion);
    this.group.scale.setScalar(this.scale);
    this.group.updateMatrixWorld();
  }

  // World position of the wand tip (spell origin).
  getTip() {
    return this._tip.copy(this._tipLocal).applyMatrix4(this.group.matrixWorld);
  }

  // Normalized world-space forward direction the wand points.
  getForward() {
    return this._forward.copy(UP).applyQuaternion(this.quaternion).normalize();
  }
}
