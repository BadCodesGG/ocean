/**
 * The GPU FFT's index arithmetic, in TypeScript so it can be tested against a plain DFT. `shaders.ts`
 * transcribes `stockhamPass` line for line; change one, change the other.
 *
 * Stockham radix-2, log2(N) passes, natural order in and out. Pass s combines sub-transforms of size
 * 2^s into 2^(s+1). The inverse transform (positive exponent, no 1/N) is what turns a spectrum into a
 * field: x_n = sum_m X_m e^{+2πi mn/N}.
 */

/** One pass over complex pairs stored interleaved (re, im). */
export function stockhamPass(src: Float64Array, n: number, sub: number): Float64Array {
  const out = new Float64Array(src.length);
  const half = sub / 2;
  for (let index = 0; index < n; index++) {
    const even = Math.floor(index / sub) * half + (index % half);
    const odd = even + n / 2;
    const angle = (2 * Math.PI * index) / sub;
    const wr = Math.cos(angle);
    const wi = Math.sin(angle);
    const or = src[2 * odd];
    const oi = src[2 * odd + 1];
    out[2 * index] = src[2 * even] + wr * or - wi * oi;
    out[2 * index + 1] = src[2 * even + 1] + wr * oi + wi * or;
  }
  return out;
}

export function inverseFft(src: Float64Array, n: number): Float64Array {
  let data = src;
  for (let sub = 2; sub <= n; sub *= 2) data = stockhamPass(data, n, sub);
  return data;
}

/** Time evolution of one texel of `initialSpectrum`: h(k, t) = h0(k) e^{-iωt} + conj(h0(-k)) e^{iωt}. */
export function evolve(h0: ArrayLike<number>, offset: number, omega: number, t: number): [number, number] {
  const c = Math.cos(omega * t);
  const s = Math.sin(omega * t);
  // h0 (c - is) + h0m (c + is)
  const re = h0[offset] * c + h0[offset + 1] * s + h0[offset + 2] * c - h0[offset + 3] * s;
  const im = h0[offset + 1] * c - h0[offset] * s + h0[offset + 3] * c + h0[offset + 2] * s;
  return [re, im];
}
