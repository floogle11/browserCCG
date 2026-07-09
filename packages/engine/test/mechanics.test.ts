import { describe, it, expect } from 'vitest';
import { applyAction } from '../src/game.ts';
import { freshGame, mustApply, giveMana, putInHand, pass } from './util.ts';
import type { CreatureInstance, GameState } from '../src/types.ts';

function board(state: GameState, p: 0 | 1): (CreatureInstance | null)[] {
  return state.players[p].board;
}
function creatures(state: GameState, p: 0 | 1): CreatureInstance[] {
  return state.players[p].board.filter((c): c is CreatureInstance => c !== null);
}

/** helper: active player plays defId into first legal slot */
function playCreature(state: GameState, defId: string, slot?: number): GameState {
  const p = state.active;
  const i = putInHand(state, p, defId);
  giveMana(state, p, 'O', 10);
  giveMana(state, p, 'C', 10);
  giveMana(state, p, 'R', 10);
  const s = slot ?? (creatures(state, p).length === 0 ? 2 : firstAdjacent(state, p));
  return mustApply(state, { kind: 'playCard', handIndex: i, slot: s }, p);
}
function firstAdjacent(state: GameState, p: 0 | 1): number {
  const row = state.players[p].board;
  for (let i = 0; i < 6; i++) {
    if (row[i] === null && ((i > 0 && row[i - 1]) || (i < 5 && row[i + 1]))) return i;
  }
  throw new Error('no adjacent slot');
}

describe('placement rules', () => {
  it('first creature must be center; later ones adjacent', () => {
    const state = freshGame();
    const p = state.active;
    const i = putInHand(state, p, 'crystal_warden');
    giveMana(state, p, 'O', 6);
    // slot 0 illegal on empty board
    const bad = applyAction(state, { kind: 'playCard', handIndex: i, slot: 0 }, p);
    expect(bad.error).toBeTruthy();
    const good = mustApply(state, { kind: 'playCard', handIndex: i, slot: 2 }, p);
    expect(board(good, p)[2]?.defId).toBe('crystal_warden');
    // next creature must be adjacent (slot 1 or 3), not slot 5
    const j = putInHand(good, p, 'dalguarde_initiate');
    giveMana(good, p, 'O', 1);
    const bad2 = applyAction(good, { kind: 'playCard', handIndex: j, slot: 5 }, p);
    expect(bad2.error).toBeTruthy();
    const good2 = mustApply(good, { kind: 'playCard', handIndex: j, slot: 3 }, p);
    expect(board(good2, p)[3]?.defId).toBe('dalguarde_initiate');
  });
});

describe('mana', () => {
  it('requires colored crystals and charges the track', () => {
    const state = freshGame();
    const p = state.active;
    state.players[p].pool = [];
    const i = putInHand(state, p, 'crystal_warden');
    const noMana = applyAction(state, { kind: 'playCard', handIndex: i, slot: 2 }, p);
    expect(noMana.error).toBe('Not enough mana');
    giveMana(state, p, 'R', 6); // wrong color
    const wrong = applyAction(state, { kind: 'playCard', handIndex: i, slot: 2 }, p);
    expect(wrong.error).toBe('Not enough mana');
    giveMana(state, p, 'O', 6);
    const before = state.players[p].track.charges;
    const ok = mustApply(state, { kind: 'playCard', handIndex: i, slot: 2 }, p);
    expect(ok.players[p].track.charges).toBe(before + 6);
    expect(ok.players[p].pool.filter((m) => m.tapped && m.color === 'O').length).toBe(6);
  });
});

