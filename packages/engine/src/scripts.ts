// Behavior for every non-vanilla card in data/cards.json, plus god devotion
// tracks and pending-choice continuations. Registered into the ctx registries.

import type { CreatureInstance, TargetRef } from './types.ts';
import { BOARD_SLOTS } from './types.ts';
import { cardDef, totalCost } from './data.ts';
import { shuffle } from './rng.ts';
import {
  G, registerScripts, registerChoices, registerGod, scriptOf,
  emit, opp, boardOf, allBoard, creaturesOf, byUid, adjacentOf, facingSlot,
  hasKw, getAttack, draw, discardLeftmost, cardToGraveyard,
  damageCreature, damageGod, healGod, healCreature, buffCreature,
  applyBurn, burnTick, burstBurn, snareCreature, nullifyCreature, purifyCreature,
  destroyCreature, sacrificeCreature, processDeaths, transformCreature,
  returnToHand, moveCreature, summonFromDef, emptySlots, firstLegalSlot,
  untappedByColor, refreshDynamicStats,
} from './ctx.ts';

// -- helpers ---------------------------------------------------------------

function creatureTarget(g: G, targets: TargetRef[], i = 0): CreatureInstance | undefined {
  const t = targets[i];
  if (t && t.type === 'creature') return byUid(g, t.uid);
  return undefined;
}

function summonBudsAdjacent(g: G, self: CreatureInstance, count: number): void {
  const row = g.s.players[self.owner].board;
  const spots = [self.slot - 1, self.slot + 1].filter(
    (i) => i >= 0 && i < BOARD_SLOTS && row[i] === null
  );
  for (const slot of spots.slice(0, count)) {
    summonFromDef(g, self.owner, 'flame_bud', slot);
  }
}

// -- card scripts ----------------------------------------------------------

