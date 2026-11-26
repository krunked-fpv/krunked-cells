// =============================================================================
// KRUNKED CELLS — Universal Spatial Controller & Menu Focus Navigator
// Supports D-Pad / Left-Stick 2D spatial navigation across all visible menus
// and modals, live range slider adjustment with Left/Right, scroll-into-view,
// re-render focus restoration, and automatic clear on real mouse movement.
// Headless Node / JSDOM safe. Zero Unicode emojis.
// =============================================================================

import type { UiNavAction } from '../contracts';

const FOCUSABLE_SELECTOR = [
  'button:not(:disabled)',
  'input[type="range"]:not(:disabled)',
  'input[type="number"]:not(:disabled)',
  'select:not(:disabled)',
].join(', ');

const FOCUS_KEY_ATTRS = [
  'data-act',
  'data-tab',
  'data-scroll-stat',
  'data-range',
  'data-rebind',
  'data-fps',
  'data-light',
  'data-art',
  'data-art-toggle',
  'data-title-bc',
  'data-gp-layout',
  'data-gp-glyph',
  'data-touch-mode',
  'data-invest',
  'data-pick-mut',
  'data-forge-up',
  'data-forge-reforge',
  'data-leg-forge',
  'data-enter-biome',
  'data-tp-uid',
  'data-loot-act',
] as const;

export class ControllerNav {
  private focusedEl: HTMLElement | null = null;
  private activeContainer: HTMLElement | null = null;
  private lastFocusKey: string | null = null;
  private lastMouseX: number | null = null;
  private lastMouseY: number | null = null;
  private mouseMoveListener: ((e: MouseEvent) => void) | null = null;

  constructor() {
    if (typeof window !== 'undefined') {
      this.mouseMoveListener = (e: MouseEvent) => {
        if (this.lastMouseX === null || this.lastMouseY === null) {
          this.lastMouseX = e.clientX;
          this.lastMouseY = e.clientY;
          return;
        }
        const dx = Math.abs(e.clientX - this.lastMouseX);
        const dy = Math.abs(e.clientY - this.lastMouseY);
        if (dx > 3 || dy > 3) {
          this.lastMouseX = e.clientX;
          this.lastMouseY = e.clientY;
          this.clearFocus();
        }
      };
      window.addEventListener('mousemove', this.mouseMoveListener, { passive: true });
    }
  }

  public getFocusedElement(): HTMLElement | null {
    return this.focusedEl;
  }

  public clearFocus(): void {
    if (this.focusedEl) {
      this.focusedEl.classList.remove('kc-gp-focused');
      this.focusedEl = null;
    }
  }

  public syncFocus(container: HTMLElement | null, preferAutoFocus = false): void {
    if (!container || this.isHiddenElement(container)) {
      this.activeContainer = null;
      this.lastFocusKey = null;
      this.clearFocus();
      return;
    }

    const focusables = this.getFocusables(container);
    if (focusables.length === 0) {
      this.activeContainer = container;
      this.clearFocus();
      return;
    }

    // Keep current focus if still mounted, visible, and inside this container
    if (
      this.focusedEl &&
      this.focusedEl.isConnected &&
      container.contains(this.focusedEl) &&
      focusables.includes(this.focusedEl)
    ) {
      this.activeContainer = container;
      this.focusedEl.classList.add('kc-gp-focused');
      return;
    }

    // Attempt to restore focus to the logically matching element after DOM re-renders
    if (this.activeContainer === container && this.lastFocusKey) {
      const restored = focusables.find((el) => this.computeFocusKey(el) === this.lastFocusKey);
      if (restored) {
        this.applyFocus(restored, container, false);
        return;
      }
    }

    this.activeContainer = container;

    if (!preferAutoFocus) {
      this.clearFocus();
      return;
    }

    const target = this.pickDefaultTarget(focusables);
    if (target) {
      this.applyFocus(target, container, true);
    }
  }

