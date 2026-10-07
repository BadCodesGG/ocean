/**
 * Just enough of OPeNDAP's text encodings to read CDIP's THREDDS server: the `.dds` structure
 * (for array lengths) and the `.ascii` values response.
 */

/** Array lengths declared in a `.dds`, keyed by variable name: `Float32 waveHs[waveTime = 6266];` -> waveHs: [6266]. */
export function parseDdsShapes(dds: string): Map<string, number[]> {
  const shapes = new Map<string, number[]>();
  for (const match of dds.matchAll(/^\s*\w+\s+(\w+)((?:\[\w+ = \d+\])+);/gm)) {
    const dims = [...match[2].matchAll(/= (\d+)\]/g)].map((d) => Number(d[1]));
    // Grid maps repeat the axis variables inside each grid; the first (top-level) declaration wins.
    if (!shapes.has(match[1])) shapes.set(match[1], dims);
  }
  return shapes;
}

/**
 * Values from a `.ascii` response. Scalars come back as `name, value`; arrays as a `name[dims]` header
 * followed by comma-separated rows, where rows of a multi-dimensional array are prefixed `[i], `.
 * Grid arrays are named `grid.array`; the key is the array's own name. Quoted strings stay strings.
 */
export function parseAscii(text: string): Map<string, number[] | string> {
  const divider = text.indexOf("\n---");
  if (divider < 0) throw new Error("OPeNDAP: not an ascii response");
  const lines = text.slice(text.indexOf("\n", divider + 1) + 1).split(/\r?\n/);
  const out = new Map<string, number[] | string>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const header = /^([\w.]+)(?:\[\d+\])+$/.exec(line);
    if (header) {
      const values: number[] = [];
      while (i + 1 < lines.length && lines[i + 1].trim()) {
        const row = lines[++i].trim().replace(/^(\[\d+\],\s*)+/, "");
        for (const v of row.split(",")) values.push(Number(v));
      }
      const parts = header[1].split(".");
      const name = parts[parts.length - 1];
      // In `waveHs.waveTime`, the map axis repeats a variable read on its own; keep the first.
      if (parts.length === 1 || parts[0] === name || !out.has(name)) out.set(name, values);
      continue;
    }
    const scalar = /^(\w+), (.*)$/.exec(line);
    if (scalar) {
      const raw = scalar[2];
      out.set(scalar[1], raw.startsWith('"') ? raw.slice(1, -1) : [Number(raw)]);
    }
  }
  return out;
}

export function numbers(values: Map<string, number[] | string>, name: string): number[] {
  const v = values.get(name);
  if (!Array.isArray(v)) throw new Error(`OPeNDAP: missing numeric variable ${name}`);
  return v;
}

export function scalar(values: Map<string, number[] | string>, name: string): number {
  return numbers(values, name)[0];
}

export function text(values: Map<string, number[] | string>, name: string): string {
  const v = values.get(name);
  if (typeof v !== "string") throw new Error(`OPeNDAP: missing string variable ${name}`);
  return v;
}
