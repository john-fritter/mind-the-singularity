// The seeded RNG. Every random draw in the game comes from a generator seeded
// by the epoch's seed and the sequence number of the order or event that
// draws, so any battle or program run can be replayed from the log.

export interface Rng {
  /** A draw in [0, 1). */
  next(): number;
}

/** A 32-bit hash of a string (FNV-1a), for mixing the seed and sequence number. */
function hash32(text: string, basis: number): number {
  let h = basis >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** The generator for one order or event: sfc32, seeded from (seed, seq). */
export function rngFor(seed: number, seq: number): Rng {
  const key = `${seed}:${seq}`;
  let a = hash32(key, 0x811c9dc5);
  let b = hash32(key, 0x9e3779b9);
  let c = hash32(key, 0x85ebca6b);
  let d = hash32(key, 0xc2b2ae35);
  const next = () => {
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  // Warm up, so nearby seeds don't give nearby first draws.
  for (let i = 0; i < 12; i++) next();
  return { next };
}
