import * as THREE from 'three';

// Base class: a fixed-size pool of CPU-integrated particles rendered as a single
// THREE.Points. Subclasses override `applyForces()` to give each spell its own
// motion (turbulence, gravity, drag, directional thrust, …) and call `emit()`
// to spawn from the wand tip.
//
// Pool is a ring buffer: spawning past capacity recycles the oldest particle.
export class ParticleEffect {
  constructor(sceneManager, max, material) {
    this.sm = sceneManager;
    this.max = max;
    this.cursor = 0;
    this.elapsed = 0;
    this._aliveLastFrame = false;

    // Geometry-backed attributes.
    this.positions = new Float32Array(max * 3);
    this.aSize = new Float32Array(max);
    this.aLife = new Float32Array(max);

    // CPU-only state.
    this.vel = new Float32Array(max * 3);
    this.age = new Float32Array(max);
    this.lifetime = new Float32Array(max); // 0 = dead slot
    this.baseSize = new Float32Array(max);

    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.positions, 3);
    this.sizeAttr = new THREE.BufferAttribute(this.aSize, 1);
    this.lifeAttr = new THREE.BufferAttribute(this.aLife, 1);
    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('aSize', this.sizeAttr);
    geo.setAttribute('aLife', this.lifeAttr);
    geo.setDrawRange(0, max);

    this.geometry = geo;
    this.material = material;
    this.points = new THREE.Points(geo, material);
    this.points.frustumCulled = false;
    sceneManager.add(this.points);
  }

  // Spawn `count` particles. initFn(idx, effect) sets pos/vel/life/size for each.
  emit(count, initFn) {
    for (let c = 0; c < count; c++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % this.max;
      this.age[i] = 0;
      this.lifetime[i] = 1; // default; initFn usually overrides
      this.baseSize[i] = 1;
      initFn(i, this);
    }
  }

  // --- setters for use inside initFn ---
  setPos(i, x, y, z) {
    const o = i * 3;
    this.positions[o] = x;
    this.positions[o + 1] = y;
    this.positions[o + 2] = z;
  }
  setVel(i, x, y, z) {
    const o = i * 3;
    this.vel[o] = x;
    this.vel[o + 1] = y;
    this.vel[o + 2] = z;
  }
  setLife(i, t) { this.lifetime[i] = t; }
  setSize(i, s) { this.baseSize[i] = s; }

  // Override in subclass to mutate this.vel[*] for particle i. Default: no force.
  applyForces(/* i, dt */) {}

  update(dt) {
    this.elapsed += dt;
    let anyAlive = false;

    for (let i = 0; i < this.max; i++) {
      const life = this.lifetime[i];
      if (life <= 0) continue;

      let a = this.age[i] + dt;
      if (a >= life) {
        // just died
        this.lifetime[i] = 0;
        this.aSize[i] = 0;
        this.aLife[i] = 1;
        continue;
      }
      this.age[i] = a;
      anyAlive = true;

      this.applyForces(i, dt);

      const o = i * 3;
      this.positions[o] += this.vel[o] * dt;
      this.positions[o + 1] += this.vel[o + 1] * dt;
      this.positions[o + 2] += this.vel[o + 2] * dt;

      const t = a / life; // 0..1
      this.aLife[i] = t;
      this.aSize[i] = this.baseSize[i];
    }

    // Only re-upload buffers when something is (or just was) moving.
    if (anyAlive || this._aliveLastFrame) {
      this.posAttr.needsUpdate = true;
      this.sizeAttr.needsUpdate = true;
      this.lifeAttr.needsUpdate = true;
    }
    this._aliveLastFrame = anyAlive;
  }

  dispose() {
    this.sm.remove(this.points);
    this.geometry.dispose();
    this.material.dispose();
  }
}

// --- shared helpers ---------------------------------------------------------

// Cheap pseudo-random in [-1,1] from an integer seed and a salt; deterministic
// per particle so turbulence is coherent frame-to-frame.
export function hashNoise(seed, salt) {
  const x = Math.sin(seed * 12.9898 + salt * 78.233) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

// Build an orthonormal basis (right, up) around a forward direction.
export function basisFromForward(forward, right, up) {
  const ref = Math.abs(forward.y) > 0.95 ? UP_X : UP_Y;
  right.crossVectors(forward, ref).normalize();
  up.crossVectors(right, forward).normalize();
}
const UP_Y = new THREE.Vector3(0, 1, 0);
const UP_X = new THREE.Vector3(1, 0, 0);
