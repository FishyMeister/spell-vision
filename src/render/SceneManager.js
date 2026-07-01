import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { CAMERA, BLOOM, TRACKING } from '../config.js';

// Owns the renderer, camera, post-processing, and the webcam background plane.
// Also provides screenToWorld(): the single source of truth for mapping
// MediaPipe's normalized image coords into the 3D world.
export class SceneManager {
  constructor(canvas, video) {
    this.canvas = canvas;
    this.video = video;

    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(
      CAMERA.fov,
      window.innerWidth / window.innerHeight,
      0.1,
      100
    );
    this.camera.position.set(0, 0, CAMERA.distance);
    this.camera.lookAt(0, 0, 0);

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;

    // Ambient + a soft key so the wand mesh isn't pure silhouette.
    this.scene.add(new THREE.AmbientLight(0x404a66, 1.4));
    const key = new THREE.DirectionalLight(0xffffff, 0.6);
    key.position.set(1, 2, 3);
    this.scene.add(key);

    this._buildWebcamPlane();
    this._buildComposer();

    this._tmpV = new THREE.Vector3();
    this._raycastPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0); // z = 0

    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

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
    this.bgPlane.scale.x = -1; // mirror for a natural "selfie" view
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
  }

  // Height (world units) of the view frustum at a given z-plane.
  _frustumHeightAt(z) {
    const dist = this.camera.position.z - z;
    return 2 * Math.tan((this.camera.fov * Math.PI) / 360) * dist;
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const aspect = w / h;

    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();

    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.bloom.setSize(w, h);

    // Stretch the webcam plane to exactly fill the frustum at its depth.
    const bgH = this._frustumHeightAt(CAMERA.bgZ);
    this.bgPlane.scale.set(-bgH * aspect, bgH, 1); // x negative = mirrored
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

  render() {
    if (this.video.readyState >= this.video.HAVE_CURRENT_DATA) {
      this.videoTexture.needsUpdate = true;
    }
    this.composer.render();
  }
}
