import { Component } from '@theme/component';
import { fetchConfig } from '@theme/utilities';
import { CartLinesUpdateEvent } from '@shopify/events';

const COOKIE_NAME = 'zs_bundle';
const COOKIE_DAYS = 30;
const STORE_EVENT = 'bundle:change';

/* ---------------------------------------------------------------------------
 * Bundle store
 *
 * Persists the in-progress bundle in a first-party cookie so it survives
 * navigations. JSON shape:
 *   { subscribe: boolean|null,
 *     items: [{ variant_id, product_id, handle, title, image, price,
 *               plan_id, plan_price, accent, qty }] }
 *
 * `subscribe: null` means "not touched yet" — the section's default applies.
 * --------------------------------------------------------------------------- */
const BundleStore = {
  /** @returns {{subscribe: boolean|null, items: Array<Record<string, any>>}} */
  read() {
    const match = document.cookie.split('; ').find((row) => row.startsWith(`${COOKIE_NAME}=`));
    if (match) {
      try {
        const parsed = JSON.parse(decodeURIComponent(match.split('=')[1] || ''));
        if (parsed && Array.isArray(parsed.items)) {
          return { subscribe: parsed.subscribe ?? null, items: parsed.items };
        }
      } catch (_) {
        /* fall through */
      }
    }
    return { subscribe: null, items: [] };
  },

  /** @param {{subscribe: boolean|null, items: Array<Record<string, any>>}} data */
  write(data) {
    const value = encodeURIComponent(JSON.stringify(data));
    const expires = new Date(Date.now() + COOKIE_DAYS * 864e5).toUTCString();
    document.cookie = `${COOKIE_NAME}=${value}; expires=${expires}; path=/; SameSite=Lax`;
    document.dispatchEvent(new CustomEvent(STORE_EVENT, { detail: data }));
  },

  items() {
    return this.read().items;
  },

  totalQty() {
    return this.items().reduce((sum, item) => sum + (Number(item.qty) || 0), 0);
  },

  /** Add one unit of a variant (merges into an existing line). */
  add(item) {
    const data = this.read();
    const existing = data.items.find((i) => String(i.variant_id) === String(item.variant_id));
    if (existing) existing.qty = (Number(existing.qty) || 0) + 1;
    else data.items.push({ ...item, qty: 1 });
    this.write(data);
  },

  /** @param {string|number} variantId @param {number} delta */
  step(variantId, delta) {
    const data = this.read();
    const item = data.items.find((i) => String(i.variant_id) === String(variantId));
    if (!item) return;
    item.qty = (Number(item.qty) || 0) + delta;
    if (item.qty <= 0) data.items = data.items.filter((i) => i !== item);
    this.write(data);
  },

  /** @param {boolean} on */
  setSubscribe(on) {
    const data = this.read();
    data.subscribe = on;
    this.write(data);
  },

  clear() {
    this.write({ subscribe: this.read().subscribe, items: [] });
  },
};

/* ---------------------------------------------------------------------------
 * BuildABoxSection
 *
 * Owns the whole build-a-box UI: tier highlighting, progress bar, selected
 * picks strip (inline + floating bar), order summary, and the bulk add to
 * cart. Tier thresholds come from the section's JSON script tag; products are
 * rendered by Liquid and expose their payload via data-* on the add button.
 *
 * Appstle compatibility: when the Subscribe & Save toggle is on, each line is
 * posted to /cart/add.js with its `selling_plan` (first Appstle selling plan
 * allocation rendered by Liquid), which is all Appstle needs to create the
 * subscription at checkout. Tier discounts are display-only estimates — the
 * matching quantity discount must be configured in Appstle/Shopify admin.
 *
 * @extends Component<{}>
 * --------------------------------------------------------------------------- */
class BuildABoxSection extends Component {
  /** @type {AbortController} */
  #ac = new AbortController();
  /** @type {IntersectionObserver | null} */
  #railObserver = null;
  /** @type {Array<{name: string, quantity: number, discount: number, perks: string, freeShipping: boolean}>} */
  #tiers = [];

  get minQty() {
    return Number(this.dataset.minQty) || 3;
  }
  get maxQty() {
    return Number(this.dataset.maxQty) || 12;
  }

