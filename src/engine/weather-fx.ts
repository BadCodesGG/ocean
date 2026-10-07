import * as THREE from "three";

/**
 * What the weather does to the picture: rain on the lens, rain falling through the air, rings where it
 * lands on the sea, and lightning. The sky, haze and whitecaps are the water and dome shaders' own,
 * driven by the same conditions.
 */

/**
 * Rain on the camera's front glass, applied to the finished linear image before tone mapping. Three
 * layers of beads land, sit and dry out; a few larger drops gather and run down, leaving a trail of
 * droplets. Each drop is a small lens: it shows the scene flipped from a patch a little larger than
 * itself, so the sky ends up in its lower half; a thin rim darkens where light bends away, and the
 * bottom edge brightens where the flipped sky gathers.
 */
export const LensShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    time: { value: 0 },
    /** 0 to 1: how much rain is on the glass. */
    rain: { value: 0 },
    aspect: { value: 1 },
  },
  vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float time;
    uniform float rain;
    uniform float aspect;
    varying vec2 vUv;

    vec3 hash3(vec2 p) {
      vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
      q += dot(q, q.yxz + 33.33);
      return fract((q.xxy + q.yzz) * q.zyx);
    }

    /**
     * A drop at offset d (screen units, aspect-corrected) of radius r: (image offset, coverage, shade),
     * shade being the bright crescent along its lower edge (positive) less its thin dark rim (negative).
     */
    vec4 drop(vec2 d, float r, float presence) {
      float dist = length(d);
      float cover = (1.0 - smoothstep(r * 0.86, r, dist)) * presence;
      if (cover <= 0.0) return vec4(0.0);
      vec2 n = d / r;
      float edge = smoothstep(0.62, 0.95, length(n));
      float crescent = edge * smoothstep(0.2, 0.9, -n.y);
      float rim = edge * (1.0 - smoothstep(0.0, 0.5, -n.y)) * 0.8;
      // Magnifying toward the middle, as a plano-convex lens does.
      vec2 bend = -n * r * (1.2 + 0.8 * dot(n, n));
      return vec4(bend * cover, cover, (crescent - rim) * cover);
    }

    /** One layer of beads that land, sit and dry, one to a cell of 1/scale. */
    vec4 beads(vec2 p, float scale, float t, float density) {
      vec2 g = p * scale;
      vec2 id = floor(g);
      vec3 n = hash3(id);
      if (n.y > density) return vec4(0.0);
      float period = 5.0 + 9.0 * n.z;
      float age = fract(t / period + n.x);
      vec3 m = hash3(id + 7.31);
      vec2 centre = 0.5 + (m.xy - 0.5) * 0.55;
      // Drying shrinks a bead before it goes.
      float r = (0.1 + 0.2 * m.z) * (1.0 - smoothstep(0.6, 1.0, age));
      vec4 b = drop((fract(g) - centre) / scale, r / scale, smoothstep(0.0, 0.015, age));
      return b;
    }

    /** Larger drops that gather, then run down the glass in fits and starts, trailing droplets. */
    vec4 runs(vec2 p, float t, float density) {
      const float COLS = 7.0;
      float col = floor(p.x * COLS);
      vec3 n = hash3(vec2(col, 17.7));
      if (n.x > density) return vec4(0.0);
      float s = t * (0.045 + 0.07 * n.y) + n.z * 13.0;
      // Stick and slip: a run is slow, then quick, then slow.
      float k = fract(s);
      float y = 1.25 - 1.5 * (k + 0.06 * sin(k * 37.0 + n.x * 9.0));
      float x = (col + 0.5 + 0.28 * sin(y * 11.0 + n.y * 6.3)) / COLS;
      float r = 0.012 + 0.012 * n.y;
      vec2 d = vec2(p.x - x, (p.y - y) * 0.75);
      vec4 head = drop(d, r, 1.0);
      // The trail: droplets left in the run's path above it, drying behind.
      float above = p.y - y;
      float lane = (1.0 - smoothstep(r * 0.4, r * 0.9, abs(p.x - x))) * step(0.0, above) * (1.0 - smoothstep(0.0, 0.35, above));
      vec4 trail = beads(p + vec2(0.0, n.z), 70.0, t * 0.3, 0.9) * lane;
      return head + trail * (1.0 - head.z);
    }

    void main() {
      vec3 base = texture2D(tDiffuse, vUv).rgb;
      if (rain <= 0.001) {
        gl_FragColor = vec4(base, 1.0);
        return;
      }
      vec2 p = vec2(vUv.x * aspect, vUv.y);
      vec4 sum = beads(p, 6.0, time, rain * 0.35)
        + beads(p + 3.1, 11.0, time * 1.3, rain * 0.5)
        + beads(p + 7.7, 23.0, time * 1.7, rain * 0.4)
        + runs(p, time, rain * 0.9);
      float cover = min(sum.z, 1.0);
      vec2 offset = vec2(sum.x / aspect, sum.y);
      vec3 seen = texture2D(tDiffuse, clamp(vUv + offset, 0.001, 0.999)).rgb;
      // A wet glass softens the whole picture a little in heavy rain.
      vec2 px = vec2(1.5 / aspect, 1.5) / 900.0;
      vec3 soft = 0.25 * (texture2D(tDiffuse, vUv + px).rgb + texture2D(tDiffuse, vUv - px).rgb
        + texture2D(tDiffuse, vUv + vec2(px.x, -px.y)).rgb + texture2D(tDiffuse, vUv - vec2(px.x, -px.y)).rgb);
      vec3 around = mix(base, soft, smoothstep(0.3, 1.0, rain) * 0.7);
      float shade = clamp(sum.w, -1.0, 1.0);
      vec3 inDrop = seen * (1.0 - 0.45 * max(-shade, 0.0));
      // The crescent takes the brightness of the sky at the top of the frame.
      vec3 sky = texture2D(tDiffuse, vec2(0.5, 0.92)).rgb;
      gl_FragColor = vec4(mix(around, inDrop, cover) + sky * max(shade, 0.0) * 0.35, 1.0);
    }`,
};

const RAIN_BOX = 40;

/**
 * Rain falling through the air around the eye: short motion-blurred streaks, wrapped in a box that
 * travels with the camera, so a fixed set of drops fills the air wherever it looks.
 */
export function createRain(count = 30_000): THREE.LineSegments<THREE.BufferGeometry, THREE.ShaderMaterial> {
  const seeds = new Float32Array(count * 2 * 4);
  const ends = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    const s = [Math.random(), Math.random(), Math.random(), Math.random()];
    seeds.set(s, i * 8);
    seeds.set(s, i * 8 + 4);
    ends[i * 2 + 1] = 1;
  }
  const geometry = new THREE.BufferGeometry();
  // Positions are computed in the shader; three still wants a position attribute.
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * 2 * 3), 3));
  geometry.setAttribute("seed", new THREE.BufferAttribute(seeds, 4));
  geometry.setAttribute("end", new THREE.BufferAttribute(ends, 1));
  const material = new THREE.ShaderMaterial({
    uniforms: {
      time: { value: 0 },
      eye: { value: new THREE.Vector3() },
      fall: { value: new THREE.Vector3(0, -8, 0) },
      amount: { value: 0 },
      color: { value: new THREE.Color() },
    },
    vertexShader: /* glsl */ `
      attribute vec4 seed;
      attribute float end;
      uniform float time;
      uniform vec3 eye;
      uniform vec3 fall;
      uniform float amount;
      varying float vFade;
      const float BOX = ${RAIN_BOX.toFixed(1)};
      void main() {
        vFade = 0.0;
        if (seed.w > amount) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
        // Each drop falls with the wind, wrapped into a box around the eye.
        vec3 p = seed.xyz * BOX + fall * time * (0.85 + 0.3 * seed.w);
        p = mod(p - eye + BOX * 0.5, BOX) - BOX * 0.5 + eye;
        // A streak as long as the drop falls in a thirtieth of a second.
        p -= fall * (1.0 / 30.0) * end;
        float d = distance(p, eye);
        vFade = smoothstep(0.4, 1.5, d) * (1.0 - smoothstep(BOX * 0.3, BOX * 0.5, d));
        gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 color;
      varying float vFade;
      void main() {
        gl_FragColor = vec4(color * vFade, 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const lines = new THREE.LineSegments(geometry, material);
  lines.frustumCulled = false;
  return lines;
}

/** Rings where rain lands on the sea: slope to add to the surface's, within a few tens of metres. */
export const RIPPLES_GLSL = /* glsl */ `
vec2 rippleHash(vec2 p) { vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.103, 0.0973)); q += dot(q, q.yzx + 33.33); return fract((q.xx + q.yz) * q.zy); }
vec2 rippleLayer(vec2 p, float t) {
  vec2 id = floor(p);
  vec2 n = rippleHash(id);
  float life = fract(t * (0.8 + 0.5 * n.y) + n.x);
  vec2 d = fract(p) - (0.2 + 0.6 * rippleHash(id + 5.3));
  float r = length(d);
  float front = life * 0.5;
  float wave = sin((r - front) * 42.0) * exp(-abs(r - front) * 22.0) * (1.0 - life) * (1.0 - life);
  return d / max(r, 1e-3) * wave;
}
vec2 rainRipples(vec2 p, float t, float amount) {
  return (rippleLayer(p * 2.3, t) + rippleLayer(p * 3.1 + 17.0, t * 1.2)) * 0.12 * amount;
}
`;

/**
 * Lightning as brightness over time: a strike every several seconds to half a minute, each a quick
 * cluster of flickers. Deterministic in time, so it needs no state.
 */
export function lightning(t: number): number {
  const slot = Math.floor(t / 11);
  const r = (n: number) => {
    const x = Math.sin((slot + 1) * 127.1 + n * 311.7) * 43758.5453;
    return x - Math.floor(x);
  };
  if (r(0) < 0.3) return 0;
  const since = t - (slot * 11 + r(1) * 8);
  if (since < 0 || since > 0.6) return 0;
  // Two or three return strokes.
  let f = 0;
  for (let i = 0; i < 3; i++) {
    const at = i * (0.09 + r(2 + i) * 0.1);
    const x = since - at;
    if (x > 0) f = Math.max(f, Math.exp(-x * 22) * (i === 0 ? 1 : 0.6 + 0.4 * r(5 + i)));
  }
  return f;
}