  public handleAction(action: UiNavAction, container: HTMLElement | null): boolean {
    if (!container || this.isHiddenElement(container)) {
      return false;
    }

    const focusables = this.getFocusables(container);
    if (focusables.length === 0) {
      return false;
    }

    // Resolve current focusable inside this container
    let current: HTMLElement | null =
      this.focusedEl && this.focusedEl.isConnected && focusables.includes(this.focusedEl)
        ? this.focusedEl
        : null;

    if (!current && this.activeContainer === container && this.lastFocusKey) {
      current = focusables.find((el) => this.computeFocusKey(el) === this.lastFocusKey) ?? null;
    }

    if (action === 'confirm') {
      if (!current) {
        current = this.pickDefaultTarget(focusables);
        if (!current) return false;
        this.applyFocus(current, container, true);
      }
      return this.activateElement(current);
    }

    if (action !== 'up' && action !== 'down' && action !== 'left' && action !== 'right') {
      return false;
    }

    // If nothing focused yet, focus the primary/first control right away
    if (!current) {
      const initial = this.pickDefaultTarget(focusables);
      if (!initial) return false;
      this.applyFocus(initial, container, true);
      return true;
    }

    // Special controller handling for <input type="range">: Left/Right adjusts value live!
    if (
      (action === 'left' || action === 'right') &&
      current instanceof HTMLInputElement &&
      current.type === 'range'
    ) {
      return this.adjustRangeInput(current, action === 'right' ? 1 : -1);
    }

    const next = this.findNextSpatial(current, action, focusables);
    if (!next || next === current) {
      // Keep focus visibly applied even if we hit a boundary
      this.applyFocus(current, container, false);
      return false;
    }

    this.applyFocus(next, container, true);
    return true;
  }

  public dispose(): void {
    this.clearFocus();
    this.activeContainer = null;
    this.lastFocusKey = null;
    if (this.mouseMoveListener && typeof window !== 'undefined') {
      window.removeEventListener('mousemove', this.mouseMoveListener);
      this.mouseMoveListener = null;
    }
  }

  private getFocusables(container: HTMLElement): HTMLElement[] {
    const raw = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    return raw.filter((el) => {
      if ((el as HTMLButtonElement | HTMLInputElement | HTMLSelectElement).disabled) {
        return false;
      }
      if (el.getAttribute('aria-hidden') === 'true') {
        return false;
      }
      if (el.tabIndex < 0) {
        return false;
      }
      return !this.isHiddenWithin(el, container);
    });
  }

  private isHiddenElement(el: HTMLElement): boolean {
    if (el.classList.contains('kc-hidden')) return true;
    if (el.hidden) return true;
    if (el.style.display === 'none' || el.style.visibility === 'hidden') return true;
    return false;
  }

  private isHiddenWithin(el: HTMLElement, boundary: HTMLElement): boolean {
    let cur: HTMLElement | null = el;
    while (cur) {
      if (this.isHiddenElement(cur)) return true;
      if (cur === boundary) break;
      cur = cur.parentElement;
    }
    return false;
  }

  private pickDefaultTarget(focusables: HTMLElement[]): HTMLElement | null {
    if (focusables.length === 0) return null;
    const explicit = focusables.find((el) => el.hasAttribute('data-gp-autofocus'));
    if (explicit) return explicit;
    const primary = focusables.find(
      (el) => el.classList.contains('is-primary') || el.classList.contains('kc-btn-primary')
    );
    if (primary) return primary;
    return focusables[0] ?? null;
  }

  private applyFocus(el: HTMLElement, container: HTMLElement, scrollIntoView: boolean): void {
    if (this.focusedEl && this.focusedEl !== el) {
      this.focusedEl.classList.remove('kc-gp-focused');
    }
    this.focusedEl = el;
    this.activeContainer = container;
    this.lastFocusKey = this.computeFocusKey(el);
    el.classList.add('kc-gp-focused');

    try {
      el.focus({ preventScroll: true });
    } catch {
      // Ignore focus errors in restricted/headless DOM environments
    }

    if (scrollIntoView && typeof el.scrollIntoView === 'function') {
      try {
        el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      } catch {
        // Older engines may not support options dictionary
        try {
          el.scrollIntoView(false);
        } catch {
          // Ignore in headless environments
        }
      }
    }
  }

  private activateElement(el: HTMLElement): boolean {
    if (el instanceof HTMLInputElement) {
      if (el.type === 'range') {
        el.focus();
        return true;
      }
      if (el.type === 'number' || el.type === 'text') {
        el.focus();
        try {
          el.select();
        } catch {
          // Ignore
        }
        return true;
      }
    }
    if (el instanceof HTMLSelectElement) {
      el.focus();
      return true;
    }
    el.click();
    return true;
  }

