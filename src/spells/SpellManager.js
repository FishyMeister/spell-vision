import { Incendio } from './effects/Incendio.js';
import { Force } from './effects/Force.js';
import { Lumos } from './effects/Lumos.js';
import { Diffindo } from './effects/Diffindo.js';

// Owns all spell effects, routes a recognized spell to the right one, and keeps
// continuous effects (fire emission, the Lumos orb) glued to the moving wand.
export class SpellManager {
  constructor(sceneManager) {
    this.incendio = new Incendio(sceneManager);
    this.force = new Force(sceneManager);
    this.lumos = new Lumos(sceneManager);
    this.diffindo = new Diffindo(sceneManager);

    this.effects = [this.incendio, this.force, this.lumos, this.diffindo];
  }

  // spell = entry from spellConfig.SPELLS. Returns true if anything fired.
  cast(spell, wand) {
    const tip = wand.getTip();
    const forward = wand.getForward();

    switch (spell.type) {
      case 'fire':
        this.incendio.trigger(tip, forward);
        return true;
      case 'force':
        this.force.trigger(tip, forward);
        return true;
      case 'slash':
        this.diffindo.trigger(tip, forward);
        return true;
      case 'light':
        this.lumos.toggle(tip);
        return true;
      case 'lightoff':
        this.lumos.off();
        return true;
      default:
        return false;
    }
  }

  update(dt, wand) {
    // Keep sustained effects following the live wand tip.
    if (wand && wand.held) {
      const tip = wand.getTip();
      const forward = wand.getForward();
      if (this.incendio.emitTimer > 0) this.incendio.setOrigin(tip, forward);
      this.lumos.follow(tip);
    }

    for (const e of this.effects) e.update(dt);
  }
}
