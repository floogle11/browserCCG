// Mutation helpers + script registries. Card behaviors live in scripts.ts and
// register themselves here; game.ts drives turns/actions through these helpers.

import type {
  CardDef, Cost, CreatureInstance, Devotion, GameEvent, GameState, Keyword,
  TargetRef, TargetSpec,
} from './types.ts';
import { BOARD_SLOTS, GOD_HP } from './types.ts';
import { cardDef, totalCost } from './data.ts';
import { randInt } from './rng.ts';

/** Mutable game wrapper passed to every helper and script. */
export interface G {
  s: GameState;
  ev: GameEvent[];
}

// ---------------------------------------------------------------------------
// Script registry (populated by scripts.ts)
// ---------------------------------------------------------------------------

export interface CardScript {
  /** battlecry — fires when entering the battlefield from hand or graveyard */
  onSummon?(g: G, self: CreatureInstance, targets: TargetRef[]): void;
  /** deathrattle */
  onCrossing?(g: G, self: CreatureInstance): void;
  /** this card's damage killed a creature */
  onLethal?(g: G, self: CreatureInstance, victimDefId: string): void;
  /** this creature dealt damage to a creature (combat or ability) */
  onDealtDamageToCreature?(g: G, self: CreatureInstance, target: CreatureInstance, amount: number): void;
  /** this creature dealt damage to a god */
  onDealtDamageToGod?(g: G, self: CreatureInstance, god: 0 | 1, amount: number): void;
  /** any creature died while self is on the battlefield */
  onAnyDeath?(g: G, self: CreatureInstance, deadDefId: string, deadOwner: 0 | 1): void;
  /** any creature was sacrificed while self is on the battlefield */
  onAnySacrifice?(g: G, self: CreatureInstance, deadDefId: string, deadOwner: 0 | 1): void;
  /** controller's start step */
  onStartOfTurn?(g: G, self: CreatureInstance): void;
  /** start of EITHER player's turn (auras like Vrya's Labyrinth) */
  onGlobalStartOfTurn?(g: G, self: CreatureInstance, activePlayer: 0 | 1): void;
  /** controller's end step */
  onEndOfTurn?(g: G, self: CreatureInstance): void;
  /** controller played any card while self is on the battlefield */
  onOwnerPlayedCard?(g: G, self: CreatureInstance, defId: string): void;
  /** any creature entered the battlefield while self is on the battlefield */
  onAnySummon?(g: G, self: CreatureInstance, entered: CreatureInstance): void;
  /** controller drew a card while self is on the battlefield */
  onOwnerDrew?(g: G, self: CreatureInstance, defId: string): void;
  /** burn damage was dealt somewhere while self is on the battlefield */
  onBurnDamage?(g: G, self: CreatureInstance): void;
  /** conditional attack bonus (Battle Tested) */
  attackBonus?(g: G, self: CreatureInstance): number;
  /** activated ability */
  activatable?: {
    cost: Cost;
    targets?: TargetSpec[];
    run(g: G, self: CreatureInstance, targets: TargetRef[]): void;
  };
  /** spell resolution; return 'hand' to bounce the card back instead of graveyard */
  spell?(g: G, caster: 0 | 1, targets: TargetRef[]): void | 'hand';
  /** flat flags */
  cannotBeSacrificed?: boolean;
  returnsToHandOnSacrifice?: boolean;
  /** Cyclops Enforcer style: does self prevent `other` (same owner) from attacking? */
  blocksAllyAttack?(g: G, self: CreatureInstance, other: CreatureInstance): boolean;
  /** does self grant Forcing to `other` (same owner)? */
  grantsForcing?(g: G, self: CreatureInstance, other: CreatureInstance): boolean;
  /** extra damage the owner's god takes (Dalguarde Fortress) */
  godDamageTakenBonus?(g: G, self: CreatureInstance, damagedPlayer: 0 | 1): number;
  /** Flamebright Shaman: burn application multiplier contributed by self */
  burnMultiplier?: number;
  /** decree behavior */
  decree?: {
    event: 'enemySummon' | 'creatureDamagedMyGod';
    run(g: G, owner: 0 | 1, payload: CreatureInstance): void;
  };
}

