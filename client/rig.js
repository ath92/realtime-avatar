// Blendshape-driven deformation of the Gaussian rig, on the CPU.
//
// Each Gaussian stores a rig weight per channel and the displacement it receives
// at weight 1. The deformed position is  p + sum_b(w_b * v_b * d_b)  — linear
// blend shapes, applied per Gaussian rather than per vertex.
//
// 25k gaussians x ~8 active channels is a few hundred thousand multiply-adds per
// frame, comfortably inside a millisecond. If the asset grows past ~100k, move
// this to a vertex shader with a blendshape delta texture.

export class Rig {
  constructor(avatar) {
    this.av = avatar;
    this.n = avatar.n;
    this.nb = avatar.nb;

    // Per-gaussian rig weights, straight from the asset.
    this.gw = avatar.weights;
    // Per-channel frame values, set every frame from the speech/idle streams.
    this.values = new Float32Array(avatar.nb);

    this.positions = new Float32Array(avatar.n * 3);
    this.index = new Map(avatar.names.map((name, i) => [name, i]));
    this.active = [];   // channel indices with a non-zero value this frame
  }

  indexOf(name) {
    return this.index.has(name) ? this.index.get(name) : -1;
  }

  // values: { channelName: weight } — unknown names are ignored.
  set(values) {
    this.values.fill(0);
    for (const name in values) {
      const i = this.index.get(name);
      if (i === undefined) continue;
      const v = values[name];
      if (!Number.isFinite(v)) continue;
      this.values[i] = v < 0 ? 0 : v > 1 ? 1 : v;
    }
    this.active.length = 0;
    for (let b = 0; b < this.nb; b++) {
      if (this.values[b] > 1e-4) this.active.push(b);
    }
  }

  update() {
    const { n, nb, positions, active, values, gw } = this;
    const base = this.av.positions;
    const deltas = this.av.deltas;

    if (active.length === 0) {
      positions.set(base);
      return positions;
    }

    for (let i = 0; i < n; i++) {
      const row = i * nb;
      let x = base[i * 3];
      let y = base[i * 3 + 1];
      let z = base[i * 3 + 2];
      for (let a = 0; a < active.length; a++) {
        const b = active[a];
        const w = gw[row + b];
        if (w === 0) continue;
        const amt = w * values[b];
        const o = (row + b) * 3;
        x += deltas[o] * amt;
        y += deltas[o + 1] * amt;
        z += deltas[o + 2] * amt;
      }
      positions[i * 3] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;
    }
    return positions;
  }
}
