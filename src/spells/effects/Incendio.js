import * as THREE from 'three';
import { ParticleEffect, hashNoise, basisFromForward } from '../ParticleEffect.js';
import { createParticleMaterial } from '../materials.js';
import { PARTICLES } from '../../config.js';

// FIRE: a sustained cone of buoyant, turbulent embers. White-hot at birth,
// cooling through orange to deep red. Rises and curls as it travels.
export class Incendio extends ParticleEffect {
  constructor(sceneManager) {
    super(
      sceneManager,
      PARTICLES.incendio,
      createParticleMaterial({
        colorHot: '#fff1c0',
        colorMid: '#ff6a1a',
        colorCool: '#7a0d02',
        sizeScale: 1.0,
        softness: 1.3,
        fadeIn: 0.08,
      })
    );

    this.emitTimer = 0;
    this.spawnRate = 3200; // particles/sec while casting
    this._accum = 0;

    this.origin = new THREE.Vector3();
    this.dir = new THREE.Vector3(0, 1, 0);
    this._right = new THREE.Vector3();
    this._up = new THREE.Vector3();
  }

  trigger(tip, forward) {
    this.emitTimer = 0.55;
    this.setOrigin(tip, forward);
  }

  setOrigin(tip, forward) {
    this.origin.copy(tip);
    this.dir.copy(forward).normalize();
  }

  update(dt) {
    if (this.emitTimer > 0) {
      this.emitTimer -= dt;
      basisFromForward(this.dir, this._right, this._up);
      this._accum += this.spawnRate * dt;
      const n = Math.floor(this._accum);
      this._accum -= n;
      this._spawnBatch(n);
    }
    super.update(dt);
  }

  _spawnBatch(n) {
    const spread = 0.32; // cone half-angle-ish
    this.emit(n, (i, e) => {
      const ox = (Math.random() * 2 - 1) * 0.02;
      const oy = (Math.random() * 2 - 1) * 0.02;
      const oz = (Math.random() * 2 - 1) * 0.02;
      e.setPos(
        i,
        this.origin.x + ox,
        this.origin.y + oy,
        this.origin.z + oz
      );

      // forward + random cone offset
      const rx = (Math.random() * 2 - 1) * spread;
      const ry = (Math.random() * 2 - 1) * spread;
      const vx = this.dir.x + this._right.x * rx + this._up.x * ry;
      const vy = this.dir.y + this._right.y * rx + this._up.y * ry;
      const vz = this.dir.z + this._right.z * rx + this._up.z * ry;
      const speed = 2.0 + Math.random() * 1.4;
      e.setVel(i, vx * speed, vy * speed + 0.4, vz * speed);

      e.setLife(i, 0.5 + Math.random() * 0.5);
      e.setSize(i, 0.22 + Math.random() * 0.22);
    });
  }

  applyForces(i, dt) {
    const o = i * 3;
    // buoyancy
    this.vel[o + 1] += 2.6 * dt;
    // curling turbulence
    const t = this.elapsed * 2.2;
    this.vel[o] += hashNoise(i, t) * 3.0 * dt;
    this.vel[o + 2] += hashNoise(i, t + 17.3) * 3.0 * dt;
    // drag
    const d = 1 - 1.4 * dt;
    this.vel[o] *= d;
    this.vel[o + 1] *= d;
    this.vel[o + 2] *= d;
  }
}
