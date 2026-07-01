import * as THREE from 'three';
import { WAND } from '../config.js';

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

    this.group = this._buildMesh();
    this.group.visible = false;
    sceneManager.add(this.group);

    this.occluder = this._buildOccluder();
    this.occluder.visible = false;
    sceneManager.add(this.occluder);

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
    // Landmarks in world space: at the hand's true depth (for wand placement)
    // and biased toward the camera (for the occluder).
    this._lm = Array.from({ length: 21 }, () => new THREE.Vector3());
    this._lmOcc = Array.from({ length: 21 }, () => new THREE.Vector3());
    this._targetScale = 1;
    this._idleT = 0;
  }

  // Depth-only mesh shaped like the hand (joint spheres + bone capsules). It
  // writes depth but no color, sitting just in front of the wand, so the wand is
  // hidden behind the hand's real silhouette and the webcam's hand pixels show
  // through. Geometry is reused; only transforms change per frame.
  _buildOccluder() {
    const g = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({
      colorWrite: WAND.occluderDebug, // debug: paint it red to see its coverage
      color: 0xff0044,
      transparent: WAND.occluderDebug,
      opacity: WAND.occluderDebug ? 0.45 : 1,
    });
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

  // World positions of all 21 landmarks for this frame, with true per-landmark
  // depth from MediaPipe. _lmOcc is the same hand slid toward the camera along
  // each view ray (stays pixel-aligned) so the occluder sits in front of the
  // wand shaft — making occlusion 3D-correct: fingers nearer the camera than
  // the shaft hide it, while wand parts pointing at the camera stay visible.
  _updateLandmarks(hand) {
    for (let i = 0; i < 21; i++) {
      this.sm.landmarkToWorld(hand[i], 0, this._lm[i]);
      this.sm.landmarkToWorld(hand[i], WAND.occluderZ, this._lmOcc[i]);
    }
  }

  // Fit the hand-shaped occluder to the live 3D landmarks.
  _updateOccluder() {
    const lm = this._lmOcc;
    const handLen = lm[WRIST].distanceTo(lm[MIDDLE_MCP]) || 0.1;
    const finger = handLen * WAND.occluderFingerRadius;
    const palm = handLen * WAND.occluderPalmRadius;

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

  _buildMesh() {
    const g = new THREE.Group();
    const L = WAND.length;
    const t = WAND.thickness;
    // The grip point (origin) sits partway up the shaft so the wand passes
    // *through* the fist: `back` pokes out the bottom, `front` is the business end.
    const back = L * WAND.gripOffset;
    const front = L - back;

    // Tapered shaft: thick handle → thin tip. Cylinder axis is +Y; center it on
    // the span [-back, +front] so the grip lands at the origin.
    const shaftGeo = new THREE.CylinderGeometry(0.006 * t, 0.013 * t, L, 16, 1);
    shaftGeo.translate(0, (front - back) / 2, 0);
    const shaftMat = new THREE.MeshStandardMaterial({
      color: 0x241a12,
      roughness: 0.65,
      metalness: 0.1,
      emissive: 0x110a06,
    });
    g.add(new THREE.Mesh(shaftGeo, shaftMat));

    // Handle band near the butt of the wand, for a bit of detail.
    const bandGeo = new THREE.CylinderGeometry(0.015 * t, 0.015 * t, 0.04, 16);
    bandGeo.translate(0, -back + 0.04, 0);
    const bandMat = new THREE.MeshStandardMaterial({
      color: 0x3a2a1a,
      roughness: 0.5,
      metalness: 0.3,
    });
    g.add(new THREE.Mesh(bandGeo, bandMat));

    // Emissive tip nub — the anchor spells emit from, gives a subtle glow.
    const tipGeo = new THREE.SphereGeometry(0.009 * t, 12, 12);
    tipGeo.translate(0, front, 0);
    this.tipMat = new THREE.MeshStandardMaterial({
      color: 0xfff0d0,
      emissive: 0x886644,
      emissiveIntensity: 1.2,
    });
    g.add(new THREE.Mesh(tipGeo, this.tipMat));

    this._tipLocal = new THREE.Vector3(0, front, 0);
    return g;
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

      // Hand size measured in 3D, so it stays steady when the hand tilts
      // toward/away from the camera (the 2D projection would shrink).
      const handLen = lm[WRIST].distanceTo(lm[MIDDLE_MCP]) || 0.1;

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
      this.position.lerp(this._targetPos, WAND.positionLerp);
      this.quaternion.slerp(this._targetQuat, WAND.rotationSlerp);
      if (this._targetScale) {
        this.scale += (this._targetScale - this.scale) * WAND.positionLerp;
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

    // Hide the wand mid-section behind the fingers so it looks gripped.
    if (this.held) {
      if (hand) this._updateOccluder();
    } else {
      this.occluder.visible = false;
    }
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
