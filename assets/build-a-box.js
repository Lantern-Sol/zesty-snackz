import { Component } from '@theme/component';
import { fetchConfig } from '@theme/utilities';
import { CartLinesUpdateEvent, StandardEvents } from '@shopify/events';

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
  /**
   * variantId → Appstle selling plans allocated to that (single-bag) variant,
   * one per plan group: [{id, group, price}]. Built from the product cards'
   * data-plans so the cookie stays small and plans are always fresh.
   * @type {Map<string, Array<{id: number, group: string, price: number}>>}
   */
  #planMap = new Map();
  /**
   * Selling plan id from the Appstle Build-a-Box config (get-bundle API).
   * When present it is attached to every subscribed line — Appstle's
   * Build-a-Box applies the tiered discount for that plan at checkout.
   * @type {number | null}
   */
  #bundleSellingPlanId = null;
  /**
   * Signature of the boat cargo currently painted, so the pop-in animation only
   * replays when the set of products changes — not on every quantity step.
   * @type {string}
   */
  #boatSig = '';

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

    this.querySelectorAll('[data-bab-add][data-plans]').forEach((btn) => {
      try {
        this.#planMap.set(
          String(/** @type {HTMLElement} */ (btn).dataset.variantId),
          JSON.parse(/** @type {HTMLElement} */ (btn).dataset.plans || '[]')
        );
      } catch (_) {
        /* card without valid plan data simply has no subscription option */
      }
    });

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

    this.#loadAppstleBundle();

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

  /* --- Appstle Build-a-Box config ------------------------------------------ */

  /**
   * Appstle's Build-a-Box (unlike plain subscription plans) supports quantity
   * thresholds. When the section is given the bundle handle, pull its config
   * from the public get-bundle endpoint and let it override the theme's tier
   * discounts + selling plan, so the page always mirrors what Appstle will
   * charge. Any failure (no bundle yet, auth, network) keeps the theme's tier
   * block settings as the source of truth.
   */
  async #loadAppstleBundle() {
    const handle = this.dataset.appstleBundleHandle;
    if (!handle) return;
    const prefix = /** @type {any} */ (window).RSConfig?.appstle_app_proxy_path_prefix || 'apps/subscriptions';
    try {
      // The /bb/ app-proxy route is the one Appstle's own Build-a-Box app uses
      // (its axios baseURL is `{origin}/{proxy_prefix}/bb/`); unlike /cp/, it
      // requires no extra auth.
      const res = await fetch(`/${prefix}/bb/api/v3/subscription-bundlings/external/get-bundle/${encodeURIComponent(handle)}`, {
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.#applyBundleConfig(await res.json());
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[build-a-box] Appstle bundle config unavailable — using theme tier settings.', err);
    }
  }

  /** @param {Record<string, any>} payload - get-bundle response ({bundle, subscription, ...}) */
  #applyBundleConfig(payload) {
    const bundle = payload?.bundle || payload || {};

    // tieredDiscount is a JSON string:
    // [{"discountBasedOn":"QUANTITY","quantity":3,"discount":"5"},...] —
    // parse defensively and merge into the theme tiers by quantity so
    // names/perks from the editor are kept while Appstle owns the numbers.
    let tiers = bundle.tieredDiscount;
    if (typeof tiers === 'string') {
      try {
        tiers = JSON.parse(tiers);
      } catch (_) {
        tiers = null;
      }
    }
    if (Array.isArray(tiers)) {
      for (const t of tiers) {
        const qty = Number(t.quantity ?? t.minQuantity ?? t.qty);
        const pct = Number(t.discount ?? t.percentage ?? t.value);
        if (!qty || Number.isNaN(pct)) continue;
        const match = this.#tiers.find((x) => x.quantity === qty);
        if (match) match.discount = pct;
        else this.#tiers.push({ name: `${qty} bags`, quantity: qty, discount: pct, perks: '', freeShipping: false });
      }
      this.#tiers.sort((a, b) => a.quantity - b.quantity);

      // Reflect Appstle's numbers on the Liquid-rendered tier badges.
      this.querySelectorAll('[data-bab-tier]').forEach((el) => {
        const qty = Number(/** @type {HTMLElement} */ (el).dataset.quantity);
        const tier = this.#tiers.find((x) => x.quantity === qty);
        const badge = el.querySelector('.bab__badge--success');
        if (tier && badge) badge.textContent = `${tier.discount}% OFF`;
      });
    }

    if (Number(bundle.minProductCount) > 0) this.dataset.minQty = String(bundle.minProductCount);

    const planIds = String(bundle.sellingPlanIds || '')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter(Boolean);
    if (planIds.length) this.#bundleSellingPlanId = planIds[0];

    this.#render();
  }

  /* --- Selling plan matching ----------------------------------------------- */

  /** @param {string|number} variantId */
  #plansFor(variantId) {
    return this.#planMap.get(String(variantId)) || [];
  }

  /**
   * Appstle plan groups are named after the tiers ("Mini Munch - 3 Bags"…), so
   * the plan for the achieved tier is the group whose name starts with it.
   *
   * @param {string|number} variantId
   * @param {{name: string}|null} tier
   */
  #tierPlan(variantId, tier) {
    if (!tier) return null;
    const name = tier.name.trim().toLowerCase();
    return this.#plansFor(variantId).find((p) => (p.group || '').trim().toLowerCase().startsWith(name)) || null;
  }

  /** Plan from the group matching no tier (e.g. "Single Bag Plans"), else the first. */
  #defaultPlan(variantId) {
    const plans = this.#plansFor(variantId);
    const tierNames = this.#tiers.map((t) => t.name.trim().toLowerCase());
    return (
      plans.find((p) => !tierNames.some((n) => (p.group || '').trim().toLowerCase().startsWith(n))) ||
      plans[0] ||
      null
    );
  }

  /**
   * Subscription unit price at the achieved tier: the real Appstle allocation
   * price when the tier plan is assigned to the single-bag variant, otherwise
   * the advertised tier % off base (matches what checkout will charge once the
   * tier groups include the single-bag variants in Appstle).
   *
   * @param {{variant_id: string|number, price: number}} item
   * @param {{name: string, discount: number}|null} active
   */
  #subscribeUnitPrice(item, active) {
    const tierPlan = this.#tierPlan(item.variant_id, active);
    if (tierPlan) return tierPlan.price;
    if (active) return Math.round(item.price * (1 - active.discount / 100));
    const plan = this.#defaultPlan(item.variant_id);
    return plan ? plan.price : item.price;
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

    // Boat banner cargo: stack the selected product images into the hull.
    this.#renderBoat(items);

    // Picks strips (inline + floating). Empty slots pad up to the next tier.
    const targetQty = next ? next.quantity : this.maxQty;
    const emptySlots = Math.max(targetQty - total, 0);
    const picksHTML = this.#picksHTML(items, emptySlots);
    this.querySelectorAll('[data-bab-picks], [data-bab-float-picks]').forEach((el) => {
      el.innerHTML = picksHTML;
    });

    // Card prices reflect the achieved tier's subscription price.
    this.querySelectorAll('[data-bab-card-price]').forEach((el) => {
      const base = Number(/** @type {HTMLElement} */ (el).dataset.base) || 0;
      const vid = /** @type {HTMLElement | null} */ (
        el.closest('.bab-card')?.querySelector('[data-bab-add]')
      )?.dataset.variantId;
      let now = base;
      if (subscribe && active && vid) {
        now = this.#subscribeUnitPrice({ variant_id: vid, price: base }, active);
      }
      const nowEl = el.querySelector('[data-bab-card-price-now]');
      if (nowEl) nowEl.textContent = formatMoney(now);
      const compareEl = el.querySelector('[data-bab-card-price-compare]');
      if (compareEl instanceof HTMLElement) {
        compareEl.hidden = now >= base;
        compareEl.textContent = formatMoney(base);
      }
    });

    // Summary + totals.
    this.#renderSummary(items, total, active, subscribe);

    // Subscribe toggles (rail + float).
    this.querySelectorAll('[data-bab-subscribe-toggle], [data-bab-float-toggle]').forEach((el) => {
      el.setAttribute('aria-checked', String(subscribe));
    });

    // Float subscribe pill shows the discount unlocked at the current tier,
    // e.g. "SUBSCRIBE & SAVE 10%" — the % drops when below the first tier.
    const floatSubLabel = this.querySelector('[data-bab-float-subscribe-label]');
    if (floatSubLabel instanceof HTMLElement) {
      if (!this.dataset.subscribeBaseLabel) {
        this.dataset.subscribeBaseLabel = (floatSubLabel.textContent || 'SUBSCRIBE & SAVE').trim();
      }
      const base = this.dataset.subscribeBaseLabel;
      floatSubLabel.textContent = active && active.discount > 0 ? `${base} ${active.discount}%` : base;
    }

    // Floating bar count + visibility.
    this.querySelectorAll('[data-bab-float-count]').forEach((el) => {
      el.textContent = String(total);
    });
    this.#syncFloatVisibility();
  };

  /**
   * Fill the boat banner's cargo well with the selected products' main images.
   * One chip per distinct product (newest last) so the boat visibly "loads up"
   * as the shopper picks flavours; a "+N" chip absorbs any overflow beyond the
   * well's capacity. Only re-renders when the product set changes so the pop-in
   * animation doesn't replay on every quantity step.
   *
   * @param {Array<Record<string, any>>} items
   */
  #renderBoat(items) {
    const cargo = this.querySelector('[data-bab-boat-cargo]');
    if (!(cargo instanceof HTMLElement)) return;

    const MAX_CHIPS = 6;
    const withImage = items.filter((item) => item.image);
    const shown = withImage.slice(0, MAX_CHIPS);
    const overflow = withImage.length - shown.length;

    const sig = `${shown.map((i) => i.variant_id).join(',')}|${overflow}`;
    if (sig === this.#boatSig) return;
    this.#boatSig = sig;

    const chips = shown.map(
      (item, index) => `
        <div class="bab-cargo" style="--pick-accent: ${escapeAttr(item.accent || '')}; z-index: ${index + 1};">
          <img src="${escapeAttr(item.image)}" alt="" loading="lazy">
        </div>
      `
    );
    if (overflow > 0) {
      chips.push(
        `<div class="bab-cargo bab-cargo--more" style="z-index: ${shown.length + 1};">+${overflow}</div>`
      );
    }
    cargo.innerHTML = chips.join('');
  }

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
    // price switches to the tier's Appstle selling-plan price for the achieved
    // quantity (see #subscribeUnitPrice).
    const payableSubtotal = items.reduce((sum, i) => {
      const unit = subscribe ? this.#subscribeUnitPrice(i, active) : i.price;
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
    // Price per Pack shows what the shopper actually pays per bag at the
    // current tier (discounted while Subscribe & Save is on).
    setText('[data-bab-summary-per-pack]', total > 0 ? formatMoney(Math.round(payableSubtotal / total)) : '—');

    const planRow = this.querySelector('[data-bab-summary-plan-row]');
    if (planRow instanceof HTMLElement) {
      planRow.hidden = !(subscribe && planSavings > 0);
      if (!planRow.hidden) {
        const pct = active ? ` (${active.discount}%)` : '';
        setText('[data-bab-summary-plan-label]', `Subscription Savings${pct}`);
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
    const active = this.#activeTier(BundleStore.totalQty());
    const bundleRef = this.dataset.appstleBundleHandle || '';
    const payload = {
      items: items.map((item) => {
        /** @type {Record<string, any>} */
        const line = { id: item.variant_id, quantity: item.qty };
        if (subscribe) {
          // Appstle Build-a-Box plan first (its tiered discount fires at
          // checkout); else the tier's plan when allocated to the single-bag
          // variant; else the variant's default (single-bag) plan.
          const plan = this.#tierPlan(item.variant_id, active) || this.#defaultPlan(item.variant_id);
          const planId = this.#bundleSellingPlanId || plan?.id;
          if (planId) line.selling_plan = planId;
          // Marks the line as part of the Build-a-Box — Appstle's discount
          // endpoint only counts lines carrying this property.
          if (bundleRef) line.properties = { '_appstle-bb-id': bundleRef };
        }
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

      let cart = await fetch(`${Theme.routes.cart_url}.json`, {
        headers: { Accept: 'application/json' },
        credentials: 'same-origin',
      }).then((r) => r.json());

      // Appstle applies the Build-a-Box tiered discount by minting a discount
      // code for the current cart (same flow its own cart-page script runs):
      // PUT the cart to its discount endpoint, then hit /discount/{code} so
      // the code is attached to the checkout session.
      let sections = data.sections;
      if (subscribe && bundleRef) {
        const applied = await this.#applyAppstleBundleDiscount(bundleRef, cart);
        if (applied) {
          // The sections in the cart/add response were rendered BEFORE the
          // code existed — re-render them (and the cart payload) so the
          // drawer's first paint shows the discounted prices and the
          // "Bundle discount" summary row.
          try {
            const sectionIds = this.#getCartSectionIds();
            const [freshSections, freshCart] = await Promise.all([
              sectionIds
                ? fetch(`${window.location.pathname}?sections=${encodeURIComponent(sectionIds)}`).then((r) => r.json())
                : null,
              fetch(`${Theme.routes.cart_url}.json`, {
                headers: { Accept: 'application/json' },
                credentials: 'same-origin',
              }).then((r) => r.json()),
            ]);
            if (freshSections) sections = freshSections;
            if (freshCart) cart = freshCart;
          } catch (_) {
            /* keep the pre-discount render — checkout still gets the code */
          }
        }
      }

      deferred.resolve({
        cart: CartLinesUpdateEvent.createCartFromAjaxResponse(cart),
        detail: {
          sections,
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

  /**
   * @param {string} bundleRef
   * @param {Record<string, any>} cart - /cart.json payload (its lines carry _appstle-bb-id)
   * @returns {Promise<boolean>} whether a discount code was applied
   */
  async #applyAppstleBundleDiscount(bundleRef, cart) {
    const prefix = /** @type {any} */ (window).RSConfig?.appstle_app_proxy_path_prefix || 'apps/subscriptions';
    try {
      const res = await fetch(`/${prefix}/bb/api/subscription-bundlings/discount/${encodeURIComponent(bundleRef)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ cart }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data?.discountCode) {
        const applied = await fetch(
          `${/** @type {any} */ (window).Shopify?.routes?.root || '/'}discount/${encodeURIComponent(data.discountCode)}`
        );
        return applied.ok;
      }
      return false;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[build-a-box] Could not apply Appstle bundle discount — checkout will show full price.', err);
      return false;
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
 * Appstle bundle discount sync
 *
 * The minted Build-a-Box code is only valid for the exact cart it was created
 * for — any later mutation (quantity change, removal, switching a line to
 * one-time) invalidates it. Every cart mutation in this theme (drawer + cart
 * page) resolves a CartLinesUpdateEvent, so one document-level listener can
 * re-mint the code for the new cart state and repaint the cart sections.
 *
 * Runs on every page (this file is a global script). Appstle decides the new
 * tier server-side — with "Allow one-time purchase" off, only subscription
 * lines count, so e.g. switching 3 of 6 bags to one-time drops 10% → 5%.
 * --------------------------------------------------------------------------- */

const SYNC_SOURCE = 'build-a-box-discount-sync';
const SYNC_FLAG = '__buildABoxDiscountSyncInstalled';
if (!(/** @type {any} */ (window))[SYNC_FLAG]) {
  /** @type {any} */ (window)[SYNC_FLAG] = true;

  let syncRun = 0;

  document.addEventListener(StandardEvents.cartLinesUpdate, (/** @type {any} */ event) => {
    event.promise?.then(async (/** @type {any} */ result) => {
      const source = result?.detail?.source;
      // Skip our own events: the initial add already applies + repaints, and
      // the sync's own repaint event must not re-trigger the sync.
      if (source === SYNC_SOURCE || source === 'build-a-box') return;

      const run = ++syncRun; // latest-wins guard for rapid stepper clicks

      const cart = await fetch(`${Theme.routes.cart_url}.json`, {
        headers: { Accept: 'application/json' },
        credentials: 'same-origin',
      }).then((r) => r.json());

      const bundleRef = cart?.items?.find(
        (/** @type {any} */ i) => i.properties?.['_appstle-bb-id']
      )?.properties?.['_appstle-bb-id'];
      if (!bundleRef || run !== syncRun) return;

      const prefix = /** @type {any} */ (window).RSConfig?.appstle_app_proxy_path_prefix || 'apps/subscriptions';
      try {
        const res = await fetch(`/${prefix}/bb/api/subscription-bundlings/discount/${encodeURIComponent(bundleRef)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ cart }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        // Below the minimum tier Appstle mints nothing (discountNeeded:false);
        // the previously applied code simply stops validating at checkout.
        if (!data?.discountCode) return;
        const applied = await fetch(
          `${/** @type {any} */ (window).Shopify?.routes?.root || '/'}discount/${encodeURIComponent(data.discountCode)}`
        );
        if (!applied.ok || run !== syncRun) return;

        // Repaint cart sections with the fresh code baked in.
        const ids = [];
        document.querySelectorAll('cart-items-component').forEach((el) => {
          if (el instanceof HTMLElement && el.dataset.sectionId) ids.push(el.dataset.sectionId);
        });
        if (!ids.length) return;
        const [sections, freshCart] = await Promise.all([
          fetch(`${window.location.pathname}?sections=${encodeURIComponent(ids.join(','))}`).then((r) => r.json()),
          fetch(`${Theme.routes.cart_url}.json`, { headers: { Accept: 'application/json' }, credentials: 'same-origin' }).then((r) => r.json()),
        ]);
        if (run !== syncRun) return;

        const deferred = CartLinesUpdateEvent.createPromise();
        document.dispatchEvent(
          new CartLinesUpdateEvent({ action: 'update', context: 'cart', lines: [], promise: deferred.promise })
        );
        deferred.resolve({
          cart: CartLinesUpdateEvent.createCartFromAjaxResponse(freshCart),
          detail: {
            sections,
            items: freshCart.items,
            itemCount: freshCart.item_count,
            source: SYNC_SOURCE,
            didError: false,
          },
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[build-a-box] Bundle discount re-sync failed — checkout may show a stale discount.', err);
      }
    }).catch(() => {});
  });
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