registerScripts({
  flame_bud: {
    cannotBeSacrificed: true,
    onDealtDamageToCreature(g, self, target) {
      applyBurn(g, target, 1, self.owner);
    },
  },

  // ------------------------------------------------------------- Order
  dalguarde_initiate: {
    activatable: {
      cost: { O: 1 },
      run(g, self) {
        self.statuses.aegis = true;
        emit(g, { t: 'status', uid: self.uid, status: 'aegis', value: true });
      },
    },
  },
  blinding_light: {
    spell(g, caster, targets) {
      const t = creatureTarget(g, targets);
      if (!t) return;
      damageCreature(g, t, 3, { sourcePlayer: caster });
      if (t.health > 0) snareCreature(g, t, caster);
      processDeaths(g);
    },
  },
  novice_shieldmaiden: {
    activatable: {
      cost: { O: 1 },
      run(g, self) {
        buffCreature(g, self, 0, 0, 1);
      },
    },
  },
  denounce: {
    decree: {
      event: 'enemySummon',
      run(g, _owner, entered) {
        buffCreature(g, entered, -2, -2, -2);
      },
    },
  },
  dalguarde_fortress: {
    onAnySummon(g, self, entered) {
      if (entered.owner === self.owner) buffCreature(g, entered, 0, 0, 1);
    },
    godDamageTakenBonus(_g, _self, _p) {
      return 1;
    },
  },
  cyclops_recruiter: {
    onSummon(g, self) {
      const pl = g.s.players[self.owner];
      const i = pl.deck.findIndex((id) => (cardDef(id).tribes ?? []).includes('Cyclops'));
      if (i >= 0) {
        const [defId] = pl.deck.splice(i, 1);
        pl.hand.push(defId);
        emit(g, { t: 'draw', player: self.owner, defId });
        shuffle(g.s, pl.deck);
      }
    },
  },
  center_of_attention: {
    spell(g, caster, targets) {
      const t = creatureTarget(g, targets);
      if (!t) return;
      buffCreature(g, t, 0, 0, 2);
      if (!t.keywords.includes('Defender')) t.keywords.push('Defender');
    },
  },
  lock_down: {
    spell(g, caster, targets) {
      const t = targets[0];
      if (!t || t.type !== 'column') return;
      const mine = g.s.players[caster].board[t.col];
      const theirs = g.s.players[opp(caster)].board[facingSlot(t.col)];
      let snared = 0;
      for (const c of [mine, theirs]) {
        if (c && !c.isAura && c.health > 0) {
          const before = c.statuses.snareTurns;
          snareCreature(g, c, caster);
          if (c.statuses.snareTurns > before || before === 0) snared++;
        }
      }
      draw(g, caster, snared);
    },
  },
  hunker: {
    spell(g, caster) {
      for (const c of creaturesOf(g, caster)) {
        if (hasKw(g, c, 'Defender')) buffCreature(g, c, 0, 0, 2);
      }
    },
  },
  discipline: {
    spell(g, caster, targets) {
      const t = creatureTarget(g, targets);
      if (t && t.inAttackStance) destroyCreature(g, t, { sourcePlayer: caster });
    },
  },
  pack_mule: {
    onSummon(g, self) {
      const spells = g.s.players[self.owner].graveyard.filter((id) => cardDef(id).type === 'spell');
      if (spells.length === 0) return;
      g.s.pendingChoice = {
        player: self.owner, tag: 'pack_mule',
        prompt: 'Return a spell from your graveyard to your hand?',
        options: [...new Set(spells)], min: 0, max: 1,
      };
    },
  },
  cloud_piercer: {
    activatable: {
      cost: { O: 2 },
      run(g, self) {
        for (const c of allBoard(g)) {
          if (!c.isAura && c.statuses.snareTurns > 0) {
            damageCreature(g, c, 2, { pierce: true, sourceUid: self.uid, sourcePlayer: self.owner });
          }
        }
        processDeaths(g);
      },
    },
  },
  spear_supplier: {
    onSummon(g, self, targets) {
      const t = creatureTarget(g, targets);
      if (t && t.owner === self.owner && !t.keywords.includes('Pierce')) t.keywords.push('Pierce');
    },
  },
  cyclops_enforcer: {
    blocksAllyAttack(g, self, other) {
      return other.owner === self.owner && !(cardDef(other.defId).tribes ?? []).includes('Cyclops');
    },
    grantsForcing(g, self, other) {
      return other.owner === self.owner && (cardDef(other.defId).tribes ?? []).includes('Cyclops');
    },
  },
  true_form: {
    decree: {
      event: 'creatureDamagedMyGod',
      run(g, _owner, culprit) {
        destroyCreature(g, culprit, { obliterate: true });
      },
    },
  },
  light_ray: {
    spell(g, caster, targets) {
      const t = creatureTarget(g, targets);
      if (!t) return;
      if (t.statuses.snareTurns > 0) destroyCreature(g, t, { sourcePlayer: caster });
      else snareCreature(g, t, caster);
    },
  },
  time_keepers_decree: {
    decree: {
      event: 'enemySummon',
      run(g, _owner, entered) {
        entered.statuses.sanctuary = 1;
        emit(g, { t: 'status', uid: entered.uid, status: 'sanctuary', value: 1 });
      },
    },
  },
  executioner_of_valanaar: {
    onSummon(g, self, targets) {
      const t = creatureTarget(g, targets);
      if (t && getAttack(g, t) <= 4) destroyCreature(g, t, { sourcePlayer: self.owner });
    },
  },
  grand_council: {
    spell(g) {
      const all = [...creaturesOf(g, 0), ...creaturesOf(g, 1)];
      if (all.length === 0) return;
      const max = Math.max(...all.map((c) => totalCost(c.defId)));
      for (const c of all) {
        if (totalCost(c.defId) === max) destroyCreature(g, c, { obliterate: true });
      }
    },
  },
  the_life_force: {
    onCrossing(g) {
      for (const c of [...creaturesOf(g, 0), ...creaturesOf(g, 1)]) destroyCreature(g, c);
    },
  },

  // ------------------------------------------------------------- Chaos
  counterbalance: {
    spell(g, caster) {
      for (const c of creaturesOf(g, caster)) {
        if (c.inAttackStance) {
          c.inAttackStance = false;
          c.armor = c.baseArmor;
        }
      }
    },
  },
  flame_bud_pin: {
    attackBonus(_g, self) {
      return self.health < self.maxHealth ? 2 : 0;
    },
  },
  ring_dancer: {
    onSummon(g, self) {
      for (const c of adjacentOf(g, self)) {
        if (!c.keywords.includes('Shroud')) c.keywords.push('Shroud');
      }
    },
  },
  scape_goat: {
    onSummon(g, self, targets) {
      const t = creatureTarget(g, targets);
      if (t && t.owner === self.owner && t.uid !== self.uid) returnToHand(g, t);
    },
  },
  nameless_wanderer: {
    onSummon(g, self, targets) {
      const t = creatureTarget(g, targets);
      if (t && t.owner !== self.owner) nullifyCreature(g, t, self.owner);
    },
  },
  scorch: {
    spell(g, caster, targets) {
      const t = creatureTarget(g, targets);
      if (t) applyBurn(g, t, totalCost(t.defId), caster);
    },
  },
  free_from_shackles: {
    spell(g, caster, targets) {
      const ally = creatureTarget(g, targets, 0);
      const enemy = creatureTarget(g, targets, 1);
      if (enemy) destroyCreature(g, enemy, { sourcePlayer: caster });
      if (ally && ally.health > 0) returnToHand(g, ally);
    },
  },
  coalossus: {
    activatable: {
      cost: { C: 1 },
      run(g, self) {
        buffCreature(g, self, -2, -2);
        if (self.health > 0) summonBudsAdjacent(g, self, 2);
      },
    },
  },
  bomber: {
    onStartOfTurn(g, self) {
      const atk = getAttack(g, self);
      const facing = g.s.players[opp(self.owner)].board[facingSlot(self.slot)];
      destroyCreature(g, self);
      if (facing && facing.health > 0) {
        damageCreature(g, facing, atk, { sourcePlayer: self.owner });
        for (const adj of adjacentOf(g, facing)) {
          damageCreature(g, adj, atk, { sourcePlayer: self.owner });
        }
      }
      processDeaths(g);
    },
  },
  sunder: {
    spell(g, caster, targets) {
      const t = creatureTarget(g, targets);
      if (t) damageCreature(g, t, 6, { pierce: true, sourcePlayer: caster });
      processDeaths(g);
    },
  },
  snipers_nest: {
    onAnySummon(g, self, entered) {
      if (!entered.isAura) {
        damageCreature(g, entered, 1, { pierce: true });
        processDeaths(g);
      }
    },
  },
  reposition: {
    spell(g, caster, targets) {
      const a = creatureTarget(g, targets, 0);
      const b = creatureTarget(g, targets, 1);
      if (!a || !b || a.uid === b.uid || a.owner !== caster || b.owner !== caster) return;
      const row = g.s.players[caster].board;
      const sa = a.slot; const sb = b.slot;
      row[sa] = b; row[sb] = a;
      a.slot = sb; b.slot = sa;
      emit(g, { t: 'moved', uid: a.uid, slot: sb });
      emit(g, { t: 'moved', uid: b.uid, slot: sa });
    },
  },
  curse_of_callisto: {
    spell(g, caster, targets) {
      const t = creatureTarget(g, targets);
      if (t && !(caster !== t.owner && t.statuses.sanctuary > 0)) transformCreature(g, t, 'bear');
    },
  },
  heat_seeking_boulder_tosser: {
    onSummon(g, self, targets) {
      const t = creatureTarget(g, targets);
      if (t && t.statuses.burn > 0) {
        damageCreature(g, t, 5, { sourceUid: self.uid, sourcePlayer: self.owner });
        processDeaths(g);
      }
    },
  },
  the_fire_bringer: {
    onStartOfTurn(g, self) {
      summonBudsAdjacent(g, self, 2);
    },
  },
  cave_in: {
    spell(g) {
      for (const c of [...creaturesOf(g, 0), ...creaturesOf(g, 1)]) {
        if ((cardDef(c.defId).cost.C ?? 0) === 0) destroyCreature(g, c);
      }
    },
  },
  twisting_nether_ledger: {
    onStartOfTurn(g, self) {
      draw(g, self.owner, 1);
    },
    onEndOfTurn(g, self) {
      discardLeftmost(g, self.owner, 1);
    },
  },
  ember_echo: {
    spell(g, caster, targets) {
      const t = targets[0];
      if (t?.type === 'creature') {
        const c = byUid(g, t.uid);
        if (c) damageCreature(g, c, 2, { sourcePlayer: caster });
      } else if (t?.type === 'god') {
        damageGod(g, t.player, 2, { sourcePlayer: caster });
      }
      processDeaths(g);
      if (g.s.players[caster].hand.length === 0) return 'hand';
    },
  },
  hraumella: {
    onSummon(g, self) {
      let sacrificed = 0;
      for (const c of creaturesOf(g, self.owner)) {
        if (c.uid !== self.uid && sacrificeCreature(g, c)) sacrificed++;
      }
      for (const c of creaturesOf(g, opp(self.owner))) {
        applyBurn(g, c, sacrificed, self.owner);
      }
    },
  },

  // ------------------------------------------------------------- Ruin
  spiteful_spitter: {
    onCrossing(g, self) {
      const enemies = creaturesOf(g, opp(self.owner)).filter((c) => c.health > 0);
      if (enemies.length === 0) return;
      const min = Math.min(...enemies.map((c) => c.health));
      for (const c of enemies) {
        if (c.health === min) damageCreature(g, c, 1, { sourcePlayer: self.owner });
      }
      processDeaths(g);
    },
  },
  unscathed_chicken: {
    returnsToHandOnSacrifice: true,
  },
  brand: {
    spell(g, caster, targets) {
      const t = creatureTarget(g, targets);
      if (t) applyBurn(g, t, 3, caster);
    },
  },
  no_strings_attached: {
    spell(g, caster) {
      g.s.players[caster].freeSacrifices = true;
    },
  },
  burst_into_flames: {
    spell(g) {
      burstBurn(g);
    },
  },
  rubble: {
    onSummon(g) {
      refreshDynamicStats(g);
      processDeaths(g);
    },
    onStartOfTurn(g, self) {
      discardLeftmost(g, self.owner, 1);
      refreshDynamicStats(g);
      processDeaths(g);
    },
  },
  reckless_vandal: {
    onCrossing(g, self) {
      discardLeftmost(g, self.owner, 2);
    },
  },
  blindside_blocker: {
    onSummon(g, self) {
      if (self.slot === 0 || self.slot === BOARD_SLOTS - 1) buffCreature(g, self, 0, 0, 1);
    },
  },
  siphon: {
    spell(g, caster) {
      const untapped = Object.values(untappedByColor(g, opp(caster))).reduce((a, b) => a + b, 0);
      damageGod(g, opp(caster), untapped, { sourcePlayer: caster });
    },
  },
  reap_destruction: {
    spell(g, caster) {
      healGod(g, caster, g.s.diedThisTurn.length * 2);
    },
  },
  locust_swarm: {
    onDealtDamageToGod(g, self, god) {
      discardLeftmost(g, god, 1);
    },
  },
  flamebright_shaman: {
    burnMultiplier: 2,
  },
  empty_gardens: {
    spell(g, caster, targets) {
      const t = creatureTarget(g, targets);
      if (t && t.isAura) destroyCreature(g, t, { sourcePlayer: caster });
    },
  },
  corrosive_ooze: {
    onSummon(g, self) {
      let removed = 0;
      for (const c of allBoard(g)) {
        if (c.uid === self.uid) continue;
        removed += c.armor;
        c.armor = 0;
        c.baseArmor = 0;
      }
      if (removed > 0) damageCreature(g, self, removed, { pierce: true });
      processDeaths(g);
    },
  },
  repurpose: {
    spell(g, caster) {
      const pl = g.s.players[caster];
      const creatures = pl.graveyard.filter((id) => cardDef(id).type === 'creature');
      pl.graveyard = pl.graveyard.filter((id) => cardDef(id).type !== 'creature');
      pl.banished.push(...creatures);
      healGod(g, caster, creatures.length);
      refreshDynamicStats(g);
      processDeaths(g);
    },
  },
  fields_of_corruption: {
    onAnySummon(g, self, entered) {
      entered.armor = 0;
      entered.baseArmor = 0;
    },
  },
  safe_keeping: {
    spell(g, caster, targets) {
      const t = creatureTarget(g, targets);
      if (t && t.owner !== caster) destroyCreature(g, t, { sourcePlayer: caster, graveyardOwner: caster });
    },
  },
  acolyte_of_the_damned: {
    onAnyDeath(g, self) {
      healGod(g, self.owner, 2);
    },
  },
  fire_breather: {
    activatable: {
      cost: { R: 2 },
      targets: [{ kind: 'creature', side: 'any', label: 'Creature to burn' }],
      run(g, self, targets) {
        const t = creatureTarget(g, targets);
        if (t) applyBurn(g, t, 3, self.owner);
      },
    },
  },
  raging_flame: {
    spell(g, caster, targets) {
      const copies = g.s.players[caster].graveyard.filter((id) => id === 'raging_flame').length;
      const dmg = 1 + copies;
      const t = targets[0];
      if (t?.type === 'creature') {
        const c = byUid(g, t.uid);
        if (c) damageCreature(g, c, dmg, { sourcePlayer: caster });
      } else if (t?.type === 'god') {
        damageGod(g, t.player, dmg, { sourcePlayer: caster });
      }
      processDeaths(g);
    },
  },
  bloodcrazed: {
    spell(g, caster, targets) {
      const t = creatureTarget(g, targets);
      if (!t || (caster !== t.owner && t.statuses.sanctuary > 0)) return;
      if (!t.keywords.includes('Lifetap')) t.keywords.push('Lifetap');
      t.statuses.mustAttack = true;
      emit(g, { t: 'status', uid: t.uid, status: 'mustAttack', value: true });
    },
  },
  the_shallow: {
    onEndOfTurn(g, self) {
      if (g.s.players[self.owner].hand.length > 0) {
        discardLeftmost(g, self.owner, 1);
        draw(g, self.owner, 1);
      }
    },
  },
  grave_tithe: {
    onAnySacrifice(g, self) {
      damageGod(g, opp(self.owner), 1);
      healGod(g, self.owner, 1);
    },
  },
  vryas_labyrinth: {
    onGlobalStartOfTurn(g, _self, active) {
      discardLeftmost(g, active, 1);
    },
  },
  famine: {
    spell(g) {
      const c0 = creaturesOf(g, 0).length;
      const c1 = creaturesOf(g, 1).length;
      discardLeftmost(g, 0, c0);
      discardLeftmost(g, 1, c1);
    },
  },
  suspended_in_disaster: {
    spell(g, caster) {
      const options = [...new Set(
        g.s.players[caster].deck.filter(
          (id) => cardDef(id).type === 'creature' && totalCost(id) >= 2
        )
      )];
      if (options.length === 0) return;
      g.s.pendingChoice = {
        player: caster, tag: 'suspended_in_disaster',
        prompt: 'Choose a creature to summon for free',
        options, min: 1, max: 1,
      };
    },
  },
  cruel_necromancer: {
    onSummon(g, self) {
      const unique = new Set(
        g.s.players[self.owner].graveyard.filter((id) => cardDef(id).type === 'creature')
      ).size;
      if (unique > 0) {
        damageGod(g, opp(self.owner), unique, { sourcePlayer: self.owner });
        healGod(g, self.owner, unique);
      }
    },
    onCrossing(g, self) {
      const pl = g.s.players[self.owner];
      const creatures = pl.graveyard.filter((id) => cardDef(id).type === 'creature');
      pl.graveyard = pl.graveyard.filter((id) => cardDef(id).type !== 'creature');
      pl.banished.push(...creatures);
      refreshDynamicStats(g);
    },
  },
  sacred_vault_guard_hound: {
    onAnyDeath(g, self) {
      if (self.health > 0) buffCreature(g, self, 2, 2);
    },
  },
  blot: {
    onEndOfTurn(g, self) {
      const adj = adjacentOf(g, self).filter(
        (c) => !c.isAura && !scriptOf(c)?.cannotBeSacrificed
      );
      const victim = adj[0];
      if (!victim) {
        destroyCreature(g, self);
        return;
      }
      const atk = victim.attack;
      const hp = victim.maxHealth;
      if (sacrificeCreature(g, victim)) {
        if (self.health > 0) {
          buffCreature(g, self, atk, hp);
          self.statuses.aegis = true;
          emit(g, { t: 'status', uid: self.uid, status: 'aegis', value: true });
        }
      } else {
        destroyCreature(g, self);
      }
    },
  },
  doomfeed_scholar: {
    onOwnerDrew(g, self, defId) {
      const rCost = cardDef(defId).cost.R ?? 0;
      if (rCost > 0) damageGod(g, self.owner, rCost);
    },
    onEndOfTurn(g, self) {
      draw(g, self.owner, 1);
    },
  },

  // ------------------------------------------------------------- Order/Ruin
  vryas_chains: {
    spell(g, caster, targets) {
      const t = creatureTarget(g, targets);
      if (t && !(caster !== t.owner && t.statuses.sanctuary > 0)) buffCreature(g, t, -4, -4);
    },
  },
  underdark_guardian: {
    onCrossing(g, self) {
      discardLeftmost(g, opp(self.owner), 1);
    },
  },
  grave_exchange: {
    spell(g, caster, targets) {
      const t = creatureTarget(g, targets);
      if (!t || t.owner !== caster) return;
      const oldSlot = t.slot;
      if (!sacrificeCreature(g, t)) return;
      // Reanimate: top creature of graveyard
      const pl = g.s.players[caster];
      for (let i = pl.graveyard.length - 1; i >= 0; i--) {
        if (cardDef(pl.graveyard[i]).type === 'creature') {
          const [defId] = pl.graveyard.splice(i, 1);
          const slot = pl.board[oldSlot] === null ? oldSlot : firstLegalSlot(g, caster);
          if (slot !== null) summonFromDef(g, caster, defId, slot);
          else pl.graveyard.splice(i, 0, defId);
          return;
        }
      }
    },
  },
  unfinished_business: {
    spell(g, caster) {
      const options = [...new Set(g.s.players[caster].graveyard)];
      if (options.length === 0) return;
      g.s.pendingChoice = {
        player: caster, tag: 'unfinished_business',
        prompt: 'Shuffle a card from your graveyard into your deck (it costs 1O 1R less)',
        options, min: 1, max: 1,
      };
    },
  },
  isolate: {
    spell(g, caster, targets) {
      const t = creatureTarget(g, targets);
      if (!t) return;
      for (const adj of adjacentOf(g, t)) destroyCreature(g, adj, { sourcePlayer: caster });
    },
  },
  obliterating_verdict: {
    spell(g, caster, targets) {
      const t = creatureTarget(g, targets);
      if (t) destroyCreature(g, t, { obliterate: true, sourcePlayer: caster });
    },
  },
  destroy_rebuild: {
    spell(g) {
      const counts: [number, number] = [0, 0];
      for (const p of [0, 1] as const) {
        for (const c of creaturesOf(g, p)) {
          if (c.health > 0) {
            counts[p]++;
            destroyCreature(g, c);
          }
        }
      }
      draw(g, 0, counts[0]);
      draw(g, 1, counts[1]);
    },
  },
  sorinoth: {
    onDealtDamageToCreature(g, self, target) {
      if (target.health > 0 && target.attack > 1) {
        target.attack = 1;
        emit(g, { t: 'status', uid: target.uid, status: 'attackSetTo1', value: true });
      }
    },
  },

  // ------------------------------------------------------------- Chaos/Ruin
  quartered_and_drawn: {
    spell(g, caster, targets) {
      const t = creatureTarget(g, targets);
      if (!t) return;
      nullifyCreature(g, t, caster);
      if (t.health > 0) destroyCreature(g, t, { sourcePlayer: caster });
    },
  },
  field_scorcher: {
    onSummon(g, self) {
      for (const c of allBoard(g)) {
        if (c.uid !== self.uid && !c.isAura) applyBurn(g, c, 1, self.owner);
      }
    },
  },
  best_buds: {
    spell(g, caster, targets) {
      for (const t of targets) {
        if (t.type === 'slot' && t.player === caster) {
          summonFromDef(g, caster, 'flame_bud', t.slot);
        }
      }
    },
  },
  lava_lasher: {
    onDealtDamageToCreature(g, self, target) {
      if (target.health > 0) applyBurn(g, target, 2, self.owner);
    },
  },
  combust: {
    spell(g, caster, targets) {
      const t = creatureTarget(g, targets);
      if (!t || t.statuses.burn <= 0) return;
      const burnVal = t.statuses.burn;
      const adj = adjacentOf(g, t);
      destroyCreature(g, t, { sourcePlayer: caster });
      for (const c of adj) {
        if (c.health > 0) applyBurn(g, c, burnVal, caster);
      }
    },
  },
  unstable_explosives: {
    spell(g, caster) {
      damageGod(g, opp(caster), 5, { sourcePlayer: caster });
      damageGod(g, caster, 5);
    },
  },
  pyromaniac: {
    onBurnDamage(g, self) {
      self.attack += 1;
      emit(g, { t: 'buff', uid: self.uid, attack: 1, health: 0, armor: 0 });
    },
  },
  aldranaris_wrath: {
    spell(g, caster) {
      for (const c of [...creaturesOf(g, 0), ...creaturesOf(g, 1)]) {
        damageCreature(g, c, 5, { sourcePlayer: caster });
      }
      processDeaths(g);
    },
  },
  cataclysm: {
    onOwnerPlayedCard(g, self) {
      const enemy = opp(self.owner);
      for (const c of creaturesOf(g, enemy)) damageCreature(g, c, 1);
      damageGod(g, enemy, 1);
      processDeaths(g);
    },
  },
});

