// =============================================================================
// KRUNKED CELLS — PIXEL-ART ITEM / SKILL / MUTATION / HUD ICON PROVIDER
// Resolves crisp 24x24 pixel-art icons from Owned Custom Pack (`cardIcons.png`)
// in Custom Pack Mode, or hand-crafted Built-In Krunked pixel icons in Built-In Mode.
// =============================================================================

import type { ArtPackMode, CustomPackAssetResolver } from '../contracts';

const builtinCache = new Map<string, string>();

/**
 * Returns a crisp pixel-art data URL (nearest-neighbor upscaled from 24x24)
 * for any weapon, skill, mutation, or HUD icon ID (`HealthFlask`, `Cell`,
 * `Gold`, `ScrollBrutality`, `ScrollTactics`, `ScrollSurvival`, `ScrollAny`,
 * `Skull`, `BossCell`).
 */
export function getBuiltinItemIconUrl(itemId: string): string | null {
  if (typeof document === 'undefined') return null;
  return builtinCache.get(itemId) ?? null;
}

/**
 * Unified art-mode-aware icon resolver:
 * - In `custom` mode, returns the real extracted `cardIcons.png` icon when loaded.
 * - Falls back cleanly to Built-In Krunked pixel-art icons in `builtin` mode or before load.
 */
export function getItemIconUrl(
  itemId: string,
  artPackMode: ArtPackMode,
  customPack?: CustomPackAssetResolver | null
): string | null {
  if (artPackMode === 'custom' && customPack?.getCardIconDataUrl) {
    const customUrl = customPack.getCardIconDataUrl(itemId);
    if (customUrl) return customUrl;
  }
  return getBuiltinItemIconUrl(itemId);
}
