// Core shared types for the Divinity CCG engine.
// The engine is pure TypeScript: no DOM, no Node APIs.

export type Devotion = 'O' | 'C' | 'I' | 'G' | 'N' | 'R';

/** Colored crystal cost, e.g. { O: 2, R: 1 } */
export type Cost = Partial<Record<Devotion, number>>;

export type Rarity = 'S' | 'C' | 'R' | 'E' | 'L';
export type CardType = 'creature' | 'spell' | 'decree' | 'aura' | 'token';

export type Keyword =
  | 'Defender' | 'Forcing' | 'Aegis' | 'Rushdown' | 'Cleave' | 'Pierce'
  | 'Crushing' | 'Lifetap' | 'Shroud' | 'Poisonous';

/** Declarative targeting requirement checked before a card/ability resolves. */
export interface TargetSpec {
  kind: 'creature' | 'god' | 'any' | 'slot' | 'column';
  side?: 'ally' | 'enemy' | 'any';       // for creature/any/slot targets
  filter?: string;                        // named filter, see game.ts targetFilters
  optional?: boolean;
  label?: string;                         // UI prompt
}

export interface CardDef {
  id: string;
  name: string;
  rarity: Rarity;
  type: CardType;
  cost: Cost;
  attack?: number;
  health?: number;
  armor?: number;
  tribes?: string[];
  keywords?: Keyword[];
  text: string;
  /** Sacrifice N additional play cost */
  sacrifice?: number;
  /** Aura upkeep, paid at controller's start step or the aura dies */
  upkeep?: Cost;
  /** Targets required when playing this card (spells & Summon: effects) */
  targets?: TargetSpec[];
}

export interface Statuses {
  burn: number;
  /** player index whose next turn-start kills this creature, or null */
  poisonedBy: 0 | 1 | null;
  /** number of the controller's turns this creature stays snared */
  snareTurns: number;
  /** number of the controller's turns of sanctuary remaining */
  sanctuary: number;
  aegis: boolean;
  /** Bloodcrazed: must enter attack stance if able */
  mustAttack: boolean;
}

export interface CreatureInstance {
  uid: number;
  defId: string;
  owner: 0 | 1;
  slot: number;                 // 0..5, from the owner's point of view
  attack: number;               // current permanent attack (buffs applied)
  health: number;
  maxHealth: number;
  armor: number;                // current shield value (drops when attacking)
  baseArmor: number;            // regenerates to this each turn
  keywords: Keyword[];
  statuses: Statuses;
  inAttackStance: boolean;
  attackTargetUid: number | null;  // pre-picked Defender when several apply
  playedOnTurn: number;
  nullified: boolean;
  isAura: boolean;
  isToken: boolean;
  /** per-instance counters used by card scripts (e.g. Pace-style effects) */
  counters: Record<string, number>;
}

export interface DecreeInstance {
  uid: number;
  defId: string;
  owner: 0 | 1;
}

export interface ManaCrystal {
  color: Devotion;
  tapped: boolean;
}

export interface PlayerState {
  god: string;                  // god id from gods.json
  hp: number;
  deck: string[];               // card def ids, index 0 = top
  hand: string[];
  graveyard: string[];          // last element = top
  banished: string[];
  bag: Devotion[];              // remaining crystals to be pulled
  pool: ManaCrystal[];
  board: (CreatureInstance | null)[];  // length 6 (auras live here too)
  decrees: DecreeInstance[];    // max 2
  track: { charges: number; usedThisTurn: boolean };
  mulligansUsed: number;
  mulliganDone: boolean;
  /** No Strings Attached: sacrifice costs waived until end of turn */
  freeSacrifices: boolean;
  /** cost discounts granted to specific card ids (Unfinished Business) */
  discounts: { defId: string; cost: Cost }[];
}

export interface ChoiceRequest {
  player: 0 | 1;
  tag: string;                  // continuation id handled in scripts.ts
  prompt: string;
  /** options are card def ids (deck/graveyard picks) shown to the player */
  options: string[];
  min: number;
  max: number;
  /** data the continuation needs (e.g. source uid) */
  data?: Record<string, unknown>;
}