export type ChoiceHandler = (g: G, player: 0 | 1, picks: string[], data: Record<string, unknown>) => void;
export type GodAbility = (g: G, player: 0 | 1, targets: TargetRef[]) => void;

export const SCRIPTS: Record<string, CardScript> = {};
export const CHOICES: Record<string, ChoiceHandler> = {};
export const GOD_ABILITIES: Record<string, GodAbility[]> = {};

export function registerScripts(map: Record<string, CardScript>): void {
  Object.assign(SCRIPTS, map);
}
export function registerChoices(map: Record<string, ChoiceHandler>): void {
  Object.assign(CHOICES, map);
}
export function registerGod(id: string, abilities: GodAbility[]): void {
  GOD_ABILITIES[id] = abilities;
}

export function scriptOf(c: CreatureInstance): CardScript | undefined {
  if (c.nullified) return undefined;
  return SCRIPTS[c.defId];
}

// ---------------------------------------------------------------------------
// Basic accessors
// ---------------------------------------------------------------------------

export const opp = (p: 0 | 1): 0 | 1 => (p === 0 ? 1 : 0);

export function emit(g: G, e: GameEvent): void {
  g.ev.push(e);
}

export function boardOf(g: G, p: 0 | 1): CreatureInstance[] {
  return g.s.players[p].board.filter((c): c is CreatureInstance => c !== null);
}

/** all board occupants, both players */
export function allBoard(g: G): CreatureInstance[] {
  return [...boardOf(g, 0), ...boardOf(g, 1)];
}

/** non-aura creatures only */
export function creaturesOf(g: G, p: 0 | 1): CreatureInstance[] {
  return boardOf(g, p).filter((c) => !c.isAura);
}

export function byUid(g: G, uid: number): CreatureInstance | undefined {
  return allBoard(g).find((c) => c.uid === uid);
}

export function facingSlot(slot: number): number {
  return BOARD_SLOTS - 1 - slot;
}

export function adjacentOf(g: G, c: CreatureInstance): CreatureInstance[] {
  const row = g.s.players[c.owner].board;
  const out: CreatureInstance[] = [];
  if (c.slot > 0 && row[c.slot - 1]) out.push(row[c.slot - 1]!);
  if (c.slot < BOARD_SLOTS - 1 && row[c.slot + 1]) out.push(row[c.slot + 1]!);
  return out;
}

export function hasKw(g: G, c: CreatureInstance, k: Keyword): boolean {
  if (c.keywords.includes(k)) return true;
  if (k === 'Forcing') {
    for (const ally of boardOf(g, c.owner)) {
      if (ally.uid !== c.uid && scriptOf(ally)?.grantsForcing?.(g, ally, c)) return true;
    }
  }
  return false;
}

export function getAttack(g: G, c: CreatureInstance): number {
  let a = c.attack;
  const bonus = scriptOf(c)?.attackBonus?.(g, c) ?? 0;
  return Math.max(0, a + bonus);
}

// ---------------------------------------------------------------------------
// Cards / zones
// ---------------------------------------------------------------------------

/** put a card def id into a player's graveyard (fires Gravekeeper's Hut) */
export function cardToGraveyard(g: G, p: 0 | 1, defId: string): void {
  g.s.players[p].graveyard.push(defId);
  const def = cardDef(defId);
  if (def.type === 'creature' || def.type === 'token') {
    for (const c of allBoard(g)) {
      if (c.defId === 'gravekeepers_hut' && !c.nullified) draw(g, p, 1);
    }
  }
}

