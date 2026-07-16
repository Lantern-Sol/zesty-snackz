/**
 * Wave marquee: a line of text whose letters travel along a sine wave that
 * stays fixed in space (the letters ride up over crests and down into troughs
 * as they pass through, each rotated tangent to the curve).
 *
 * The motion is one CSS animation of a single angle, --wm-phase, from 0 to
 * `frequency` full turns. Everything else is derived from it in `calc()`:
 *
 * - the strip slides left by exactly one repeat (--wm-unit) per loop, so new
 *   letters enter seamlessly;
 * - each glyph's vertical offset is `amp * sin(theta - phase)`, where `theta`
 *   is baked per glyph from its resting x. Because the wave is a function of
 *   the glyph's *absolute* position, sliding the strip leaves the wave itself
 *   stationary — the letters are what move.
 * - each glyph rotates by `atan(slope * cos(theta - phase))`, the curve's
 *   tangent at that point.
 *
 * A whole number of waves fits in one repeat, so after one loop every glyph has
 * advanced an exact number of turns and the frame is identical — seamless.
 *
 * All measurement uses offsetLeft / offsetWidth (layout coordinates), so it
 * stays correct even when the host is tilted via the `rotation` setting.
 *
 * Expected markup:
 * - host carries data-text, data-freq (waves per repeat) and data-amp (px)
 * - `[data-wm-track]` - the strip; JS fills, duplicates and bakes each glyph
 */

/** Safety cap so a tiny host width can never spin the fill loop forever. */
const MAX_UNITS_PER_SEGMENT = 200;

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

class WaveMarquee extends HTMLElement {
  /** @type {HTMLElement | null} */
  #track = null;

  /** @type {HTMLElement | null} */
  #viewport = null;

  /** Width the strip was last built for; lets us ignore height-only resizes. */
  #builtWidth = 0;

  /** @type {ResizeObserver | undefined} */
  #resizeObserver;

  connectedCallback() {
    this.#track = this.querySelector('[data-wm-track]');
    this.#viewport = this.querySelector('[data-wm-viewport]');
    if (!this.#track || !this.#viewport) return;

    this.#build();

    // Only the band's width changes what needs building. A page full of loading
    // media relayouts its height constantly; rebuilding then would clear and
    // reflow the strip for nothing, so rebuild only when the width really moves.
    this.#resizeObserver = new ResizeObserver(
      debounce(() => {
        if (this.#viewport && this.#viewport.clientWidth !== this.#builtWidth) this.#build();
      }, 150)
    );
    this.#resizeObserver.observe(this.#viewport);
  }

  disconnectedCallback() {
    this.#resizeObserver?.disconnect();
  }

  get #text() {
    return this.dataset.text ?? '';
  }

  get #frequency() {
    const freq = Math.round(Number.parseFloat(this.dataset.freq ?? '2'));
    return Number.isFinite(freq) && freq > 0 ? freq : 1;
  }

  get #amplitude() {
    const amp = Number.parseFloat(this.dataset.amp ?? '24');
    return Number.isFinite(amp) ? amp : 24;
  }

  /** Builds a single repeat: the text with every character wrapped for measuring. */
  #makeUnit() {
    const unit = document.createElement('span');
    unit.className = 'wave-marquee__unit';

    for (const char of this.#text) {
      const glyph = document.createElement('span');
      glyph.className = 'wave-marquee__glyph';
      // Preserve spaces as non-breaking so they keep width and never collapse.
      glyph.textContent = char === ' ' ? ' ' : char;
      unit.appendChild(glyph);
    }

    return unit;
  }

  #build() {
    const track = this.#track;
    if (!track || !this.#viewport) return;

    const viewport = this.#viewport.clientWidth;
    if (!viewport || this.#text === '') return;

    this.#builtWidth = viewport;
    track.textContent = '';

    // Measure one repeat.
    track.appendChild(this.#makeUnit());
    const firstUnit = track.firstElementChild;
    if (!(firstUnit instanceof HTMLElement)) return;
    const unitWidth = firstUnit.offsetWidth;
    if (!unitWidth) return;

    const freq = this.#frequency;

    // Frequency is the number of peaks the merchant wants across the *visible*
    // band, so the ideal wavelength is the band width divided by that. But the
    // loop is only seamless if a whole number of waves and a whole number of
    // text-repeats coincide (the wave stays fixed in space, so a letter must
    // re-enter on the exact same phase). Snap the wavelength to the nearest
    // value that shares a period with the repeat, and set the loop's travel
    // (`shift`) to that shared period.
    const desiredWavelength = viewport / freq;
    let wavelength;
    let shift;
    if (desiredWavelength <= unitWidth) {
      // Several waves per repeat: shift by one repeat each loop.
      const wavesPerUnit = Math.max(1, Math.round(unitWidth / desiredWavelength));
      wavelength = unitWidth / wavesPerUnit;
      shift = unitWidth;
    } else {
      // Fewer than one wave per repeat: stretch the wave over a whole number of
      // repeats and shift by that many each loop.
      const unitsPerWave = Math.max(1, Math.round(desiredWavelength / unitWidth));
      wavelength = unitsPerWave * unitWidth;
      shift = wavelength;
    }
    const turns = 360 * Math.round(shift / wavelength);

    // Fill enough repeats to cover the visible band plus one loop's travel, so
    // no gap opens up as the strip scrolls.
    const unitsNeeded = Math.min(
      MAX_UNITS_PER_SEGMENT,
      Math.ceil((viewport + shift) / unitWidth) + 1
    );
    for (let i = 1; i < unitsNeeded; i += 1) {
      track.appendChild(this.#makeUnit());
    }

    // Slope amplitude of the wave: peak dy/dx = amp * wavenumber (2π / wavelength).
    // atan() of this, scaled by cos, is the per-glyph tangent angle.
    const slope = (2 * Math.PI * this.#amplitude) / wavelength;

    // Bake the wave phase per glyph from its resting x. offsetLeft is a layout
    // coordinate, so this is unaffected by the host's rotation.
    for (const glyph of track.querySelectorAll('.wave-marquee__glyph')) {
      const centerX = glyph.offsetLeft + glyph.offsetWidth / 2;
      const theta = ((360 * centerX) / wavelength).toFixed(3);
      glyph.style.setProperty('--wm-theta', `${theta}deg`);
    }

    this.style.setProperty('--wm-shift', `${shift}px`);
    this.style.setProperty('--wm-turns', `${turns}deg`);
    this.style.setProperty('--wm-slope', slope.toFixed(4));
  }
}

if (!customElements.get('wave-marquee')) {
  customElements.define('wave-marquee', WaveMarquee);
}
