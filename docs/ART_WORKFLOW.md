# Card art workflow (local image-gen)

How to fill all 95 cards with AI-generated art using a locally hosted image
model, end to end. The client already supports art: it loads
`packages/client/public/art/<cardId>.png` for each card and falls back to a
faction-tinted gradient when the file is missing — so art can land
incrementally, card by card.

## The pipeline at a glance

```
data/cards.json ──► tools/generate-art.mjs ──► local WebUI API ──► public/art/<id>.png ──► git commit ──► GitHub Pages
     (95 cards)      (builds prompts,           (txt2img)            (auto-loaded by
                      deterministic seeds)                            CardFace/zoom/slots)
```

## 1. Launch the WebUI with API access

- **AUTOMATIC1111 / SD.Next / Forge**: start with the `--api` flag. The script
  targets `http://127.0.0.1:7860/sdapi/v1/txt2img` by default; override with
  `ART_API=http://host:port`.
- **ComfyUI**: its API is workflow-graph based, not txt2img-shaped. Easiest
  path: enable the A1111-compatible endpoint via an extension, or ask me to
  add a ComfyUI mode to the script (it would POST your exported workflow JSON
  to `/prompt` with the prompt node swapped per card).

Any SDXL or SD1.5 checkpoint works; a stylized/painterly fantasy checkpoint
(e.g. a "fantasy art" or "dark fantasy" fine-tune) will look far more coherent
than a base model. Pick **one** checkpoint and keep it for the whole set so
the cards feel like one game.

## 2. Generate

```bash
node tools/generate-art.mjs --dry-run          # review all 95 prompts first
node tools/generate-art.mjs                    # generate everything missing
node tools/generate-art.mjs --only bear,denounce --force   # redo specific cards
node tools/generate-art.mjs --only bear --force --reroll 1 # different variation
```

Key properties of the script:

- **Prompts are derived from card data** — name, type, tribes, and the
  devotion colors in the cost map to style fragments (Order → golden/holy,
  Chaos → flame, Ruin → violet decay), plus a shared style suffix. Everything
  tunable lives at the top of `tools/generate-art.mjs` (`STYLE`, `NEGATIVE`,
  `GEN` size/steps/sampler).
- **Deterministic seeds** — each card's seed is a hash of its id, so re-running
  reproduces the same image; `--reroll N` shifts every seed for new takes.
- **Skips existing files** — safe to re-run after adding new cards; only the
  missing ones generate. `--force` regenerates.
- **Per-card overrides** — when the auto-prompt misses (spell names can be
  abstract), create `data/art-prompts.json`:

  ```json
  {
    "denounce": "a stern golden god pointing in judgment at a cowering warrior",
    "blinding_light": "a knight shielding their eyes from an explosion of white-gold light"
  }
  ```

  The override replaces the subject line; faction palette + style suffix still apply.

## 3. Review and iterate

1. Run the dev client (`npm run dev`) and hover cards — the zoom panel shows
   art large, and it hot-reloads as new files appear in `public/art/`.
2. Keep a shortlist of misses, fix them with overrides + `--only id --force`.
3. The art window is landscape (576×384 generated, shown ~3:1 on the small
   card and ~5:2 in the zoom panel, center-cropped via `object-fit: cover`) —
   prompts that put the subject in the middle crop best.

## 4. Ship it

Art files are plain assets in `packages/client/public/art/`, so:

```bash
git add packages/client/public/art
git commit -m "Card art batch 1"
git push        # GitHub Actions rebuilds and redeploys Pages automatically
```

~95 PNGs at 576×384 is roughly 25–40 MB — fine for a git repo. If it grows
(multiple rerolls, SDXL sizes), convert to JPEG/WebP or add Git LFS; say the
word and I'll add a compression step to the script.

## Possible next steps

- **God portraits** — same pipeline pointed at `data/gods.json`, displayed in
  the god panels.
- **Card-back and menu splash art** — two one-off generations that make the
  first impression.
- **ComfyUI native mode** — if that's your WebUI of choice.
- **img2img polish pass** — regenerate weak cards using the current image as
  the init at low denoise to keep composition but improve quality.
