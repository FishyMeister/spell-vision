import * as THREE from 'three';
import { ParticleEffect } from '../ParticleEffect.js';
import { createParticleMaterial, createAdditiveMeshMaterial } from '../materials.js';
import { PARTICLES } from '../../config.js';

// LIGHT: not a projectile — a steady, soft white-gold orb that sits at the wand
// tip with a real point light and lazy floating motes. Toggles on/off.
export class Lumos extends ParticleEffect {
  constructor(sceneManager) {
    super(
      sceneManager,
      PARTICLES.lumos,
      createParticleMaterial({
        colorHot: '#fff6df',
        colorMid: '#ffd98a',
        colorCool: '#7a5a22',
        sizeScale: 1.0,
        softness: 2.0,
        fadeIn: 0.25,
      })
    );

    this.active = false;
    this.origin = new THREE.Vector3();
    this._sparkAccum = 0;
    this._pulse = 0;

    // The orb: a bright additive core.
    this.orb = new THREE.Mesh(
      new THREE.SphereGeometry(0.06, 20, 20),
      createAdditiveMeshMaterial('#fff3d0', 1.0)
    );
    this.orb.visible = false;
    sceneManager.add(this.orb);

    // Real light so the wand and hand area pick up the glow.
    this.light = new THREE.PointLight(0xffe6a8, 0, 4, 2);
    sceneManager.add(this.light);
  }

  toggle(tip) {
    this.active = !this.active;
    if (this.active && tip) this.origin.copy(tip);
    this.orb.visible = this.active;
  }

  off() {
    this.active = false;
    this.orb.visible = false;
  }

  follow(tip) {
    if (this.active && tip) this.origin.copy(tip);
  }

  update(dt) {
    if (this.active) {
      this._pulse += dt;
      const s = 1 + Math.sin(this._pulse * 4) * 0.12;
      this.orb.position.copy(this.origin);
      this.orb.scale.setScalar(s);
      this.light.position.copy(this.origin);
      this.light.intensity = 2.4 + Math.sin(this._pulse * 4) * 0.4;

      // Lazy sparkles drifting out of the orb.
      this._sparkAccum += 40 * dt;
      const n = Math.floor(this._sparkAccum);
      this._sparkAccum -= n;
      this.emit(n, (i, e) => {
        const dirx = (Math.random() * 2 - 1);
        const diry = (Math.random() * 2 - 1);
        const dirz = (Math.random() * 2 - 1);
        e.setPos(
          i,
          this.origin.x + dirx * 0.05,
          this.origin.y + diry * 0.05,
          this.origin.z + dirz * 0.05
        );
        e.setVel(i, dirx * 0.25, diry * 0.25 + 0.15, dirz * 0.25);
        e.setLife(i, 0.8 + Math.random() * 0.8);
        e.setSize(i, 0.06 + Math.random() * 0.1);
      });
    } else {
      this.light.intensity = Math.max(0, this.light.intensity - dt * 8);
    }
    super.update(dt);
  }

  applyForces(i, dt) {
    // Gentle damping + faint buoyancy so motes hang and rise slightly.
    const o = i * 3;
    this.vel[o + 1] += 0.2 * dt;
    const d = 1 - 1.2 * dt;
    this.vel[o] *= d;
    this.vel[o + 1] *= d;
    this.vel[o + 2] *= d;
  }
}
