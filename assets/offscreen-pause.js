/**
 * Pauses CSS animations while their component is outside the viewport.
 *
 * The homepage stacks several infinite animations (marquees, floating
 * stickers, the wave marquee's per-glyph custom-property animation, rotating
 * arcs, testimonial floats, text shimmer). Offscreen they still burn main
 * thread and battery — an IntersectionObserver toggles a class that pauses
 * every animation in the subtree until the component scrolls back into view.
 *
 * Progressive enhancement: without JS nothing is paused and everything still
 * animates. The class + injected rule are self-contained, so no base.css edit.
 *
 * Opt in either by matching a selector below or by adding
 * `data-pause-offscreen` to any element.
 */

const SELECTORS = [
  '[data-pause-offscreen]',
  'marquee-component',
  '.marquee-collection',
  'wave-marquee',
  '.floating-sticker',
  'rotating-arc-component',
  '.testimonial-block',
  '[shimmer]',
].join(',');

const PAUSED_CLASS = 'anim-paused-offscreen';

const style = document.createElement('style');
style.textContent = `.${PAUSED_CLASS}, .${PAUSED_CLASS} * { animation-play-state: paused !important; }`;
document.head.append(style);

// generous margin so animations resume just before they scroll into view
const observer = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      entry.target.classList.toggle(PAUSED_CLASS, !entry.isIntersecting);
    }
  },
  { rootMargin: '100px' }
);

const observeAll = (root = document) => {
  for (const el of root.querySelectorAll(SELECTORS)) observer.observe(el);
};

observeAll();

// theme editor re-renders sections; observe whatever it swaps in
document.addEventListener('shopify:section:load', (event) => observeAll(event.target));
