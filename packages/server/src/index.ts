// Divinity CCG relay server: private rooms, server-authoritative engine,
// per-viewer state redaction, reconnect by room code + player token.

import { WebSocketServer, WebSocket } from 'ws';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGame, applyAction, redactState, DECKS } from '@divinity/engine';
import type { Action, GameEvent, GameState } from '@divinity/engine';

const PORT = Number(process.env.PORT ?? 8787);

interface Seat {
  ws: WebSocket | null;
  token: string;
  deckId: string;
}

interface Room {
  code: string;
  seats: [Seat, Seat | null];
  state: GameState | null;
  createdAt: number;
}

const rooms = new Map<string, Room>();

// no ambiguous letters (I/O/0/1)
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
function makeCode(): string {
  let code = '';
  do {
    code = Array.from(randomBytes(4), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  } while (rooms.has(code));
  return code;
}

function send(ws: WebSocket | null, msg: unknown): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

/** hide draw contents that belong to the other player */
function redactEvents(events: GameEvent[], viewer: 0 | 1): GameEvent[] {
  return events.map((e) => {
    if (e.t === 'draw' && e.player !== viewer && e.defId !== undefined) {
      return { t: 'draw' as const, player: e.player };
    }
    return e;
  });
}

function broadcast(room: Room, events: GameEvent[]): void {
  if (!room.state) return;
  for (const i of [0, 1] as const) {
    const seat = room.seats[i];
    if (!seat) continue;
    send(seat.ws, {
      t: 'update',
      state: redactState(room.state, i),
      events: redactEvents(events, i),
    });
  }
}

function cleanupRoom(room: Room): void {
  const allClosed = room.seats.every((s) => !s || !s.ws || s.ws.readyState !== WebSocket.OPEN);
  const finished = room.state?.winner !== null && room.state !== null;
  if (allClosed || (finished && allClosed)) rooms.delete(room.code);
}

// Serve the built client (packages/client/dist) so players only need one URL.
const CLIENT_DIST = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'client', 'dist');
const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

const httpServer = createServer(async (req, res) => {
  const urlPath = (req.url ?? '/').split('?')[0];
  const relPath = urlPath === '/' ? 'index.html' : urlPath.slice(1);
  const filePath = normalize(join(CLIENT_DIST, relPath));
  if (!filePath.startsWith(CLIENT_DIST)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    // SPA fallback: unknown paths get the app shell
    try {
      const body = await readFile(join(CLIENT_DIST, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(body);
    } catch {
      res.writeHead(404).end('Client not built. Run: npm run build');
    }
  }
});

const wss = new WebSocketServer({ server: httpServer });
httpServer.listen(PORT, () => {
  console.log(`Divinity server: game page + relay on http://localhost:${PORT}`);
});

wss.on('connection', (ws) => {
  let room: Room | null = null;
  let seatIndex: 0 | 1 = 0;

  ws.on('message', (raw) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      send(ws, { t: 'error', msg: 'Bad JSON' });
      return;
    }

    switch (msg.t) {
      case 'create': {
        const deckId = String(msg.deckId ?? '');
        if (!DECKS[deckId]) { send(ws, { t: 'error', msg: 'Unknown deck' }); return; }
        const code = makeCode();
        room = {
          code,
          seats: [{ ws, token: randomBytes(12).toString('hex'), deckId }, null],
          state: null,
          createdAt: Date.now(),
        };
        rooms.set(code, room);
        seatIndex = 0;
        send(ws, { t: 'created', code, token: room.seats[0].token, playerIndex: 0 });
        break;
      }

      case 'join': {
        const code = String(msg.code ?? '').toUpperCase();
        const deckId = String(msg.deckId ?? '');
        const r = rooms.get(code);
        if (!r) { send(ws, { t: 'error', msg: 'Room not found' }); return; }
        if (r.seats[1]) { send(ws, { t: 'error', msg: 'Room is full' }); return; }
        if (!DECKS[deckId]) { send(ws, { t: 'error', msg: 'Unknown deck' }); return; }
        r.seats[1] = { ws, token: randomBytes(12).toString('hex'), deckId };
        room = r;
        seatIndex = 1;
        send(ws, { t: 'joined', code, token: r.seats[1].token, playerIndex: 1 });
        // both seated: start the game
        const seed = randomBytes(4).readUInt32BE(0);
        const { state, events } = createGame(r.seats[0].deckId, r.seats[1]!.deckId, seed);
        r.state = state;
        for (const i of [0, 1] as const) {
          send(r.seats[i]!.ws, {
            t: 'start',
            playerIndex: i,
            state: redactState(state, i),
            events: redactEvents(events, i),
          });
        }
        break;
      }

      case 'rejoin': {
        const code = String(msg.code ?? '').toUpperCase();
        const token = String(msg.token ?? '');
        const r = rooms.get(code);
        const idx = r?.seats.findIndex((s) => s?.token === token) ?? -1;
        if (!r || idx < 0) { send(ws, { t: 'error', msg: 'Cannot rejoin' }); return; }
        room = r;
        seatIndex = idx as 0 | 1;
        r.seats[seatIndex]!.ws = ws;
        if (r.state) {
          send(ws, {
            t: 'start',
            playerIndex: seatIndex,
            state: redactState(r.state, seatIndex),
            events: [],
          });
        }
        const other = r.seats[(1 - seatIndex) as 0 | 1];
        send(other?.ws ?? null, { t: 'oppBack' });
        break;
      }

      case 'action': {
        if (!room || !room.state) { send(ws, { t: 'error', msg: 'No game in progress' }); return; }
        const result = applyAction(room.state, msg.action as Action, seatIndex);
        if (result.error) {
          send(ws, { t: 'error', msg: result.error });
          return;
        }
        room.state = result.state;
        broadcast(room, result.events);
        break;
      }

      default:
        send(ws, { t: 'error', msg: 'Unknown message type' });
    }
  });

  ws.on('close', () => {
    if (!room) return;
    const seat = room.seats[seatIndex];
    if (seat && seat.ws === ws) seat.ws = null;
    const other = room.seats[(1 - seatIndex) as 0 | 1];
    send(other?.ws ?? null, { t: 'oppLeft' });
    // grace period for reconnects, then clean up if nobody is around
    const r = room;
    setTimeout(() => cleanupRoom(r), 5 * 60 * 1000);
    if (!room.state) cleanupRoom(room); // lobby that never started: drop fast
  });
});
