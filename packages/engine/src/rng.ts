// Deterministic PRNG (mulberry32). All game randomness flows through the
// rngState stored in GameState so that seed + action list fully determines a game.

export function nextRand(state: { rngState: number }): number {
  let t = (state.rngState += 0x6d2b79f5);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** random integer in [0, n) */
export function randInt(state: { rngState: number }, n: number): number {
  return Math.floor(nextRand(state) * n);
}

/** Fisher-Yates shuffle in place */
export function shuffle<T>(state: { rngState: number }, arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randInt(state, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
