import { describe, it, expect } from 'vitest';
import { CARDS, DECKS, GODS } from '../src/data.ts';
import { SCRIPTS, GOD_ABILITIES } from '../src/ctx.ts';
import '../src/scripts.ts';
import { DECK_SIZE, BAG_SIZE } from '../src/types.ts';

const COPY_LIMIT: Record<string, number> = { S: 4, C: 4, R: 3, E: 2, L: 1 };

describe('card database', () => {
  it('has unique ids and well-formed entries', () => {
    const ids = Object.keys(CARDS);
    expect(ids.length).toBeGreaterThan(80);
    for (const c of Object.values(CARDS)) {
      expect(['creature', 'spell', 'decree', 'aura', 'token']).toContain(c.type);
      if (c.type === 'creature' || c.type === 'token') {
        expect(c.attack, c.id).toBeTypeOf('number');
        expect(c.health, c.id).toBeTypeOf('number');
      }
      for (const n of Object.values(c.cost)) expect(n).toBeGreaterThan(0);
    }
  });

  it('every spell has a spell script', () => {
    for (const c of Object.values(CARDS)) {
      if (c.type === 'spell') {
        expect(SCRIPTS[c.id]?.spell, `spell script missing: ${c.id}`).toBeTypeOf('function');
      }
      if (c.type === 'decree') {
        expect(SCRIPTS[c.id]?.decree, `decree script missing: ${c.id}`).toBeDefined();
      }
    }
  });

  it('scripts only reference known cards', () => {
    for (const id of Object.keys(SCRIPTS)) {
      expect(CARDS[id], `script for unknown card: ${id}`).toBeDefined();
    }
  });
});

describe('prebuilt decks', () => {
  it('are exactly 40 legal cards with a legal bag', () => {
    for (const deck of Object.values(DECKS)) {
      const total = Object.values(deck.cards).reduce((a, b) => a + b, 0);
      expect(total, deck.id).toBe(DECK_SIZE);
      const bagTotal = Object.values(deck.bag).reduce((a, b) => a + (b ?? 0), 0);
      expect(bagTotal, deck.id).toBe(BAG_SIZE);
      expect(GODS[deck.god], `${deck.id} god`).toBeDefined();
      expect(GOD_ABILITIES[deck.god], `${deck.id} god abilities`).toBeDefined();
      for (const [defId, count] of Object.entries(deck.cards)) {
        const def = CARDS[defId];
        expect(def, `${deck.id}: unknown card ${defId}`).toBeDefined();
        expect(def.type, `${deck.id}: token in deck ${defId}`).not.toBe('token');
        expect(count, `${deck.id}: too many ${defId}`).toBeLessThanOrEqual(COPY_LIMIT[def.rarity]);
        // devotion legality
        for (const color of Object.keys(def.cost)) {
          expect(deck.devotions, `${deck.id}: ${defId} color ${color}`).toContain(color);
        }
      }
    }
  });
});
