// Procedural life. Rendering a driven face is only half the job: without blinks,
// saccades, breathing and a bit of sway the avatar reads as a mannequin within
// about five seconds, no matter how good the lip sync is.

const TAU = Math.PI * 2;
const rand = (a, b) => a + Math.random() * (b - a);
const ease = (t) => t * t * (3 - 2 * t);

export class Idle {
  constructor() {
    this.t = 0;
    this.blink = 0;
    this.nextBlink = rand(1.2, 3.5);
    this.blinkT = -1;
    this.blinkDur = 0.13;

    this.gaze = [0, 0];
    this.gazeTarget = [0, 0];
    this.nextSaccade = rand(0.4, 1.4);

    this.swayYaw = 0;
    this.swayPitch = 0;
    this.breath = 0;
    this.brow = 0;

    // speaking increases gesture amplitude slightly
    this.energy = 0;
  }

  update(dt, speechEnergy) {
    this.t += dt;
    this.energy += (speechEnergy - this.energy) * Math.min(1, dt * 4);

    // --- blink -----------------------------------------------------------
    if (this.blinkT < 0) {
      this.nextBlink -= dt;
      if (this.nextBlink <= 0) {
        this.blinkT = 0;
        this.nextBlink = rand(2.0, 6.0) * (this.energy > 0.3 ? 0.8 : 1);
      }
    }
    if (this.blinkT >= 0) {
      this.blinkT += dt;
      const p = this.blinkT / this.blinkDur;
      if (p >= 1) { this.blinkT = -1; this.blink = 0; }
      else this.blink = p < 0.4 ? ease(p / 0.4) : 1 - ease((p - 0.4) / 0.6);
    }

    // --- saccades --------------------------------------------------------
    this.nextSaccade -= dt;
    if (this.nextSaccade <= 0) {
      this.nextSaccade = rand(0.5, 2.2);
      // bias towards re-centring on the viewer
      this.gazeTarget = [
        Math.random() < 0.45 ? rand(-0.15, 0.15) : rand(-1, 1),
        Math.random() < 0.45 ? rand(-0.15, 0.15) : rand(-0.7, 0.7),
      ];
    }
    const k = Math.min(1, dt * 18);
    this.gaze[0] += (this.gazeTarget[0] - this.gaze[0]) * k;
    this.gaze[1] += (this.gazeTarget[1] - this.gaze[1]) * k;

    // --- sway + breathing ------------------------------------------------
    const amp = 0.35 + this.energy * 0.65;
    this.swayYaw = Math.sin(this.t * 0.37) * 0.055 * amp + Math.sin(this.t * 0.11) * 0.02;
    this.swayPitch = Math.sin(this.t * 0.29 + 1.3) * 0.032 * amp;
    this.breath = Math.sin(this.t * 0.26 * TAU * 0.6);

    // --- brow micro-motion ----------------------------------------------
    this.brow = 0.05 + 0.05 * Math.sin(this.t * 0.7) + this.energy * 0.12;
  }

  // Channels that idle owns. Everything else comes from the speech stream.
  channels() {
    return {
      eyeBlink_L: this.blink,
      eyeBlink_R: this.blink,
      eyeLookX: this.gaze[0] * 0.55,
      eyeLookY: this.gaze[1] * 0.45,
      browInnerUp: this.brow * 0.5,
      cheekPuff: 0,
    };
  }

  pose() {
    return {
      yaw: this.swayYaw,
      pitch: this.swayPitch,
      roll: Math.sin(this.t * 0.23) * 0.012,
      y: this.breath * 0.0022,
    };
  }
}
