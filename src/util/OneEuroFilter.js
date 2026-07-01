// One-Euro filter — adaptive low-pass that kills jitter when still but stays
// responsive on fast motion. Reference: Casiez et al., CHI 2012.
// We run one scalar filter per coordinate; a Vec3 wrapper filters x/y/z.

class LowPass {
  constructor() {
    this.hasLast = false;
    this.value = 0;
  }
  filter(x, alpha) {
    if (!this.hasLast) {
      this.hasLast = true;
      this.value = x;
      return x;
    }
    this.value = alpha * x + (1 - alpha) * this.value;
    return this.value;
  }
}

function alphaFor(cutoff, dt) {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

export class OneEuroFilter {
  constructor({ minCutoff = 1.0, beta = 0.0, dCutoff = 1.0 } = {}) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.x = new LowPass();
    this.dx = new LowPass();
    this.lastValue = 0;
    this.hasLast = false;
  }

  // dt in seconds.
  filter(value, dt) {
    if (dt <= 0) dt = 1 / 60;
    const dValue = this.hasLast ? (value - this.lastValue) / dt : 0;
    this.hasLast = true;
    this.lastValue = value;

    const edx = this.dx.filter(dValue, alphaFor(this.dCutoff, dt));
    const cutoff = this.minCutoff + this.beta * Math.abs(edx);
    return this.x.filter(value, alphaFor(cutoff, dt));
  }
}

// Convenience: filter a 3-component point (operates in-place on a {x,y,z}).
export class Vec3Filter {
  constructor(opts) {
    this.fx = new OneEuroFilter(opts);
    this.fy = new OneEuroFilter(opts);
    this.fz = new OneEuroFilter(opts);
  }
  filter(p, dt) {
    return {
      x: this.fx.filter(p.x, dt),
      y: this.fy.filter(p.y, dt),
      z: this.fz.filter(p.z, dt),
    };
  }
}
