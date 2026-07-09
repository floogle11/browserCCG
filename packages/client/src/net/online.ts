// WebSocket client for private online play. The server is authoritative;
// we send Actions and receive redacted states + event lists.

import type { Action, GameEvent, GameState } from '@divinity/engine';

export interface OnlineSession {
  playerIndex: 0 | 1;
  roomCode: string;
  token: string;
  send(action: Action): void;
  /** fires on every authoritative update (including the initial snapshot) */
  onUpdate: (cb: (state: GameState, events: GameEvent[]) => void) => void;
  onError: (cb: (msg: string) => void) => void;
  onPresence: (cb: (oppConnected: boolean) => void) => void;
  close(): void;
}

interface ServerMsg {
  t: string;
  code?: string;
  token?: string;
  playerIndex?: 0 | 1;
  state?: GameState;
  events?: GameEvent[];
  msg?: string;
}

class Session implements OnlineSession {
  playerIndex: 0 | 1 = 0;
  roomCode = '';
  token = '';
  private updateCb: ((s: GameState, e: GameEvent[]) => void) | null = null;
  private errorCb: ((m: string) => void) | null = null;
  private presenceCb: ((c: boolean) => void) | null = null;
  private closed = false;

  constructor(private ws: WebSocket, private url: string) {
    this.attach(ws);
  }

  private attach(ws: WebSocket) {
    this.ws = ws;
    ws.onmessage = (ev) => {
      const m: ServerMsg = JSON.parse(String(ev.data));
      if ((m.t === 'start' || m.t === 'update') && m.state) {
        if (m.playerIndex !== undefined) this.playerIndex = m.playerIndex;
        this.updateCb?.(m.state, m.events ?? []);
      } else if (m.t === 'error') {
        this.errorCb?.(m.msg ?? 'Server error');
      } else if (m.t === 'oppLeft') {
        this.presenceCb?.(false);
      } else if (m.t === 'oppBack') {
        this.presenceCb?.(true);
      }
    };
    ws.onclose = () => {
      if (this.closed) return;
      // auto-reconnect with our token
      setTimeout(() => {
        if (this.closed) return;
        const next = new WebSocket(this.url);
        next.onopen = () => next.send(JSON.stringify({ t: 'rejoin', code: this.roomCode, token: this.token }));
        this.attach(next);
      }, 1500);
    };
  }

  send(action: Action) {
    this.ws.send(JSON.stringify({ t: 'action', action }));
  }
  onUpdate(cb: (s: GameState, e: GameEvent[]) => void) { this.updateCb = cb; }
  onError(cb: (m: string) => void) { this.errorCb = cb; }
  onPresence(cb: (c: boolean) => void) { this.presenceCb = cb; }
  close() { this.closed = true; this.ws.close(); }
}

/** Host a room. Resolves with the session + room code once the room exists.
 *  `onStart` fires later, when the friend joins and the game begins. */
export function hostRoom(
  url: string,
  deckId: string,
  onStart: (session: OnlineSession, state: GameState, events: GameEvent[]) => void,
): Promise<OnlineSession> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const session = new Session(ws, url);
    let started = false;
    ws.onopen = () => ws.send(JSON.stringify({ t: 'create', deckId }));
    ws.onerror = () => reject(new Error('Could not reach the server'));
    const origOnMessage = ws.onmessage!;
    ws.onmessage = (ev) => {
      const m: ServerMsg = JSON.parse(String(ev.data));
      if (m.t === 'created') {
        session.roomCode = m.code ?? '';
        session.token = m.token ?? '';
        session.playerIndex = 0;
        resolve(session);
        return;
      }
      if (m.t === 'start' && !started && m.state) {
        started = true;
        session.playerIndex = m.playerIndex ?? 0;
        onStart(session, m.state, m.events ?? []);
        return;
      }
      (origOnMessage as (this: WebSocket, ev: MessageEvent) => void).call(ws, ev as MessageEvent);
    };
  });
}

/** Join a friend's room by code. Resolves when the game starts. */
export function joinRoom(
  url: string,
  code: string,
  deckId: string,
): Promise<{ session: OnlineSession; state: GameState; events: GameEvent[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const session = new Session(ws, url);
    ws.onopen = () => ws.send(JSON.stringify({ t: 'join', code: code.toUpperCase(), deckId }));
    ws.onerror = () => reject(new Error('Could not reach the server'));
    const origOnMessage = ws.onmessage!;
    ws.onmessage = (ev) => {
      const m: ServerMsg = JSON.parse(String(ev.data));
      if (m.t === 'joined') {
        session.roomCode = m.code ?? '';
        session.token = m.token ?? '';
        session.playerIndex = 1;
        return;
      }
      if (m.t === 'error' && !session.roomCode) {
        reject(new Error(m.msg ?? 'Join failed'));
        return;
      }
      if (m.t === 'start' && m.state) {
        session.playerIndex = m.playerIndex ?? 1;
        resolve({ session, state: m.state, events: m.events ?? [] });
        return;
      }
      (origOnMessage as (this: WebSocket, ev: MessageEvent) => void).call(ws, ev as MessageEvent);
    };
  });
}
