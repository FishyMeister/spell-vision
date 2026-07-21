import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { CAMERA, BLOOM, TRACKING, LIGHTING, REALISM } from '../config.js';
import { LightingEstimator } from './LightingEstimator.js';
import { createFilmGrainPass } from './FilmGrainPass.js';

// Owns the renderer, camera, post-processing, and the webcam background plane.
// Also provides screenToWorld(): the single source of truth for mapping
// MediaPipe's normalized image coords into the 3D world.
//
// opts (all optional, defaults preserve the live-app behavior):
//   mirror  — false renders the video un-mirrored (raw pixel space). The export
//             tool uses this so masks align with the source file frame-for-frame.
//   width/height — fixed render size instead of tracking the window.
//   preserveDrawingBuffer — lets the export tool read pixels back after render.
export class SceneManager {
  constructor(canvas, video, opts = {}) {
    this.canvas = canvas;
    this.video = video;
    this.mirror = opts.mirror !== false;
    this.fixedWidth = opts.width || null;
    this.fixedHeight = opts.height || null;

    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(
      CAMERA.fov,
      this._viewWidth() / this._viewHeight(),
      0.1,
      100
    );
    this.camera.position.set(0, 0, CAMERA.distance);
    this.camera.lookAt(0, 0, 0);

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      // Dual-GPU laptops otherwise default to the integrated GPU — which
      // MediaPipe's GPU delegate is already fighting for.
      powerPreference: 'high-performance',
      preserveDrawingBuffer: !!opts.preserveDrawingBuffer,
    });
    // DPR capped at 1.5: every pixel goes through a 4-pass composer (render,
    // bloom, output, grain), so 2× DPR nearly doubles GPU time for detail the
    // webcam feed doesn't even have.
    this.renderer.setPixelRatio(
      this.fixedWidth ? 1 : Math.min(window.devicePixelRatio, 1.5)
    );
    this.renderer.setSize(this._viewWidth(), this._viewHeight());
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;

    // Ambient + a soft key so the wand mesh isn't pure silhouette. These are
    // the fallback values; with lighting match on, the estimator drives them
    // from the webcam every frame instead.
    this.ambient = new THREE.AmbientLight(0x404a66, 1.4);
    this.scene.add(this.ambient);
    this.key = new THREE.DirectionalLight(0xffffff, 0.6);
    this.key.position.set(1, 2, 3);
    this.scene.add(this.key);

    this.lightingEstimator = new LightingEstimator(video, { mirror: this.mirror });
    this.lightingMatch = false;
    this.setLightingMatch(LIGHTING.enabled);

    this._buildWebcamPlane();
    this._buildComposer();

    this._tmpV = new THREE.Vector3();
    this._raycastPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0); // z = 0

    if (!this.fixedWidth) {
      window.addEventListener('resize', () => this.resize());
    }
    this.resize();
  }

  _viewWidth() { return this.fixedWidth || window.innerWidth; }
  _viewHeight() { return this.fixedHeight || window.innerHeight; }

  _buildWebcamPlane() {
    const tex = new THREE.VideoTexture(this.video);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    this.videoTexture = tex;

    // The backdrop must always fill the screen and never be hidden by anything.
    // depthWrite/Test off + lowest renderOrder = it paints first and can't be
    // rejected by the wand occluder (which writes depth in front of it).
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      side: THREE.DoubleSide,
      depthWrite: false,
      depthTest: false,
    });
    this.bgPlane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    this.bgPlane.position.z = CAMERA.bgZ;
    this.bgPlane.scale.x = this.mirror ? -1 : 1; // mirror for a "selfie" view
    this.bgPlane.renderOrder = -10; // draw first
    this.scene.add(this.bgPlane);
  }

  _buildComposer() {
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));

    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      BLOOM.strength,
      BLOOM.radius,
      BLOOM.threshold
    );
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    // Grain lives after OutputPass: display-referred sRGB, same space real
    // sensor noise lives in.
    this.grainPass = createFilmGrainPass(REALISM.grainAmount);
    this.grainPass.enabled = REALISM.grain;
    this.composer.addPass(this.grainPass);
  }

  // Toggle webcam-driven lighting. Off restores the fixed studio setup so the
  // two are directly A/B-comparable.
  setLightingMatch(on) {
    this.lightingMatch = on;
    if (!on) {
      this.ambient.color.set(0x404a66);
      this.ambient.intensity = 1.4;
      this.key.color.set(0xffffff);
      this.key.intensity = 0.6;
      this.key.position.set(1, 2, 3);
      this.scene.environment = null;
    }
    return on;
  }

  setGrain(on) {
    this.grainPass.enabled = on;
    return on;
  }

  _applyEstimatedLighting() {
    const est = this.lightingEstimator;
    this.ambient.color.copy(est.ambientColor);
    this.ambient.intensity = est.ambientIntensity;
    this.key.color.copy(est.keyColor);
    this.key.intensity = est.keyIntensity;
    this.key.position.copy(est.keyDir).multiplyScalar(5);
    if (this.scene.environment !== est.envTexture) {
      this.scene.environment = est.envTexture;
    }
  }

  // Height (world units) of the view frustum at a given z-plane.
  _frustumHeightAt(z) {
    const dist = this.camera.position.z - z;
    return 2 * Math.tan((this.camera.fov * Math.PI) / 360) * dist;
  }

  resize() {
    const w = this._viewWidth();
    const h = this._viewHeight();
    const aspect = w / h;

    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();

    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.bloom.setSize(w, h);

    // Stretch the webcam plane to exactly fill the frustum at its depth.
    const bgH = this._frustumHeightAt(CAMERA.bgZ);
    this.bgPlane.scale.set((this.mirror ? -1 : 1) * bgH * aspect, bgH, 1);
  }

  // --- The important one ---
  // nx, ny are MIRRORED normalized image coords in [0,1] (x right, y down on
  // screen). Returns the world point on the z=0 action plane under that pixel.
  screenToWorld(nx, ny, target = new THREE.Vector3()) {
    const ndcX = nx * 2 - 1;
    const ndcY = -(ny * 2 - 1);
    this._tmpV.set(ndcX, ndcY, 0.5).unproject(this.camera);
    const dir = this._tmpV.sub(this.camera.position).normalize();
    const t = -this.camera.position.z / dir.z; // intersect z = 0
    return target.copy(this.camera.position).add(dir.multiplyScalar(t));
  }

  // Full-3D version of screenToWorld for a MediaPipe landmark {x, y, z}.
  // MediaPipe z is relative depth in roughly the same scale as normalized x
  // (negative = toward the camera). We convert it to world units, then slide the
  // point *along its own view ray* to that depth — so it stays exactly over the
  // same webcam pixel while gaining real depth. That depth is what lets the wand
  // tilt toward/away from the camera instead of living flat on the z=0 plane.
  // zOffset adds a world-z bias (used to float the occluder in front of the wand).
  landmarkToWorld(lm, zOffset, target = new THREE.Vector3()) {
    this.screenToWorld(lm.x, lm.y, target);
    const unitsPerNx = this._frustumHeightAt(0) * this.camera.aspect;
    const z = -lm.z * unitsPerNx * TRACKING.depthScale + zOffset;
    const camZ = this.camera.position.z;
    const s = (camZ - z) / camZ; // move along the ray from the camera through target
    target.x *= s;
    target.y *= s;
    target.z = z;
    return target;
  }

  add(obj) { this.scene.add(obj); }
  remove(obj) { this.scene.remove(obj); }

  render(nowMs = performance.now()) {
    if (this.video.readyState >= this.video.HAVE_CURRENT_DATA) {
      this.videoTexture.needsUpdate = true;
    }
    if (this.lightingMatch) {
      this.lightingEstimator.update(nowMs);
      this._applyEstimatedLighting();
    }
    this.grainPass.uniforms.uTime.value = (nowMs % 4096) / 1000;
    this.composer.render();
  }
}
