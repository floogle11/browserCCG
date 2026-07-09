// Greedy playtest AI. Never inspects hidden information beyond what a player
// could see; picks one action at a time so the driver can animate each step.

import type { Action, GameState, TargetRef, TargetSpec, CreatureInstance } from './types.ts';
import { cardDef, totalCost, GODS } from './data.ts';
import {
  listPlayable, listStanceable, listActivatable, listUsableTrackTiers,
  listValidCreatureTargets, canEnterStance,
} from './game.ts';
import { G, boardOf, creaturesOf, getAttack, hasKw, facingSlot, byUid, legalPlacementSlots, SCRIPTS } from './ctx.ts';

/** Choose the next action for `player`. Returns endTurn when out of ideas. */
export function aiNextAction(state: GameState, player: 0 | 1): Action {
  const g: G = { s: state, ev: [] };

  if (state.pendingChoice && state.pendingChoice.player === player) {
    const c = state.pendingChoice;
    const picks = c.options.slice(0, Math.max(c.min, Math.min(1, c.max)));
    return { kind: 'resolveChoice', picks: picks.slice(0, c.max) };
  }

  if (state.phase === 'mulligan') {
    // mulligan once if the hand is all 5+ cost cards
    const pl = state.players[player];
    const expensive = pl.hand.every((id) => totalCost(id) >= 5);
    return { kind: 'mulligan', keep: !(expensive && pl.mulligansUsed === 0) };
  }

  if (state.active !== player || state.winner !== null) return { kind: 'endTurn' };

  // 1. play the highest-value affordable card
  const playable = listPlayable(state, player);
  let best: { score: number; action: Action } | null = null;
  for (const p of playable) {
    const def = cardDef(p.defId);
    // never AI-sacrifice more than half the board away
    const sacrificable = creaturesOf(g, player).filter((c) => !SCRIPTS[c.defId]?.cannotBeSacrificed);
    if (p.needsSacrifices > 0 && sacrificable.length <= p.needsSacrifices) continue;
    // don't nuke own board with symmetric wipes while ahead
    if ((p.defId === 'aldranaris_wrath' || p.defId === 'destroy_rebuild' || p.defId === 'cave_in') &&
        creaturesOf(g, player).length >= creaturesOf(g, 1 - player as 0 | 1).length) continue;

    const targets = pickTargets(g, player, p.targetSpecs);
    if (targets === null) continue;
    const action: Action = {
      kind: 'playCard',
      handIndex: p.handIndex,
      targets,
      sacrifices: p.needsSacrifices > 0
        ? sacrificable.sort((a, b) => a.attack + a.health - (b.attack + b.health)).slice(0, p.needsSacrifices).map((c) => c.uid)
        : undefined,
      slot: p.slots.length > 0 ? pickSlot(g, player, p.slots, def.keywords?.includes('Defender') ?? false) : undefined,
    };
    const score = totalCost(p.defId) + (def.type === 'creature' ? 1 : 0);
    if (!best || score > best.score) best = { score, action };
  }
  if (best) return best.action;

  // 2. activate abilities with obvious targets
  for (const ab of listActivatable(state, player)) {
    const targets = pickTargets(g, player, ab.targetSpecs);
    if (targets !== null) return { kind: 'activate', uid: ab.uid, targets };
  }

  // 3. devotion track (cheapest affordable tier)
  const tiers = listUsableTrackTiers(state, player);
  if (tiers.length > 0) {
    const tier = tiers[0];
    const specs = GODS[state.players[player].god]?.abilities[tier]?.targets ?? [];
    const targets = pickTargets(g, player, specs);
    if (targets !== null) return { kind: 'useTrack', tier, targets };
  }

  // 4. set attack stances (main1), then attack
  if (state.phase === 'main1') {
    const enemy = (1 - player) as 0 | 1;
    const enemyHp = state.players[enemy].hp;
    const totalDamage = creaturesOf(g, player)
      .filter((c) => c.inAttackStance || canEnterStance(g, c))
      .reduce((sum, c) => sum + getAttack(g, c), 0);
    const lethalPush = totalDamage >= enemyHp;

    for (const uid of listStanceable(state, player)) {
      const c = byUid(g, uid)!;
      if (lethalPush || goodAttack(g, c)) return { kind: 'toggleStance', uid };
    }
    if (creaturesOf(g, player).some((c) => c.inAttackStance)) return { kind: 'beginAttack' };
  }

  return { kind: 'endTurn' };
}

