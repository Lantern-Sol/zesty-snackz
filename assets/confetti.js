/**
 * Confetti: a decorative field of small pieces that fall from the top of the
 * floating-stickers overlay to the bottom and loop forever. Each piece is a
 * square, rectangle or circle, randomised in colour, size, fall speed, spin and
 * horizontal drift so no two read the same and the field never visibly repeats.
 *
 * The host spans the whole overlay (see _confetti.liquid) and clips to it, so
 * pieces are born just above the top edge and die just past the bottom. The
 * number of pieces comes from the density (data-density); the colour pool from
 * data-colors (a comma-separated list, blanks already stripped in Liquid).
 *
 * Motion is pure CSS: each piece animates `translateY` over the section height,
 * a `translateX` sway wrapper drifts it side to side, and the shape itself
 * spins. The one measurement this script owns is the fall distance — the pieces
 * must fall exactly the section's height regardless of how tall it renders — so
 * we publish it as --confetti-fall-distance and keep it in sync on resize.
 *
 * Expected markup: an empty <confetti-field> host carrying data-density and
 * data-colors. This script fills it with the pieces.
 */

/** Piece counts per density. Kept modest so even "high" stays light to paint. */
const DENSITY_COUNTS = {
  low: 24,
  medium: 48,
  high: 80,
};

/** Fallback palette used when the block ships no colours. */
const DEFAULT_COLORS = [
  '#ff5da2',
  '#2ec4ff',
  '#7ed957',
  '#ff8a3d',
  '#a06bff',
  '#ffd23f',
  '#ff5b5b',
];

const SHAPES = ['square', 'rectangle', 'circle'];

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

/**
 * @param {number} min
 * @param {number} max
 */
function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

/** @param {any[]} list */
function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

/**
 * @param {() => void} fn
 * @param {number} wait
 */
function debounce(fn, wait) {
  let timer;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(fn, wait);
  };
}

class ConfettiField extends HTMLElement {
  /** Height the fall distance was last published for; skips no-op resizes. */
  #builtHeight = 0;

  /** @type {ResizeObserver | undefined} */
  #resizeObserver;

  connectedCallback() {
    this.#syncFallDistance();
    this.#build();

    // The pieces fall exactly the section height, which grows as the page loads
    // its media — republish the distance whenever it really moves (debounced to
    // ride out the churn).
    this.#resizeObserver = new ResizeObserver(
      debounce(() => this.#syncFallDistance(), 150)
    );
    this.#resizeObserver.observe(this);
  }

  disconnectedCallback() {
    this.#resizeObserver?.disconnect();
  }

  #syncFallDistance() {
    const height = this.clientHeight;
    if (!height || height === this.#builtHeight) return;
    this.#builtHeight = height;
    // A buffer past the bottom so pieces clear the edge before wrapping.
    this.style.setProperty('--confetti-fall-distance', `${height + 40}px`);
  }

  get #count() {
    return DENSITY_COUNTS[this.dataset.density ?? 'medium'] ?? DENSITY_COUNTS.medium;
  }

  get #colors() {
    const colors = (this.dataset.colors ?? '')
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);
    return colors.length ? colors : DEFAULT_COLORS;
  }

  #build() {
    const colors = this.#colors;
    const still = reducedMotion.matches;
    const fragment = document.createDocumentFragment();

    for (let i = 0; i < this.#count; i += 1) {
      fragment.appendChild(this.#createPiece(colors, still));
    }

    this.replaceChildren(fragment);
  }

  /**
   * One piece: an outer faller (translateY), a sway wrapper (translateX) and the
   * coloured shape (spin). Every random dimension is handed to CSS as a custom
   * property so the keyframes stay generic.
   *
   * @param {string[]} colors
   * @param {boolean} still - reduced-motion: scatter statically, no animation
   */
  #createPiece(colors, still) {
    const shape = pick(SHAPES);
    const size = randomBetween(6, 16);
    // Rectangles are longer than they are tall; squares and circles are even.
    const width = shape === 'rectangle' ? size * randomBetween(1.6, 2.6) : size;
    const height = size;

    const piece = document.createElement('div');
    piece.className = 'confetti__piece';
    piece.style.setProperty('--confetti-x', randomBetween(0, 100).toFixed(2));
    piece.style.setProperty('--confetti-size', `${height.toFixed(1)}px`);

    const fallDuration = randomBetween(4.5, 9);
    piece.style.setProperty('--confetti-duration', `${fallDuration.toFixed(2)}s`);
    // Negative delay up to a full cycle spreads the pieces along the fall at load
    // instead of dropping them all from the top at once.
    piece.style.setProperty('--confetti-delay', `${randomBetween(0, fallDuration).toFixed(2)}s`);
    // Only read under reduced motion, where the fall is off and pieces sit put.
    piece.style.setProperty('--confetti-start-y', randomBetween(-5, 105).toFixed(2));

    const sway = document.createElement('div');
    sway.className = 'confetti__sway';
    sway.style.setProperty('--confetti-sway-distance', `${randomBetween(6, 20).toFixed(1)}px`);
    sway.style.setProperty('--confetti-sway-duration', `${randomBetween(2, 4).toFixed(2)}s`);
    sway.style.setProperty('--confetti-sway-delay', `${randomBetween(0, 4).toFixed(2)}s`);

    const shapeEl = document.createElement('div');
    shapeEl.className = `confetti__shape confetti__shape--${shape}`;
    shapeEl.style.setProperty('--confetti-color', pick(colors));
    shapeEl.style.setProperty('--confetti-w', `${width.toFixed(1)}px`);
    shapeEl.style.setProperty('--confetti-h', `${height.toFixed(1)}px`);
    shapeEl.style.setProperty('--confetti-spin-duration', `${randomBetween(1.6, 3.4).toFixed(2)}s`);
    shapeEl.style.setProperty('--confetti-spin-direction', Math.random() < 0.5 ? 'normal' : 'reverse');

    sway.appendChild(shapeEl);
    piece.appendChild(sway);
    if (still) piece.classList.add('confetti__piece--still');
    return piece;
  }
}

if (!customElements.get('confetti-field')) {
  customElements.define('confetti-field', ConfettiField);
}