export function draw(g: G, p: 0 | 1, count: number): void {
  for (let i = 0; i < count; i++) {
    if (g.s.winner !== null) return;
    const pl = g.s.players[p];
    const defId = pl.deck.shift();
    if (defId === undefined) {
      setWinner(g, opp(p));
      return;
    }
    pl.hand.push(defId);
    emit(g, { t: 'draw', player: p, defId });
    for (const c of boardOf(g, p)) scriptOf(c)?.onOwnerDrew?.(g, c, defId);
    processDeaths(g);
  }
}

/** forced discard: leftmost (oldest) card, per the design sheets */
export function discardLeftmost(g: G, p: 0 | 1, count: number): void {
  for (let i = 0; i < count; i++) {
    const pl = g.s.players[p];
    const defId = pl.hand.shift();
    if (defId === undefined) return;
    emit(g, { t: 'discard', player: p, defId });
    cardToGraveyard(g, p, defId);
  }
}

export function setWinner(g: G, w: 0 | 1 | 'draw'): void {
  if (g.s.winner !== null) {
    // simultaneous deaths become a draw
    if (g.s.winner !== w) g.s.winner = 'draw';
  } else {
    g.s.winner = w;
  }
  g.s.phase = 'ended';
  emit(g, { t: 'gameOver', winner: g.s.winner });
}

// ---------------------------------------------------------------------------
// Creature lifecycle
// ---------------------------------------------------------------------------

export function makeInstance(g: G, defId: string, owner: 0 | 1, slot: number): CreatureInstance {
  const def = cardDef(defId);
  return {
    uid: g.s.nextUid++,
    defId,
    owner,
    slot,
    attack: def.attack ?? 0,
    health: def.health ?? 1,
    maxHealth: def.health ?? 1,
    armor: def.armor ?? 0,
    baseArmor: def.armor ?? 0,
    keywords: [...(def.keywords ?? [])],
    statuses: { burn: 0, poisonedBy: null, snareTurns: 0, sanctuary: 0, aegis: false, mustAttack: false },
    inAttackStance: false,
    attackTargetUid: null,
    playedOnTurn: g.s.turn,
    nullified: false,
    isAura: def.type === 'aura',
    isToken: def.type === 'token',
    counters: {},
  };
}

export interface SummonOpts {
  targets?: TargetRef[];
  /** tokens & reanimation skip "enters battlefield" Summon triggers? No — they all fire. */
  quiet?: boolean;
}

export function summonFromDef(g: G, p: 0 | 1, defId: string, slot: number, opts: SummonOpts = {}): CreatureInstance | null {
  const row = g.s.players[p].board;
  if (slot < 0 || slot >= BOARD_SLOTS || row[slot] !== null) return null;
  const inst = makeInstance(g, defId, p, slot);
  row[slot] = inst;
  emit(g, { t: 'summon', player: p, uid: inst.uid, defId, slot });

  if (!inst.isAura) {
    // enemy decrees that react to summons
    consumeDecrees(g, opp(p), 'enemySummon', inst);
    // global "enters battlefield" observers (Snipers Nest, Fields of Corruption, Dalguarde Fortress)
    for (const c of allBoard(g)) {
      if (c.uid !== inst.uid) scriptOf(c)?.onAnySummon?.(g, c, inst);
    }
  }
  // battlecry
  if (!inst.nullified && row[slot] === inst && inst.health > 0) {
    scriptOf(inst)?.onSummon?.(g, inst, opts.targets ?? []);
  }
  processDeaths(g);
  return inst;
}

export function consumeDecrees(
  g: G,
  owner: 0 | 1,
  event: 'enemySummon' | 'creatureDamagedMyGod',
  payload: CreatureInstance
): void {
  const pl = g.s.players[owner];
  const remaining = [];
  for (const d of pl.decrees) {
    const script = SCRIPTS[d.defId]?.decree;
    if (script && script.event === event) {
      emit(g, { t: 'decreeFired', defId: d.defId, owner });
      script.run(g, owner, payload);
      cardToGraveyard(g, owner, d.defId);
    } else {
      remaining.push(d);
    }
  }
  pl.decrees = remaining;
}