export type GameEvent =
  | { t: 'coinFlip'; first: 0 | 1 }
  | { t: 'draw'; player: 0 | 1; defId?: string }        // defId omitted in redacted views
  | { t: 'manaPulled'; player: 0 | 1; color: Devotion }
  | { t: 'cardPlayed'; player: 0 | 1; defId: string }
  | { t: 'summon'; player: 0 | 1; uid: number; defId: string; slot: number }
  | { t: 'attack'; attacker: number; targetUid?: number; targetGod?: 0 | 1 }
  | { t: 'damage'; targetUid?: number; targetGod?: 0 | 1; amount: number; kind: 'combat' | 'effect' | 'burn' }
  | { t: 'aegisPopped'; uid: number }
  | { t: 'death'; uid: number; defId: string }
  | { t: 'obliterated'; uid: number; defId: string }
  | { t: 'heal'; targetUid?: number; targetGod?: 0 | 1; amount: number }
  | { t: 'buff'; uid: number; attack: number; health: number; armor: number }
  | { t: 'status'; uid: number; status: string; value: number | boolean }
  | { t: 'discard'; player: 0 | 1; defId: string }
  | { t: 'banish'; player: 0 | 1; defId: string }
  | { t: 'trackUsed'; player: 0 | 1; tier: 0 | 1 | 2 }
  | { t: 'decreeFired'; defId: string; owner: 0 | 1 }
  | { t: 'phase'; phase: Phase; turn: number; active: 0 | 1 }
  | { t: 'moved'; uid: number; slot: number }
  | { t: 'transform'; uid: number; into: string }
  | { t: 'gameOver'; winner: 0 | 1 | 'draw' }
  | { t: 'info'; msg: string };

export type Phase = 'mulligan' | 'main1' | 'attack' | 'main2' | 'ended';

export interface GameState {
  seed: number;
  rngState: number;
  turn: number;                 // global turn counter, starts at 1
  active: 0 | 1;
  phase: Phase;
  players: [PlayerState, PlayerState];
  nextUid: number;
  pendingChoice: ChoiceRequest | null;
  winner: 0 | 1 | 'draw' | null;
  /** creatures that died this game-turn (def ids), reset at end step */
  diedThisTurn: string[];
}

export type TargetRef =
  | { type: 'creature'; uid: number }
  | { type: 'god'; player: 0 | 1 }
  | { type: 'slot'; player: 0 | 1; slot: number }
  | { type: 'column'; col: number };   // col 0..5 in the ACTING player's orientation

export type Action =
  | { kind: 'mulligan'; keep: boolean }
  | { kind: 'playCard'; handIndex: number; slot?: number; targets?: TargetRef[]; sacrifices?: number[] }
  | { kind: 'toggleStance'; uid: number; defenderTargetUid?: number }
  | { kind: 'activate'; uid: number; targets?: TargetRef[] }
  | { kind: 'useTrack'; tier: 0 | 1 | 2; targets?: TargetRef[] }
  | { kind: 'beginAttack' }
  | { kind: 'endTurn' }
  | { kind: 'resolveChoice'; picks: string[] };

export interface ApplyResult {
  state: GameState;
  events: GameEvent[];
  error?: string;
}

export interface GodDef {
  id: string;
  name: string;
  devotions: Devotion[];
  abilities: { cost: number; name: string; text: string; targets?: TargetSpec[] }[];
}

export interface DeckDef {
  id: string;
  name: string;
  god: string;
  devotions: Devotion[];
  bag: Partial<Record<Devotion, number>>;
  cards: Record<string, number>;   // defId -> count
}

export const GOD_HP = 25;
export const DECK_SIZE = 40;
export const BAG_SIZE = 12;
export const HAND_LIMIT = 10;
export const BOARD_SLOTS = 6;
export const TRACK_TIERS = [10, 25, 50] as const;
export const TRACK_CAP = 60;
export const MAX_DECREES = 2;
