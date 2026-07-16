/**
 * <gravity-section> — a lightweight 2D rigid-body playground.
 *
 * Children marked with [data-gravity-item] drop from above the section,
 * collide with each other and the section bounds, and settle into a pile.
 * Items stay real DOM (links/buttons remain clickable, editor-selectable);
 * the engine only drives their transforms.
 *
 * Attributes on <gravity-section>:
 *   data-gravity      gravity multiplier (default 1)
 *   data-restitution  bounciness 0–0.9 (default 0.4)
 *   data-stagger      ms between drops (default 120)
 *   data-drag         present = items are draggable/throwable
 *
 * Attributes on items:
 *   data-shape="circle" | "pill"   collider hint (default circle)
 *   data-x="0..100"                preferred horizontal drop position (%)
 *
 * Bodies use circle colliders (pills use an averaged radius and damped,
 * clamped rotation so buttons never end up upside down).
 */

const BASE_GRAVITY = 2600; // px/s²
const MAX_DT = 1 / 30;
const SUBSTEPS = 3;
const SOLVER_ITERATIONS = 4;
const SLEEP_SPEED = 10; // px/s
const SLEEP_FRAMES = 40;
const DRAG_THRESHOLD = 6; // px before a press becomes a drag

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

class GravitySection extends HTMLElement {
  connectedCallback() {
    this.bodies = [];
    this.rafId = 0;
    this.running = false;
    this.started = false;
    this.lastTime = 0;
    this.clock = 0;
    this.dragBody = null;
    this.suppressClick = false;

    this.gravity = parseFloat(this.dataset.gravity || '1') * BASE_GRAVITY;
    this.restitution = Math.min(parseFloat(this.dataset.restitution || '0.4'), 0.9);
    this.stagger = parseFloat(this.dataset.stagger || '120') / 1000;
    this.dragEnabled = this.hasAttribute('data-drag');
    this.squashEnabled = !this.hasAttribute('data-no-squash');
    // sinks the physics floor below the visible bottom edge so the
    // lowest items straddle the clip and look cut off by the section
    this.floorOffset = parseFloat(this.dataset.floorOffset || '0');

    this.collectBodies();

    this.resizeObserver = new ResizeObserver(() => this.onResize());
    this.resizeObserver.observe(this);

    // text items size from their content, so re-measure once webfonts land
    document.fonts?.ready?.then(() => {
      if (this.isConnected) this.onResize();
    });

    if (reducedMotion.matches) {
      this.settleInstantly();
    } else {
      this.intersectionObserver = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) {
            this.intersectionObserver.disconnect();
            this.intersectionObserver = null;
            this.start();
          }
        },
        { threshold: 0.25 }
      );
      this.intersectionObserver.observe(this);
    }

    if (this.dragEnabled) {
      this.onPointerDown = this.onPointerDown.bind(this);
      this.onPointerMove = this.onPointerMove.bind(this);
      this.onPointerUp = this.onPointerUp.bind(this);
      this.onClickCapture = this.onClickCapture.bind(this);
      this.addEventListener('pointerdown', this.onPointerDown);
      this.addEventListener('click', this.onClickCapture, true);
    }

    if (window.Shopify && window.Shopify.designMode) {
      this.onBlockSelect = this.onBlockSelect.bind(this);
      document.addEventListener('shopify:block:select', this.onBlockSelect);
    }
  }

  disconnectedCallback() {
    cancelAnimationFrame(this.rafId);
    this.running = false;
    this.resizeObserver?.disconnect();
    this.intersectionObserver?.disconnect();
    if (this.onBlockSelect) {
      document.removeEventListener('shopify:block:select', this.onBlockSelect);
    }
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerUp);
  }

  collectBodies() {
    const items = [...this.querySelectorAll('[data-gravity-item]')];
    const width = this.clientWidth || 1;

    this.bodies = items.map((el, index) => {
      const rect = { w: el.offsetWidth || 1, h: el.offsetHeight || 1 };
      const isPill = el.dataset.shape === 'pill';
      const keepUpright = isPill || el.hasAttribute('data-keep-upright');
      const radius = isPill ? (rect.w + rect.h) / 4 : Math.max(rect.w, rect.h) / 2;

      // Pinned bodies hold a fixed x/y (and optional tilt) and act as
      // immovable obstacles
      const pinned = el.hasAttribute('data-pinned');
      const pinX = parseFloat(el.dataset.x);
      const pinY = parseFloat(el.dataset.y);
      const pinAngle = (parseFloat(el.dataset.rotation) || 0) * (Math.PI / 180);

      // Preferred drop x: explicit data-x, otherwise spread evenly with jitter
      const spread = ((index + 0.5) / items.length) * width;
      const jitter = (this.pseudoRandom(index) - 0.5) * (width / items.length);
      const x = Number.isFinite(pinX) ? (pinX / 100) * width : spread + jitter;

      return {
        el,
        index,
        isPill,
        keepUpright,
        pinned,
        pinX: Number.isFinite(pinX) ? pinX : 50,
        pinY: Number.isFinite(pinY) ? pinY : 50,
        radius,
        halfW: rect.w / 2,
        halfH: rect.h / 2,
        mass: Math.max(radius * radius, 1),
        x: pinned ? x : this.clampX(x, radius),
        y: pinned
          ? ((Number.isFinite(pinY) ? pinY : 50) / 100) * (this.clientHeight || 1)
          : -radius - this.pseudoRandom(index + 31) * 220,
        vx: 0,
        vy: 0,
        angle: pinned ? pinAngle : 0,
        va: 0,
        squash: 0,
        releaseAt: pinned ? 0 : index * this.stagger + this.pseudoRandom(index + 7) * 0.15,
        active: pinned,
        sleeping: pinned,
        stillFrames: 0,
        dragging: false,
      };
    });

    this.bodies.forEach((body) => this.render(body));
  }

  // Deterministic jitter so the editor doesn't reshuffle on every re-render
  pseudoRandom(seed) {
    const value = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
    return value - Math.floor(value);
  }

  clampX(x, radius) {
    const width = this.clientWidth || 1;
    return Math.min(Math.max(x, radius), Math.max(width - radius, radius));
  }

  start() {
    this.started = true;
    // styling hook: pinned items play their entrance tilt off this class
    this.classList.add('is-started');
    this.clock = 0;
    this.wakeAll();
    this.run();
  }

  run() {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    const tick = (now) => {
      if (!this.running) return;
      const dt = Math.min((now - this.lastTime) / 1000, MAX_DT);
      this.lastTime = now;
      this.clock += dt;

      const sub = dt / SUBSTEPS;
      for (let i = 0; i < SUBSTEPS; i++) this.step(sub);
      this.bodies.forEach((body) => this.render(body));

      if (this.everyoneAsleep()) {
        this.running = false;
        return;
      }
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  everyoneAsleep() {
    return (
      !this.dragBody &&
      this.bodies.every((body) => body.active && body.sleeping)
    );
  }

  wakeAll() {
    this.bodies.forEach((body) => {
      if (body.pinned) return;
      body.sleeping = false;
      body.stillFrames = 0;
    });
    if (this.started) this.run();
  }

  step(dt) {
    const height = this.clientHeight + this.floorOffset;

    for (const body of this.bodies) {
      if (!body.active) {
        if (this.clock >= body.releaseAt) body.active = true;
        else continue;
      }
      if (body.sleeping || body.dragging) continue;
      body.px = body.x;
      body.py = body.y;
      body.vy += this.gravity * dt;
      // light air drag keeps the pile from jittering forever
      const drag = 1 - 0.06 * dt;
      body.vx *= drag;
      body.vy *= drag;
      body.va *= 1 - 1.5 * dt;
      body.x += body.vx * dt;
      body.y += body.vy * dt;
      body.va = Math.max(-4, Math.min(4, body.va));
      body.angle += body.va * dt;
      // impact squash recovers on a fast exponential
      body.squash *= Math.max(0, 1 - 10 * dt);
      if (body.squash < 0.003) body.squash = 0;
      if (body.keepUpright) body.angle = Math.max(-0.35, Math.min(0.35, body.angle));
    }

    // impulses once per substep; extra iterations only relax positions
    for (let iter = 0; iter < SOLVER_ITERATIONS; iter++) {
      this.solvePairs(iter === 0);
      this.solveBounds(height, iter === 0);
    }

    // sleeping bookkeeping: a body that has barely moved this step is
    // resting (on the floor or on the pile), regardless of transient velocity
    for (const body of this.bodies) {
      if (!body.active || body.dragging || body.sleeping) continue;
      const moved = Math.hypot(body.x - body.px, body.y - body.py);
      if (moved < SLEEP_SPEED * dt && Math.abs(body.va) < 0.25) {
        body.stillFrames++;
      } else {
        body.stillFrames = 0;
      }
      if (body.stillFrames > SLEEP_FRAMES) {
        body.sleeping = true;
        body.vx = 0;
        body.vy = 0;
        body.va = 0;
        body.squash = 0;
      }
    }
  }

  solvePairs(applyImpulses) {
    const bodies = this.bodies;
    for (let i = 0; i < bodies.length; i++) {
      const a = bodies[i];
      if (!a.active) continue;
      for (let j = i + 1; j < bodies.length; j++) {
        const b = bodies[j];
        if (!b.active) continue;

        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const minDist = a.radius + b.radius;
        const distSq = dx * dx + dy * dy;
        if (distSq >= minDist * minDist || distSq === 0) continue;

        const dist = Math.sqrt(distSq);
        const nx = dx / dist;
        const ny = dy / dist;
        const penetration = minDist - dist;

        // a dragged or fast body shoves resting bodies awake
        if (applyImpulses) {
          if (a.sleeping && (b.dragging || Math.hypot(b.vx, b.vy) > 120)) this.wake(a);
          if (b.sleeping && (a.dragging || Math.hypot(a.vx, a.vy) > 120)) this.wake(b);
        }

        const invMassA = a.dragging || a.sleeping ? 0 : 1 / a.mass;
        const invMassB = b.dragging || b.sleeping ? 0 : 1 / b.mass;
        const invMassSum = invMassA + invMassB;
        if (invMassSum === 0) continue;

        // positional correction
        const correction = (Math.max(penetration - 0.5, 0) * 0.6) / invMassSum;
        a.x -= nx * correction * invMassA;
        a.y -= ny * correction * invMassA;
        b.x += nx * correction * invMassB;
        b.y += ny * correction * invMassB;

        if (!applyImpulses) continue;

        // impulse
        const rvx = b.vx - a.vx;
        const rvy = b.vy - a.vy;
        const velAlongNormal = rvx * nx + rvy * ny;
        if (velAlongNormal > 0) continue;

        const impulse = (-(1 + this.restitution) * velAlongNormal) / invMassSum;
        a.vx -= impulse * nx * invMassA;
        a.vy -= impulse * ny * invMassA;
        b.vx += impulse * nx * invMassB;
        b.vy += impulse * ny * invMassB;

        // tangential friction + a bit of spin
        const tx = -ny;
        const ty = nx;
        const velAlongTangent = rvx * tx + rvy * ty;
        const frictionImpulse = (-velAlongTangent * 0.12) / invMassSum;
        a.vx -= frictionImpulse * tx * invMassA;
        a.vy -= frictionImpulse * ty * invMassA;
        b.vx += frictionImpulse * tx * invMassB;
        b.vy += frictionImpulse * ty * invMassB;
        a.va -= (velAlongTangent / a.radius) * 0.03;
        b.va += (velAlongTangent / b.radius) * 0.03;
        // touching bodies grind each other's spin down
        a.va *= 0.92;
        b.va *= 0.92;
      }
    }
  }

  wake(body) {
    if (body.pinned) return;
    body.sleeping = false;
    body.stillFrames = 0;
  }

  solveBounds(height, applyImpulses) {
    const width = this.clientWidth;
    for (const body of this.bodies) {
      if (!body.active || body.dragging || body.pinned) continue;

      // floor uses the visual half-height for pills so they sit flush
      const floorOffset = body.isPill ? body.halfH : body.radius;
      if (body.y + floorOffset > height) {
        body.y = height - floorOffset;
        if (applyImpulses) {
          if (body.vy > 0) {
            if (this.squashEnabled) {
              // squash-and-stretch: harder landings flatten more
              body.squash = Math.max(body.squash, Math.min(0.18, body.vy / 6000));
            }
            body.vy = -body.vy * this.restitution;
          }
          if (Math.abs(body.vy) < 20) body.vy = 0;
          body.vx *= 0.94;
          // roll: ease angular velocity toward vx / r
          body.va += (body.vx / body.radius - body.va) * 0.2;
          if (body.keepUpright) body.va -= body.angle * 0.15; // settle level
        }
      }

      const sideOffset = body.isPill ? body.halfW : body.radius;
      if (body.x - sideOffset < 0) {
        body.x = sideOffset;
        if (applyImpulses && body.vx < 0) body.vx = -body.vx * this.restitution;
      } else if (body.x + sideOffset > width) {
        body.x = width - sideOffset;
        if (applyImpulses && body.vx > 0) body.vx = -body.vx * this.restitution;
      }

      // ceiling only matters for thrown items
      if (body.y - body.radius < -height && body.vy < 0) {
        body.vy = 0;
      }
    }
  }

  render(body) {
    const x = body.x - body.halfW;
    const y = body.y - body.halfH;
    // slight vertical stretch while falling fast, flatten on impact
    let sx = 1;
    let sy = 1;
    if (this.squashEnabled && !body.sleeping && !body.dragging) {
      const stretch = Math.min(0.05, Math.max(body.vy, 0) / 12000);
      sx = 1 + body.squash - stretch;
      sy = 1 - body.squash + stretch;
    }
    body.el.style.transform = `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0) scale(${sx.toFixed(3)}, ${sy.toFixed(3)}) rotate(${body.angle.toFixed(3)}rad)`;
  }

  /* ------------------------------------------------------------------ */
  /* Reduced motion: compute the resting pile off-screen, render once    */
  /* ------------------------------------------------------------------ */
  settleInstantly() {
    this.started = true;
    this.classList.add('is-started');
    this.bodies.forEach((body) => {
      if (body.pinned) return;
      body.active = true;
      body.y = -body.radius - this.pseudoRandom(body.index + 31) * 220;
    });
    const dt = 1 / 60;
    for (let i = 0; i < 480; i++) {
      this.clock += dt;
      this.step(dt);
      if (this.bodies.every((body) => body.sleeping)) break;
    }
    this.bodies.forEach((body) => this.render(body));
  }

  /* ------------------------------------------------------------------ */
  /* Resize                                                              */
  /* ------------------------------------------------------------------ */
  onResize() {
    if (!this.bodies.length) return;
    for (const body of this.bodies) {
      body.halfW = (body.el.offsetWidth || 1) / 2;
      body.halfH = (body.el.offsetHeight || 1) / 2;
      body.radius = body.isPill
        ? (body.halfW + body.halfH) / 2
        : Math.max(body.halfW, body.halfH);
      body.mass = Math.max(body.radius * body.radius, 1);
      if (body.pinned) {
        body.x = (body.pinX / 100) * this.clientWidth;
        body.y = (body.pinY / 100) * this.clientHeight;
      } else if (body.active) {
        body.x = this.clampX(body.x, body.isPill ? body.halfW : body.radius);
        body.y = Math.min(body.y, this.clientHeight + this.floorOffset - body.halfH);
      }
    }
    if (reducedMotion.matches) {
      this.settleInstantly();
    } else if (this.started) {
      this.wakeAll();
    }
  }

  /* ------------------------------------------------------------------ */
  /* Dragging                                                            */
  /* ------------------------------------------------------------------ */
  onPointerDown(event) {
    const el = event.target.closest('[data-gravity-item]');
    if (!el || !this.started) return;
    const body = this.bodies.find((candidate) => candidate.el === el);
    if (!body || !body.active || body.pinned) return;

    this.pointerId = event.pointerId;
    this.pressX = event.clientX;
    this.pressY = event.clientY;
    this.pendingBody = body;
    this.suppressClick = false;
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerUp);
  }

  onPointerMove(event) {
    if (event.pointerId !== this.pointerId) return;

    if (!this.dragBody && this.pendingBody) {
      const moved = Math.hypot(event.clientX - this.pressX, event.clientY - this.pressY);
      if (moved > DRAG_THRESHOLD) {
        this.dragBody = this.pendingBody;
        this.dragBody.dragging = true;
        this.wake(this.dragBody);
        this.suppressClick = true;
        this.prevPointer = null;
        this.run();
      }
    }
    if (!this.dragBody) return;

    event.preventDefault();
    const bounds = this.getBoundingClientRect();
    const x = event.clientX - bounds.left;
    const y = event.clientY - bounds.top;
    const body = this.dragBody;

    if (this.prevPointer) {
      // velocity from pointer movement, for the throw on release
      body.vx = (x - this.prevPointer.x) * 60;
      body.vy = (y - this.prevPointer.y) * 60;
    }
    this.prevPointer = { x, y };
    body.x = this.clampX(x, body.isPill ? body.halfW : body.radius);
    body.y = Math.min(y, this.clientHeight + this.floorOffset - body.halfH);
    this.render(body);
  }

  onPointerUp(event) {
    if (event.pointerId !== this.pointerId) return;
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerUp);

    if (this.dragBody) {
      const body = this.dragBody;
      body.dragging = false;
      // cap throw speed
      const speed = Math.hypot(body.vx, body.vy);
      const maxSpeed = 1800;
      if (speed > maxSpeed) {
        body.vx = (body.vx / speed) * maxSpeed;
        body.vy = (body.vy / speed) * maxSpeed;
      }
      this.dragBody = null;
      this.wakeAll();
      setTimeout(() => (this.suppressClick = false), 0);
    }
    this.pendingBody = null;
    this.pointerId = undefined;
  }

  onClickCapture(event) {
    if (this.suppressClick) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  /* ------------------------------------------------------------------ */
  /* Theme editor: pop the selected block so it is easy to spot          */
  /* ------------------------------------------------------------------ */
  onBlockSelect(event) {
    if (!this.contains(event.target)) return;
    const el = event.target.closest('[data-gravity-item]') || event.target.querySelector('[data-gravity-item]');
    if (!el) return;
    const body = this.bodies.find((candidate) => candidate.el === el);
    if (!body || body.pinned) return;
    if (!this.started) this.start();
    body.active = true;
    this.wake(body);
    body.vy = -650;
    body.vx = (this.pseudoRandom(body.index + 3) - 0.5) * 300;
    this.wakeAll();
  }
}

if (!customElements.get('gravity-section')) {
  customElements.define('gravity-section', GravitySection);
}