export interface DamageOpts {
  pierce?: boolean;
  sourceUid?: number;
  sourcePlayer?: 0 | 1;
  isCombat?: boolean;
  isBurn?: boolean;
  /** attacker in the attack phase (enables Cleave/Crushing/Lethal chains handled by caller) */
  isAttacker?: boolean;
}

/** Deal damage to a creature. Returns actual damage dealt (armor + health). */
export function damageCreature(g: G, target: CreatureInstance, amount: number, o: DamageOpts = {}): number {
  if (amount <= 0 || target.health <= 0) return 0;
  // Sanctuary blocks enemy non-combat effects entirely
  if (!o.isCombat && o.sourcePlayer !== undefined && o.sourcePlayer !== target.owner && target.statuses.sanctuary > 0) {
    return 0;
  }
  if (target.statuses.aegis) {
    target.statuses.aegis = false;
    emit(g, { t: 'aegisPopped', uid: target.uid });
    return 0;
  }
  const pierce = o.pierce || o.isBurn;
  let remaining = amount;
  let dealt = 0;
  if (!pierce && target.armor > 0) {
    const absorbed = Math.min(target.armor, remaining);
    target.armor -= absorbed;
    remaining -= absorbed;
    dealt += absorbed;
  }
  if (remaining > 0) {
    target.health -= remaining;
    dealt += remaining;
  }
  emit(g, {
    t: 'damage', targetUid: target.uid, amount: dealt,
    kind: o.isBurn ? 'burn' : o.isCombat ? 'combat' : 'effect',
  });

  const source = o.sourceUid !== undefined ? byUid(g, o.sourceUid) : undefined;
  if (source && dealt > 0) {
    scriptOf(source)?.onDealtDamageToCreature?.(g, source, target, dealt);
    if (hasKw(g, source, 'Poisonous') && target.health > 0) {
      target.statuses.poisonedBy = source.owner;
      emit(g, { t: 'status', uid: target.uid, status: 'poisoned', value: true });
    }
    if (hasKw(g, source, 'Lifetap')) healGod(g, source.owner, dealt);
    if (target.health <= 0) {
      (target as CreatureInstance & { killedByUid?: number }).killedByUid = source.uid;
    }
  }
  if (o.isBurn && dealt > 0) {
    for (const c of allBoard(g)) scriptOf(c)?.onBurnDamage?.(g, c);
  }
  return dealt;
}

export function damageGod(g: G, p: 0 | 1, amount: number, o: DamageOpts = {}): number {
  if (amount <= 0 || g.s.winner !== null) return 0;
  let total = amount;
  for (const c of boardOf(g, p)) {
    total += scriptOf(c)?.godDamageTakenBonus?.(g, c, p) ?? 0;
  }
  g.s.players[p].hp -= total;
  emit(g, { t: 'damage', targetGod: p, amount: total, kind: o.isCombat ? 'combat' : 'effect' });

  const source = o.sourceUid !== undefined ? byUid(g, o.sourceUid) : undefined;
  if (source) {
    scriptOf(source)?.onDealtDamageToGod?.(g, source, p, total);
    if (hasKw(g, source, 'Lifetap')) healGod(g, source.owner, total);
    // True Form: a creature damaged my god
    consumeDecrees(g, p, 'creatureDamagedMyGod', source);
  }
  checkGodDeaths(g);
  return total;
}

export function checkGodDeaths(g: G): void {
  const dead0 = g.s.players[0].hp <= 0;
  const dead1 = g.s.players[1].hp <= 0;
  if (dead0 && dead1) setWinner(g, 'draw');
  else if (dead0) setWinner(g, 1);
  else if (dead1) setWinner(g, 0);
}

export function healGod(g: G, p: 0 | 1, amount: number): void {
  if (amount <= 0) return;
  const pl = g.s.players[p];
  pl.hp = Math.min(GOD_HP, pl.hp + amount);
  emit(g, { t: 'heal', targetGod: p, amount });
}

export function healCreature(g: G, c: CreatureInstance, amount: number): void {
  if (amount <= 0) return;
  c.health = Math.min(c.maxHealth, c.health + amount);
  emit(g, { t: 'heal', targetUid: c.uid, amount });
}

