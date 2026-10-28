// WebGL2 anisotropic Gaussian splatting renderer.
//
// One instanced quad per Gaussian. The vertex shader builds the 3D covariance
// from (rotation, scale), projects it to 2D with the perspective Jacobian, and
// sizes the quad to 3 sigma along the principal axes. The fragment shader is a
// plain anisotropic falloff.
//
// Gaussians are depth-sorted on the CPU each frame (counting sort, O(n)) and the
// instance buffer is rebuilt in sorted order, because correct alpha compositing
// needs back-to-front traversal. If you outgrow this, move the sort to a GPU
// compute pass and pull attributes from textures instead of instance buffers.

const VERT = `#version 300 es
precision highp float;

layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aScale;
layout(location = 2) in vec4 aQuat;
layout(location = 3) in vec3 aColor;
layout(location = 4) in float aOpacity;
layout(location = 5) in vec2 aCorner;

uniform mat4 uModelView;
uniform mat4 uProj;
uniform vec2 uViewport;
uniform float uFocal;

out vec3 vColor;
out float vAlpha;
out vec2 vSigma;

mat3 quatToMat3(vec4 q) {
  float x = q.x, y = q.y, z = q.z, w = q.w;
  return mat3(
    1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y + z * w), 2.0 * (x * z - y * w),
    2.0 * (x * y - z * w), 1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z + x * w),
    2.0 * (x * z + y * w), 2.0 * (y * z - x * w), 1.0 - 2.0 * (x * x + y * y)
  );
}

void main() {
  vec4 tc = uModelView * vec4(aPos, 1.0);
  float z = -tc.z;
  if (z < 0.04) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }

  mat3 R = quatToMat3(aQuat);
  mat3 S = mat3(aScale.x, 0.0, 0.0, 0.0, aScale.y, 0.0, 0.0, 0.0, aScale.z);
  mat3 M = R * S;
  mat3 W = mat3(uModelView);
  mat3 T = W * M * transpose(M) * transpose(W);

  float inv = 1.0 / z;
  mat3 J = mat3(
    uFocal * inv, 0.0, 0.0,
    0.0, uFocal * inv, 0.0,
    -uFocal * tc.x * inv * inv, -uFocal * tc.y * inv * inv, 0.0
  );
  mat3 cov = J * T * transpose(J);

  float a = cov[0][0] + 0.3;
  float b = cov[1][0];
  float c = cov[1][1] + 0.3;

  float mid = 0.5 * (a + c);
  float disc = sqrt(max(0.0, 0.25 * (a - c) * (a - c) + b * b));
  float l1 = mid + disc;
  float l2 = max(mid - disc, 0.0);

  vec2 dir = (abs(b) < 1e-7) ? vec2(1.0, 0.0) : normalize(vec2(b, l1 - a));
  vec2 perp = vec2(-dir.y, dir.x);

  vec2 offset = dir * (3.0 * sqrt(max(l1, 1e-6))) * aCorner.x
              + perp * (3.0 * sqrt(max(l2, 1e-6))) * aCorner.y;

  vec4 clip = uProj * vec4(tc.xyz, 1.0);
  clip.xy += offset * (2.0 / uViewport) * clip.w;
  gl_Position = clip;

  vColor = aColor;
  vAlpha = aOpacity;
  vSigma = aCorner * 3.0;
}`;

const FRAG = `#version 300 es
precision highp float;
in vec3 vColor;
in float vAlpha;
in vec2 vSigma;
out vec4 outColor;

void main() {
  float r2 = dot(vSigma, vSigma);
  float a = vAlpha * exp(-0.5 * r2);
  if (a < 0.004) discard;
  // Slightly filmic, then sRGB-ish. Keeps the palette from going chalky.
  vec3 c = vColor / (1.0 + vColor);
  c = pow(c, vec3(0.4545));
  outColor = vec4(c, a);
}`;