// -- pending-choice continuations -------------------------------------------

registerChoices({
  pack_mule(g, player, picks) {
    const pick = picks[0];
    if (!pick) return;
    const pl = g.s.players[player];
    const i = pl.graveyard.indexOf(pick);
    if (i >= 0 && cardDef(pick).type === 'spell') {
      pl.graveyard.splice(i, 1);
      pl.hand.push(pick);
    }
  },
  suspended_in_disaster(g, player, picks) {
    const pick = picks[0];
    if (!pick) return;
    const pl = g.s.players[player];
    const i = pl.deck.indexOf(pick);
    if (i < 0 || cardDef(pick).type !== 'creature' || totalCost(pick) < 2) return;
    pl.deck.splice(i, 1);
    shuffle(g.s, pl.deck);
    const slot = firstLegalSlot(g, player);
    if (slot !== null) summonFromDef(g, player, pick, slot);
    else cardToGraveyard(g, player, pick);
  },
  unfinished_business(g, player, picks) {
    const pick = picks[0];
    if (!pick) return;
    const pl = g.s.players[player];
    const i = pl.graveyard.indexOf(pick);
    if (i < 0) return;
    pl.graveyard.splice(i, 1);
    pl.deck.push(pick);
    shuffle(g.s, pl.deck);
    pl.discounts.push({ defId: pick, cost: { O: 1, R: 1 } });
    refreshDynamicStats(g);
  },
  domari_low(g, player, picks) {
    // picks[0] = card to put on top (of the revealed top 2)
    const pick = picks[0];
    if (!pick) return;
    const pl = g.s.players[player];
    const topTwo = pl.deck.slice(0, 2);
    const i = topTwo.indexOf(pick);
    if (i === 1) {
      [pl.deck[0], pl.deck[1]] = [pl.deck[1], pl.deck[0]];
    }
  },
  domari_ultimate(g, player, picks) {
    const pick = picks[0];
    if (!pick) return;
    const pl = g.s.players[player];
    const i = pl.deck.indexOf(pick);
    if (i < 0) return;
    pl.deck.splice(i, 1);
    shuffle(g.s, pl.deck);
    pl.deck.unshift(pick);
    emit(g, { t: 'info', msg: `Perfect Timing: ${cardDef(pick).name} placed on top of the deck` });
  },
  vaerul_low(g, player, picks) {
    // pick present = send top card to bottom; empty = keep
    if (picks.length === 0) return;
    const pl = g.s.players[player];
    const top = pl.deck.shift();
    if (top !== undefined) pl.deck.push(top);
  },
});

