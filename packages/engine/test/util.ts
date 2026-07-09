import type { Action, Devotion, GameState } from '../src/types.ts';
import { createGame, applyAction } from '../src/game.ts';
import { expect } from 'vitest';

export function freshGame(seed = 1, d0 = 'dalguarde_bulwark', d1 = 'ashes_of_aldranari'): GameState {
  let { state } = createGame(d0, d1, seed);
  state = mustApply(state, { kind: 'mulligan', keep: true }, 0);
  state = mustApply(state, { kind: 'mulligan', keep: true }, 1);
  return state;
}

export function mustApply(state: GameState, action: Action, player: 0 | 1): GameState {
  const r = applyAction(state, action, player);
  expect(r.error, `action ${action.kind} failed: ${r.error}`).toBeUndefined();
  return r.state;
}

export function giveMana(state: GameState, p: 0 | 1, color: Devotion, n: number): void {
  for (let i = 0; i < n; i++) state.players[p].pool.push({ color, tapped: false });
}

/** put a card in hand, returns its hand index */
export function putInHand(state: GameState, p: 0 | 1, defId: string): number {
  state.players[p].hand.push(defId);
  return state.players[p].hand.length - 1;
}

export function active(state: GameState): 0 | 1 {
  return state.active;
}

/** pass the turn without attacking */
export function pass(state: GameState): GameState {
  return mustApply(state, { kind: 'endTurn' }, state.active);
}