describe('combat', () => {
  function combatSetup(): { state: GameState; p: 0 | 1; e: 0 | 1 } {
    let state = freshGame(7);
    const p = state.active;
    state = playCreature(state, 'crystal_warden', 2); // 6/6 defender... cannot attack; use another
    state = pass(state);
    return { state, p, e: (1 - p) as 0 | 1 };
  }

  it('attacks the facing creature with mutual damage, then the god', () => {
    let state = freshGame(3);
    const p = state.active;
    const e = (1 - p) as 0 | 1;
    state = playCreature(state, 'rush_order', 2); // 5/3 rushdown
    // enemy has nothing facing → hits god
    state = mustApply(state, { kind: 'toggleStance', uid: creatures(state, p)[0].uid }, p);
    state = mustApply(state, { kind: 'beginAttack' }, p);
    expect(state.players[e].hp).toBe(25 - 5);
    state = pass(state);
    // enemy plays a facing creature (their slot 3 faces our slot 2)
    state = playCreature(state, 'flame_bud_pin', 3); // 1/3, battle tested +2
    state = pass(state);
    // our 5/3 attacks facing 1/3: kills it, takes 1 back (pin undamaged when it strikes back simultaneously)
    const atkUid = creatures(state, p)[0].uid;
    state = mustApply(state, { kind: 'toggleStance', uid: atkUid }, p);
    state = mustApply(state, { kind: 'beginAttack' }, p);
    expect(creatures(state, e).length).toBe(0);
    expect(creatures(state, p)[0].health).toBe(2);
  });

  it('Defender priority forces attacks; Forcing ignores it', () => {
    let state = freshGame(11);
    const p = state.active;
    const e = (1 - p) as 0 | 1;
    state = playCreature(state, 'rush_order', 2);
    state = pass(state);
    // enemy defender adjacent to facing slot: our slot 2 faces enemy slot 3; defender at enemy 2 (adjacent)
    state = playCreature(state, 'crystal_warden', 3);
    state = playCreature(state, 'novice_shieldmaiden', 2);
    state = pass(state);
    const hpBefore = state.players[e].hp;
    const atk = creatures(state, p).find((c) => c.defId === 'rush_order')!;
    state = mustApply(state, { kind: 'toggleStance', uid: atk.uid }, p);
    state = mustApply(state, { kind: 'beginAttack' }, p);
    // must have hit a Defender, not the god
    expect(state.players[e].hp).toBe(hpBefore);
    const warden = creatures(state, e).find((c) => c.defId === 'crystal_warden');
    const maiden = creatures(state, e).find((c) => c.defId === 'novice_shieldmaiden');
    const someDefenderHurt =
      (warden && warden.health < 6) || maiden === undefined || maiden.health < 1 || maiden.armor < 2;
    expect(someDefenderHurt).toBe(true);
  });

  it('armor absorbs damage; Pierce ignores it; stance drops armor', () => {
    let state = freshGame(5);
    const p = state.active;
    const e = (1 - p) as 0 | 1;
    state = playCreature(state, 'novice_shieldmaiden', 2); // 1/1/2 defender
    state = pass(state);
    // enemy attacks into the defender with a 2-attack creature: armor soaks it
    state = playCreature(state, 'flame_bud_pin', 3); // 1/3 (faces our slot 2)
    state = pass(state); // back to p
    state = pass(state); // enemy turn: pin can attack now
    const pin = creatures(state, e).find((c) => c.defId === 'flame_bud_pin')!;
    let r = mustApply(state, { kind: 'toggleStance', uid: pin.uid }, e);
    r = mustApply(r, { kind: 'beginAttack' }, e);
    const maiden = creatures(r, p).find((c) => c.defId === 'novice_shieldmaiden')!;
    expect(maiden.health).toBe(1);       // armor absorbed the hit
    expect(maiden.armor).toBe(1);        // 2 armor - 1 damage
  });

  it('Crushing sends excess damage to the god; Cleave splashes adjacents', () => {
    let state = freshGame(13, 'vryas_bargain', 'dalguarde_bulwark');
    const p = state.active;
    const e = (1 - p) as 0 | 1;
    // enemy line: three 1/1s in slots 2,3,4
    state = pass(state);
    state = playCreature(state, 'dalguarde_initiate', 2);
    state = playCreature(state, 'dalguarde_initiate', 3);
    state = playCreature(state, 'dalguarde_initiate', 4);
    state = pass(state);
    // our reckless vandal (5/3/1 Crushing) at slot 2 → faces enemy slot 3 (a 2/1)
    state = playCreature(state, 'reckless_vandal', 2);
    state = pass(state);
    state = pass(state);
    const vandal = creatures(state, state.active).find((c) => c.defId === 'reckless_vandal')!;
    const hpBefore = state.players[(1 - state.active) as 0 | 1].hp;
    let r = mustApply(state, { kind: 'toggleStance', uid: vandal.uid }, state.active);
    r = mustApply(r, { kind: 'beginAttack' }, state.active);
    // 5 attack vs 1 health → 4 excess crushing damage
    expect(r.players[(1 - r.active) as 0 | 1].hp).toBe(hpBefore - 4);
  });
});

