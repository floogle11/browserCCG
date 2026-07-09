import { useReducer } from 'react';
import type { CSSProperties } from 'react';
import { cardDef, HIDDEN } from '@divinity/engine';
import type { CardDef, Cost } from '@divinity/engine';

export const DEV_COLORS: Record<string, string> = {
  O: '#e8c15a', C: '#e06038', R: '#a06ae8', I: '#58c8e8', G: '#e8e8e8', N: '#68c868',
};
export const DEV_NAMES: Record<string, string> = {
  O: 'Order', C: 'Chaos', R: 'Ruin', I: 'Inspiration', G: 'Glory', N: 'Nature',
};

/** Colors of the devotions in a card's cost (empty for tokens/free cards). */
function costColors(def: CardDef): string[] {
  return Object.keys(def.cost).filter((k) => (def.cost[k as keyof Cost] ?? 0) > 0).map((k) => DEV_COLORS[k]);
}

/** CSS vars for faction theming: --fc main frame color, --fc2 secondary. */
export function factionStyle(def: CardDef): CSSProperties {
  const colors = costColors(def);
  const fc = colors[0] ?? '#8a80a8';
  const fc2 = colors[1] ?? fc;
  return { '--fc': fc, '--fc2': fc2 } as CSSProperties;
}

export function artUrl(defId: string): string {
  return `${import.meta.env.BASE_URL}art/${defId}.png`;
}

/* Remember which images 404'd so we don't re-request them on every render. */
const missingArt = new Set<string>();

/**
 * Card illustration: real art from public/art/<id>.png when present,
 * otherwise a deterministic faction-tinted gradient placeholder.
 */
export function CardArt({ defId, className = 'card-art' }: { defId: string; className?: string }) {
  const [, bump] = useReducer((x: number) => x + 1, 0);
  const def = cardDef(defId);
  if (missingArt.has(defId)) {
    const colors = costColors(def);
    const a = colors[0] ?? '#4a4066';
    const b = colors[1] ?? '#241f38';
    // Vary the angle per card so placeholders don't all look identical.
    let hash = 0;
    for (const ch of defId) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    const angle = hash % 360;
    return (
      <div
        className={`${className} art-fallback`}
        style={{ background: `linear-gradient(${angle}deg, ${a}55, ${b}ee 70%)` }}
      />
    );
  }
  return (
    <img
      className={className}
      src={artUrl(defId)}
      alt=""
      draggable={false}
      onError={() => { missingArt.add(defId); bump(); }}
    />
  );
}

export function CostPips({ cost }: { cost: Cost }) {
  const entries = Object.entries(cost).filter(([, n]) => (n ?? 0) > 0);
  return (
    <span className="pips">
      {entries.map(([color, n]) => (
        <span key={color} className="pip" style={{ background: DEV_COLORS[color] }}>{n}</span>
      ))}
    </span>
  );
}

const TYPE_LABEL: Record<string, string> = {
  creature: 'Creature', spell: 'Spell', decree: 'Decree', aura: 'Aura', token: 'Token',
};

export function CardFace({
  defId, onClick, selected, dim, onHover,
}: {
  defId: string;
  onClick?: () => void;
  selected?: boolean;
  dim?: boolean;
  onHover?: (defId: string | null) => void;
}) {
  if (defId === HIDDEN) {
    return <div className="card card-back" />;
  }
  const def = cardDef(defId);
  const isCreature = def.type === 'creature' || def.type === 'token';
  return (
    <div
      className={`card${selected ? ' selected' : ''}${dim ? ' dim' : ''}${onClick ? ' clickable' : ''}`}
      style={factionStyle(def)}
      onClick={onClick}
      onMouseEnter={onHover ? () => onHover(defId) : undefined}
      onMouseLeave={onHover ? () => onHover(null) : undefined}
    >
      <div className="card-top">
        <span className="card-name">{def.name}</span>
        <CostPips cost={def.cost} />
      </div>
      <CardArt defId={defId} />
      <div className="card-type">
        {TYPE_LABEL[def.type]}{def.tribes?.length ? ` — ${def.tribes.join(', ')}` : ''} · {def.rarity}
      </div>
      <div className="card-text">{def.text}</div>
      {isCreature && (
        <div className="card-stats">
          <span className="stat atk">{def.attack ?? 0}</span>
          {(def.armor ?? 0) > 0 && <span className="stat arm">{def.armor}</span>}
          <span className="stat hp">{def.health ?? 0}</span>
        </div>
      )}
      {def.type === 'aura' && (
        <div className="card-stats">
          <span className="stat hp">{def.health ?? 1}</span>
        </div>
      )}
    </div>
  );
}

/** Large read-only rendering for the zoom side panel. */
export function CardZoom({ defId }: { defId: string }) {
  if (defId === HIDDEN) return null;
  const def = cardDef(defId);
  return (
    <div className="zoom-card" style={factionStyle(def)}>
      <div className="card-top">
        <span className="card-name">{def.name}</span>
        <CostPips cost={def.cost} />
      </div>
      <CardArt defId={defId} className="zoom-art" />
      <div className="card-type">
        {TYPE_LABEL[def.type]}{def.tribes?.length ? ` — ${def.tribes.join(', ')}` : ''} · {def.rarity}
      </div>
      <div className="card-text">{def.text}</div>
      {def.type === 'creature' || def.type === 'token' ? (
        <div className="zoom-stats">Attack {def.attack ?? 0} · Health {def.health ?? 0} · Armor {def.armor ?? 0}</div>
      ) : null}
      {def.upkeep && <div className="zoom-stats">Upkeep: <CostPips cost={def.upkeep} /></div>}
      {def.sacrifice ? <div className="zoom-stats">Sacrifice {def.sacrifice}</div> : null}
    </div>
  );
}
