import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  applyAction, aiNextAction, createGame, cardDef, GODS, DECKS,
  listPlayable, listStanceable, listActivatable, listUsableTrackTiers,
  listValidCreatureTargets, facingSlot, hasKw, HIDDEN, BOARD_SLOTS,
} from '@divinity/engine';
import type {
  Action, ActivatableInfo, CreatureInstance, G, GameEvent, GameState,
  PlayableCard, PlayerState, TargetRef, TargetSpec,
} from '@divinity/engine';
import { CardArt, CardFace, CardZoom, CostPips, DEV_COLORS, DEV_NAMES } from './CardFace.tsx';
import type { OnlineSession } from '../net/online.ts';

type Sel =
  | { mode: 'play'; pc: PlayableCard; sacrifices: number[]; slot: number | null; si: number; targets: TargetRef[] }
  | { mode: 'activate'; uid: number; specs: TargetSpec[]; si: number; targets: TargetRef[] }
  | { mode: 'track'; tier: 0 | 1 | 2; specs: TargetSpec[]; si: number; targets: TargetRef[] }
  | { mode: 'defender'; uid: number; cands: number[] };

export interface OnlineStart {
  session: OnlineSession;
  state: GameState;
  events: GameEvent[];
}

type Props = {
  onExit: () => void;
} & (
  | { mode: 'hotseat' | 'ai'; deck0: string; deck1: string; seed: number; online?: undefined }
  | { mode: 'online'; online: OnlineStart; deck0?: undefined; deck1?: undefined; seed?: undefined }
);

function selSpecs(sel: Sel): TargetSpec[] {
  if (sel.mode === 'play') return sel.pc.targetSpecs;
  if (sel.mode === 'activate' || sel.mode === 'track') return sel.specs;
  return [];
}

/** Current stage of a play selection. */
function playStage(sel: Extract<Sel, { mode: 'play' }>): 'sac' | 'slot' | 'spec' | 'done' {
  if (sel.sacrifices.length < sel.pc.needsSacrifices) return 'sac';
  if (sel.pc.slots.length > 0 && sel.slot === null) return 'slot';
  if (sel.si < sel.pc.targetSpecs.length) return 'spec';
  return 'done';
}

function currentSpec(sel: Sel): TargetSpec | null {
  if (sel.mode === 'defender') return null;
  if (sel.mode === 'play' && playStage(sel) !== 'spec') return null;
  const specs = selSpecs(sel);
  return sel.si < specs.length ? specs[sel.si] : null;
}

function isComplete(sel: Sel): boolean {
  if (sel.mode === 'defender') return false;
  if (sel.mode === 'play') return playStage(sel) === 'done';
  return sel.si >= sel.specs.length;
}

function selAction(sel: Sel, viewer: 0 | 1): Action | null {
  if (sel.mode === 'play') {
    return {
      kind: 'playCard',
      handIndex: sel.pc.handIndex,
      slot: sel.slot ?? undefined,
      targets: sel.targets,
      sacrifices: sel.sacrifices.length > 0 ? sel.sacrifices : undefined,
    };
  }
  if (sel.mode === 'activate') return { kind: 'activate', uid: sel.uid, targets: sel.targets };
  if (sel.mode === 'track') return { kind: 'useTrack', tier: sel.tier, targets: sel.targets };
  void viewer;
  return null;
}

const COLOR_WORD: Record<string, string> = DEV_NAMES;

