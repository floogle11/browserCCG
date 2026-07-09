#!/usr/bin/env node
/**
 * Generate card art with a local Stable Diffusion WebUI (AUTOMATIC1111-style API).
 *
 * Start the WebUI with API enabled (`--api`), then:
 *
 *   node tools/generate-art.mjs                 # generate art for every card missing it
 *   node tools/generate-art.mjs --dry-run       # print the prompts without generating
 *   node tools/generate-art.mjs --only bear,denounce
 *   node tools/generate-art.mjs --force         # regenerate even if the file exists
 *   node tools/generate-art.mjs --reroll 3      # bump every seed by 3 (new variations)
 *
 * Env: ART_API=http://127.0.0.1:7860 (default) — point at your WebUI.
 *
 * Output: packages/client/public/art/<cardId>.png — the client picks these up
 * automatically (missing files fall back to a gradient placeholder).
 *
 * Optional per-card prompt overrides in data/art-prompts.json:
 *   { "bear": "a massive brown bear rearing up in a moonlit forest" }
 * An override replaces the auto-generated subject line; the shared style
 * suffix and faction palette are still appended.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(root, 'packages', 'client', 'public', 'art');
const API = process.env.ART_API ?? 'http://127.0.0.1:7860';

// ---- tune these to taste -------------------------------------------------
const STYLE =
  'fantasy trading card game illustration, painterly digital art, dramatic lighting, ' +
  'rich color, detailed, epic composition, no text, no borders, no watermark';
const NEGATIVE =
  'text, watermark, signature, frame, border, card layout, lowres, blurry, ' +
  'deformed, extra limbs, photo, photorealistic';
const GEN = { steps: 28, cfg_scale: 6.5, width: 576, height: 384, sampler_name: 'DPM++ 2M' };
// --------------------------------------------------------------------------

const FACTION_FLAVOR = {
  O: 'golden radiant holy light, gleaming armor, marble and sunbeams (Order)',
  C: 'roaring flame, embers, wild orange-red chaos energy (Chaos)',
  R: 'violet shadow, decay, bone and entropy, eerie purple glow (Ruin)',
  I: 'shimmering cyan inspiration, starlight (Inspiration)',
  G: 'brilliant white glory, triumphant banners (Glory)',
  N: 'verdant green growth, ancient forest (Nature)',
};

const TYPE_SUBJECT = {
  creature: (c) => `${c.name}, a fantasy ${c.tribes?.length ? c.tribes.join(' ') + ' ' : ''}creature, full-body character portrait`,
  token: (c) => `${c.name}, a small summoned fantasy creature`,
  spell: (c) => `${c.name}, a dramatic burst of spell magic being cast`,
  decree: (c) => `${c.name}, a divine decree, gods intervening from the heavens`,
  aura: (c) => `${c.name}, a mystical enchanted place or monument`,
};

function hashSeed(id) {
  let h = 2166136261;
  for (const ch of id) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return (h >>> 0) % 2147483647;
}

function buildPrompt(card, overrides) {
  const subject = overrides[card.id] ?? TYPE_SUBJECT[card.type]?.(card) ?? card.name;
  const factions = Object.keys(card.cost ?? {}).map((k) => FACTION_FLAVOR[k]).filter(Boolean);
  return [subject, ...factions, STYLE].join(', ');
}

async function txt2img(prompt, seed) {
  const res = await fetch(`${API}/sdapi/v1/txt2img`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt, negative_prompt: NEGATIVE, seed, ...GEN }),
  });
  if (!res.ok) throw new Error(`WebUI API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  if (!data.images?.[0]) throw new Error('WebUI returned no image');
  return Buffer.from(data.images[0], 'base64');
}

// ---- main ----------------------------------------------------------------
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };

const cards = JSON.parse(readFileSync(join(root, 'data', 'cards.json'), 'utf8'));
const overridesPath = join(root, 'data', 'art-prompts.json');
const overrides = existsSync(overridesPath) ? JSON.parse(readFileSync(overridesPath, 'utf8')) : {};
const only = opt('only')?.split(',').map((s) => s.trim());
const reroll = Number(opt('reroll') ?? 0);

const todo = cards.filter((c) => {
  if (only && !only.includes(c.id)) return false;
  if (!flag('force') && !flag('dry-run') && existsSync(join(OUT_DIR, `${c.id}.png`))) return false;
  return true;
});

console.log(`${todo.length} card(s) to generate (of ${cards.length} total). API: ${API}`);
mkdirSync(OUT_DIR, { recursive: true });

let done = 0;
for (const card of todo) {
  const prompt = buildPrompt(card, overrides);
  const seed = hashSeed(card.id) + reroll;
  if (flag('dry-run')) {
    console.log(`\n[${card.id}] seed=${seed}\n  ${prompt}`);
    continue;
  }
  process.stdout.write(`[${++done}/${todo.length}] ${card.id} ... `);
  try {
    const png = await txt2img(prompt, seed);
    writeFileSync(join(OUT_DIR, `${card.id}.png`), png);
    console.log(`ok (${(png.length / 1024).toFixed(0)} KB)`);
  } catch (e) {
    console.log(`FAILED: ${e.message}`);
  }
}
if (!flag('dry-run')) console.log('\nDone. Refresh the client to see the art.');