export function buffCreature(g: G, c: CreatureInstance, attack: number, health: number, armor = 0): void {
  c.attack += attack;
  c.maxHealth += health;
  c.health += health;
  c.baseArmor = Math.max(0, c.baseArmor + armor);
  c.armor = Math.max(0, c.armor + armor);
  emit(g, { t: 'buff', uid: c.uid, attack, health, armor });
  processDeaths(g);
}

export function applyBurn(g: G, target: CreatureInstance, amount: number, sourcePlayer?: 0 | 1): void {
  if (amount <= 0 || target.health <= 0) return;
  if (sourcePlayer !== undefined && sourcePlayer !== target.owner && target.statuses.sanctuary > 0) return;
  let mult = 1;
  for (const c of allBoard(g)) {
    const m = scriptOf(c)?.burnMultiplier;
    if (m) mult *= m;
  }
  target.statuses.burn += amount * mult;
  emit(g, { t: 'status', uid: target.uid, status: 'burn', value: target.statuses.burn });
}

/** end-of-turn burn tick: damage then decrement */
export function burnTick(g: G): void {
  for (const c of allBoard(g)) {
    if (c.statuses.burn > 0 && c.health > 0) {
      damageCreature(g, c, c.statuses.burn, { isBurn: true });
      c.statuses.burn = Math.max(0, c.statuses.burn - 1);
    }
  }
  processDeaths(g);
}

/** Burst Into Flames: trigger burn damage without decrementing */
export function burstBurn(g: G): void {
  for (const c of allBoard(g)) {
    if (c.statuses.burn > 0 && c.health > 0) {
      damageCreature(g, c, c.statuses.burn, { isBurn: true });
    }
  }
  processDeaths(g);
}

export function snareCreature(g: G, c: CreatureInstance, sourcePlayer?: 0 | 1): void {
  if (sourcePlayer !== undefined && sourcePlayer !== c.owner && c.statuses.sanctuary > 0) return;
  c.statuses.snareTurns = Math.max(c.statuses.snareTurns, 1);
  if (c.inAttackStance) c.inAttackStance = false;
  emit(g, { t: 'status', uid: c.uid, status: 'snared', value: true });
}

export function nullifyCreature(g: G, c: CreatureInstance, sourcePlayer?: 0 | 1): void {
  if (sourcePlayer !== undefined && sourcePlayer !== c.owner && c.statuses.sanctuary > 0) return;
  const def = cardDef(c.defId);
  c.nullified = true;
  c.keywords = [];
  c.attack = def.attack ?? 0;
  c.maxHealth = def.health ?? 1;
  c.health = Math.min(c.health, c.maxHealth);
  c.baseArmor = def.armor ?? 0;
  c.armor = Math.min(c.armor, c.baseArmor);
  c.statuses = { burn: 0, poisonedBy: null, snareTurns: 0, sanctuary: 0, aegis: false, mustAttack: false };
  emit(g, { t: 'status', uid: c.uid, status: 'nullified', value: true });
  processDeaths(g);
}

export function purifyCreature(g: G, c: CreatureInstance): void {
  const def = cardDef(c.defId);
  c.statuses.burn = 0;
  c.statuses.poisonedBy = null;
  c.statuses.snareTurns = 0;
  c.attack = Math.max(c.attack, def.attack ?? 0);
  emit(g, { t: 'status', uid: c.uid, status: 'purified', value: true });
}

export interface KillOpts {
  obliterate?: boolean;
  /** graveyard the card goes to (Safe Keeping) */
  graveyardOwner?: 0 | 1;
  /** blocked by sanctuary for enemy effects */
  sourcePlayer?: 0 | 1;
}