  get subscribeOn() {
    const stored = BundleStore.read().subscribe;
    if (stored === null) return this.dataset.subscribeDefault === 'true';
    return !!stored;
  }

  connectedCallback() {
    super.connectedCallback();
    const { signal } = this.#ac;

    try {
      this.#tiers = JSON.parse(this.querySelector('[data-bab-tiers]')?.textContent || '[]');
    } catch (_) {
      this.#tiers = [];
    }
    this.#tiers.sort((a, b) => a.quantity - b.quantity);

    this.addEventListener('click', this.#onClick, { signal });
    document.addEventListener(STORE_EVENT, this.#render, { signal });

    // Floating bar visibility: show once the rail (summary/CTA) scrolls out of
    // view and the shopper has picked at least one bag.
    const rail = this.querySelector('[data-bab-rail]');
    if (rail && 'IntersectionObserver' in window) {
      this.#railObserver = new IntersectionObserver(
        ([entry]) => {
          this.toggleAttribute('data-rail-visible', !!entry?.isIntersecting);
          this.#syncFloatVisibility();
        },
        { rootMargin: '0px 0px -80px 0px' }
      );
      this.#railObserver.observe(rail);
    }

    // "See more" starts collapsed only when there are overflow cards.
    if (this.querySelector('[data-bab-overflow]')) {
      this.setAttribute('data-collapsed', '');
      const seeMore = this.querySelector('[data-bab-see-more]');
      if (seeMore instanceof HTMLElement) seeMore.hidden = false;
    }

    this.#render();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#ac.abort();
    this.#railObserver?.disconnect();
  }

  /* --- Events -------------------------------------------------------------- */

  /** @param {MouseEvent} event */
  #onClick = (event) => {
    const target = /** @type {HTMLElement} */ (event.target);
    if (!(target instanceof Element)) return;

    const addBtn = target.closest('[data-bab-add]');
    if (addBtn instanceof HTMLElement) {
      this.#addFromCard(addBtn);
      return;
    }

    const stepBtn = target.closest('[data-bab-step]');
    if (stepBtn instanceof HTMLElement) {
      const delta = stepBtn.dataset.babStep === 'plus' ? 1 : -1;
      if (delta > 0 && BundleStore.totalQty() >= this.maxQty) return;
      BundleStore.step(stepBtn.dataset.variantId || '', delta);
      return;
    }

    if (target.closest('[data-bab-subscribe-toggle], [data-bab-float-subscribe]')) {
      BundleStore.setSubscribe(!this.subscribeOn);
      return;
    }

    if (target.closest('[data-bab-add-to-cart], [data-bab-float-add]')) {
      this.#submit();
      return;
    }

    if (target.closest('[data-bab-float-details]')) {
      this.querySelector('[data-bab-rail]')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }

    if (target.closest('[data-bab-see-more]')) {
      this.removeAttribute('data-collapsed');
      return;
    }

    const prev = target.closest('[data-bab-picks-prev]');
    const next = target.closest('[data-bab-picks-next]');
    if (prev || next) {
      const strip = this.querySelector('[data-bab-picks]');
      strip?.scrollBy({ left: prev ? -240 : 240, behavior: 'smooth' });
    }
  };

