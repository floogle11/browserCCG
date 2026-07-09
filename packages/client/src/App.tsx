import { useRef, useState } from 'react';
import { DECKS, totalCost } from '@divinity/engine';
import { GameView, deckOptions, deckSummary } from './game/GameView.tsx';
import type { OnlineStart } from './game/GameView.tsx';
import { hostRoom, joinRoom } from './net/online.ts';
import type { OnlineSession } from './net/online.ts';
import { Rules } from './Rules.tsx';

function DeckCurve({ deckId }: { deckId: string }) {
  const deck = DECKS[deckId];
  if (!deck) return null;
  const buckets = Array(8).fill(0) as number[]; // CMC 1..7, 8+
  for (const [defId, count] of Object.entries(deck.cards)) {
    const cmc = Math.min(totalCost(defId), 8);
    buckets[Math.max(cmc, 1) - 1] += count;
  }
  const max = Math.max(...buckets, 1);
  return (
    <span className="curve" title="Mana curve (cards per total cost)">
      {buckets.map((n, i) => (
        <span key={i} className="curve-col">
          <span className="curve-bar" style={{ height: `${(n / max) * 26 + 2}px` }} />
          <span className="curve-label">{i + 1 === 8 ? '8+' : i + 1}</span>
        </span>
      ))}
    </span>
  );
}

type Screen =
  | { name: 'menu' }
  | { name: 'rules' }
  | { name: 'game'; mode: 'hotseat' | 'ai'; deck0: string; deck1: string; seed: number }
  | { name: 'hosting'; code: string }
  | { name: 'joining' }
  | { name: 'online'; start: OnlineStart };

// From an https page (e.g. GitHub Pages) browsers only allow wss:// or ws://localhost,
// so default to a wss placeholder there and the local relay otherwise.
const DEFAULT_SERVER = location.protocol === 'https:'
  ? 'wss://'
  : `ws://${location.hostname || 'localhost'}:8787`;

export function App() {
  const decks = deckOptions();
  const [screen, setScreen] = useState<Screen>({ name: 'menu' });
  const [deck0, setDeck0] = useState(decks[0]?.id ?? '');
  const [deck1, setDeck1] = useState(decks[1]?.id ?? decks[0]?.id ?? '');
  const [serverUrl, setServerUrl] = useState(localStorage.getItem('divinity.server') ?? DEFAULT_SERVER);
  const [joinCode, setJoinCode] = useState('');
  const [netError, setNetError] = useState<string | null>(null);
  const hostSessionRef = useRef<OnlineSession | null>(null);

  if (screen.name === 'game') {
    return (
      <GameView
        key={screen.seed}
        mode={screen.mode}
        deck0={screen.deck0}
        deck1={screen.deck1}
        seed={screen.seed}
        onExit={() => setScreen({ name: 'menu' })}
      />
    );
  }

  if (screen.name === 'online') {
    return (
      <GameView
        key={screen.start.session.roomCode}
        mode="online"
        online={screen.start}
        onExit={() => setScreen({ name: 'menu' })}
      />
    );
  }

  if (screen.name === 'rules') {
    return <Rules onBack={() => setScreen({ name: 'menu' })} />;
  }

  const rememberServer = () => localStorage.setItem('divinity.server', serverUrl);

  const start = (mode: 'hotseat' | 'ai') =>
    setScreen({ name: 'game', mode, deck0, deck1, seed: (Math.random() * 0xffffffff) >>> 0 });

  const host = async () => {
    setNetError(null);
    rememberServer();
    try {
      const session = await hostRoom(serverUrl, deck0, (s, state, events) => {
        setScreen({ name: 'online', start: { session: s, state, events } });
      });
      hostSessionRef.current = session;
      setScreen({ name: 'hosting', code: session.roomCode });
    } catch (e) {
      setNetError((e as Error).message);
    }
  };

  const join = async () => {
    setNetError(null);
    rememberServer();
    setScreen({ name: 'joining' });
    try {
      const { session, state, events } = await joinRoom(serverUrl, joinCode, deck0);
      setScreen({ name: 'online', start: { session, state, events } });
    } catch (e) {
      setNetError((e as Error).message);
      setScreen({ name: 'menu' });
    }
  };

  if (screen.name === 'hosting') {
    return (
      <div className="menu">
        <h1>Room {screen.code}</h1>
        <p className="tagline">Give this code to your friend</p>
        <p className="menu-note">Waiting for them to join… the game starts automatically.</p>
        <button
          className="big-btn"
          onClick={() => { hostSessionRef.current?.close(); setScreen({ name: 'menu' }); }}
        >
          Cancel
        </button>
      </div>
    );
  }

  if (screen.name === 'joining') {
    return (
      <div className="menu">
        <h1>Joining…</h1>
        <button className="big-btn" onClick={() => setScreen({ name: 'menu' })}>Cancel</button>
      </div>
    );
  }

  return (
    <div className="menu">
      <h1>Divinity CCG</h1>
      <p className="tagline">Order · Chaos · Ruin</p>

      <div className="deck-pickers">
        <label>
          Your deck
          <select value={deck0} onChange={(e) => setDeck0(e.target.value)}>
            {decks.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          <span className="deck-sub">{deckSummary(deck0)}</span>
          <DeckCurve deckId={deck0} />
        </label>
        <label>
          Player 2 / AI deck
          <select value={deck1} onChange={(e) => setDeck1(e.target.value)}>
            {decks.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          <span className="deck-sub">{deckSummary(deck1)}</span>
          <DeckCurve deckId={deck1} />
        </label>
      </div>

      <div className="menu-btns">
        <button className="big-btn" onClick={() => start('hotseat')}>Hotseat (2 players)</button>
        <button className="big-btn" onClick={() => start('ai')}>Play vs AI</button>
        <button className="big-btn subtle" onClick={() => setScreen({ name: 'rules' })}>Rules</button>
      </div>

      <div className="online-box">
        <h3>Play online with a friend</h3>
        <label className="server-label">
          Server
          <input value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} spellCheck={false} />
        </label>
        <div className="menu-btns">
          <button className="big-btn" onClick={host}>Host a room</button>
          <input
            className="code-input"
            placeholder="CODE"
            maxLength={4}
            value={joinCode}
            onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
          />
          <button className="big-btn" disabled={joinCode.length !== 4} onClick={join}>Join</button>
        </div>
        {netError && <p className="net-error">{netError}</p>}
      </div>

      <p className="menu-note">Hotseat and AI run entirely in your browser. Online needs the relay server (npm run server).</p>
    </div>
  );
}