/** Hard destroy (bypasses armor/aegis). */
export function destroyCreature(g: G, c: CreatureInstance, o: KillOpts = {}): void {
  if (c.health <= 0) return;
  if (o.sourcePlayer !== undefined && o.sourcePlayer !== c.owner && c.statuses.sanctuary > 0) return;
  c.health = 0;
  const marked = c as CreatureInstance & { _obliterate?: boolean; _gyOwner?: 0 | 1 };
  if (o.obliterate) marked._obliterate = true;
  if (o.graveyardOwner !== undefined) marked._gyOwner = o.graveyardOwner;
  processDeaths(g);
}

/** Sacrifice pipeline (Unscathed Chicken returns to hand; Grave Tithe observes). */
export function sacrificeCreature(g: G, c: CreatureInstance): boolean {
  if (c.health <= 0) return false;
  if (SCRIPTS[c.defId]?.cannotBeSacrificed) return false;
  const owner = c.owner;
  const defId = c.defId;
  if (SCRIPTS[defId]?.returnsToHandOnSacrifice && !c.nullified && !c.isToken) {
    g.s.players[owner].board[c.slot] = null;
    g.s.players[owner].hand.push(defId);
    emit(g, { t: 'info', msg: `${cardDef(defId).name} returns to hand instead of being sacrificed away` });
  } else {
    c.health = 0;
    processDeaths(g);
  }
  for (const w of allBoard(g)) scriptOf(w)?.onAnySacrifice?.(g, w, defId, owner);
  return true;
}

/**
 * Remove dead creatures, firing Lethal, Crossing and observer hooks.
 * Loops until stable (deathrattles can cause more deaths).
 */
export function processDeaths(g: G): void {
  for (let guard = 0; guard < 100; guard++) {
    const dead: CreatureInstance[] = [];
    for (const p of [0, 1] as const) {
      for (const c of g.s.players[p].board) {
        if (c && c.health <= 0) dead.push(c);
      }
    }
    if (dead.length === 0) break;
    for (const c of dead) {
      const marked = c as CreatureInstance & { _obliterate?: boolean; _gyOwner?: 0 | 1; killedByUid?: number };
      g.s.players[c.owner].board[c.slot] = null;
      g.s.diedThisTurn.push(c.defId);
      if (marked._obliterate) {
        emit(g, { t: 'obliterated', uid: c.uid, defId: c.defId });
        if (!c.isToken) g.s.players[c.owner].banished.push(c.defId);
      } else {
        emit(g, { t: 'death', uid: c.uid, defId: c.defId });
        if (!c.isToken) cardToGraveyard(g, marked._gyOwner ?? c.owner, c.defId);
      }
      // Lethal on the killer
      if (marked.killedByUid !== undefined) {
        const killer = byUid(g, marked.killedByUid);
        if (killer) scriptOf(killer)?.onLethal?.(g, killer, c.defId);
      }
      // Crossing (deathrattle) — not for nullified creatures
      if (!c.nullified && !marked._obliterate) scriptOf(c)?.onCrossing?.(g, c);
      // observers
      if (!c.isAura) {
        for (const w of allBoard(g)) scriptOf(w)?.onAnyDeath?.(g, w, c.defId, c.owner);
      }
    }
    refreshDynamicStats(g);
  }
}

/** Rubble-style creatures recompute stats from game state. */
export function refreshDynamicStats(g: G): void {
  for (const c of allBoard(g)) {
    if (c.defId === 'rubble' && !c.nullified) {
      const n = g.s.players[c.owner].graveyard.filter((id) => cardDef(id).type === 'creature').length;
      c.attack = n;
      const prevMax = c.maxHealth;
      c.maxHealth = n;
      c.health = Math.min(c.health + Math.max(0, n - prevMax), c.maxHealth);
      if (n <= 0) c.health = 0;
    }
  }
}

export function transformCreature(g: G, c: CreatureInstance, intoDefId: string): void {
  const fresh = makeInstance(g, intoDefId, c.owner, c.slot);
  fresh.playedOnTurn = c.playedOnTurn;
  g.s.players[c.owner].board[c.slot] = fresh;
  emit(g, { t: 'transform', uid: c.uid, into: intoDefId });
}