export function GameView(props: Props) {
  const { mode, onExit } = props;
  const online = mode === 'online' ? props.online : undefined;
  const namesRef = useRef<Map<number, string>>(new Map());
  const initial = useMemo(
    () => online
      ? { state: online.state, events: online.events }
      : createGame(props.deck0!, props.deck1!, props.seed!),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [online, props.deck0, props.deck1, props.seed],
  );
  const [oppConnected, setOppConnected] = useState(true);
  const stateRef = useRef<GameState>(initial.state);
  const [state, setState] = useState<GameState>(initial.state);
  const [log, setLog] = useState<string[]>([]);
  const [sel, setSel] = useState<Sel | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [hoverDef, setHoverDef] = useState<string | null>(null);
  const [menuUid, setMenuUid] = useState<number | null>(null);
  const [viewList, setViewList] = useState<{ title: string; cards: string[] } | null>(null);
  const [choicePicks, setChoicePicks] = useState<number[]>([]);
  const logBoxRef = useRef<HTMLDivElement>(null);
  const initLoggedRef = useRef(false);

  const fmtEvents = useCallback((events: GameEvent[]): string[] => {
    const names = namesRef.current;
    const nm = (uid: number) => names.get(uid) ?? `#${uid}`;
    const out: string[] = [];
    for (const e of events) {
      switch (e.t) {
        case 'coinFlip': out.push(`Player ${e.first + 1} goes first.`); break;
        case 'draw': out.push(`P${e.player + 1} draws ${e.defId && e.defId !== HIDDEN ? cardDef(e.defId).name : 'a card'}.`); break;
        case 'manaPulled': out.push(`P${e.player + 1} gains a ${COLOR_WORD[e.color] ?? e.color} crystal.`); break;
        case 'cardPlayed': out.push(`P${e.player + 1} plays ${cardDef(e.defId).name}.`); break;
        case 'summon':
          names.set(e.uid, cardDef(e.defId).name);
          out.push(`${cardDef(e.defId).name} enters the battlefield (P${e.player + 1}, slot ${e.slot + 1}).`);
          break;
        case 'attack': out.push(`${nm(e.attacker)} attacks ${e.targetUid !== undefined ? nm(e.targetUid) : `Player ${(e.targetGod ?? 0) + 1}'s god`}.`); break;
        case 'damage': out.push(`${e.targetUid !== undefined ? nm(e.targetUid) : `Player ${(e.targetGod ?? 0) + 1}'s god`} takes ${e.amount} ${e.kind} damage.`); break;
        case 'aegisPopped': out.push(`${nm(e.uid)}'s Aegis absorbs the blow.`); break;
        case 'death': out.push(`${cardDef(e.defId).name} dies.`); break;
        case 'obliterated': out.push(`${cardDef(e.defId).name} is obliterated.`); break;
        case 'heal': out.push(`${e.targetUid !== undefined ? nm(e.targetUid) : `Player ${(e.targetGod ?? 0) + 1}'s god`} heals ${e.amount}.`); break;
        case 'buff': {
          const parts: string[] = [];
          if (e.attack) parts.push(`${e.attack > 0 ? '+' : ''}${e.attack} Atk`);
          if (e.health) parts.push(`${e.health > 0 ? '+' : ''}${e.health} HP`);
          if (e.armor) parts.push(`${e.armor > 0 ? '+' : ''}${e.armor} Armor`);
          if (parts.length) out.push(`${nm(e.uid)} gets ${parts.join(', ')}.`);
          break;
        }
        case 'status': out.push(`${nm(e.uid)}: ${e.status} ${e.value === true ? '' : e.value}`.trim() + '.'); break;
        case 'discard': out.push(`P${e.player + 1} discards ${e.defId !== HIDDEN ? cardDef(e.defId).name : 'a card'}.`); break;
        case 'banish': out.push(`P${e.player + 1} banishes ${e.defId !== HIDDEN ? cardDef(e.defId).name : 'a card'} (hand limit).`); break;
        case 'trackUsed': {
          const god = GODS[stateRef.current.players[e.player].god];
          out.push(`P${e.player + 1} invokes ${god?.abilities[e.tier]?.name ?? `tier ${e.tier + 1}`}.`);
          break;
        }
        case 'decreeFired': out.push(`Decree fires: ${cardDef(e.defId).name}.`); break;
        case 'phase':
          if (e.phase === 'main1') out.push(`— Turn ${e.turn}: Player ${e.active + 1} —`);
          else if (e.phase === 'attack') out.push('Attack phase.');
          break;
        case 'moved': out.push(`${nm(e.uid)} moves to slot ${e.slot + 1}.`); break;
        case 'transform':
          out.push(`${nm(e.uid)} transforms into ${cardDef(e.into).name}.`);
          names.set(e.uid, cardDef(e.into).name);
          break;
        case 'gameOver': out.push(e.winner === 'draw' ? 'The game is a draw.' : `Player ${e.winner + 1} wins!`); break;
        case 'info': out.push(e.msg); break;
      }
    }
    return out;
  }, []);

  useEffect(() => {
    if (!initLoggedRef.current) {
      initLoggedRef.current = true;
      setLog(fmtEvents(initial.events));
    }
  }, [initial, fmtEvents]);

  const doAction = useCallback((a: Action, player: 0 | 1): boolean => {
    if (online) {
      online.session.send(a);
      setSel(null);
      setMenuUid(null);
      return true;
    }
    const r = applyAction(stateRef.current, a, player);
    if (r.error) {
      setToast(r.error);
      return false;
    }
    const lines = fmtEvents(r.events);
    stateRef.current = r.state;
    setState(r.state);
    if (lines.length) setLog((prev) => [...prev, ...lines].slice(-300));
    setSel(null);
    setMenuUid(null);
    setChoicePicks([]);
    return true;
  }, [fmtEvents, online]);

  // online: authoritative updates from the server
  useEffect(() => {
    if (!online) return;
    online.session.onUpdate((s, events) => {
      const lines = fmtEvents(events);
      stateRef.current = s;
      setState(s);
      if (lines.length) setLog((prev) => [...prev, ...lines].slice(-300));
      setSel(null);
      setMenuUid(null);
      setChoicePicks([]);
    });
    online.session.onError((msg) => setToast(msg));
    online.session.onPresence(setOppConnected);
    return () => online.session.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online]);

  // toast auto-dismiss
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(t);
  }, [toast]);

  // auto-scroll log
  useEffect(() => {
    const el = logBoxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log]);

  // whose screen is it?
  const viewer: 0 | 1 = useMemo(() => {
    if (mode === 'ai') return 0;
    if (online) return online.session.playerIndex;
    if (state.pendingChoice) return state.pendingChoice.player;
    if (state.phase === 'mulligan') return !state.players[0].mulliganDone ? 0 : 1;
    return state.active;
  }, [mode, online, state]);

  // hotseat pass-device curtain
  const [curtain, setCurtain] = useState<boolean>(mode === 'hotseat');
  const prevViewerRef = useRef<0 | 1>(viewer);
  useEffect(() => {
    if (mode === 'hotseat' && viewer !== prevViewerRef.current && state.winner === null) {
      setCurtain(true);
      setSel(null);
      setMenuUid(null);
    }
    prevViewerRef.current = viewer;
  }, [viewer, mode, state.winner]);

  // AI driver
  useEffect(() => {
    if (mode !== 'ai' || state.winner !== null) return;
    const aiActs = state.pendingChoice
      ? state.pendingChoice.player === 1
      : state.phase === 'mulligan'
        ? state.players[0].mulliganDone && !state.players[1].mulliganDone
        : state.active === 1;
    if (!aiActs) return;
    const t = setTimeout(() => {
      doAction(aiNextAction(stateRef.current, 1), 1);
    }, 450);
    return () => clearTimeout(t);
  }, [state, mode, doAction]);

  // Esc cancels selection
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setSel(null); setMenuUid(null); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const me = state.players[viewer];
  const foe = state.players[(1 - viewer) as 0 | 1];
  const myTurn = state.active === viewer && !state.pendingChoice && state.winner === null;
  const g: G = useMemo(() => ({ s: state, ev: [] }), [state]);

  const playables = useMemo(() => listPlayable(state, viewer), [state, viewer]);
  const stanceable = useMemo(() => new Set(listStanceable(state, viewer)), [state, viewer]);
  const activatable = useMemo(() => {
    const m = new Map<number, ActivatableInfo>();
    for (const a of listActivatable(state, viewer)) m.set(a.uid, a);
    return m;
  }, [state, viewer]);
  const trackTiers = useMemo(() => new Set(listUsableTrackTiers(state, viewer)), [state, viewer]);

  // advance a selection; dispatch when complete
  const advance = useCallback((next: Sel) => {
    if (isComplete(next)) {
      const a = selAction(next, viewer);
      if (a) doAction(a, viewer);
      else setSel(null);
    } else {
      setSel(next);
    }
  }, [doAction, viewer]);

  // ----- highlight sets for the current selection -----
  const highlights = useMemo(() => {
    const creatures = new Set<number>();
    const gods = new Set<0 | 1>();
    const slots = new Set<string>();
    const columns = new Set<number>();
    if (!sel) return { creatures, gods, slots, columns };

    if (sel.mode === 'defender') {
      for (const uid of sel.cands) creatures.add(uid);
      return { creatures, gods, slots, columns };
    }
    if (sel.mode === 'play') {
      const stage = playStage(sel);
      if (stage === 'sac') {
        for (const c of me.board) {
          if (c && !c.isAura && !sel.sacrifices.includes(c.uid)) creatures.add(c.uid);
        }
        return { creatures, gods, slots, columns };
      }
      if (stage === 'slot') {
        for (const s of sel.pc.slots) slots.add(`${viewer}:${s}`);
        return { creatures, gods, slots, columns };
      }
    }
    const spec = currentSpec(sel);
    if (!spec) return { creatures, gods, slots, columns };
    const selfUid = sel.mode === 'activate' ? sel.uid : undefined;
    const used = new Set(sel.targets.filter((t) => t.type === 'creature').map((t) => (t as { uid: number }).uid));
    if (spec.kind === 'creature' || spec.kind === 'any') {
      for (const c of listValidCreatureTargets(g, viewer, { ...spec, kind: 'creature' }, selfUid)) {
        if (!used.has(c.uid)) creatures.add(c.uid);
      }
    }
    if (spec.kind === 'god' || spec.kind === 'any') {
      gods.add(0); gods.add(1);
    }
    if (spec.kind === 'slot') {
      const usedSlots = new Set(sel.targets.filter((t) => t.type === 'slot').map((t) => (t as { slot: number }).slot));
      me.board.forEach((c, i) => {
        if (c === null && !usedSlots.has(i)) slots.add(`${viewer}:${i}`);
      });
    }
    if (spec.kind === 'column') {
      for (let i = 0; i < BOARD_SLOTS; i++) columns.add(i);
    }
    return { creatures, gods, slots, columns };
  }, [sel, g, me.board, viewer]);

  const canSkipSpec = useMemo(() => {
    if (!sel) return false;
    const spec = currentSpec(sel);
    if (!spec) return false;
    if (spec.optional) return true;
    if (spec.kind === 'creature') {
      const selfUid = sel.mode === 'activate' ? sel.uid : undefined;
      return listValidCreatureTargets(g, viewer, spec, selfUid).length === 0;
    }
    return false;
  }, [sel, g, viewer]);

  // ----- click handlers -----
  const pushTarget = useCallback((ref: TargetRef) => {
    if (!sel || sel.mode === 'defender') return;
    advance({ ...sel, targets: [...sel.targets, ref], si: sel.si + 1 });
  }, [sel, advance]);

  const skipSpec = useCallback(() => {
    if (!sel || sel.mode === 'defender') return;
    advance({ ...sel, si: sel.si + 1 });
  }, [sel, advance]);

  const tryEnterStance = useCallback((c: CreatureInstance) => {
    // if several enemy Defenders constrain this attacker, let the player pick
    if (!hasKw(g, c, 'Forcing')) {
      const enemyRow = state.players[(1 - viewer) as 0 | 1].board;
      const f = facingSlot(c.slot);
      const cands: number[] = [];
      for (const i of [f - 1, f, f + 1]) {
        if (i < 0 || i >= BOARD_SLOTS) continue;
        const d = enemyRow[i];
        if (d && d.health > 0 && hasKw(g, d, 'Defender')) cands.push(d.uid);
      }
      if (cands.length > 1) {
        setSel({ mode: 'defender', uid: c.uid, cands });
        return;
      }
    }
    doAction({ kind: 'toggleStance', uid: c.uid }, viewer);
  }, [g, state, viewer, doAction]);

  const onCreatureClick = useCallback((c: CreatureInstance) => {
    if (state.winner !== null) return;
    if (sel) {
      if (sel.mode === 'defender') {
        if (sel.cands.includes(c.uid)) {
          doAction({ kind: 'toggleStance', uid: sel.uid, defenderTargetUid: c.uid }, viewer);
        }
        return;
      }
      if (sel.mode === 'play' && playStage(sel) === 'sac') {
        if (c.owner === viewer && !c.isAura && !sel.sacrifices.includes(c.uid)) {
          advance({ ...sel, sacrifices: [...sel.sacrifices, c.uid] });
        }
        return;
      }
      if (highlights.creatures.has(c.uid)) pushTarget({ type: 'creature', uid: c.uid });
      return;
    }
    // no selection: own creature in your turn -> stance / ability
    if (c.owner !== viewer || !myTurn) return;
    const canStance = state.phase === 'main1' && (stanceable.has(c.uid) || c.inAttackStance);
    const ab = activatable.get(c.uid);
    if (canStance && ab) {
      setMenuUid(menuUid === c.uid ? null : c.uid);
    } else if (canStance) {
      if (c.inAttackStance) doAction({ kind: 'toggleStance', uid: c.uid }, viewer);
      else tryEnterStance(c);
    } else if (ab) {
      advance({ mode: 'activate', uid: c.uid, specs: ab.targetSpecs, si: 0, targets: [] });
    }
  }, [sel, state, viewer, myTurn, stanceable, activatable, highlights, menuUid, advance, pushTarget, doAction, tryEnterStance]);

  const onGodClick = useCallback((side: 0 | 1) => {
    if (sel && highlights.gods.has(side)) pushTarget({ type: 'god', player: side });
  }, [sel, highlights, pushTarget]);

  const onSlotClick = useCallback((player: 0 | 1, slot: number) => {
    if (!sel || sel.mode === 'defender') return;
    if (sel.mode === 'play' && playStage(sel) === 'slot') {
      if (player === viewer && sel.pc.slots.includes(slot)) advance({ ...sel, slot });
      return;
    }
    if (highlights.slots.has(`${player}:${slot}`)) pushTarget({ type: 'slot', player, slot });
  }, [sel, viewer, highlights, advance, pushTarget]);

  const onColumnClick = useCallback((col: number) => {
    if (highlights.columns.has(col)) pushTarget({ type: 'column', col });
  }, [highlights, pushTarget]);

  const onHandClick = useCallback((handIndex: number) => {
    if (!myTurn || sel) return;
    const pc = playables.find((p) => p.handIndex === handIndex);
    if (!pc) return;
    advance({ mode: 'play', pc, sacrifices: [], slot: null, si: 0, targets: [] });
  }, [myTurn, sel, playables, advance]);

  const useTrackTier = useCallback((tier: 0 | 1 | 2) => {
    if (!trackTiers.has(tier)) return;
    const specs = GODS[me.god]?.abilities[tier]?.targets ?? [];
    advance({ mode: 'track', tier, specs, si: 0, targets: [] });
  }, [trackTiers, me.god, advance]);

  // ----- prompt text -----
  const prompt = useMemo(() => {
    if (!sel) return null;
    if (sel.mode === 'defender') return 'Several Defenders apply — click the one to attack.';
    if (sel.mode === 'play') {
      const stage = playStage(sel);
      const name = cardDef(state.players[viewer].hand[sel.pc.handIndex] ?? sel.pc.defId).name;
      if (stage === 'sac') return `${name}: choose ${sel.pc.needsSacrifices - sel.sacrifices.length} more sacrifice(s).`;
      if (stage === 'slot') return `${name}: choose a slot.`;
    }
    const spec = currentSpec(sel);
    if (spec) return spec.label ?? `Choose a ${spec.kind} target.`;
    return 'Choose…';
  }, [sel, state, viewer]);

  // ----- rendering -----
  const renderCreature = (c: CreatureInstance | null, side: 0 | 1, slot: number) => {
    const key = `${side}:${slot}`;
    if (!c) {
      const glow = highlights.slots.has(key) || (sel?.mode === 'play' && playStage(sel) === 'slot' && side === viewer && sel.pc.slots.includes(slot));
      return (
        <div
          key={key}
          className={`slot empty${glow ? ' glow' : ''}`}
          onClick={() => onSlotClick(side, slot)}
        />
      );
    }
    const def = cardDef(c.defId);
    const glow = highlights.creatures.has(c.uid);
    const mine = side === viewer;
    const badges: string[] = [];
    if (c.statuses.burn > 0) badges.push(`🔥${c.statuses.burn}`);
    if (c.statuses.snareTurns > 0) badges.push('🕸');
    if (c.statuses.poisonedBy !== null) badges.push('☠');
    if (c.statuses.aegis) badges.push('✨');
    if (c.statuses.sanctuary > 0) badges.push('⛨');
    if (c.keywords.includes('Shroud') && !c.nullified) badges.push('🌫');
    if (c.nullified) badges.push('🔇');
    return (
      <div
        key={key}
        className={`slot filled${c.isAura ? ' aura' : ''}${glow ? ' glow' : ''}${c.inAttackStance ? ' stance' : ''}${mine ? ' mine' : ''}`}
        onClick={() => onCreatureClick(c)}
        onMouseEnter={() => setHoverDef(c.defId)}
        onMouseLeave={() => setHoverDef(null)}
      >
        <CardArt defId={c.defId} className="slot-art" />
        <div className="slot-name">{def.name}</div>
        {badges.length > 0 && <div className="slot-badges">{badges.join(' ')}</div>}
        {c.inAttackStance && <div className="slot-sword">⚔</div>}
        {!c.isAura && (
          <div className="slot-stats">
            <span className="stat atk">{c.attack}</span>
            {c.armor > 0 && <span className="stat arm">{c.armor}</span>}
            <span className={`stat hp${c.health < c.maxHealth ? ' hurt' : ''}`}>{c.health}</span>
          </div>
        )}
        {c.isAura && <div className="slot-stats"><span className="stat hp">{c.health}</span></div>}
        {menuUid === c.uid && (
          <div className="creature-menu" onClick={(e) => e.stopPropagation()}>
            <button onClick={() => { setMenuUid(null); c.inAttackStance ? doAction({ kind: 'toggleStance', uid: c.uid }, viewer) : tryEnterStance(c); }}>
              {c.inAttackStance ? 'Cancel attack' : 'Attack stance'}
            </button>
            {activatable.get(c.uid) && (
              <button onClick={() => {
                setMenuUid(null);
                const ab = activatable.get(c.uid)!;
                advance({ mode: 'activate', uid: c.uid, specs: ab.targetSpecs, si: 0, targets: [] });
              }}>
                Use ability
              </button>
            )}
          </div>
        )}
      </div>
    );
  };

  const renderGodPanel = (side: 0 | 1) => {
    const pl = state.players[side];
    const god = GODS[pl.god];
    const mine = side === viewer;
    const glow = highlights.gods.has(side);
    return (
      <div className={`god-panel${glow ? ' glow' : ''}`} onClick={() => onGodClick(side)}>
        <div className="god-name">{god?.name ?? pl.god}</div>
        <div className="god-hp">{pl.hp} ❤</div>
        <div className="track">
          <span className="charges">{pl.track.charges}⚡</span>
          {god?.abilities.map((ab, i) => (
            <button
              key={i}
              className="track-btn"
              title={`${ab.name} (${ab.cost}): ${ab.text}`}
              disabled={!mine || !myTurn || !trackTiers.has(i as 0 | 1 | 2) || !!sel}
              onClick={(e) => { e.stopPropagation(); useTrackTier(i as 0 | 1 | 2); }}
            >
              {ab.cost}
            </button>
          ))}
        </div>
        {pl.decrees.length > 0 && (
          <div className="decrees">
            {pl.decrees.map((d) => (
              <span
                key={d.uid}
                className="decree"
                onMouseEnter={() => setHoverDef(d.defId)}
                onMouseLeave={() => setHoverDef(null)}
              >
                📜 {cardDef(d.defId).name}
              </span>
            ))}
          </div>
        )}
      </div>
    );
  };

  const renderCounts = (pl: PlayerState, side: 0 | 1) => (
    <div className="counts">
      <span title="Cards in deck">🂠 {pl.deck.length}</span>
      <span
        title="Graveyard (click to view)"
        className="clickable"
        onClick={() => setViewList({ title: `Player ${side + 1} graveyard`, cards: [...pl.graveyard].reverse() })}
      >
        🪦 {pl.graveyard.length}
      </span>
      <span title="Crystals left in bag">💎 {pl.bag.length}</span>
      <span title="Hand size">🃏 {pl.hand.length}</span>
    </div>
  );

  const manaRow = (
    <div className="mana-row">
      {me.pool.map((m, i) => (
        <span
          key={i}
          className={`gem${m.tapped ? ' tapped' : ''}`}
          style={{ background: DEV_COLORS[m.color] }}
          title={`${COLOR_WORD[m.color]}${m.tapped ? ' (tapped)' : ''}`}
        />
      ))}
      {me.pool.length === 0 && <span className="mana-empty">no crystals yet</span>}
    </div>
  );

  const anyStance = me.board.some((c) => c && c.inAttackStance);
  const choice = state.pendingChoice;

  return (
    <div className="game">
      <div className="log-panel" ref={logBoxRef}>
        {log.map((line, i) => (
          <div key={i} className={line.startsWith('—') ? 'log-turn' : 'log-line'}>{line}</div>
        ))}
      </div>

      <div className="center">
        <div className="opp-hand">
          {foe.hand.map((id, i) => (
            mode === 'hotseat' || id === HIDDEN
              ? <div key={i} className="card card-back small" />
              : <div key={i} className="card card-back small" />
          ))}
        </div>

        <div className="god-row">
          {renderGodPanel((1 - viewer) as 0 | 1)}
          {renderCounts(foe, (1 - viewer) as 0 | 1)}
        </div>

        <div className="board">
          {highlights.columns.size > 0 && (
            <div className="column-overlay">
              {Array.from({ length: BOARD_SLOTS }, (_, col) => (
                <div key={col} className="column-btn glow" onClick={() => onColumnClick(col)} />
              ))}
            </div>
          )}
          <div className="board-row">
            {Array.from({ length: BOARD_SLOTS }, (_, col) => {
              const eSlot = facingSlot(col);
              return renderCreature(foe.board[eSlot], (1 - viewer) as 0 | 1, eSlot);
            })}
          </div>
          <div className="board-row">
            {Array.from({ length: BOARD_SLOTS }, (_, col) => renderCreature(me.board[col], viewer, col))}
          </div>
        </div>

        <div className="god-row">
          {renderGodPanel(viewer)}
          {renderCounts(me, viewer)}
          <div className="controls">
            <div className="phase-chip">Turn {state.turn} · {state.phase}{myTurn ? ' · your turn' : ''}</div>
            <button
              className="big-btn attack"
              disabled={!myTurn || state.phase !== 'main1' || !anyStance || !!sel}
              onClick={() => doAction({ kind: 'beginAttack' }, viewer)}
            >
              ⚔ Attack!
            </button>
            <button
              className="big-btn"
              disabled={!myTurn || (state.phase !== 'main1' && state.phase !== 'main2') || !!sel}
              onClick={() => doAction({ kind: 'endTurn' }, viewer)}
            >
              End turn
            </button>
            <button className="big-btn subtle" onClick={onExit}>Exit</button>
          </div>
        </div>

        {manaRow}

        <div className="hand">
          {me.hand.map((id, i) => {
            const playable = myTurn && !sel && playables.some((p) => p.handIndex === i);
            const selected = sel?.mode === 'play' && sel.pc.handIndex === i;
            return (
              <CardFace
                key={i}
                defId={id}
                dim={!playable && !selected}
                selected={selected}
                onClick={() => onHandClick(i)}
                onHover={setHoverDef}
              />
            );
          })}
        </div>
      </div>

      <div className="zoom-panel">
        {hoverDef ? <CardZoom defId={hoverDef} /> : <div className="zoom-hint">Hover a card to inspect it.</div>}
      </div>

      {prompt && (
        <div className="prompt-bar">
          <span>{prompt}</span>
          {canSkipSpec && <button onClick={skipSpec}>Skip</button>}
          <button onClick={() => setSel(null)}>Cancel (Esc)</button>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}

      {/* mulligan overlay */}
      {state.phase === 'mulligan' && !curtain && !state.players[viewer].mulliganDone && (mode !== 'ai' || viewer === 0) && (
        <div className="overlay">
          <div className="overlay-box">
            <h2>Player {viewer + 1} — keep this hand?</h2>
            <div className="mull-hand">
              {me.hand.map((id, i) => <CardFace key={i} defId={id} onHover={setHoverDef} />)}
            </div>
            <div className="overlay-btns">
              <button className="big-btn" onClick={() => doAction({ kind: 'mulligan', keep: true }, viewer)}>Keep</button>
              <button
                className="big-btn"
                onClick={() => doAction({ kind: 'mulligan', keep: false }, viewer)}
              >
                Mulligan ({2 - me.mulligansUsed} left{me.mulligansUsed === 1 ? ', then keep' : ''})
              </button>
            </div>
          </div>
        </div>
      )}

      {/* waiting for the other side's mulligan */}
      {state.phase === 'mulligan' && mode !== 'hotseat' && state.players[viewer].mulliganDone && (
        <div className="overlay"><div className="overlay-box"><h2>Opponent is deciding…</h2></div></div>
      )}

      {/* online status strip */}
      {online && (
        <div className="online-strip">
          Room {online.session.roomCode}
          {!oppConnected && <span className="opp-away"> · opponent disconnected, waiting…</span>}
          {state.pendingChoice && state.pendingChoice.player !== viewer && <span> · opponent is choosing…</span>}
        </div>
      )}

      {/* pending choice modal */}
      {choice && choice.player === viewer && (
        <div className="overlay">
          <div className="overlay-box">
            <h2>{choice.prompt}</h2>
            <div className="mull-hand">
              {choice.options.map((id, i) => (
                <CardFace
                  key={i}
                  defId={id}
                  selected={choicePicks.includes(i)}
                  onHover={setHoverDef}
                  onClick={() => setChoicePicks((prev) =>
                    prev.includes(i)
                      ? prev.filter((x) => x !== i)
                      : prev.length < choice.max ? [...prev, i] : prev
                  )}
                />
              ))}
            </div>
            <div className="overlay-btns">
              <button
                className="big-btn"
                disabled={choicePicks.length < choice.min || choicePicks.length > choice.max}
                onClick={() => doAction({ kind: 'resolveChoice', picks: choicePicks.map((i) => choice.options[i]) }, viewer)}
              >
                Confirm ({choicePicks.length} / {choice.min === choice.max ? choice.min : `${choice.min}–${choice.max}`})
              </button>
            </div>
          </div>
        </div>
      )}

      {/* card list viewer */}
      {viewList && (
        <div className="overlay" onClick={() => setViewList(null)}>
          <div className="overlay-box" onClick={(e) => e.stopPropagation()}>
            <h2>{viewList.title}</h2>
            <div className="mull-hand scrolly">
              {viewList.cards.length === 0 && <p>Empty.</p>}
              {viewList.cards.map((id, i) => <CardFace key={i} defId={id} onHover={setHoverDef} />)}
            </div>
            <div className="overlay-btns">
              <button className="big-btn" onClick={() => setViewList(null)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* hotseat curtain */}
      {curtain && state.winner === null && (
        <div className="overlay curtain">
          <div className="overlay-box">
            <h2>Pass the device to Player {viewer + 1}</h2>
            <button className="big-btn" onClick={() => setCurtain(false)}>I'm Player {viewer + 1} — show my hand</button>
          </div>
        </div>
      )}

      {/* winner */}
      {state.winner !== null && (
        <div className="overlay">
          <div className="overlay-box">
            <h2>{state.winner === 'draw' ? 'Draw!' : `Player ${state.winner + 1} wins!`}</h2>
            <button className="big-btn" onClick={onExit}>Back to menu</button>
          </div>
        </div>
      )}
    </div>
  );
}

export function deckOptions() {
  return Object.values(DECKS).map((d) => ({ id: d.id, name: d.name, god: GODS[d.god]?.name ?? d.god }));
}

export function deckSummary(id: string) {
  const d = DECKS[id];
  if (!d) return '';
  return `${d.devotions.map((x) => DEV_NAMES[x]).join('/')} · ${GODS[d.god]?.name ?? d.god}`;
}

export { CostPips };