// -- god devotion tracks -----------------------------------------------------

registerGod('domari', [
  (g, player) => {
    const top = g.s.players[player].deck.slice(0, 2);
    if (top.length < 2) return;
    g.s.pendingChoice = {
      player, tag: 'domari_low',
      prompt: 'Choose which card goes on top of your deck',
      options: [...new Set(top)], min: 1, max: 1,
    };
  },
  (g, player, targets) => {
    const t = creatureTarget(g, targets);
    if (t && t.owner === player) purifyCreature(g, t);
  },
  (g, player) => {
    const options = [...new Set(g.s.players[player].deck)];
    if (options.length === 0) return;
    g.s.pendingChoice = {
      player, tag: 'domari_ultimate',
      prompt: 'Search your deck for a card to put on top',
      options, min: 1, max: 1,
    };
  },
]);

registerGod('sitja', [
  (g, _player, targets) => {
    const t = creatureTarget(g, targets);
    if (!t) return;
    const row = g.s.players[t.owner].board;
    const spots = [t.slot - 1, t.slot + 1].filter((i) => i >= 0 && i < BOARD_SLOTS && row[i] === null);
    if (spots.length > 0) moveCreature(g, t, spots[0]);
  },
  (g, player) => {
    const mine = creaturesOf(g, player);
    if (mine.length < 2) return;
    const left = mine.reduce((a, b) => (a.slot < b.slot ? a : b));
    const right = mine.reduce((a, b) => (a.slot > b.slot ? a : b));
    for (const c of [left, right]) {
      const a = c.attack;
      c.attack = c.health;
      c.maxHealth = Math.max(c.maxHealth, a);
      c.health = a;
      emit(g, { t: 'buff', uid: c.uid, attack: 0, health: 0, armor: 0 });
    }
    processDeaths(g);
  },
  (g, _player, targets) => {
    const t = creatureTarget(g, targets);
    if (!t) return;
    const atk = getAttack(g, t);
    for (const adj of adjacentOf(g, t)) {
      damageCreature(g, adj, atk, { sourceUid: t.uid, sourcePlayer: t.owner });
    }
    processDeaths(g);
  },
]);

