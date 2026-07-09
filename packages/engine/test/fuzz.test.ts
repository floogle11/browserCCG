// AI-vs-AI fuzz: plays full games across many seeds and deck matchups.
// Catches crashes, illegal AI actions, stuck states and infinite loops.

import { describe, it, expect } from 'vitest';
import { createGame, applyAction } from '../src/game.ts';
import { aiNextAction } from '../src/ai.ts';
import type { GameState } from '../src/types.ts';

const MATCHUPS: [string, string][] = [
  ['dalguarde_bulwark', 'ashes_of_aldranari'],
  ['ashes_of_aldranari', 'vryas_bargain'],
  ['vryas_bargain', 'dalguarde_bulwark'],
  ['dalguarde_bulwark', 'dalguarde_bulwark'],
  ['vryas_bargain', 'vryas_bargain'],
];

function whoActs(state: GameState): 0 | 1 {
  if (state.pendingChoice) return state.pendingChoice.player;
  if (state.phase === 'mulligan') {
    if (!state.players[0].mulliganDone) return 0;
    return 1;
  }
  return state.active;
}

function playGame(d0: string, d1: string, seed: number): { state: GameState; actions: number } {
  let { state } = createGame(d0, d1, seed);
  let actions = 0;
  while (state.winner === null) {
    actions++;
    expect(actions, `game ${d0} vs ${d1} seed ${seed} ran away`).toBeLessThan(4000);
    const player = whoActs(state);
    const action = aiNextAction(state, player);
    const r = applyAction(state, action, player);
    expect(r.error, `seed ${seed}: AI played illegal ${action.kind}: ${r.error}`).toBeUndefined();
    state = r.state;
    expect(state.turn, `seed ${seed} exceeded 300 turns`).toBeLessThan(300);
  }
  return { state, actions };
}

describe('AI vs AI fuzz', () => {
  it('completes 100 games without illegal actions or hangs', () => {
    let games = 0;
    for (const [d0, d1] of MATCHUPS) {
      for (let seed = 1; seed <= 20; seed++) {
        const { state } = playGame(d0, d1, seed * 7919 + games);
        expect(state.winner).not.toBeNull();
        games++;
      }
    }
    expect(games).toBe(100);
  }, 120_000);

  it('is deterministic: same seed + same actions = same outcome', () => {
    const a = playGame('dalguarde_bulwark', 'ashes_of_aldranari', 12345);
    const b = playGame('dalguarde_bulwark', 'ashes_of_aldranari', 12345);
    expect(a.state.winner).toBe(b.state.winner);
    expect(a.state.turn).toBe(b.state.turn);
    expect(a.actions).toBe(b.actions);
  });
});
