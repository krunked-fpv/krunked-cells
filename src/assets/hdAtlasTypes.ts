// =============================================================================
// KRUNKED CELLS — SHARED TYPES FOR BUILT-IN 1:1 DEAD CELLS PIXEL-ART ATLASES
// =============================================================================

export interface HdAtlasPageData {
  readonly w: number;
  readonly h: number;
  readonly albedo: string;   // data:image/webp;base64,... (lossless RGBA)
  readonly normal: string;   // data:image/webp;base64,... (tangent-space normal map, Y-down)
  readonly emissive: string; // data:image/webp;base64,... (self-lit emissive mask)
}

export interface HdRegionMeta {
  readonly p: number;  // Local page index inside this module's PAGES array
  readonly x: number;  // Atlas pixel X
  readonly y: number;  // Atlas pixel Y
  readonly w: number;  // Atlas pixel width
  readonly h: number;  // Atlas pixel height
  readonly ww: number; // Logical world width (480x270 space)
  readonly wh: number; // Logical world height (480x270 space)
  readonly px: number; // Pivot X [0..1]
  readonly py: number; // Pivot Y [0..1]
}

export interface HdBackdropPair {
  readonly far: string; // 480x270 lossless WebP data URI (smooth atmospheric sky + far vista)
  readonly mid: string; // 480x270 lossless WebP RGBA data URI (silhouette parallax layer, alpha=0 sky)
}