registerGod('vrya', [
  (g, player, targets) => {
    const t = creatureTarget(g, targets);
    if (t) {
      damageCreature(g, t, 1, { sourcePlayer: player });
      processDeaths(g);
    }
  },
  (g, player) => {
    const pl = g.s.players[player];
    for (let i = pl.graveyard.length - 1; i >= 0; i--) {
      if (cardDef(pl.graveyard[i]).type === 'creature') {
        const [defId] = pl.graveyard.splice(i, 1);
        pl.hand.push(defId);
        refreshDynamicStats(g);
        return;
      }
    }
  },
  (g, player, targets) => {
    const t = creatureTarget(g, targets);
    if (!t) return;
    const defId = t.defId;
    const targetOwner = t.owner;
    destroyCreature(g, t, { obliterate: true, sourcePlayer: player });
    const pl = g.s.players[targetOwner];
    // hand & deck copies (owner of the destroyed creature)
    const strip = (arr: string[]) => {
      for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i] === defId) {
          pl.banished.push(arr[i]);
          arr.splice(i, 1);
        }
      }
    };
    strip(pl.hand);
    strip(pl.deck);
    for (const c of creaturesOf(g, targetOwner)) {
      if (c.defId === defId) destroyCreature(g, c, { obliterate: true, sourcePlayer: player });
    }
  },
]);

