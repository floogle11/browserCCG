import cardsJson from '../../../data/cards.json';
import godsJson from '../../../data/gods.json';
import decksJson from '../../../data/decks.json';
import type { CardDef, GodDef, DeckDef } from './types.ts';

export const CARDS: Record<string, CardDef> = Object.fromEntries(
  (cardsJson as unknown as CardDef[]).map((c) => [c.id, c])
);

export const GODS: Record<string, GodDef> = Object.fromEntries(
  (godsJson as unknown as GodDef[]).map((g) => [g.id, g])
);

export const DECKS: Record<string, DeckDef> = Object.fromEntries(
  (decksJson as unknown as DeckDef[]).map((d) => [d.id, d])
);

export function cardDef(id: string): CardDef {
  const def = CARDS[id];
  if (!def) throw new Error(`Unknown card def: ${id}`);
  return def;
}

export function totalCost(id: string): number {
  const def = cardDef(id);
  return Object.values(def.cost).reduce((a, b) => a + (b ?? 0), 0);
}