  private adjustRangeInput(input: HTMLInputElement, dir: -1 | 1): boolean {
    const min = Number.isFinite(Number(input.min)) && input.min !== '' ? Number(input.min) : 0;
    const max = Number.isFinite(Number(input.max)) && input.max !== '' ? Number(input.max) : 100;
    const current = Number.isFinite(Number(input.value)) ? Number(input.value) : min;
    const rawStep = Number(input.step);
    const span = Math.max(0.0001, max - min);

    let delta: number;
    if (Number.isFinite(rawStep) && rawStep > 0) {
      const fivePct = span * 0.05;
      const stepsPerChunk = span / rawStep > 25 ? Math.max(1, Math.round(fivePct / rawStep)) : 1;
      delta = rawStep * stepsPerChunk;
    } else {
      delta = span * 0.05;
    }

    const nextRaw = Math.max(min, Math.min(max, current + dir * delta));
    const precision = Number.isFinite(rawStep) && rawStep > 0 && rawStep < 1 ? 4 : 2;
    const nextVal = Number(nextRaw.toFixed(precision));

    if (nextVal === current) {
      return true;
    }

    input.value = String(nextVal);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  private findNextSpatial(
    current: HTMLElement,
    dir: 'up' | 'down' | 'left' | 'right',
    focusables: HTMLElement[]
  ): HTMLElement | null {
    const curIndex = focusables.indexOf(current);
    const curRect = current.getBoundingClientRect();
    const rects = focusables.map((el) => el.getBoundingClientRect());
    const hasLayout =
      (curRect.width > 0 || curRect.height > 0) &&
      rects.some((r, idx) => idx !== curIndex && (r.width > 0 || r.height > 0));

    // Headless / JSDOM fallback when layout rects are 0x0
    if (!hasLayout) {
      if (focusables.length <= 1) return current;
      const step = dir === 'down' || dir === 'right' ? 1 : -1;
      const nextIdx = (curIndex + step + focusables.length) % focusables.length;
      return focusables[nextIdx] ?? current;
    }

    const cx = curRect.left + curRect.width * 0.5;
    const cy = curRect.top + curRect.height * 0.5;

    let bestEl: HTMLElement | null = null;
    let bestScore = Infinity;

    for (let i = 0; i < focusables.length; i++) {
      const el = focusables[i]!;
      if (el === current) continue;
      const r = rects[i]!;
      if (r.width <= 0 && r.height <= 0) continue;

      const tx = r.left + r.width * 0.5;
      const ty = r.top + r.height * 0.5;
      const dx = tx - cx;
      const dy = ty - cy;

      let primary = 0;
      let perp = 0;
      let overlap = false;

      if (dir === 'right') {
        if (dx <= 2) continue;
        primary = dx;
        perp = Math.abs(dy);
        overlap = r.bottom >= curRect.top - 4 && r.top <= curRect.bottom + 4;
      } else if (dir === 'left') {
        if (dx >= -2) continue;
        primary = -dx;
        perp = Math.abs(dy);
        overlap = r.bottom >= curRect.top - 4 && r.top <= curRect.bottom + 4;
      } else if (dir === 'down') {
        if (dy <= 2) continue;
        primary = dy;
        perp = Math.abs(dx);
        overlap = r.right >= curRect.left - 4 && r.left <= curRect.right + 4;
      } else {
        if (dy >= -2) continue;
        primary = -dy;
        perp = Math.abs(dx);
        overlap = r.right >= curRect.left - 4 && r.left <= curRect.right + 4;
      }

      // Strongly prefer elements in the same horizontal band for left/right
      if ((dir === 'left' || dir === 'right') && !overlap && perp > Math.max(curRect.height * 1.6, 56)) {
        continue;
      }

      const perpWeight = overlap ? 0.8 : 2.6;
      const score = primary + perp * perpWeight;
      if (score < bestScore) {
        bestScore = score;
        bestEl = el;
      }
    }

    if (bestEl) {
      return bestEl;
    }

    // Wrap smoothly at boundaries
    if (dir === 'down' || dir === 'up') {
      const nextIdx =
        dir === 'down'
          ? (curIndex + 1) % focusables.length
          : (curIndex - 1 + focusables.length) % focusables.length;
      return focusables[nextIdx] ?? current;
    }

    // Horizontal wrap within the same row band (e.g., scroll pillars, segmented buttons, tabs)
    const rowTolerance = Math.max(curRect.height * 0.75, 22);
    const sameRow = focusables
      .map((el, i) => ({ el, r: rects[i]! }))
      .filter(({ r }) => Math.abs(r.top + r.height * 0.5 - cy) <= rowTolerance)
      .sort((a, b) => a.r.left - b.r.left);

    if (sameRow.length > 1) {
      return dir === 'right' ? sameRow[0]!.el : sameRow[sameRow.length - 1]!.el;
    }

    return current;
  }

  private computeFocusKey(el: HTMLElement): string {
    const parts: string[] = [el.tagName];
    for (const attr of FOCUS_KEY_ATTRS) {
      const val = el.getAttribute(attr);
      if (val !== null) {
        parts.push(`${attr}=${val}`);
      }
    }
    const amt = el.getAttribute('data-amt');
    if (amt !== null) {
      parts.push(`data-amt=${amt}`);
    }
    if (parts.length === 1) {
      const txt = (el.textContent ?? '').trim().slice(0, 32);
      if (txt) parts.push(`txt=${txt}`);
    }
    return parts.join('|');
  }
}
