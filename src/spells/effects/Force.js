import * as THREE from 'three';
import { ParticleEffect } from '../ParticleEffect.js';
import { createParticleMaterial, createAdditiveMeshMaterial } from '../materials.js';
import { PARTICLES } from '../../config.js';

// FORCE: a single hard concussive blast. A bright shockwave ring snaps outward
// (facing the camera so it always reads as a ring) while a sheet of blue-white
// particles is thrown radially with strong drag — a punch of kinetic energy.
export class Force extends ParticleEffect {
  constructor(sceneManager) {
    super(
      sceneManager,
      PARTICLES.force,
      createParticleMaterial({
        colorHot: '#eaf6ff',
        colorMid: '#5aa0ff',
        colorCool: '#0a1c66',
        sizeScale: 1.0,
        softness: 1.7,
        fadeIn: 0.04,
      })
    );

    // Shockwave ring mesh (reused). RingGeometry faces +Z by default, i.e. the
    // camera — we keep it that way so it expands as a visible ring on screen.
    this.ringGeo = new THREE.RingGeometry(0.5, 0.82, 56);
    this.ringMat = createAdditiveMeshMaterial('#bfe0ff', 1.0);
    this.ring = new THREE.Mesh(this.ringGeo, this.ringMat);
    this.ring.visible = false;
    sceneManager.add(this.ring);

    this.ringTime = 0;
    this.ringDur = 0.4;
  }

  trigger(tip, forward) {
    const dir = forward.clone().normalize();

    this.ring.position.copy(tip).addScaledVector(dir, 0.05);
    this.ring.visible = true;
    this.ringTime = this.ringDur;

    // Radial blast in the screen plane, biased forward along the wand.
    const count = Math.min(800, this.max);
    this.emit(count, (i, e) => {
      const ang = Math.random() * Math.PI * 2;
      const rad = Math.random();
      const rx = Math.cos(ang) * rad;
      const ry = Math.sin(ang) * rad;
      e.setPos(i, tip.x, tip.y, tip.z);

      const radialSpeed = 3.5 + Math.random() * 3.5;
      const fwdSpeed = 1.5 + Math.random() * 2.5;
      e.setVel(
        i,
        rx * radialSpeed + dir.x * fwdSpeed,
        ry * radialSpeed + dir.y * fwdSpeed,
        dir.z * fwdSpeed
      );
      e.setLife(i, 0.3 + Math.random() * 0.35);
      e.setSize(i, 0.14 + Math.random() * 0.16);
    });
  }

  applyForces(i, dt) {
    // Heavy drag → snappy deceleration, like air resistance after a punch.
    const o = i * 3;
    const d = 1 - 4.5 * dt;
    this.vel[o] *= d;
    this.vel[o + 1] *= d;
    this.vel[o + 2] *= d;
  }

  update(dt) {
    if (this.ringTime > 0) {
      this.ringTime -= dt;
      const t = 1 - this.ringTime / this.ringDur; // 0→1
      const scale = 0.2 + t * 2.0;
      this.ring.scale.setScalar(scale);
      this.ringMat.opacity = Math.max(0, 1 - t) * 0.9;
      if (this.ringTime <= 0) this.ring.visible = false;
    }
    super.update(dt);
  }
}