function goodAttack(g: G, c: CreatureInstance): boolean {
  const enemy = (1 - c.owner) as 0 | 1;
  const atk = getAttack(g, c);
  if (atk <= 0) return false;
  const facing = g.s.players[enemy].board[facingSlot(c.slot)];
  const defenders = boardOf(g, enemy).filter(
    (d) => hasKw(g, d, 'Defender') && Math.abs(d.slot - facingSlot(c.slot)) <= 1 && d.health > 0
  );
  const target = !hasKw(g, c, 'Forcing') && defenders.length > 0 ? defenders[0] : facing;
  if (!target || target.health <= 0) return true; // face damage is always fine
  const kills = atk >= target.health + (hasKw(g, c, 'Pierce') ? 0 : target.armor);
  const survives = target.isAura || getAttack(g, target) < c.health; // stance drops armor
  return kills || survives;
}

function pickSlot(g: G, player: 0 | 1, slots: number[], isDefender: boolean): number {
  const enemy = (1 - player) as 0 | 1;
  if (isDefender) {
    // face the biggest enemy attacker
    let bestSlot = slots[0];
    let bestAtk = -1;
    for (const s of slots) {
      const foe = g.s.players[enemy].board[facingSlot(s)];
      const atk = foe ? getAttack(g, foe) : 0;
      if (atk > bestAtk) { bestAtk = atk; bestSlot = s; }
    }
    return bestSlot;
  }
  // prefer an empty facing slot (free face damage)
  for (const s of slots) {
    if (g.s.players[enemy].board[facingSlot(s)] === null) return s;
  }
  return slots[0];
}

/** Returns null when a required target cannot be satisfied. */
function pickTargets(g: G, player: 0 | 1, specs: TargetSpec[]): TargetRef[] | null {
  const refs: TargetRef[] = [];
  const used = new Set<number>();
  for (const spec of specs) {
    let ref: TargetRef | null = null;
    if (spec.kind === 'creature' || spec.kind === 'any') {
      const cands = listValidCreatureTargets(g, player, { ...spec, kind: 'creature' })
        .filter((c) => !used.has(c.uid));
      if (cands.length > 0) {
        // damage enemies: biggest first; buffs on allies: biggest first too
        const preferEnemy = spec.side !== 'ally';
        const pool = preferEnemy ? cands.filter((c) => c.owner !== player) : cands.filter((c) => c.owner === player);
        const pick = (pool.length > 0 ? pool : cands)
          .sort((a, b) => b.attack + b.health - (a.attack + a.health))[0];
        used.add(pick.uid);
        ref = { type: 'creature', uid: pick.uid };
      } else if (spec.kind === 'any') {
        ref = { type: 'god', player: (1 - player) as 0 | 1 };
      }
    } else if (spec.kind === 'god') {
      ref = { type: 'god', player: (1 - player) as 0 | 1 };
    } else if (spec.kind === 'slot') {
      const empties = legalPlacementSlots(g, player);
      const all = g.s.players[player].board
        .map((c, i) => (c === null ? i : -1))
        .filter((i) => i >= 0 && !refs.some((r) => r.type === 'slot' && r.slot === i));
      const slot = (empties.find((s) => all.includes(s)) ?? all[0]);
      if (slot !== undefined) ref = { type: 'slot', player, slot };
    } else if (spec.kind === 'column') {
      // column with the most enemy creatures
      const enemy = (1 - player) as 0 | 1;
      let bestCol = 0;
      let bestCount = -1;
      for (let col = 0; col < 6; col++) {
        const foe = g.s.players[enemy].board[facingSlot(col)];
        const n = foe && !foe.isAura ? 1 : 0;
        if (n > bestCount) { bestCount = n; bestCol = col; }
      }
      ref = { type: 'column', col: bestCol };
    }
    if (ref === null) {
      if (spec.optional) continue;
      if (spec.kind === 'creature') continue; // engine allows skipping unsatisfiable required creature targets
      return null;
    }
    refs.push(ref);
  }
  return refs;
}
