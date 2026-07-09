// Game construction, the action interpreter (the ONLY public way to mutate
// state), the turn machine and combat resolution.

import type {
  Action, ApplyResult, CreatureInstance, DeckDef, Devotion, GameEvent,
  GameState, PlayerState, TargetRef, TargetSpec,
} from './types.ts';
import {
  BOARD_SLOTS, GOD_HP, HAND_LIMIT, MAX_DECREES, TRACK_TIERS,
} from './types.ts';
import { cardDef, totalCost, GODS, DECKS } from './data.ts';
import { randInt, shuffle } from './rng.ts';
import {
  G, SCRIPTS, CHOICES, GOD_ABILITIES, scriptOf,
  emit, opp, boardOf, allBoard, creaturesOf, byUid, facingSlot,
  hasKw, getAttack, draw, discardLeftmost, cardToGraveyard,
  damageCreature, damageGod, healGod, processDeaths, sacrificeCreature,
  summonFromDef, burnTick, canPayCost, payCost, effectiveCost, pullMana,
  legalPlacementSlots, refreshDynamicStats,
} from './ctx.ts';
import './scripts.ts'; // side effect: registers all card/god behaviors

// ---------------------------------------------------------------------------
// Game creation
// ---------------------------------------------------------------------------

function buildPlayer(deck: DeckDef): PlayerState {
  const cards: string[] = [];
  for (const [defId, count] of Object.entries(deck.cards)) {
    for (let i = 0; i < count; i++) cards.push(defId);
  }
  const bag: Devotion[] = [];
  for (const [color, count] of Object.entries(deck.bag)) {
    for (let i = 0; i < (count ?? 0); i++) bag.push(color as Devotion);
  }
  return {
    god: deck.god,
    hp: GOD_HP,
    deck: cards,
    hand: [],
    graveyard: [],
    banished: [],
    bag,
    pool: [],
    board: Array(BOARD_SLOTS).fill(null),
    decrees: [],
    track: { charges: 0, usedThisTurn: false },
    mulligansUsed: 0,
    mulliganDone: false,
    freeSacrifices: false,
    discounts: [],
  };
}

export function createGame(deckId0: string, deckId1: string, seed: number): { state: GameState; events: GameEvent[] } {
  const d0 = DECKS[deckId0];
  const d1 = DECKS[deckId1];
  if (!d0 || !d1) throw new Error('Unknown deck id');
  const state: GameState = {
    seed,
    rngState: seed >>> 0,
    turn: 0,
    active: 0,
    phase: 'mulligan',
    players: [buildPlayer(d0), buildPlayer(d1)],
    nextUid: 1,
    pendingChoice: null,
    winner: null,
    diedThisTurn: [],
  };
  const g: G = { s: state, ev: [] };
  shuffle(state, state.players[0].deck);
  shuffle(state, state.players[1].deck);
  // more cards goes first; tie -> coin flip
  const len0 = state.players[0].deck.length;
  const len1 = state.players[1].deck.length;
  const first: 0 | 1 = len0 !== len1 ? (len0 > len1 ? 0 : 1) : (randInt(state, 2) as 0 | 1);
  state.active = first;
  emit(g, { t: 'coinFlip', first });
  // opening hands: first player 5, second player 6 (no draw hooks yet — hands only)
  for (let i = 0; i < 5; i++) state.players[first].hand.push(state.players[first].deck.shift()!);
  for (let i = 0; i < 6; i++) state.players[opp(first)].hand.push(state.players[opp(first)].deck.shift()!);
  return { state, events: g.ev };
}

// ---------------------------------------------------------------------------
// Turn machine
// ---------------------------------------------------------------------------

