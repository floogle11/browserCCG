// Static rules reference, condensed from the authoritative rules spec.

const KEYWORDS: [string, string][] = [
  ['Summon:', 'Triggers when this card enters the battlefield from hand or graveyard. Targets are chosen on play.'],
  ['Crossing:', 'Triggers when this creature dies.'],
  ['Passive:', 'Continuous effect while on the battlefield.'],
  ['Activatable X:', 'Activated ability. Pay X, once per turn, only in your main phases, not the turn it was played (unless it has Rushdown).'],
  ['Lethal:', "Triggers when this card's damage kills a creature."],
  ['Battle Tested:', 'Bonus applies while this creature is damaged.'],
  ['Defender', 'Enemy attackers facing it or adjacent to its facing slot must attack it first. Cannot attack.'],
  ['Forcing', 'This attacker ignores Defender priority.'],
  ['Aegis', 'The next time this creature would take damage, prevent it and remove Aegis.'],
  ['Rushdown', 'Can attack (and use Activatables) the turn it is played.'],
  ['Cleave', 'Combat damage to a creature also hits the creatures adjacent to the target.'],
  ['Pierce', "This card's damage ignores Armor."],
  ['Crushing', "Excess combat damage beyond the killed creature's Health + Armor hits the enemy god."],
  ['Lifetap', 'Heals its controller\'s god equal to the damage it deals.'],
  ['Shroud', 'Cannot be targeted by enemy spells or abilities (combat and untargeted effects still work).'],
  ['Poisonous', "Creatures damaged by this die at the start of this card's controller's next turn. Purify removes it."],
  ['Burn (x)', 'At the end of each turn a burned creature takes x damage, then x drops by 1. New burns add. Ignores armor.'],
  ['Snare', 'Snared creatures cannot enter attack stance until their controller\'s next turn ends.'],
  ['Nullify', 'Remove all text, keywords, buffs and statuses (stats revert to printed values).'],
  ['Sanctuary (x)', "Cannot be affected by enemy cards or abilities for x of the controller's turns. Combat still works."],
  ['Purify', 'Remove negative statuses (poison, burn, snare, debuffs) from a friendly creature.'],
  ['Sacrifice N', 'Additional cost: destroy N friendly creatures (they die, triggering Crossing).'],
  ['Obliterate', 'Removed from the game entirely — not the graveyard.'],
  ['Reanimate', 'Return the top creature card of your graveyard to the battlefield.'],
  ['Restore X', "Heal X (creatures can't exceed max Health; gods can't exceed 25)."],
];

export function Rules({ onBack }: { onBack: () => void }) {
  return (
    <div className="rules">
      <div className="rules-inner">
        <button className="big-btn" onClick={onBack}>← Back</button>
        <h1>How to play</h1>

        <h2>The basics</h2>
        <p>
          Two gods battle from 25 HP; reduce your opponent to 0 to win. Drawing from an empty deck loses the game.
          Decks are 40 cards in 1–2 devotions, plus a bag of 12 mana crystals split between those devotions.
        </p>
        <p>
          At the start of your turn, all your crystals refresh and one random crystal is pulled from your bag
          into your permanent pool. Cards cost specific colors (e.g. 2 Order + 1 Ruin taps those crystals).
          Hand limit is 10 — excess cards are banished at end of turn.
        </p>

        <h2>Turn order</h2>
        <ol>
          <li><b>Start:</b> refresh crystals, pull 1 from the bag, armor regenerates, start-of-turn triggers, draw a card, pay Aura upkeep.</li>
          <li><b>Main 1:</b> play cards, use abilities, set creatures to attack stance.</li>
          <li><b>Attack:</b> press <i>Attack!</i> — attackers resolve left to right automatically.</li>
          <li><b>Main 2:</b> play more cards (stances are locked).</li>
          <li><b>End:</b> end-of-turn triggers, Burn ticks, hand limit, pass.</li>
        </ol>

        <h2>The board & combat</h2>
        <p>
          Each side has 6 slots. Your first creature must go in slot 3 or 4; after that, new creatures must be
          placed adjacent to one you control. A creature in attack stance <b>drops its armor</b> until your next turn.
        </p>
        <p>
          When an attack resolves: enemy <b>Defenders</b> in or adjacent to the facing slot must be hit first
          (unless the attacker has Forcing); otherwise the creature in the facing slot is hit; otherwise the enemy god.
          Combat damage is mutual — the defender simultaneously hits back. Armor absorbs damage point-for-point and
          regenerates each turn; Pierce ignores it.
        </p>

        <h2>Devotion track</h2>
        <p>
          Every crystal you spend adds 1 charge to your god's Devotion Track. Abilities cost 10 / 25 / 50 charges,
          and you may use one track ability per turn during your main phases.
        </p>

        <h2>Card types</h2>
        <ul>
          <li><b>Creature</b> — Attack / Health / Armor, occupies a slot.</li>
          <li><b>Spell</b> — one-shot effect, then graveyard.</li>
          <li><b>Decree</b> — face-up delayed trigger (max 2); fires once when its condition occurs.</li>
          <li><b>Aura</b> — sits in a creature slot, pays Upkeep at your start step or dies; can be attacked.</li>
          <li><b>Token</b> — created by effects; ceases to exist when it leaves the board.</li>
        </ul>

        <h2>Keywords</h2>
        <table>
          <tbody>
            {KEYWORDS.map(([k, v]) => (
              <tr key={k}><td className="kw">{k}</td><td>{v}</td></tr>
            ))}
          </tbody>
        </table>

        <button className="big-btn" onClick={onBack}>← Back</button>
      </div>
    </div>
  );
}