registerGod('aldranari', [
  (g, player, targets) => {
    const t = targets[0];
    if (t?.type === 'slot' && t.player === player && g.s.players[player].board[t.slot] === null) {
      summonFromDef(g, player, 'flame_bud', t.slot);
    }
  },
  (g, player) => {
    for (const c of creaturesOf(g, opp(player))) applyBurn(g, c, 1, player);
  },
  (g) => {
    for (const c of allBoard(g)) {
      if (c.statuses.burn > 0) c.statuses.burn *= 2;
    }
    burstBurn(g);
  },
]);

registerGod('vaerul', [
  (g, player) => {
    const pl = g.s.players[player];
    if (pl.deck.length === 0) return;
    g.s.pendingChoice = {
      player, tag: 'vaerul_low',
      prompt: `Top card: ${cardDef(pl.deck[0]).name}. Send it to the bottom?`,
      options: [pl.deck[0]], min: 0, max: 1,
    };
  },
  (g, player, targets) => {
    const t = creatureTarget(g, targets);
    if (t) nullifyCreature(g, t, player);
  },
  (g, player) => {
    for (const c of [...creaturesOf(g, 0), ...creaturesOf(g, 1)]) {
      nullifyCreature(g, c, c.owner === player ? player : undefined);
      snareCreature(g, c);
    }
  },
]);