function startTurn(g: G): void {
  if (g.s.winner !== null) return;
  g.s.turn += 1;
  const p = g.s.active;
  const pl = g.s.players[p];
  g.s.phase = 'main1';
  pl.track.usedThisTurn = false;
  emit(g, { t: 'phase', phase: 'main1', turn: g.s.turn, active: p });

  // refresh crystals, pull one from the bag
  for (const m of pl.pool) m.tapped = false;
  pullMana(g, p);

  // armor regen + stance reset for own creatures; sanctuary tick
  for (const c of boardOf(g, p)) {
    c.armor = c.baseArmor;
    c.inAttackStance = false;
    c.attackTargetUid = null;
    if (c.statuses.sanctuary > 0) c.statuses.sanctuary -= 1;
  }
  // poison kills at the start of the poisoner's turn (both boards)
  for (const c of allBoard(g)) {
    if (c.statuses.poisonedBy === p) c.health = 0;
  }
  processDeaths(g);

  // start-of-turn triggers: own creatures in slot order, then global auras
  for (const c of [...boardOf(g, p)].sort((a, b) => a.slot - b.slot)) {
    if (g.s.winner !== null) return;
    if (g.s.players[p].board[c.slot] === c) scriptOf(c)?.onStartOfTurn?.(g, c);
  }
  for (const c of allBoard(g)) {
    if (g.s.winner !== null) return;
    scriptOf(c)?.onGlobalStartOfTurn?.(g, c, p);
  }
  processDeaths(g);

  // draw for turn
  if (g.s.winner === null) draw(g, p, 1);

  // aura upkeep: auto-pay or the aura dies
  for (const c of boardOf(g, p)) {
    if (!c.isAura || c.nullified) continue;
    const up = cardDef(c.defId).upkeep;
    if (!up) continue;
    if (!payCost(g, p, up)) {
      c.health = 0;
      emit(g, { t: 'info', msg: `${cardDef(c.defId).name} crumbles (upkeep unpaid)` });
    }
  }
  processDeaths(g);
}

function endTurn(g: G): void {
  const p = g.s.active;
  const pl = g.s.players[p];

  // end-of-turn triggers, own creatures in slot order
  for (const c of [...boardOf(g, p)].sort((a, b) => a.slot - b.slot)) {
    if (g.s.winner !== null) return;
    if (g.s.players[p].board[c.slot] === c) scriptOf(c)?.onEndOfTurn?.(g, c);
  }
  processDeaths(g);
  if (g.s.winner !== null) return;

  // burn ticks at the end of every turn
  burnTick(g);
  if (g.s.winner !== null) return;

  // snare wears off after the controller's full turn
  for (const c of boardOf(g, p)) {
    if (c.statuses.snareTurns > 0) c.statuses.snareTurns -= 1;
  }

  pl.freeSacrifices = false;

  // hand limit: banish oldest cards beyond 10
  while (pl.hand.length > HAND_LIMIT) {
    const defId = pl.hand.shift()!;
    pl.banished.push(defId);
    emit(g, { t: 'banish', player: p, defId });
  }

  g.s.diedThisTurn = [];
  g.s.active = opp(p);
  startTurn(g);
}

// ---------------------------------------------------------------------------
// Combat
// ---------------------------------------------------------------------------

/** enemy Defenders that constrain an attacker in `slot` */
function defenderCandidates(g: G, attackerOwner: 0 | 1, slot: number): CreatureInstance[] {
  const enemyRow = g.s.players[opp(attackerOwner)].board;
  const f = facingSlot(slot);
  const out: CreatureInstance[] = [];
  for (const i of [f - 1, f, f + 1]) {
    if (i < 0 || i >= BOARD_SLOTS) continue;
    const c = enemyRow[i];
    if (c && c.health > 0 && hasKw(g, c, 'Defender')) out.push(c);
  }
  return out;
}