  /** @param {HTMLElement} btn */
  #addFromCard(btn) {
    if (BundleStore.totalQty() >= this.maxQty) {
      this.#pulseCap();
      return;
    }
    BundleStore.add({
      variant_id: Number(btn.dataset.variantId),
      product_id: Number(btn.dataset.productId),
      handle: btn.dataset.handle || '',
      title: btn.dataset.title || '',
      image: btn.dataset.image || '',
      price: Number(btn.dataset.price) || 0,
      plan_id: btn.dataset.planId ? Number(btn.dataset.planId) : null,
      plan_price: btn.dataset.planPrice ? Number(btn.dataset.planPrice) : null,
      accent: btn.dataset.accent || '',
    });
  }

  /** Briefly flash the unlock pill when the shopper is at the cap. */
  #pulseCap() {
    const pill = this.querySelector('[data-bab-unlock-pill]');
    if (!(pill instanceof HTMLElement)) return;
    pill.style.transition = 'transform 0.15s ease';
    pill.style.transform = 'scale(1.08)';
    setTimeout(() => {
      pill.style.transform = '';
    }, 180);
  }

  /* --- Tier math ----------------------------------------------------------- */

  /** @param {number} total */
  #activeTier(total) {
    let active = null;
    for (const tier of this.#tiers) {
      if (total >= tier.quantity) active = tier;
    }
    return active;
  }

  /** @param {number} total */
  #nextTier(total) {
    return this.#tiers.find((tier) => tier.quantity > total) || null;
  }

  /* --- Rendering ----------------------------------------------------------- */

  #render = () => {
    const items = BundleStore.items();
    const total = BundleStore.totalQty();
    const active = this.#activeTier(total);
    const next = this.#nextTier(total);
    const subscribe = this.subscribeOn;

    // Drives CSS that hides the % OFF badges when Subscribe & Save is off.
    this.setAttribute('data-subscribe', String(subscribe));

    // Tier cards: reached stage gets the full highlight, the stage currently
    // being worked toward gets a half-strength one.
    this.querySelectorAll('[data-bab-tier]').forEach((el) => {
      const qty = Number(/** @type {HTMLElement} */ (el).dataset.quantity);
      el.toggleAttribute('data-active', !!active && qty === active.quantity);
      el.toggleAttribute('data-next', !!next && qty === next.quantity);
    });

    // Selected count.
    this.querySelectorAll('[data-bab-selected-count]').forEach((el) => {
      el.textContent = String(total);
    });

    // Unlock pill. Discount claims only appear while Subscribe & Save is on.
    const pill = this.querySelector('[data-bab-unlock-pill]');
    if (pill instanceof HTMLElement) {
      if (next) {
        const remaining = next.quantity - total;
        const shipping = next.freeShipping && !active?.freeShipping ? ' + FREE SHIPPING' : '';
        const reward = subscribe ? `${next.discount}% OFF` : next.name.toUpperCase();
        pill.textContent = `${remaining} MORE BAG${remaining === 1 ? '' : 'S'} TO UNLOCK ${reward}${shipping}`;
        pill.hidden = false;
      } else if (active) {
        pill.textContent = subscribe
          ? `${active.discount}% OFF UNLOCKED — MAX SAVINGS!`
          : `${active.name.toUpperCase()} UNLOCKED — MAX LEVEL!`;
        pill.hidden = false;
      } else {
        pill.hidden = true;
      }
    }

    // Progress bar + milestones.
    const fill = this.querySelector('[data-bab-progress-fill]');
    if (fill instanceof HTMLElement) {
      fill.style.width = `${Math.min((total / this.maxQty) * 100, 100)}%`;
    }
    this.querySelectorAll('[data-bab-milestone]').forEach((el) => {
      const qty = Number(/** @type {HTMLElement} */ (el).dataset.quantity);
      el.toggleAttribute('data-reached', total >= qty);
    });

    // Picks strips (inline + floating). Empty slots pad up to the next tier.
    const targetQty = next ? next.quantity : this.maxQty;
    const emptySlots = Math.max(targetQty - total, 0);
    const picksHTML = this.#picksHTML(items, emptySlots);
    this.querySelectorAll('[data-bab-picks], [data-bab-float-picks]').forEach((el) => {
      el.innerHTML = picksHTML;
    });

    // Summary + totals.
    this.#renderSummary(items, total, active, subscribe);

    // Subscribe toggles (rail + float).
    this.querySelectorAll('[data-bab-subscribe-toggle], [data-bab-float-toggle]').forEach((el) => {
      el.setAttribute('aria-checked', String(subscribe));
    });

    // Floating bar count + visibility.
    this.querySelectorAll('[data-bab-float-count]').forEach((el) => {
      el.textContent = String(total);
    });
    this.#syncFloatVisibility();
  };

  /**
   * @param {Array<Record<string, any>>} items
   * @param {number} emptySlots
   */
  #picksHTML(items, emptySlots) {
    const filled = items
      .map(
        (item) => `
          <div class="bab-pick" style="--pick-accent: ${escapeAttr(item.accent || '')};">
            <div class="bab-pick__media">
              ${item.image ? `<img src="${escapeAttr(item.image)}" alt="${escapeAttr(item.title)}" loading="lazy">` : ''}
            </div>
            <div class="bab-pick__stepper">
              <button type="button" class="bab-pick__step" data-bab-step="minus" data-variant-id="${item.variant_id}" aria-label="Remove one ${escapeAttr(item.title)}">&minus;</button>
              <span class="bab-pick__qty">${Number(item.qty) || 0}</span>
              <button type="button" class="bab-pick__step" data-bab-step="plus" data-variant-id="${item.variant_id}" aria-label="Add one ${escapeAttr(item.title)}">+</button>
            </div>
          </div>
        `
      )
      .join('');

    const empties = Array.from(
      { length: emptySlots },
      () => '<div class="bab-pick--empty" aria-hidden="true">+</div>'
    ).join('');

    return filled + empties;
  }

  /**
   * @param {Array<Record<string, any>>} items
   * @param {number} total
   * @param {{discount: number, freeShipping: boolean}|null} active
   * @param {boolean} subscribe
   */
  #renderSummary(items, total, active, subscribe) {
    // Prices come from each product's single-bag variant (rendered by Liquid).
    const baseSubtotal = items.reduce((sum, i) => sum + i.price * i.qty, 0);
    // Subscription savings only exist while the toggle is on: the payable unit
    // price switches to the variant's selling-plan (Appstle) allocation price.
    const payableSubtotal = items.reduce((sum, i) => {
      const unit = subscribe && i.plan_price != null ? i.plan_price : i.price;
      return sum + unit * i.qty;
    }, 0);

    // FUTURE: bundle-level (tier) savings. This version has no bundle discount
    // mechanism — the Appstle tier plan groups are only allocated to pack-size
    // variants, not the single bag — so the "Bundle Savings" summary row stays
    // hidden and no tier percentage is applied here. When a quantity discount
    // exists (Appstle bundle or Shopify automatic discount), reintroduce
    // tierSavings from `active.discount` and un-hide [data-bab-summary-tier-row].
    const planSavings = baseSubtotal - payableSubtotal;
    const estimatedTotal = payableSubtotal;

    const setText = (/** @type {string} */ selector, /** @type {string} */ text) => {
      const el = this.querySelector(selector);
      if (el) el.textContent = text;
    };

    setText('[data-bab-summary-count]', String(total));
    setText('[data-bab-summary-per-pack]', total > 0 ? formatMoney(Math.round(baseSubtotal / total)) : '—');

    const planRow = this.querySelector('[data-bab-summary-plan-row]');
    if (planRow instanceof HTMLElement) {
      planRow.hidden = !(subscribe && planSavings > 0);
      if (!planRow.hidden) {
        setText('[data-bab-summary-plan-label]', 'Subscription Savings');
        setText('[data-bab-summary-plan-value]', `- ${formatMoney(planSavings)}`);
      }
    }

    setText('[data-bab-summary-shipping]', active?.freeShipping ? 'FREE' : '—');

    setText('[data-bab-summary-total]', formatMoney(estimatedTotal));
    const compare = this.querySelector('[data-bab-summary-compare]');
    if (compare instanceof HTMLElement) {
      compare.hidden = estimatedTotal >= baseSubtotal;
      compare.textContent = formatMoney(baseSubtotal);
    }
    const save = this.querySelector('[data-bab-summary-save]');
    if (save instanceof HTMLElement) {
      const saved = baseSubtotal - estimatedTotal;
      save.hidden = saved <= 0;
      save.textContent = `Save ${formatMoney(saved)}`;
    }

    // CTAs.
    const ready = total >= this.minQty;
    const ctaText = ready
      ? `${this.#ctaBaseText()}  -  ${formatMoney(estimatedTotal)}`
      : this.#ctaBaseText();
    this.querySelectorAll('[data-bab-cta-text], [data-bab-float-cta-text]').forEach((el) => {
      el.textContent = ctaText;
    });
    this.querySelectorAll('[data-bab-add-to-cart], [data-bab-float-add]').forEach((el) => {
      /** @type {HTMLButtonElement} */ (el).disabled = !ready;
    });
  }

  #ctaBaseText() {
    if (!this.dataset.ctaLabel) {
      const el = this.querySelector('[data-bab-cta-text]');
      this.dataset.ctaLabel = (el?.textContent || 'ADD TO CART').split('  -  ')[0].trim();
    }
    return this.dataset.ctaLabel;
  }

  #syncFloatVisibility() {
    const float = this.querySelector('[data-bab-float]');
    if (!(float instanceof HTMLElement)) return;
    const railVisible = this.hasAttribute('data-rail-visible');
    float.hidden = railVisible || BundleStore.totalQty() === 0;
  }

  /* --- Cart submit ---------------------------------------------------------- */

  async #submit() {
    const items = BundleStore.items();
    if (BundleStore.totalQty() < this.minQty || items.length === 0) return;

    const buttons = /** @type {HTMLButtonElement[]} */ ([
      ...this.querySelectorAll('[data-bab-add-to-cart], [data-bab-float-add]'),
    ]);
    if (buttons.some((b) => b.dataset.busy === '1')) return;
    buttons.forEach((b) => {
      b.dataset.busy = '1';
      b.disabled = true;
    });

    const subscribe = this.subscribeOn;
    const payload = {
      items: items.map((item) => {
        /** @type {Record<string, any>} */
        const line = { id: item.variant_id, quantity: item.qty };
        if (subscribe && item.plan_id) line.selling_plan = item.plan_id;
        return line;
      }),
      sections: this.#getCartSectionIds(),
      sections_url: window.location.pathname,
    };

    // The cart drawer morphs itself from the sections carried by a resolved
    // CartLinesUpdateEvent (see cart-drawer-extras.js / component-cart-items.js).
    const deferred = CartLinesUpdateEvent.createPromise();
    this.dispatchEvent(
      new CartLinesUpdateEvent({
        action: 'add',
        context: 'cart',
        lines: items.map((item) => ({ merchandiseId: String(item.variant_id), quantity: item.qty })),
        promise: deferred.promise,
      })
    );

    try {
      const res = await fetch(Theme.routes.cart_add_url, fetchConfig('json', { body: JSON.stringify(payload) }));
      const data = await res.json();
      if (data.status) throw new Error(data.description || data.message || 'Add to cart failed');

      const cart = await fetch(`${Theme.routes.cart_url}.json`, {
        headers: { Accept: 'application/json' },
        credentials: 'same-origin',
      }).then((r) => r.json());

      deferred.resolve({
        cart: CartLinesUpdateEvent.createCartFromAjaxResponse(cart),
        detail: {
          sections: data.sections,
          items: cart.items,
          itemCount: cart.item_count,
          source: 'build-a-box',
          didError: false,
        },
      });

      // The cart drawer auto-opens itself off the bubbling CartLinesUpdateEvent.
      BundleStore.clear();
    } catch (err) {
      deferred.reject(err);
      // eslint-disable-next-line no-console
      console.error('Build-a-box add error', err);
    } finally {
      buttons.forEach((b) => {
        delete b.dataset.busy;
        b.disabled = false;
      });
      this.#render();
    }
  }

  /** @returns {string} */
  #getCartSectionIds() {
    const ids = [];
    document.querySelectorAll('cart-items-component').forEach((el) => {
      if (el instanceof HTMLElement && el.dataset.sectionId) ids.push(el.dataset.sectionId);
    });
    return ids.join(',');
  }
}

if (!customElements.get('build-a-box-section')) {
  customElements.define('build-a-box-section', BuildABoxSection);
}

/* ---------------------------------------------------------------------------
 * Utilities
 * --------------------------------------------------------------------------- */

/** @param {string} s */
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return c;
    }
  });
}

/** @param {string} s */
function escapeAttr(s) {
  return escapeHtml(s);
}

/**
 * Format a Shopify price (integer cents) using the storefront currency.
 *
 * @param {number} cents
 */
function formatMoney(cents) {
  const amount = (Number(cents) || 0) / 100;
  try {
    return new Intl.NumberFormat(document.documentElement.lang || 'en-US', {
      style: 'currency',
      currency: window.Shopify?.currency?.active || 'USD',
    }).format(amount);
  } catch (_) {
    return `$${amount.toFixed(2)}`;
  }
}

export { BundleStore };