export function returnToHand(g: G, c: CreatureInstance): void {
  g.s.players[c.owner].board[c.slot] = null;
  if (!c.isToken) g.s.players[c.owner].hand.push(c.defId);
  emit(g, { t: 'info', msg: `${cardDef(c.defId).name} returned to hand` });
}

export function moveCreature(g: G, c: CreatureInstance, slot: number): boolean {
  const row = g.s.players[c.owner].board;
  if (slot < 0 || slot >= BOARD_SLOTS || row[slot] !== null) return false;
  row[c.slot] = null;
  row[slot] = c;
  c.slot = slot;
  emit(g, { t: 'moved', uid: c.uid, slot });
  return true;
}

// ---------------------------------------------------------------------------
// Mana
// ---------------------------------------------------------------------------

export function untappedByColor(g: G, p: 0 | 1): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of g.s.players[p].pool) {
    if (!m.tapped) out[m.color] = (out[m.color] ?? 0) + 1;
  }
  return out;
}

export function canPayCost(g: G, p: 0 | 1, cost: Cost): boolean {
  const have = untappedByColor(g, p);
  for (const [color, n] of Object.entries(cost)) {
    if ((have[color] ?? 0) < (n ?? 0)) return false;
  }
  return true;
}

/** taps crystals and adds devotion track charges */
export function payCost(g: G, p: 0 | 1, cost: Cost): boolean {
  if (!canPayCost(g, p, cost)) return false;
  const pl = g.s.players[p];
  let spent = 0;
  for (const [color, n] of Object.entries(cost)) {
    let need = n ?? 0;
    for (const m of pl.pool) {
      if (need === 0) break;
      if (!m.tapped && m.color === color) {
        m.tapped = true;
        need--;
        spent++;
      }
    }
  }
  pl.track.charges = Math.min(60, pl.track.charges + spent);
  return true;
}

export function effectiveCost(g: G, p: 0 | 1, defId: string): Cost {
  const def = cardDef(defId);
  const disc = g.s.players[p].discounts.find((d) => d.defId === defId);
  if (!disc) return def.cost;
  const out: Cost = {};
  for (const [color, n] of Object.entries(def.cost)) {
    const reduced = (n ?? 0) - (disc.cost[color as Devotion] ?? 0);
    if (reduced > 0) out[color as Devotion] = reduced;
  }
  return out;
}

export function pullMana(g: G, p: 0 | 1): void {
  const pl = g.s.players[p];
  if (pl.bag.length === 0) return;
  const i = randInt(g.s, pl.bag.length);
  const color = pl.bag.splice(i, 1)[0];
  pl.pool.push({ color, tapped: false });
  emit(g, { t: 'manaPulled', player: p, color });
}

// ---------------------------------------------------------------------------
// Misc shared queries
// ---------------------------------------------------------------------------

export function emptySlots(g: G, p: 0 | 1): number[] {
  const out: number[] = [];
  for (let i = 0; i < BOARD_SLOTS; i++) {
    if (g.s.players[p].board[i] === null) out.push(i);
  }
  return out;
}

/** legal placement slots when playing a creature/aura from hand */
export function legalPlacementSlots(g: G, p: 0 | 1): number[] {
  const row = g.s.players[p].board;
  const occupied = row.some((c) => c !== null);
  if (!occupied) return [2, 3].filter((i) => row[i] === null);
  const out: number[] = [];
  for (let i = 0; i < BOARD_SLOTS; i++) {
    if (row[i] !== null) continue;
    if ((i > 0 && row[i - 1] !== null) || (i < BOARD_SLOTS - 1 && row[i + 1] !== null)) out.push(i);
  }
  return out;
}

export function isCyclops(defId: string): boolean {
  return (cardDef(defId).tribes ?? []).includes('Cyclops');
}

export function firstLegalSlot(g: G, p: 0 | 1): number | null {
  const slots = legalPlacementSlots(g, p);
  return slots.length > 0 ? slots[0] : null;
}