// ---- small mat4 helpers (column-major) ------------------------------------
export const mat4 = {
  identity: () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
  perspective(out, fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2);
    out.fill(0);
    out[0] = f / aspect;
    out[5] = f;
    out[10] = (far + near) / (near - far);
    out[11] = -1;
    out[14] = (2 * far * near) / (near - far);
    return out;
  },
  lookAt(out, eye, target, up) {
    let zx = eye[0] - target[0], zy = eye[1] - target[1], zz = eye[2] - target[2];
    let l = Math.hypot(zx, zy, zz) || 1; zx /= l; zy /= l; zz /= l;
    let xx = up[1] * zz - up[2] * zy;
    let xy = up[2] * zx - up[0] * zz;
    let xz = up[0] * zy - up[1] * zx;
    l = Math.hypot(xx, xy, xz) || 1; xx /= l; xy /= l; xz /= l;
    const yx = zy * xz - zz * xy;
    const yy = zz * xx - zx * xz;
    const yz = zx * xy - zy * xx;
    out[0] = xx; out[1] = yx; out[2] = zx; out[3] = 0;
    out[4] = xy; out[5] = yy; out[6] = zy; out[7] = 0;
    out[8] = xz; out[9] = yz; out[10] = zz; out[11] = 0;
    out[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
    out[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
    out[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
    out[15] = 1;
    return out;
  },
  multiply(out, a, b) {
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1]
          + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
      }
    }
    return out;
  },
  // Model matrix: yaw/pitch/roll about the origin, then translate.
  headPose(out, yaw, pitch, roll, tx, ty, tz) {
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const cr = Math.cos(roll), sr = Math.sin(roll);
    // R = Ry * Rx * Rz
    const r00 = cy * cr + sy * sp * sr;
    const r01 = -cy * sr + sy * sp * cr;
    const r02 = sy * cp;
    const r10 = cp * sr;
    const r11 = cp * cr;
    const r12 = -sp;
    const r20 = -sy * cr + cy * sp * sr;
    const r21 = sy * sr + cy * sp * cr;
    const r22 = cy * cp;
    out[0] = r00; out[1] = r10; out[2] = r20; out[3] = 0;
    out[4] = r01; out[5] = r11; out[6] = r21; out[7] = 0;
    out[8] = r02; out[9] = r12; out[10] = r22; out[11] = 0;
    out[12] = tx; out[13] = ty; out[14] = tz; out[15] = 1;
    return out;
  },
};

const STRIDE = 14; // pos3 + scale3 + quat4 + color3 + opacity1
const BUCKETS = 1 << 16;

