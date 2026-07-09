# Divinity CCG (web)

A two-player card battler — Order, Chaos and Ruin devotions, a 6-slot positional board,
random-draw mana crystals and per-god Devotion Track powers. Pure-TypeScript rules engine,
React client, and a small WebSocket relay for private online play.

**Play it now:** https://floogle11.github.io/browserCCG/ — hotseat and vs-AI run
entirely in the browser.

## Quick start (local dev)

```bash
npm install
npm run dev        # client at http://localhost:5173
```

From the menu you can play **hotseat** (pass the device) or **vs the AI** — both run
entirely in the browser, no server needed.

## Hosting

Pushing to `main` triggers `.github/workflows/deploy.yml`, which runs the engine
tests, builds the client, and deploys it to GitHub Pages. One-time setup: in the
repo's **Settings → Pages**, set *Source* to **GitHub Actions**.

## Play online with a friend

1. Start the relay server:

   ```bash
   npm run server           # ws://localhost:8787 (set PORT to change)
   ```

2. Both players open the client, put the server address in the *Server* box,
   then one clicks **Host a room** and shares the 4-letter code; the other enters it and clicks **Join**.

3. The server is authoritative and redacts hidden information (opponent hand, deck order),
   so peeking at network traffic won't spoil anything. If a browser drops, reloading and
   re-joining within a few minutes resumes the game.

### Playing over the internet

The relay binds to localhost — to reach a friend elsewhere, tunnel the port:

- **cloudflared:** `cloudflared tunnel --url http://localhost:8787` and give your friend the
  printed URL (as `wss://<subdomain>.trycloudflare.com`), or
- **ngrok:** `ngrok http 8787` (use the `wss://` form of the forwarding URL),

or run the server on any free-tier Node host and point both clients at it. Room codes are
random 4-letter strings; there is no lobby list, so only people you give the code to can join.

> **From the GitHub Pages site** the page is https, so browsers only allow secure
> WebSockets — use the `wss://` tunnel URL (cloudflared/ngrok both provide one),
> not a plain `ws://` address.

## Card art

Card art lives in `packages/client/public/art/<cardId>.png`; missing art falls back
to a faction-tinted placeholder. `tools/generate-art.mjs` generates the full set from
a locally hosted Stable Diffusion WebUI — see [docs/ART_WORKFLOW.md](docs/ART_WORKFLOW.md).

## Workspace layout

| Package | What it is |
|---|---|
| `packages/engine` | Pure-TS rules engine — game state, action interpreter, all card scripts, greedy AI. No DOM/Node deps. |
| `packages/client` | Vite + React UI (hotseat, AI, online). |
| `packages/server` | Node + `ws` relay: rooms, authoritative engine, per-viewer redaction, reconnect. |
| `data/` | `cards.json` (the card set), `decks.json` (prebuilt decks), `gods.json` (devotion track kits). |

## Tests

```bash
npm test                              # engine: mechanics, card data, 100-game AI fuzz
npm run selftest -w packages/server   # relay: full online game, redaction + reconnect asserts
```

## Balance tunables

`GOD_HP 25 · deck 40 · mana bag 12 · hand limit 10 · track tiers 10/25/50` — all constants
in `packages/engine/src/types.ts`. Starter decks in `data/decks.json` are first drafts; rebalance freely.