function resolveAttack(g: G, attacker: CreatureInstance): void {
  if (g.s.winner !== null || attacker.health <= 0) return;
  const p = attacker.owner;
  const enemy = opp(p);
  const atk = getAttack(g, attacker);

  // pick target
  let target: CreatureInstance | null = null;
  if (!hasKw(g, attacker, 'Forcing')) {
    const defenders = defenderCandidates(g, p, attacker.slot);
    if (defenders.length > 0) {
      target = defenders.find((d) => d.uid === attacker.attackTargetUid) ?? defenders[0];
    }
  }
  if (!target) {
    const facing = g.s.players[enemy].board[facingSlot(attacker.slot)];
    if (facing && facing.health > 0) target = facing;
  }

  if (!target) {
    emit(g, { t: 'attack', attacker: attacker.uid, targetGod: enemy });
    damageGod(g, enemy, atk, { isCombat: true, sourceUid: attacker.uid, sourcePlayer: p });
    processDeaths(g);
    return;
  }

  emit(g, { t: 'attack', attacker: attacker.uid, targetUid: target.uid });
  const pierce = hasKw(g, attacker, 'Pierce');
  const preShield = (pierce ? 0 : target.armor) + target.health;
  const retaliation = target.isAura ? 0 : getAttack(g, target);

  // attacker hits target
  damageCreature(g, target, atk, {
    isCombat: true, pierce, sourceUid: attacker.uid, sourcePlayer: p, isAttacker: true,
  });
  // Cleave: same damage to creatures adjacent to the target
  if (hasKw(g, attacker, 'Cleave')) {
    const row = g.s.players[target.owner].board;
    for (const i of [target.slot - 1, target.slot + 1]) {
      if (i < 0 || i >= BOARD_SLOTS) continue;
      const adj = row[i];
      if (adj && adj.health > 0) {
        damageCreature(g, adj, atk, {
          isCombat: true, pierce, sourceUid: attacker.uid, sourcePlayer: p,
        });
      }
    }
  }
  // Crushing: overflow to the god
  if (hasKw(g, attacker, 'Crushing') && target.health <= 0) {
    const excess = atk - preShield;
    if (excess > 0) damageGod(g, enemy, excess, { isCombat: true, sourceUid: attacker.uid, sourcePlayer: p });
  }
  // simultaneous retaliation
  if (retaliation > 0 && attacker.health > 0) {
    damageCreature(g, attacker, retaliation, {
      isCombat: true, pierce: hasKw(g, target, 'Pierce'), sourceUid: target.uid, sourcePlayer: target.owner,
    });
  }
  processDeaths(g);
}

function resolveAttackPhase(g: G): void {
  const p = g.s.active;
  // Bloodcrazed: force ready creatures into stance
  for (const c of creaturesOf(g, p)) {
    if (c.statuses.mustAttack && !c.inAttackStance && canEnterStance(g, c)) {
      c.inAttackStance = true;
      c.armor = 0;
    }
  }
  g.s.phase = 'attack';
  emit(g, { t: 'phase', phase: 'attack', turn: g.s.turn, active: p });
  for (let slot = 0; slot < BOARD_SLOTS; slot++) {
    if (g.s.winner !== null) break;
    const c = g.s.players[p].board[slot];
    if (c && c.inAttackStance && c.health > 0) {
      resolveAttack(g, c);
      if (c.health > 0) c.inAttackStance = false;
    }
  }
  if (g.s.winner === null) {
    g.s.phase = 'main2';
    emit(g, { t: 'phase', phase: 'main2', turn: g.s.turn, active: p });
  }
}

