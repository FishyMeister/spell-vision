import * as THREE from 'three';
import { ParticleEffect, basisFromForward } from '../ParticleEffect.js';
import { createParticleMaterial, createAdditiveMeshMaterial } from '../materials.js';
import { PARTICLES } from '../../config.js';

const UP_Y = new THREE.Vector3(0, 1, 0);

// SLASH: a fast, sharp, directional cut. A thin bright blade shoots along the
// wand while a tight, high-velocity ribbon of cyan particles streaks with it.
// Almost no spread, very short life → reads as a clean slice, not a spray.
export class Diffindo extends ParticleEffect {
  constructor(sceneManager) {
    super(
      sceneManager,
      PARTICLES.diffindo,
      createParticleMaterial({
        colorHot: '#dafcff',
        colorMid: '#1ad6ff',
        colorCool: '#024a8a',
        sizeScale: 1.0,
        softness: 1.9,
        fadeIn: 0.03,
      })
    );

    // The blade: a thin elongated additive quad.
    this.blade = new THREE.Mesh(
      new THREE.PlaneGeometry(0.05, 1, 1, 1),
      createAdditiveMeshMaterial('#9ff6ff', 1.0)
    );
    this.blade.visible = false;
    sceneManager.add(this.blade);

    this.bladeTime = 0;
    this.bladeDur = 0.22;
    this.bladeLen = 1.0;

    this._right = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._dir = new THREE.Vector3();
  }

  trigger(tip, forward) {
    const dir = this._dir.copy(forward).normalize();
    basisFromForward(dir, this._right, this._up);

    // Orient blade so its long (+Y) axis runs along travel; place its base at
    // the tip and extend outward.
    this._q.setFromUnitVectors(UP_Y, dir);
    this.blade.quaternion.copy(this._q);
    this.blade.position.copy(tip).addScaledVector(dir, this.bladeLen * 0.5);
    this.blade.visible = true;
    this.bladeTime = this.bladeDur;

    // Tight ribbon of fast particles streaking along the cut.
    const count = Math.min(900, this.max);
    this.emit(count, (i, e) => {
      const along = Math.random();              // distributed down the blade
      const jr = (Math.random() * 2 - 1) * 0.04; // tiny lateral jitter
      const ju = (Math.random() * 2 - 1) * 0.04;
      e.setPos(
        i,
        tip.x + dir.x * along * this.bladeLen + this._right.x * jr + this._up.x * ju,
        tip.y + dir.y * along * this.bladeLen + this._right.y * jr + this._up.y * ju,
        tip.z + dir.z * along * this.bladeLen + this._right.z * jr + this._up.z * ju
      );
      const speed = 7.0 + Math.random() * 5.0;
      e.setVel(i, dir.x * speed, dir.y * speed, dir.z * speed);
      e.setLife(i, 0.14 + Math.random() * 0.18);
      e.setSize(i, 0.08 + Math.random() * 0.12);
    });
  }

  applyForces(i, dt) {
    // Light drag; mostly ballistic so the slice stays sharp and directional.
    const o = i * 3;
    const d = 1 - 1.0 * dt;
    this.vel[o] *= d;
    this.vel[o + 1] *= d;
    this.vel[o + 2] *= d;
  }

  update(dt) {
    if (this.bladeTime > 0) {
      this.bladeTime -= dt;
      const t = 1 - this.bladeTime / this.bladeDur; // 0→1
      // grow fast, then fade
      const grow = Math.min(1, t * 3);
      this.blade.scale.set(1, grow, 1);
      this.blade.material.opacity = Math.max(0, 1 - t) * 0.95;
      if (this.bladeTime <= 0) this.blade.visible = false;
    }
    super.update(dt);
  }
}