export class SplatRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      alpha: false, antialias: false, depth: false, stencil: false,
      powerPreference: 'high-performance', preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('WebGL2 is required');
    this.gl = gl;
    this.avatar = null;
    this.count = 0;

    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        throw new Error(gl.getShaderInfoLog(s) || 'shader compile failed');
      }
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(prog) || 'link failed');
    }
    this.prog = prog;
    gl.useProgram(prog);

    this.uModelView = gl.getUniformLocation(prog, 'uModelView');
    this.uProj = gl.getUniformLocation(prog, 'uProj');
    this.uViewport = gl.getUniformLocation(prog, 'uViewport');
    this.uFocal = gl.getUniformLocation(prog, 'uFocal');

    // quad
    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(5);
    gl.vertexAttribPointer(5, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(5, 0);

    this.inst = gl.createBuffer();
    this.data = new Float32Array(0);
    this.modelView = mat4.identity();
    this.proj = mat4.identity();
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0.055, 0.06, 0.075, 1);
  }

  setAvatar(avatar) {
    const gl = this.gl;
    this.avatar = avatar;
    this.count = avatar.n;
    const n = avatar.n;

    this.data = new Float32Array(n * STRIDE);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.inst);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);

    const stride = STRIDE * 4;
    const attr = (loc, size, offset) => {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset);
      gl.vertexAttribDivisor(loc, 1);
    };
    attr(0, 3, 0);
    attr(1, 3, 12);
    attr(2, 4, 24);
    attr(3, 3, 40);
    attr(4, 1, 52);

    // scratch for sorting
    this.depth = new Float32Array(n);
    this.bucket = new Uint16Array(n);
    this.order = new Int32Array(n);
    this.counts = new Int32Array(BUCKETS);
    this.starts = new Int32Array(BUCKETS);
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.gl.viewport(0, 0, w, h);
  }

  // positions: Float32Array(n*3) already deformed
  draw(positions, modelMatrix, camera) {
    const gl = this.gl;
    const av = this.avatar;
    if (!av) return { visible: 0, ms: 0 };
    const t0 = performance.now();
    const n = av.n;

    this.resize();
    const w = this.canvas.width;
    const h = this.canvas.height;
    const aspect = w / h;
    const focal = (0.5 * h) / Math.tan(camera.fov / 2);

    mat4.perspective(this.proj, camera.fov, aspect, 0.02, 20);
    const eye = [
      Math.sin(camera.yaw) * Math.cos(camera.pitch) * camera.dist,
      Math.sin(camera.pitch) * camera.dist + camera.targetY,
      Math.cos(camera.yaw) * Math.cos(camera.pitch) * camera.dist,
    ];
    const view = mat4.lookAt(new Float32Array(16), eye, [0, camera.targetY, 0], [0, 1, 0]);
    mat4.multiply(this.modelView, view, modelMatrix);

    const mv = this.modelView;
    // Row 2 of the column-major model-view matrix = camera-space z.
    const m2 = mv[2], m6 = mv[6], m10 = mv[10], m14 = mv[14];

    // --- depth per gaussian, then counting sort back-to-front ---
    const depth = this.depth;
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < n; i++) {
      const d = m2 * positions[i * 3] + m6 * positions[i * 3 + 1]
        + m10 * positions[i * 3 + 2] + m14;
      depth[i] = d;
      if (d < min) min = d;
      if (d > max) max = d;
    }
    const span = max - min || 1;
    const scale = (BUCKETS - 1) / span;
    const counts = this.counts;
    counts.fill(0);
    for (let i = 0; i < n; i++) {
      const b = ((depth[i] - min) * scale) | 0;
      this.bucket[i] = b;
      counts[b]++;
    }
    let acc = 0;
    const starts = this.starts;
    for (let b = 0; b < BUCKETS; b++) { starts[b] = acc; acc += counts[b]; }
    const order = this.order;
    for (let i = 0; i < n; i++) order[starts[this.bucket[i]]++] = i;

    // --- rebuild the interleaved instance buffer in sorted order ---
    const data = this.data;
    let k = 0;
    const near = 0.04;
    for (let s = 0; s < n; s++) {
      const i = order[s];
      if (depth[i] > -near) continue; // camera looks down -z
      const o = k * STRIDE;
      data[o] = positions[i * 3];
      data[o + 1] = positions[i * 3 + 1];
      data[o + 2] = positions[i * 3 + 2];
      data[o + 3] = av.scales[i * 3];
      data[o + 4] = av.scales[i * 3 + 1];
      data[o + 5] = av.scales[i * 3 + 2];
      data[o + 6] = av.quats[i * 4];
      data[o + 7] = av.quats[i * 4 + 1];
      data[o + 8] = av.quats[i * 4 + 2];
      data[o + 9] = av.quats[i * 4 + 3];
      data[o + 10] = av.colors[i * 3];
      data[o + 11] = av.colors[i * 3 + 1];
      data[o + 12] = av.colors[i * 3 + 2];
      data[o + 13] = av.opacity[i];
      k++;
    }

    gl.useProgram(this.prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.inst);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, k * STRIDE);
    gl.uniformMatrix4fv(this.uModelView, false, mv);
    gl.uniformMatrix4fv(this.uProj, false, this.proj);
    gl.uniform2f(this.uViewport, w, h);
    gl.uniform1f(this.uFocal, focal);

    gl.clear(gl.COLOR_BUFFER_BIT);
    if (k > 0) gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, k);
    return { visible: k, ms: performance.now() - t0 };
  }
}