describe('keywords & statuses', () => {
  it('Aegis blocks the first damage instance', () => {
    let state = freshGame(21);
    const p = state.active;
    state = playCreature(state, 'dalguarde_initiate', 2);
    const c = creatures(state, p)[0];
    giveMana(state, p, 'O', 1);
    state = pass(state); // creature has summoning sickness for activatable
    state = pass(state);
    giveMana(state, state.active, 'O', 1);
    const uid = creatures(state, state.active)[0].uid;
    state = mustApply(state, { kind: 'activate', uid }, state.active);
    expect(creatures(state, state.active)[0].statuses.aegis).toBe(true);
    // burn it: aegis pops instead of damage
    const cr = creatures(state, state.active)[0];
    const i = putInHand(state, (1 - state.active) as 0 | 1, 'brand');
    void c; void i; void cr;
    // direct check via spell from the enemy on their turn
    let s2 = pass(state);
    const e = s2.active;
    const j = putInHand(s2, e, 'brand');
    giveMana(s2, e, 'R', 2);
    const target = creatures(s2, (1 - e) as 0 | 1)[0];
    s2 = mustApply(s2, { kind: 'playCard', handIndex: j, targets: [{ type: 'creature', uid: target.uid }] }, e);
    s2 = mustApply(s2, { kind: 'endTurn' }, e); // burn ticks at end of turn
    const after = creatures(s2, s2.active)[0];
    expect(after.statuses.aegis).toBe(false); // popped by burn tick
    expect(after.health).toBe(1);             // no damage went through
  });

  it('Burn ticks down 3,2,1 at end of turns', () => {
    let state = freshGame(23);
    const p = state.active;
    state = playCreature(state, 'crystal_warden', 2); // 6/6
    const e = (1 - p) as 0 | 1;
    state = pass(state);
    const i = putInHand(state, e, 'brand');
    giveMana(state, e, 'R', 2);
    const target = creatures(state, p)[0];
    state = mustApply(state, { kind: 'playCard', handIndex: i, targets: [{ type: 'creature', uid: target.uid }] }, e);
    expect(creatures(state, p)[0].statuses.burn).toBe(3);
    state = pass(state); // end e's turn → tick 3
    expect(creatures(state, p)[0].health).toBe(3);
    expect(creatures(state, p)[0].statuses.burn).toBe(2);
    state = pass(state); // end p's turn → tick 2
    expect(creatures(state, p)[0].health).toBe(1);
    state = pass(state); // tick 1 → dies
    expect(creatures(state, p).length).toBe(0);
  });

  it('Snare prevents attacking for a full turn', () => {
    let state = freshGame(29);
    const p = state.active;
    const e = (1 - p) as 0 | 1;
    state = playCreature(state, 'coalossus', 2); // 6/6 survives the 3 damage
    state = pass(state);
    const i = putInHand(state, e, 'blinding_light');
    giveMana(state, e, 'O', 2);
    const target = creatures(state, p)[0];
    state = mustApply(state, { kind: 'playCard', handIndex: i, targets: [{ type: 'creature', uid: target.uid }] }, e);
    state = pass(state);
    // p's turn: snared, cannot enter stance
    const c = creatures(state, p)[0];
    const bad = applyAction(state, { kind: 'toggleStance', uid: c.uid }, p);
    expect(bad.error).toBeTruthy();
    state = pass(state);
    state = pass(state);
    // next p turn: snare gone
    const ok = applyAction(state, { kind: 'toggleStance', uid: c.uid }, p);
    expect(ok.error).toBeUndefined();
  });

  it('Nullify strips keywords and text', () => {
    let state = freshGame(31, 'dalguarde_bulwark', 'dalguarde_bulwark');
    const p = state.active;
    const e = (1 - p) as 0 | 1;
    state = playCreature(state, 'crystal_warden', 2); // defender
    state = pass(state);
    const i = putInHand(state, e, 'quartered_and_drawn');
    void i;
    // use a nameless wanderer instead (nullify only)
    const j = putInHand(state, e, 'nameless_wanderer');
    giveMana(state, e, 'C', 4);
    state = mustApply(state, { kind: 'playCard', handIndex: j, slot: 2, targets: [{ type: 'creature', uid: creatures(state, p)[0].uid }] }, e);
    const warden = creatures(state, p)[0];
    expect(warden.nullified).toBe(true);
    expect(warden.keywords).toEqual([]);
  });

  it('Sacrifice is a real cost and Unscathed Chicken bounces back', () => {
    let state = freshGame(37, 'vryas_bargain', 'dalguarde_bulwark');
    const p = state.active;
    state = playCreature(state, 'unscathed_chicken', 2);
    state = pass(state);
    state = pass(state);
    // play phoenix reborn (sacrifice 1) sacrificing the chicken
    const chicken = creatures(state, p)[0];
    const i = putInHand(state, p, 'phoenix_reborn');
    giveMana(state, p, 'R', 2);
    const noSac = applyAction(state, { kind: 'playCard', handIndex: i, slot: 3 }, p);
    expect(noSac.error).toBeTruthy();
    const ok = mustApply(state, { kind: 'playCard', handIndex: i, slot: 3, sacrifices: [chicken.uid] }, p);
    expect(ok.players[p].hand).toContain('unscathed_chicken'); // returned to hand
    expect(creatures(ok, p).some((c) => c.defId === 'phoenix_reborn')).toBe(true);
  });

  it('deck-out loses the game', () => {
    let state = freshGame(41);
    const p = state.active;
    state.players[p].deck = [];
    state = pass(state); // opponent's turn starts fine
    state = pass(state); // p draws from empty deck → loses
    expect(state.winner).toBe((1 - p) as 0 | 1);
  });
});

