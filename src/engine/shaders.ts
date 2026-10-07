/**
 * GLSL for the ocean's GPU passes. All passes are GLSL ES 3.00 RawShaderMaterials drawn as one
 * full-screen triangle into float render targets.
 *
 * Field layout, shared by the FFT cascades and the swell window so the water shader reads both alike:
 *   texture 0: (Dx, Dy, Dz, dη/dx)   horizontal and vertical displacement, slope along x
 *   texture 1: (dη/dz, dDx/dx, dDz/dz, dDx/dz)   slope along z and the Jacobian terms
 * World axes: x east, y up, z south.
 */

export const FULLSCREEN_VERTEX = /* glsl */ `
in vec3 position;
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const HEADER = /* glsl */ `
precision highp float;
precision highp int;
const float PI = 3.141592653589793;
vec2 cmul(vec2 a, vec2 b) { return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
`;

/**
 * Evolve h0 to time t and build the four packed spectra, two real fields per complex channel pair
 * (the inverse transform of A + iB is a + ib when a and b are real).
 */
export const EVOLVE_FRAGMENT = /* glsl */ `${HEADER}
uniform sampler2D h0;
uniform float size;
uniform float patchLength;
uniform float time;
layout(location = 0) out vec4 out0;
layout(location = 1) out vec4 out1;
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  vec4 s = texelFetch(h0, px, 0);
  vec2 m = vec2(px);
  m = mix(m, m - size, step(size * 0.5, m));
  vec2 k = m * (2.0 * PI / patchLength);
  float kl = length(k);
  float omega = sqrt(9.81 * kl);
  float c = cos(omega * time);
  float sn = sin(omega * time);
  // h = h0 e^{-iwt} + conj(h0(-k)) e^{iwt}
  vec2 h = cmul(s.xy, vec2(c, -sn)) + cmul(s.zw, vec2(c, sn));
  vec2 ih = vec2(-h.y, h.x);
  vec2 dir = kl > 0.0 ? k / kl : vec2(0.0);
  vec2 dx = ih * dir.x;
  vec2 dz = ih * dir.y;
  vec2 sx = ih * k.x;
  vec2 sz = ih * k.y;
  float invk = kl > 0.0 ? 1.0 / kl : 0.0;
  vec2 dxx = -h * k.x * k.x * invk;
  vec2 dzz = -h * k.y * k.y * invk;
  vec2 dxz = -h * k.x * k.y * invk;
  // A + iB with complex A, B: (A.re - B.im, A.im + B.re)
  out0 = vec4(dx + vec2(-h.y, h.x), dz + vec2(-sx.y, sx.x));
  out1 = vec4(sz + vec2(-dxx.y, dxx.x), dzz + vec2(-dxz.y, dxz.x));
}
`;

/** One Stockham pass, horizontal or vertical, over both textures. Transcribes fft.ts `stockhamPass`. */
export const FFT_FRAGMENT = /* glsl */ `${HEADER}
uniform sampler2D src0;
uniform sampler2D src1;
uniform float size;
uniform float sub;
uniform bool horizontal;
layout(location = 0) out vec4 out0;
layout(location = 1) out vec4 out1;
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  float index = float(horizontal ? px.x : px.y);
  float half_ = sub * 0.5;
  float even = floor(index / sub) * half_ + mod(index, half_);
  float odd = even + size * 0.5;
  ivec2 pe = horizontal ? ivec2(int(even), px.y) : ivec2(px.x, int(even));
  ivec2 po = horizontal ? ivec2(int(odd), px.y) : ivec2(px.x, int(odd));
  float angle = 2.0 * PI * index / sub;
  vec2 w = vec2(cos(angle), sin(angle));
  vec4 e0 = texelFetch(src0, pe, 0);
  vec4 o0 = texelFetch(src0, po, 0);
  vec4 e1 = texelFetch(src1, pe, 0);
  vec4 o1 = texelFetch(src1, po, 0);
  out0 = vec4(e0.xy + cmul(w, o0.xy), e0.zw + cmul(w, o0.zw));
  out1 = vec4(e1.xy + cmul(w, o1.xy), e1.zw + cmul(w, o1.zw));
}
`;

/** Copy the transformed fields into the filterable, mipmapped textures the water samples. */
export const ASSEMBLE_FRAGMENT = /* glsl */ `${HEADER}
uniform sampler2D src0;
uniform sampler2D src1;
uniform float choppiness;
layout(location = 0) out vec4 out0;
layout(location = 1) out vec4 out1;
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  vec4 a = texelFetch(src0, px, 0);
  vec4 b = texelFetch(src1, px, 0);
  out0 = vec4(a.x * choppiness, a.y, a.z * choppiness, a.w);
  out1 = vec4(b.x, b.y * choppiness, b.z * choppiness, b.w * choppiness);
}
`;

/**
 * The phase-resolved swell (one record, or two across a fade), summed directly (waves.ts \`surfaceAt\`) over a square window that follows
 * the camera. Component i is two texels of \`waves\`: (kx, kz, omega, orbit) and (re, im, 0, 0), with
 * (kx, kz) the wave vector on the world axes and the buoy at the origin.
 */
export const SWELL_FRAGMENT = /* glsl */ `${HEADER}
uniform sampler2D waves;
uniform int count;
/** Components [0, countA) belong to the record fading in (weightA), the rest to the one fading out. */
uniform int countA;
uniform float weightA;
uniform float weightB;
uniform float time;
uniform vec2 origin;
uniform float texel;
layout(location = 0) out vec4 out0;
layout(location = 1) out vec4 out1;
void main() {
  vec2 p = origin + (gl_FragCoord.xy - 0.5) * texel;
  vec3 d = vec3(0.0);
  vec2 slope = vec2(0.0);
  vec3 jac = vec3(0.0);
  for (int i = 0; i < count; i++) {
    vec4 a = texelFetch(waves, ivec2(2 * i, 0), 0);
    vec2 z = texelFetch(waves, ivec2(2 * i + 1, 0), 0).xy * (i < countA ? weightA : weightB);
    float phase = a.z * time - dot(a.xy, p);
    vec2 e = vec2(cos(phase), sin(phase));
    float re = z.x * e.x - z.y * e.y;
    float im = z.x * e.y + z.y * e.x;
    float k = length(a.xy);
    vec2 u = a.xy / k;
    d += vec3(u.x * a.w * im, re, u.y * a.w * im);
    slope += a.xy * im;
    jac += vec3(-u.x * a.w * a.x, -u.y * a.w * a.y, -u.x * a.w * a.y) * re;
  }
  out0 = vec4(d, slope.x);
  out1 = vec4(slope.y, jac);
}
`;