export function canEnterStance(g: G, c: CreatureInstance): boolean {
  if (c.isAura || c.health <= 0) return false;
  if (hasKw(g, c, 'Defender')) return false;
  if (c.statuses.snareTurns > 0) return false;
  if (c.playedOnTurn === g.s.turn && !hasKw(g, c, 'Rushdown')) return false;
  for (const ally of boardOf(g, c.owner)) {
    if (ally.uid !== c.uid && scriptOf(ally)?.blocksAllyAttack?.(g, ally, c)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Target validation
// ---------------------------------------------------------------------------

const FILTERS: Record<string, (g: G, c: CreatureInstance) => boolean> = {
  attackStance: (_g, c) => c.inAttackStance,
  attackLE4: (g, c) => getAttack(g, c) <= 4,
  burned: (_g, c) => c.statuses.burn > 0,
  armored: (_g, c) => c.armor > 0,
  aura: (_g, c) => c.isAura,
  notSelf: () => true, // enforced contextually (self isn't on the board list during summon validation)
};

function validateTarget(g: G, actor: 0 | 1, spec: TargetSpec, ref: TargetRef | undefined, selfUid?: number): string | null {
  if (!ref) {
    if (spec.optional) return null;
    // required target may be skipped only if nothing valid exists
    if (spec.kind === 'creature' && listValidCreatureTargets(g, actor, spec, selfUid).length === 0) return null;
    if (spec.kind === 'slot' || spec.kind === 'column' || spec.kind === 'any' || spec.kind === 'god') return `Missing target: ${spec.label ?? spec.kind}`;
    return `Missing target: ${spec.label ?? spec.kind}`;
  }
  switch (spec.kind) {
    case 'creature': {
      if (ref.type !== 'creature') return 'Expected a creature target';
      const c = byUid(g, ref.uid);
      if (!c) return 'Target not found';
      return checkCreatureTargetable(g, actor, spec, c, selfUid);
    }
    case 'any': {
      if (ref.type === 'god') return null;
      if (ref.type === 'creature') {
        const c = byUid(g, ref.uid);
        if (!c) return 'Target not found';
        return checkCreatureTargetable(g, actor, { ...spec, kind: 'creature' }, c, selfUid);
      }
      return 'Expected a creature or god';
    }
    case 'god':
      return ref.type === 'god' ? null : 'Expected a god target';
    case 'slot': {
      if (ref.type !== 'slot') return 'Expected a slot';
      if (spec.side === 'ally' && ref.player !== actor) return 'Must pick your own slot';
      if (g.s.players[ref.player].board[ref.slot] !== null) return 'Slot is occupied';
      return null;
    }
    case 'column':
      return ref.type === 'column' && ref.col >= 0 && ref.col < BOARD_SLOTS ? null : 'Expected a column';
  }
}

function checkCreatureTargetable(g: G, actor: 0 | 1, spec: TargetSpec, c: CreatureInstance, selfUid?: number): string | null {
  if (spec.side === 'ally' && c.owner !== actor) return 'Must target a friendly creature';
  if (spec.side === 'enemy' && c.owner === actor) return 'Must target an enemy creature';
  if (spec.filter === 'notSelf' && selfUid !== undefined && c.uid === selfUid) return 'Cannot target itself';
  if (spec.filter && spec.filter !== 'notSelf' && !FILTERS[spec.filter]?.(g, c)) return 'Target does not match';
  if (c.owner !== actor) {
    if (hasKw(g, c, 'Shroud')) return 'Target has Shroud';
    if (c.statuses.sanctuary > 0) return 'Target has Sanctuary';
  }
  return null;
}

export function listValidCreatureTargets(g: G, actor: 0 | 1, spec: TargetSpec, selfUid?: number): CreatureInstance[] {
  return allBoard(g).filter((c) => checkCreatureTargetable(g, actor, spec, c, selfUid) === null);
}

function validateTargets(g: G, actor: 0 | 1, specs: TargetSpec[] | undefined, refs: TargetRef[], selfUid?: number): string | null {
  const list = specs ?? [];
  for (let i = 0; i < list.length; i++) {
    const err = validateTarget(g, actor, list[i], refs[i], selfUid);
    if (err) return err;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Action interpreter
// ---------------------------------------------------------------------------

export function applyAction(prev: GameState, action: Action, player: 0 | 1): ApplyResult {
  const state = structuredClone(prev);
  const g: G = { s: state, ev: [] };
  const fail = (error: string): ApplyResult => ({ state: prev, events: [], error });

  if (state.winner !== null) return fail('Game is over');

  // pending choice gates everything else
  if (state.pendingChoice) {
    if (action.kind !== 'resolveChoice') return fail('A choice is pending');
    const choice = state.pendingChoice;
    if (choice.player !== player) return fail('Not your choice');
    if (action.picks.length < choice.min || action.picks.length > choice.max) return fail('Wrong number of picks');
    for (const p of action.picks) {
      if (!choice.options.includes(p)) return fail('Invalid pick');
    }
    state.pendingChoice = null;
    CHOICES[choice.tag]?.(g, player, action.picks, choice.data ?? {});
    processDeaths(g);
    return { state, events: g.ev };
  }

  if (state.phase === 'mulligan') {
    if (action.kind !== 'mulligan') return fail('Mulligan phase: keep or mulligan');
    const pl = state.players[player];
    if (pl.mulliganDone) return fail('Already kept');
    if (action.keep || pl.mulligansUsed >= 2) {
      pl.mulliganDone = true;
    } else {
      pl.deck.push(...pl.hand);
      const n = pl.hand.length;
      pl.hand = [];
      shuffle(state, pl.deck);
      for (let i = 0; i < n; i++) pl.hand.push(pl.deck.shift()!);
      pl.mulligansUsed += 1;
      if (pl.mulligansUsed >= 2) pl.mulliganDone = true;
      emit(g, { t: 'info', msg: `Player ${player + 1} mulligans` });
    }
    if (state.players[0].mulliganDone && state.players[1].mulliganDone) {
      startTurn(g);
    }
    return { state, events: g.ev };
  }

  if (player !== state.active) return fail('Not your turn');

  switch (action.kind) {
    case 'endTurn': {
      if (state.phase !== 'main1' && state.phase !== 'main2') return fail('Cannot end turn now');
      endTurn(g);
      return { state, events: g.ev };
    }

    case 'beginAttack': {
      if (state.phase !== 'main1') return fail('Attack phase already used');
      resolveAttackPhase(g);
      return { state, events: g.ev };
    }

    case 'toggleStance': {
      if (state.phase !== 'main1') return fail('Stances are set in main phase 1');
      const c = byUid(g, action.uid);
      if (!c || c.owner !== player) return fail('Not your creature');
      if (c.inAttackStance) {
        c.inAttackStance = false;
        c.armor = c.baseArmor;
        c.attackTargetUid = null;
      } else {
        if (!canEnterStance(g, c)) return fail('This creature cannot attack');
        c.inAttackStance = true;
        c.armor = 0;
        c.attackTargetUid = action.defenderTargetUid ?? null;
      }
      return { state, events: g.ev };
    }

    case 'playCard': {
      if (state.phase !== 'main1' && state.phase !== 'main2') return fail('Cannot play cards now');
      const pl = state.players[player];
      if (action.handIndex < 0 || action.handIndex >= pl.hand.length) return fail('Bad hand index');
      const defId = pl.hand[action.handIndex];
      const def = cardDef(defId);
      if (def.type === 'token') return fail('Tokens cannot be played');
      const cost = effectiveCost(g, player, defId);
      if (!canPayCost(g, player, cost)) return fail('Not enough mana');

      // placement
      let slot = -1;
      if (def.type === 'creature' || def.type === 'aura') {
        if (action.slot === undefined) return fail('Choose a slot');
        if (!legalPlacementSlots(g, player).includes(action.slot)) return fail('Illegal slot');
        slot = action.slot;
      }
      if (def.type === 'decree' && pl.decrees.length >= MAX_DECREES) return fail('Decree zone is full');

      // sacrifices
      const sacUids = action.sacrifices ?? [];
      const needSac = pl.freeSacrifices ? 0 : (def.sacrifice ?? 0);
      if (needSac > 0) {
        if (sacUids.length !== needSac) return fail(`Requires ${needSac} sacrifice(s)`);
        for (const uid of sacUids) {
          const c = byUid(g, uid);
          if (!c || c.owner !== player || c.isAura) return fail('Invalid sacrifice');
          if (SCRIPTS[c.defId]?.cannotBeSacrificed) return fail('That creature cannot be sacrificed');
        }
      }

      // targets
      const targets = action.targets ?? [];
      const tErr = validateTargets(g, player, def.targets, targets);
      if (tErr) return fail(tErr);

      // commit
      payCost(g, player, cost);
      const di = pl.discounts.findIndex((d) => d.defId === defId);
      if (di >= 0) pl.discounts.splice(di, 1);
      pl.hand.splice(action.handIndex, 1);
      emit(g, { t: 'cardPlayed', player, defId });
      for (const w of boardOf(g, player)) scriptOf(w)?.onOwnerPlayedCard?.(g, w, defId);
      if (g.s.winner !== null) return { state, events: g.ev };

      for (const uid of sacUids.slice(0, needSac)) {
        const c = byUid(g, uid);
        if (c) sacrificeCreature(g, c);
      }

      if (def.type === 'creature' || def.type === 'aura') {
        // slot may have opened/closed via sacrifice; re-check softly
        if (state.players[player].board[slot] !== null) {
          const alt = legalPlacementSlots(g, player)[0];
          if (alt === undefined) {
            cardToGraveyard(g, player, defId);
            processDeaths(g);
            return { state, events: g.ev };
          }
          slot = alt;
        }
        summonFromDef(g, player, defId, slot, { targets });
      } else if (def.type === 'spell') {
        const result = SCRIPTS[defId]?.spell?.(g, player, targets);
        if (result === 'hand') pl.hand.push(defId);
        else cardToGraveyard(g, player, defId);
      } else if (def.type === 'decree') {
        pl.decrees.push({ uid: state.nextUid++, defId, owner: player });
      }
      refreshDynamicStats(g);
      processDeaths(g);
      return { state, events: g.ev };
    }

    case 'activate': {
      if (state.phase !== 'main1' && state.phase !== 'main2') return fail('Cannot activate now');
      const c = byUid(g, action.uid);
      if (!c || c.owner !== player) return fail('Not your creature');
      if (c.nullified) return fail('Creature is nullified');
      const ab = SCRIPTS[c.defId]?.activatable;
      if (!ab) return fail('No activated ability');
      if ((c.counters.activatedTurn ?? -1) === state.turn) return fail('Already activated this turn');
      if (c.playedOnTurn === state.turn && !hasKw(g, c, 'Rushdown')) return fail('Summoning sickness');
      if (!canPayCost(g, player, ab.cost)) return fail('Not enough mana');
      const targets = action.targets ?? [];
      const tErr = validateTargets(g, player, ab.targets, targets, c.uid);
      if (tErr) return fail(tErr);
      payCost(g, player, ab.cost);
      c.counters.activatedTurn = state.turn;
      ab.run(g, c, targets);
      processDeaths(g);
      return { state, events: g.ev };
    }

    case 'useTrack': {
      if (state.phase !== 'main1' && state.phase !== 'main2') return fail('Cannot use track now');
      const pl = state.players[player];
      if (pl.track.usedThisTurn) return fail('Track already used this turn');
      const god = GODS[pl.god];
      const ability = god?.abilities[action.tier];
      if (!ability) return fail('No such ability');
      if (pl.track.charges < ability.cost) return fail('Not enough charges');
      const targets = action.targets ?? [];
      const tErr = validateTargets(g, player, ability.targets, targets);
      if (tErr) return fail(tErr);
      pl.track.charges -= ability.cost;
      pl.track.usedThisTurn = true;
      emit(g, { t: 'trackUsed', player, tier: action.tier });
      GOD_ABILITIES[pl.god]?.[action.tier]?.(g, player, targets);
      processDeaths(g);
      return { state, events: g.ev };
    }

    case 'mulligan':
      return fail('Mulligan phase is over');
    case 'resolveChoice':
      return fail('No choice pending');
  }
}

// ---------------------------------------------------------------------------
// Views / redaction
// ---------------------------------------------------------------------------

export const HIDDEN = '???';

/** hide information `viewer` must not see (opponent hand, both deck orders) */
export function redactState(state: GameState, viewer: 0 | 1): GameState {
  const s = structuredClone(state);
  for (const p of [0, 1] as const) {
    s.players[p].deck = s.players[p].deck.map(() => HIDDEN);
    s.players[p].bag = [...s.players[p].bag].sort();
    if (p !== viewer) {
      s.players[p].hand = s.players[p].hand.map(() => HIDDEN);
    }
  }
  if (s.pendingChoice && s.pendingChoice.player !== viewer) {
    s.pendingChoice = { ...s.pendingChoice, options: [] };
  }
  return s;
}

// ---------------------------------------------------------------------------
// Legality summaries (drives UI enablement and the AI)
// ---------------------------------------------------------------------------

export interface PlayableCard {
  handIndex: number;
  defId: string;
  slots: number[];              // empty when no slot needed
  targetSpecs: TargetSpec[];
  needsSacrifices: number;
}

export function listPlayable(state: GameState, player: 0 | 1): PlayableCard[] {
  if (state.winner !== null || state.pendingChoice || state.active !== player) return [];
  if (state.phase !== 'main1' && state.phase !== 'main2') return [];
  const g: G = { s: state, ev: [] };
  const pl = state.players[player];
  const out: PlayableCard[] = [];
  pl.hand.forEach((defId, handIndex) => {
    const def = cardDef(defId);
    if (def.type === 'token') return;
    if (!canPayCost(g, player, effectiveCost(g, player, defId))) return;
    const needsSlot = def.type === 'creature' || def.type === 'aura';
    const slots = needsSlot ? legalPlacementSlots(g, player) : [];
    if (needsSlot && slots.length === 0) return;
    if (def.type === 'decree' && pl.decrees.length >= MAX_DECREES) return;
    const needSac = pl.freeSacrifices ? 0 : (def.sacrifice ?? 0);
    const sacrificable = creaturesOf(g, player).filter((c) => !SCRIPTS[c.defId]?.cannotBeSacrificed);
    if (needSac > sacrificable.length) return;
    // required, non-satisfiable targets block the play
    for (const spec of def.targets ?? []) {
      if (!spec.optional && spec.kind === 'creature' && listValidCreatureTargets(g, player, spec).length === 0) {
        // playable with target skipped (validateTargets allows this) — keep
      }
    }
    out.push({ handIndex, defId, slots, targetSpecs: def.targets ?? [], needsSacrifices: needSac });
  });
  return out;
}

export function listStanceable(state: GameState, player: 0 | 1): number[] {
  if (state.winner !== null || state.pendingChoice) return [];
  if (state.active !== player || state.phase !== 'main1') return [];
  const g: G = { s: state, ev: [] };
  return creaturesOf(g, player)
    .filter((c) => !c.inAttackStance && canEnterStance(g, c))
    .map((c) => c.uid);
}

export interface ActivatableInfo {
  uid: number;
  defId: string;
  targetSpecs: TargetSpec[];
}

export function listActivatable(state: GameState, player: 0 | 1): ActivatableInfo[] {
  if (state.winner !== null || state.pendingChoice || state.active !== player) return [];
  if (state.phase !== 'main1' && state.phase !== 'main2') return [];
  const g: G = { s: state, ev: [] };
  const out: ActivatableInfo[] = [];
  for (const c of boardOf(g, player)) {
    if (c.nullified) continue;
    const ab = SCRIPTS[c.defId]?.activatable;
    if (!ab) continue;
    if ((c.counters.activatedTurn ?? -1) === state.turn) continue;
    if (c.playedOnTurn === state.turn && !hasKw(g, c, 'Rushdown')) continue;
    if (!canPayCost(g, player, ab.cost)) continue;
    out.push({ uid: c.uid, defId: c.defId, targetSpecs: ab.targets ?? [] });
  }
  return out;
}

export function listUsableTrackTiers(state: GameState, player: 0 | 1): (0 | 1 | 2)[] {
  if (state.winner !== null || state.pendingChoice || state.active !== player) return [];
  if (state.phase !== 'main1' && state.phase !== 'main2') return [];
  const pl = state.players[player];
  if (pl.track.usedThisTurn) return [];
  const out: (0 | 1 | 2)[] = [];
  ([0, 1, 2] as const).forEach((tier) => {
    if (pl.track.charges >= TRACK_TIERS[tier]) out.push(tier);
  });
  return out;
}