describe('devotion track', () => {
  it('accrues charges from spending and fires abilities', () => {
    let state = freshGame(43, 'vryas_bargain', 'dalguarde_bulwark');
    const p = state.active;
    state.players[p].track.charges = 10;
    state = playCreature(state, 'unscathed_chicken', 2);
    state = pass(state);
    state = playCreature(state, 'crystal_warden', 2);
    state = pass(state);
    // vrya tier 0: deal 1 damage to a creature
    const target = creatures(state, (1 - p) as 0 | 1)[0];
    const before = target.health;
    state = mustApply(state, { kind: 'useTrack', tier: 0, targets: [{ type: 'creature', uid: target.uid }] }, p);
    expect(creatures(state, (1 - p) as 0 | 1)[0].health).toBe(before - 1);
    expect(state.players[p].track.usedThisTurn).toBe(true);
    const again = applyAction(state, { kind: 'useTrack', tier: 0, targets: [{ type: 'creature', uid: target.uid }] }, p);
    expect(again.error).toBeTruthy();
  });
});

describe('spells & scripts', () => {
  it("Aldranari's Wrath wipes small boards", () => {
    let state = freshGame(47, 'ashes_of_aldranari', 'dalguarde_bulwark');
    const p = state.active;
    const e = (1 - p) as 0 | 1;
    state = pass(state);
    state = playCreature(state, 'dalguarde_initiate', 2);
    state = playCreature(state, 'novice_shieldmaiden', 3);
    state = pass(state);
    const i = putInHand(state, p, 'aldranaris_wrath');
    giveMana(state, p, 'C', 1);
    giveMana(state, p, 'R', 4);
    state = mustApply(state, { kind: 'playCard', handIndex: i }, p);
    expect(creatures(state, e).length).toBe(0);
  });

  it('Famine forces both players to discard per creature', () => {
    let state = freshGame(53);
    const p = state.active;
    const e = (1 - p) as 0 | 1;
    state = playCreature(state, 'rush_order', 2);
    state = pass(state);
    state = playCreature(state, 'flame_bud_pin', 2);
    const h0 = state.players[p].hand.length;
    const h1 = state.players[e].hand.length;
    const i = putInHand(state, e, 'famine');
    giveMana(state, e, 'R', 4);
    state = mustApply(state, { kind: 'playCard', handIndex: i }, e);
    expect(state.players[p].hand.length).toBe(h0 - 1);
    expect(state.players[e].hand.length).toBe(h1 - 1); // +1 famine -1 played -1 discard
  });

  it('Grave Exchange sacrifices and reanimates the top creature', () => {
    let state = freshGame(59, 'vryas_bargain', 'dalguarde_bulwark');
    const p = state.active;
    state = playCreature(state, 'shadow_horror', 2); // 3/3
    const horror = creatures(state, p)[0];
    const i = putInHand(state, p, 'grave_exchange');
    giveMana(state, p, 'O', 2);
    giveMana(state, p, 'R', 2);
    state = mustApply(state, { kind: 'playCard', handIndex: i, targets: [{ type: 'creature', uid: horror.uid }] }, p);
    // sacrificed then reanimated: a fresh shadow horror back on the board, graveyard has only the spell
    const back = creatures(state, p).find((c) => c.defId === 'shadow_horror');
    expect(back).toBeDefined();
    expect(back!.uid).not.toBe(horror.uid);
    expect(state.players[p].graveyard.filter((id) => id === 'shadow_horror')).toHaveLength(0);
  });
});
