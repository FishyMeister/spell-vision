// 2D debug overlay: draws the smoothed hand skeleton over the scene.
// Toggle with the D key. Coordinates are the mirrored normalized landmarks,
// so dots sit on the on-screen hand.

const CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],          // thumb
  [0, 5], [5, 6], [6, 7], [7, 8],          // index
  [5, 9], [9, 10], [10, 11], [11, 12],     // middle
  [9, 13], [13, 14], [14, 15], [15, 16],   // ring
  [13, 17], [17, 18], [18, 19], [19, 20],  // pinky
  [0, 17],                                  // palm base
];

export class LandmarkOverlay {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.visible = false;
    this._resize();
    window.addEventListener('resize', () => this._resize());
  }

  _resize() {
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
  }

  toggle() {
    this.visible = !this.visible;
    this.canvas.classList.toggle('visible', this.visible);
  }

  draw(hand) {
    if (!this.visible) return;
    const { ctx, canvas } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!hand) return;

    const W = canvas.width;
    const H = canvas.height;

    ctx.strokeStyle = 'rgba(127, 214, 255, 0.7)';
    ctx.lineWidth = 2;
    for (const [a, b] of CONNECTIONS) {
      ctx.beginPath();
      ctx.moveTo(hand[a].x * W, hand[a].y * H);
      ctx.lineTo(hand[b].x * W, hand[b].y * H);
      ctx.stroke();
    }

    for (let i = 0; i < hand.length; i++) {
      const tip = i === 4 || i === 8;
      ctx.beginPath();
      ctx.fillStyle = tip ? '#ffe9a8' : '#a98bff';
      ctx.arc(hand[i].x * W, hand[i].y * H, tip ? 7 : 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
