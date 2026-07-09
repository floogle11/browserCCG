// End-to-end relay self-test: boots the server, connects two ws clients,
// plays a full AI-driven game through the relay, and asserts:
//  - the server never rejects an action the client-side AI proposes
//  - redaction: a client never sees opponent hand contents or any deck order
//  - reconnect: a client can drop mid-game and resume with its token
// Run: npm run selftest -w packages/server

import WebSocket from 'ws';
import { aiNextAction, HIDDEN } from '@divinity/engine';
import type { GameEvent, GameState } from '@divinity/engine';

process.env.PORT = process.env.PORT ?? '8788';
const PORT = process.env.PORT;
await import('./index.ts');

const url = `ws://localhost:${PORT}`;
const DECK0 = 'dalguarde_bulwark';
const DECK1 = 'vryas_bargain';

let failures = 0;
const fail = (msg: string) => { failures++; console.error('FAIL:', msg); };

interface Client {
  ws: WebSocket;
  idx: 0 | 1;
  token: string;
  code: string;
  state: GameState | null;
}

function connect(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

// Buffer every message per socket so back-to-back sends can't be missed
// between two awaits.
const queues = new WeakMap<WebSocket, Record<string, unknown>[]>();
function watch(ws: WebSocket): void {
  const q: Record<string, unknown>[] = [];
  queues.set(ws, q);
  ws.on('message', (raw: WebSocket.RawData) => q.push(JSON.parse(String(raw))));
}

async function nextMsg(ws: WebSocket, type: string): Promise<Record<string, unknown>> {
  const q = queues.get(ws)!;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const i = q.findIndex((m) => m.t === type || m.t === 'error');
    if (i >= 0) {
      const m = q.splice(i, 1)[0];
      if (m.t === 'error') throw new Error(String(m.msg));
      return m;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timeout waiting for ${type}`);
}

function checkRedaction(c: Client, state: GameState): void {
  const opp = (1 - c.idx) as 0 | 1;
  if (state.players[opp].hand.some((id) => id !== HIDDEN)) fail(`P${c.idx} can see opponent hand`);
  for (const p of [0, 1] as const) {
    if (state.players[p].deck.some((id) => id !== HIDDEN)) fail(`P${c.idx} can see a deck order`);
  }
  if (state.pendingChoice && state.pendingChoice.player !== c.idx && state.pendingChoice.options.length > 0) {
    fail(`P${c.idx} can see opponent choice options`);
  }
}

// --- setup: host + join ---
const ws0 = await connect();
watch(ws0);
ws0.send(JSON.stringify({ t: 'create', deckId: DECK0 }));
const created = await nextMsg(ws0, 'created');
const c0: Client = { ws: ws0, idx: 0, token: String(created.token), code: String(created.code), state: null };
console.log('room created:', c0.code);

const ws1 = await connect();
watch(ws1);
const start0Promise = nextMsg(ws0, 'start');
ws1.send(JSON.stringify({ t: 'join', code: c0.code, deckId: DECK1 }));
const joined = await nextMsg(ws1, 'joined');
const c1: Client = { ws: ws1, idx: 1, token: String(joined.token), code: c0.code, state: null };
const start1 = await nextMsg(ws1, 'start');
const start0 = await start0Promise;
c0.state = start0.state as GameState;
c1.state = start1.state as GameState;
checkRedaction(c0, c0.state);
checkRedaction(c1, c1.state);
console.log('game started; both clients have redacted snapshots');

// --- drive a full game ---
let actionsSent = 0;
let serverErrors = 0;
let gameOver = false;
let reconnected = false;

function myMove(c: Client): boolean {
  const s = c.state;
  if (!s || s.winner !== null) return false;
  if (s.pendingChoice) return s.pendingChoice.player === c.idx;
  // serialize mulligans (P0 first) so stale views can't double-send
  if (s.phase === 'mulligan') {
    return !s.players[c.idx].mulliganDone && (c.idx === 0 || s.players[0].mulliganDone);
  }
  return s.active === c.idx;
}

function act(c: Client): void {
  if (!myMove(c) || gameOver) return;
  const a = aiNextAction(c.state!, c.idx);
  c.ws.send(JSON.stringify({ t: 'action', action: a }));
  actionsSent++;
}

function attach(c: Client): void {
  c.ws.on('message', (raw: WebSocket.RawData) => {
    const m = JSON.parse(String(raw));
    if (m.t === 'update' || m.t === 'start') {
      c.state = m.state as GameState;
      checkRedaction(c, c.state);
      const events = (m.events ?? []) as GameEvent[];
      // opponent draw events must not carry card ids
      for (const e of events) {
        if (e.t === 'draw' && e.player !== c.idx && e.defId !== undefined) {
          fail(`P${c.idx} saw opponent draw ${e.defId}`);
        }
      }
      if (c.state.winner !== null) gameOver = true;
      else if (c.idx === 1 && actionsSent >= 30 && !reconnectStarted) {
        reconnectStarted = true;
        void doReconnect();
      } else setImmediate(() => act(c));
    } else if (m.t === 'error') {
      serverErrors++;
      fail(`server rejected P${c.idx} action: ${m.msg}`);
    }
  });
}
attach(c0);
attach(c1);
act(c0);
act(c1);

// --- reconnect drill, triggered mid-game from the update handler ---
let reconnectStarted = false;
async function doReconnect(): Promise<void> {
  console.log(`dropping P1 after ${actionsSent} actions to test reconnect…`);
  c1.ws.removeAllListeners('message');
  c1.ws.close();
  await new Promise((r) => setTimeout(r, 300));
  const ws1b = await connect();
  watch(ws1b);
  c1.ws = ws1b;
  ws1b.send(JSON.stringify({ t: 'rejoin', code: c1.code, token: c1.token }));
  const snap = await nextMsg(ws1b, 'start');
  c1.state = snap.state as GameState;
  checkRedaction(c1, c1.state);
  reconnected = true;
  console.log('P1 rejoined, snapshot received');
  attach(c1);
  act(c1);
}

// --- wait for the game to finish ---
const deadline = Date.now() + 60_000;
while (!gameOver && Date.now() < deadline && serverErrors < 5) {
  await new Promise((r) => setTimeout(r, 200));
}

if (!gameOver) fail('game did not finish within 60s');
if (!reconnected) fail('reconnect drill never ran');
console.log(`actions relayed: ${actionsSent}, winner: ${c0.state?.winner}, reconnected: ${reconnected}`);
console.log(failures === 0 ? 'SELFTEST PASSED' : `SELFTEST FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
