// =============================================================================
// KRUNKED CELLS — WEBGL2 GLSL 300 ES SHADERS (4-PASS NORMAL-MAPPED PIPELINE)
// Zero compile warnings. Strict Y-down world-space normal consistency with
// flipped-sprite normal.x inversion, 64-light cel shading, fog, and bloom.
// =============================================================================

import { MAX_ACTIVE_LIGHTS } from '../contracts';

// Shared Fullscreen Triangle Vertex Shader (zero VBO required)
export const FULLSCREEN_VERT = `#version 300 es
precision highp float;
precision highp int;

out vec2 v_uv;

void main() {
  float x = float((gl_VertexID & 1) << 2) - 1.0;
  float y = float((gl_VertexID & 2) << 1) - 1.0;
  v_uv = vec2((x + 1.0) * 0.5, (y + 1.0) * 0.5);
  gl_Position = vec4(x, y, 0.0, 1.0);
}
`;

// =============================================================================
// PASS 1 — MULTI-LAYER GOTHIC PARALLAX BACKDROP SHADER
// =============================================================================

export const PARALLAX_FRAG = `#version 300 es
precision highp float;
precision highp int;

in vec2 v_uv;

uniform vec2 u_resolution;
uniform vec2 u_camera;
uniform float u_time;
uniform vec3 u_skyTop;
uniform vec3 u_skyMid;
uniform vec3 u_skyBottom;
uniform vec3 u_fogColor;
uniform vec3 u_celShadow;
uniform vec3 u_accentColor;
uniform int u_themeId;
uniform int u_biomeStyle;
uniform float u_hasFarTex;
uniform sampler2D u_scrollerFarTex;
uniform float u_hasMidTex;
uniform sampler2D u_scrollerMidTex;
uniform float u_hasNearTex;
uniform sampler2D u_scrollerNearTex;
uniform float u_hasOverlayTex;
uniform sampler2D u_scrollerOverlayTex;
uniform float u_overlayAdditive;

out vec4 o_color;

float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),
    mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

float fbm2(vec2 p) {
  return vnoise(p) * 0.65 + vnoise(p * 2.07 + vec2(13.1, 7.7)) * 0.35;
}

// Rotating serrated clockwork gear SDF for Clock Tower / Clock Room
float gearMask(vec2 p, vec2 center, float radius, float teeth, float speed) {
  vec2 d = p - center;
  float r = length(d);
  float a = atan(d.y, d.x) + u_time * speed;
  float tooth = smoothstep(0.35, 0.55, sin(a * teeth) * 0.5 + 0.5) * (radius * 0.16);
  float outer = step(r, radius + tooth);
  float hole = step(radius * 0.30, r);
  float innerRing = step(radius * 0.58, r) + step(r, radius * 0.44);
  float spokes = step(0.18, abs(sin(a * 3.0)));
  return outer * hole * clamp(innerRing + (1.0 - spokes), 0.0, 1.0);
}

// Distance to 2D line segment (for crooked tree branches, ship masts, pendulum rod)
float sdSegment(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  float h = clamp(dot(pa, ba) / max(0.0001, dot(ba, ba)), 0.0, 1.0);
  return length(pa - ba * h);
}

// Pointed gothic arch opening test: returns 1.0 inside open arch void, 0.0 on stone
float pointedArchOpening(float localX, float period, float topY, float archWidthFrac, float archRise, float sy) {
  float halfW = period * archWidthFrac * 0.5;
  float dx = abs(localX - period * 0.5) / max(1.0, halfW);
  if (dx >= 1.0) return 0.0;
  // Gothic ogive curve: sharper apex than semicircular Roman arch
  float curve = topY + archRise * pow(max(dx, 0.0001), 1.65);
  return step(curve, sy);
}

// Crooked gnarled dead-tree silhouette (trunk + forked limbs + optional gibbet)
vec2 deadTreeLayer(float xWorld, float sy, float spacing, float baseH, float seedOff, bool withGibbet) {
  float cell = floor(xWorld / spacing);
  float lx = fract(xWorld / spacing) - 0.5; // -0.5..0.5
  float s0 = hash11(cell * 11.37 + seedOff);
  float s1 = hash11(cell * 23.91 + seedOff * 1.7);
  float s2 = hash11(cell * 37.13 + seedOff * 2.3);
  if (s0 < 0.16) return vec2(0.0);

  float topY = baseH - s1 * 0.24;
  float sway = (s2 - 0.5) * 0.14;
  float leanX = sway * (1.0 - clamp((sy - topY) / max(0.08, 1.0 - topY), 0.0, 1.0));
  float crook = sin(sy * 16.0 + s0 * 12.0) * 0.022;
  float trunkCenter = (s0 - 0.5) * 0.22 + leanX + crook;
  float tH = clamp((sy - topY) / max(0.10, 1.0 - topY), 0.0, 1.0);
  float trunkHalfW = mix(0.014, 0.068 + s1 * 0.022, tH * tH);
  float inTrunk = step(abs(lx - trunkCenter), trunkHalfW) * step(topY, sy);

  // Two gnarled forked limbs reaching out asymmetrically
  vec2 p = vec2(lx, sy);
  vec2 forkA0 = vec2(trunkCenter, topY + 0.13);
  vec2 forkA1 = vec2(trunkCenter + (0.20 + s1 * 0.14), topY + 0.03 - s2 * 0.04);
  vec2 forkA2 = vec2(forkA1.x + 0.11, forkA1.y - 0.05);
  float dA = min(sdSegment(p, forkA0, forkA1), sdSegment(p, forkA1, forkA2));

  vec2 forkB0 = vec2(trunkCenter, topY + 0.20);
  vec2 forkB1 = vec2(trunkCenter - (0.18 + s2 * 0.15), topY + 0.09 - s1 * 0.03);
  vec2 forkB2 = vec2(forkB1.x - 0.09, forkB1.y - 0.06);
  float dB = min(sdSegment(p, forkB0, forkB1), sdSegment(p, forkB1, forkB2));

  // Upper crooked spire twig
  vec2 forkC0 = vec2(trunkCenter, topY + 0.07);
  vec2 forkC1 = vec2(trunkCenter + (s2 - 0.5) * 0.18, topY - 0.06);
  float dC = sdSegment(p, forkC0, forkC1);

  float inLimb = step(min(min(dA, dB), dC), 0.016);
  float treeMask = clamp(inTrunk + inLimb, 0.0, 1.0);

  // Optional hanging silhouetted gibbet cage suspended from the outer limb
  float gibbetMask = 0.0;
  if (withGibbet && s0 > 0.62) {
    float hangX = forkA1.x - 0.03;
    float ropeTop = forkA1.y + 0.01;
    float swing = sin(u_time * 1.15 + cell * 3.1) * 0.012;
    float cageTop = ropeTop + 0.10;
    float cageBot = cageTop + 0.095;
    float curX = hangX + swing * clamp((sy - ropeTop) / 0.14, 0.0, 1.0);
    float rope = step(abs(lx - curX), 0.006) * step(ropeTop, sy) * step(sy, cageTop);
    float inCageBox = step(abs(lx - curX), 0.034) * step(cageTop, sy) * step(sy, cageBot);
    float cageBars = step(0.45, abs(sin((lx - curX) * 145.0))) + step(abs(sy - cageTop), 0.008) + step(abs(sy - cageBot), 0.009);
    gibbetMask = clamp(rope + inCageBox * clamp(cageBars, 0.0, 1.0), 0.0, 1.0);
  }
  return vec2(treeMask, gibbetMask);
}

// Pixel-crisp Dead Cells Custom Pack scroller sampler (handles 128x128 seamless
// tiles, 256x128 wide arch banners, and 512x512 landscape panoramas cleanly!)
vec4 sampleScrollerLayer(
  sampler2D tex,
  vec2 px,
  float sy,
  float speedX,
  float speedY,
  int depthKind
) {
  vec2 sz = max(vec2(1.0), vec2(textureSize(tex, 0)));
  float py = u_resolution.y - 1.0 - px.y;
  float u;
  float v;
  bool isNear = (depthKind >= 2);
  bool isMid = (depthKind == 1);
  if (sz.y <= 160.0 && abs(sz.x - sz.y) < 4.0) {
    // 128x128 seamless 2D dungeon wallpaper (e.g. prisonStartScrollerA.png)
    u = fract((px.x + u_camera.x * speedX) / sz.x);
    v = fract((py + u_camera.y * speedY) / sz.y);
  } else if (sz.y <= 200.0) {
    // 256x128 repeating gothic arch panoramas (archeSmallBg_0 / archeSmallFg_0)
    float scale = isNear ? 1.85 : (isMid ? 1.72 : (u_resolution.y / sz.y));
    float tileW = max(64.0, sz.x * scale);
    float tileH = sz.y * scale;
    u = fract((px.x + u_camera.x * speedX) / tileW);
    if (isMid || isNear) {
      float topOff = u_resolution.y - tileH;
      if (py < topOff) return vec4(0.0);
      v = clamp((py - topOff) / tileH, 0.002, 0.998);
    } else {
      v = clamp(sy, 0.002, 0.998);
    }
  } else {
    // Tall 512x512 cliff / castle / skylight panoramas (scrollerBg_0 / scrollerLayer1_0 / scrollerLayer2_0)
    u = fract((px.x + u_camera.x * speedX) / max(128.0, sz.x));
    float span = min(sz.y, u_resolution.y * (isNear ? 1.22 : (isMid ? 1.35 : 1.55)));
    float yAnchor = isNear ? 0.68 : (isMid ? 0.60 : 0.46);
    float yBase = (sz.y - span) * yAnchor + u_camera.y * speedY * 0.12;
    v = clamp((yBase + sy * span) / sz.y, 0.002, 0.998);
  }
  return texture(tex, vec2(u, v));
}

// Overlay sampler for Custom Pack fog.png ribbons and godray/glow strips
vec4 sampleScrollerOverlay(sampler2D tex, vec2 px, float sy, bool additiveMode) {
  vec2 sz = max(vec2(1.0), vec2(textureSize(tex, 0)));
  float speedX = additiveMode ? 0.10 : 0.19;
  float driftX = additiveMode ? sin(u_time * 0.35) * 6.0 : (u_time * 9.0);
  float tileW = max(128.0, sz.x * (sz.x < 200.0 ? 2.0 : 1.0));
  float u = fract((px.x + u_camera.x * speedX + driftX) / tileW);
  float v = additiveMode
    ? clamp(sy * 1.15, 0.002, 0.998)
    : clamp((sy - 0.35) / 0.65, 0.002, 0.998);
  if (!additiveMode && sy < 0.35) return vec4(0.0);
  return texture(tex, vec2(u, v));
}

void drawStars(vec2 px, float sy, float maxY, float intensity, vec3 tint, inout vec3 col) {
  if (sy >= maxY) return;
  float starCell = hash21(floor(vec2(px.x + floor(u_camera.x * 0.02), px.y)));
  if (starCell > 0.9962) {
    float twinkle = 0.55 + 0.45 * sin(u_time * 2.6 + starCell * 42.0);
    col += mix(tint, vec3(0.92, 0.96, 1.0), 0.72) * twinkle * (1.0 - sy / maxY) * intensity;
  }
}

void drawMoon(vec2 uv, float sy, vec2 moonPos, float radius, float haloMul, vec3 moonTint, inout vec3 col) {
  vec2 mDelta = (vec2(uv.x, sy) - moonPos) * vec2(u_resolution.x / u_resolution.y, 1.0);
  float mDist = length(mDelta);
  float moonDisc = 1.0 - smoothstep(radius - 0.006, radius + 0.004, mDist);
  float moonCrater = fbm2(mDelta * 36.0 + vec2(3.1, 1.7));
  float moonHalo = (exp(-mDist * 3.8) * 0.50 + exp(-mDist * 1.6) * 0.16) * haloMul;
  col += moonTint * moonHalo;
  if (moonDisc > 0.01) {
    vec3 discCol = moonTint * (0.86 + moonCrater * 0.30);
    col = mix(col, discCol, moonDisc * 0.92);
  }
}

void main() {
  // Snap to crisp logical 480x270 pixel grid (Y-down screen uv: sy=0 top, sy=1 bottom)
  vec2 px = floor(v_uv * u_resolution);
  vec2 uv = (px + 0.5) / u_resolution;
  float sy = 1.0 - uv.y;

  // 3-stop atmospheric sky gradient
  vec3 col = sy < 0.52
    ? mix(u_skyTop, u_skyMid, smoothstep(0.0, 0.52, sy))
    : mix(u_skyMid, u_skyBottom, smoothstep(0.52, 1.0, sy));

  // Owned Custom Pack Multi-Layer Dead Cells Parallax Scrollers (up to 4 depth layers!)
  if (u_hasFarTex > 0.5) {
    // Subtle sky moon glow behind transparent outdoor scroller sky edges (skip indoor Prison/Sewer)
    if (u_biomeStyle != 0 && u_biomeStyle != 2) {
      vec2 moonPos = vec2(0.76 - fract(u_camera.x * 0.000025) * 0.08, 0.20);
      vec2 mDelta = (vec2(uv.x, sy) - moonPos) * vec2(u_resolution.x / u_resolution.y, 1.0);
      float mDist = length(mDelta);
      vec3 moonTint = mix(u_accentColor, vec3(1.0, 0.96, 0.88), 0.65);
      col += moonTint * (exp(-mDist * 3.4) * 0.36);
    }

    vec3 atmosTint = mix(
      vec3(1.0),
      mix(u_skyMid * 1.45 + vec3(0.20), u_accentColor * 0.45 + vec3(0.68), 0.35),
      0.22
    );

    vec4 farTex = sampleScrollerLayer(u_scrollerFarTex, px, sy, 0.07, 0.035, 0);
    col = mix(col, farTex.rgb * atmosTint, clamp(farTex.a * 0.92, 0.0, 0.94));

    if (u_hasMidTex > 0.5) {
      vec4 midTex = sampleScrollerLayer(u_scrollerMidTex, px, sy, 0.17, 0.06, 1);
      vec3 midTint = mix(vec3(1.0), atmosTint, 0.72);
      col = mix(col, midTex.rgb * midTint, clamp(midTex.a * 0.90, 0.0, 0.92));
    }

    if (u_hasNearTex > 0.5) {
      vec4 nearTex = sampleScrollerLayer(u_scrollerNearTex, px, sy, 0.27, 0.085, 2);
      vec3 nearTint = mix(vec3(1.0), atmosTint, 0.55);
      col = mix(col, nearTex.rgb * nearTint, clamp(nearTex.a * 0.92, 0.0, 0.94));
    }

    if (u_hasOverlayTex > 0.5) {
      bool isAdditive = (u_overlayAdditive > 0.5);
      vec4 ovTex = sampleScrollerOverlay(u_scrollerOverlayTex, px, sy, isAdditive);
      if (isAdditive) {
        float pulse = 0.88 + 0.12 * sin(u_time * 1.5);
        vec3 rayTint = mix(vec3(1.0), u_accentColor * 1.15 + vec3(0.25), 0.35);
        col += ovTex.rgb * ovTex.a * rayTint * (0.44 * pulse);
      } else {
        vec3 fogTint = mix(ovTex.rgb, u_fogColor * 1.25, 0.38);
        col = mix(col, fogTint, clamp(ovTex.a * 0.44, 0.0, 0.56));
      }
    }

    // Subtle atmospheric horizon depth mist so foreground gameplay silhouettes pop cleanly
    float horizonMist = smoothstep(0.58, 1.0, sy);
    col = mix(col, u_fogColor * 0.82, horizonMist * 0.28);

    o_color = vec4(col, 1.0);
    return;
  }

  // ===========================================================================
  // BUILT-IN 8-STYLE BIOME-DISTINCT DARK-FANTASY PARALLAX BACKDROPS
  // 0: Prison/Passage  1: Promenade  2: Toxic Sewer  3: Ramparts
  // 4: Black Bridge    5: Stilt      6: Clock Tower  7: Castle/Throne
  // ===========================================================================

  vec3 moonTint = mix(u_accentColor, vec3(1.0, 0.96, 0.88), 0.64);
  float seedTheme = float(u_themeId) * 2.31;

  if (u_biomeStyle == 0) {
    // -------------------------------------------------------------------------
    // STYLE 0: PRISON / PASSAGE — Vaulted subterranean catacomb arches,
    // distant hanging chains, sconce alcoves & drifting cell dust!
    // -------------------------------------------------------------------------
    // Subtle dark masonry courses in deep catacomb recess
    float courseY = fract(sy * 18.0 + u_camera.y * 0.002);
    float blockX = fract((uv.x * 480.0 + u_camera.x * 0.04) / 28.0 + floor(sy * 18.0) * 0.5);
    float mortar = step(0.92, courseY) + step(0.95, blockX);
    col = mix(col * 0.78, u_celShadow * 0.24, clamp(mortar, 0.0, 1.0) * 0.38);

    // High angled dungeon air-shaft light beams slicing across the vault
    float shaftCoord = uv.x * 6.5 + sy * 3.8 + u_camera.x * 0.00032;
    float shaft = pow(max(0.0, sin(shaftCoord) * 0.5 + 0.5), 4.0) * pow(max(0.0, sin(shaftCoord * 0.37 + 0.9) * 0.5 + 0.5), 2.0);
    float shaftFade = smoothstep(0.0, 0.14, sy) * (1.0 - smoothstep(0.55, 0.98, sy));
    col += mix(u_accentColor, vec3(0.68, 0.84, 1.0), 0.58) * (shaft * shaftFade * 0.30);

    // Far Vaulted Catacomb Arcade (0.06x parallax)
    float xFar = uv.x * 480.0 + u_camera.x * 0.06;
    float farPeriod = 76.0;
    float farLocal = mod(xFar, farPeriod);
    float farIdx = floor(xFar / farPeriod);
    float farOpen = pointedArchOpening(farLocal, farPeriod, 0.22, 0.66, 0.24, sy) * step(sy, 0.84);
    float inFarStone = 1.0 - farOpen;
    if (inFarStone > 0.5) {
      vec3 catCol = mix(u_celShadow * 0.32, u_skyMid * 0.65, 0.42);
      // Faint stone arch keystone highlight
      float ribEdge = step(abs(farLocal - farPeriod * 0.5), farPeriod * 0.36) * step(abs(sy - 0.24), 0.025);
      catCol += u_accentColor * ribEdge * 0.08;
      col = mix(col, catCol, 0.84);
    } else {
      // Barred dungeon alcove windows & warm distant flickering torch sconce inside open vault!
      float bar = step(0.84, fract(farLocal / 8.0)) * step(0.30, sy) * step(sy, 0.66);
      col = mix(col, u_celShadow * 0.16, bar * 0.52);
      if (hash11(farIdx * 5.1 + seedTheme) > 0.38) {
        vec2 scP = vec2((farLocal - farPeriod * 0.5) / 18.0, (sy - 0.56) * 5.2);
        float flick = 0.84 + 0.16 * sin(u_time * 8.5 + farIdx * 4.7);
        col += u_accentColor * exp(-length(scP) * 2.5) * 0.36 * flick;
      }
    }

    // Distant Hanging Iron Chains swaying from upper vault (0.11x parallax)
    float xCh = uv.x * 480.0 + u_camera.x * 0.11;
    float chCell = floor(xCh / 44.0);
    float chSeed = hash11(chCell * 9.73 + seedTheme);
    if (chSeed > 0.35) {
      float chLen = 0.28 + chSeed * 0.34;
      float chSway = sin(u_time * 1.2 + chCell * 2.7) * 2.2 * clamp(sy / chLen, 0.0, 1.0);
      float chDx = abs(mod(xCh, 44.0) - (16.0 + chSeed * 16.0) - chSway);
      float link = step(0.35, fract(sy * 48.0));
      float chainW = mix(1.0, 2.2, link);
      if (chDx < chainW && sy < chLen) {
        vec3 chainCol = mix(u_celShadow * 0.20, vec3(0.34, 0.40, 0.52), 0.25 * link);
        col = mix(col, chainCol, 0.82);
      }
    }

    // Midground Subterranean Vaulted Ribs & Floor Parapet (0.17x parallax)
    float xMid = uv.x * 480.0 + u_camera.x * 0.17;
    float midPeriod = 112.0;
    float midLocal = mod(xMid, midPeriod);
    float midOpen = pointedArchOpening(midLocal, midPeriod, 0.12, 0.78, 0.26, sy) * step(sy, 0.78);
    float inMidRib = (1.0 - midOpen) * (step(sy, 0.38) + step(0.76, sy) + step(abs(midLocal - midPeriod * 0.5), midPeriod * 0.5) * (1.0 - step(abs(midLocal - midPeriod * 0.5), midPeriod * 0.39)));
    if (inMidRib > 0.5) {
      vec3 midCol = mix(u_celShadow * 0.22, u_fogColor * 0.45, 0.38);
      col = mix(col, midCol, 0.90);
    }

    // Drifting crisp 1px cell dust motes catching skylight shafts
    vec2 dustCell = floor(vec2(px.x + floor(u_camera.x * 0.14 + u_time * 4.0), px.y - floor(u_time * 5.0)));
    float dustH = hash21(dustCell);
    if (dustH > 0.9945) {
      float dustGlow = (0.45 + 0.55 * sin(u_time * 3.0 + dustH * 30.0)) * (0.35 + shaft * 1.4);
      col += mix(u_accentColor, vec3(0.85, 0.92, 1.0), 0.6) * dustGlow * 0.48;
    }

    col = mix(col, u_fogColor * 0.84, smoothstep(0.58, 1.0, sy) * 0.50);

  } else if (u_biomeStyle == 1) {
    // -------------------------------------------------------------------------
    // STYLE 1: PROMENADE — Mist-veiled full moon, 3 parallax layers of gnarled
    // crooked dead-tree forest silhouettes & silhouetted hanging gibbets!
    // -------------------------------------------------------------------------
    drawStars(px, sy, 0.44, 0.48, u_accentColor, col);

    vec2 moonPos = vec2(0.72 - fract(u_camera.x * 0.000022) * 0.07, 0.22);
    drawMoon(uv, sy, moonPos, 0.095, 1.18, moonTint, col);

    // Mist ribbons veiling the moon and upper canopy
    vec2 veilUv = vec2(uv.x * 4.4 + u_camera.x * 0.00016 + u_time * 0.016, sy * 3.8);
    float veil = smoothstep(0.38, 0.74, fbm2(veilUv)) * (1.0 - smoothstep(0.45, 0.88, sy));
    col = mix(col, mix(u_skyMid * 1.25, moonTint * 0.78, 0.38), veil * 0.48);

    // Far Dead-Tree Forest Ridge (Layer 1 — 0.05x parallax)
    float xL1 = uv.x * 480.0 + u_camera.x * 0.05;
    float ridge1 = 0.62 + (fbm2(vec2(xL1 * 0.009 + 2.1, 1.3)) - 0.5) * 0.14;
    vec2 t1 = deadTreeLayer(xL1, sy, 34.0, 0.54, 1.7, false);
    if (sy > ridge1 || t1.x > 0.5) {
      vec3 c1 = mix(u_skyMid * 0.52, u_fogColor * 0.88, 0.55);
      col = mix(col, c1, 0.82);
    }

    // Atmospheric mist separation band between Layer 1 & Layer 2
    col = mix(col, mix(u_fogColor, u_skyBottom, 0.45), smoothstep(0.48, 0.92, sy) * 0.24);

    // Mid Gnarled Forest + Hanging Silhouetted Gibbets (Layer 2 — 0.12x parallax)
    float xL2 = uv.x * 480.0 + u_camera.x * 0.12;
    float ridge2 = 0.72 + (fbm2(vec2(xL2 * 0.012 + 7.4, 2.5)) - 0.5) * 0.10;
    vec2 t2 = deadTreeLayer(xL2, sy, 62.0, 0.44, 5.3, true);
    if (sy > ridge2 || t2.x > 0.5 || t2.y > 0.5) {
      vec3 c2 = mix(u_celShadow * 0.28, u_fogColor * 0.62, 0.52);
      if (t2.y > 0.5) c2 *= 0.82;
      col = mix(col, c2, 0.90);
    }

    // Near Silhouetted Crooked Trunks & Gibbet Posts (Layer 3 — 0.22x parallax)
    float xL3 = uv.x * 480.0 + u_camera.x * 0.22;
    float ridge3 = 0.82 + (fbm2(vec2(xL3 * 0.015 + 11.2, 4.1)) - 0.5) * 0.07;
    vec2 t3 = deadTreeLayer(xL3, sy, 108.0, 0.34, 9.9, true);
    if (sy > ridge3 || t3.x > 0.5 || t3.y > 0.5) {
      vec3 c3 = mix(u_celShadow * 0.18, u_fogColor * 0.38, 0.40);
      col = mix(col, c3, 0.94);
    }

    col = mix(col, u_fogColor * 0.90, smoothstep(0.58, 1.0, sy) * 0.50);

  } else if (u_biomeStyle == 2) {
    // -------------------------------------------------------------------------
    // STYLE 2: TOXIC SEWER — Vaulted cylindrical stone drain tunnels, massive
    // horizontal overhead conduit pipes & rising toxic emerald vapor (NO sky/moon!)
    // -------------------------------------------------------------------------
    // Enclosed curved cylindrical stone vault shading (dark apex, damp mossy rings)
    float vaultGrad = smoothstep(0.0, 0.34, sy);
    col = mix(u_skyTop * 0.60, u_skyMid * 0.78, vaultGrad);

    // Rising toxic emerald floor-vapor glow illuminating the cistern from below!
    vec2 vapUv1 = vec2(uv.x * 5.2 + u_camera.x * 0.0012, sy * 3.2 + u_time * 0.12);
    vec2 vapUv2 = vec2(uv.x * 9.4 + u_camera.x * 0.0018 - u_time * 0.05, sy * 5.4 + u_time * 0.18);
    float vapor = fbm2(vapUv1) * 0.60 + fbm2(vapUv2) * 0.40;
    float floorGlow = smoothstep(0.44, 1.0, sy);
    vec3 toxicCol = mix(u_skyBottom * 1.35, u_accentColor, 0.58);
    col += toxicCol * (floorGlow * (0.28 + vapor * 0.52));

    // Far Vaulted Cylindrical Stone Drain Tunnels (0.07x parallax)
    float xFar = uv.x * 480.0 + u_camera.x * 0.07;
    float drainPeriod = 84.0;
    float dLocal = mod(xFar, drainPeriod);
    float dIdx = floor(xFar / drainPeriod);
    float dSeed = hash11(dIdx * 7.31 + 2.1);
    // Circular sewer drain openings recessed in background stone wall
    vec2 drainC = vec2((dLocal - drainPeriod * 0.5) / 26.0, (sy - 0.54) / 0.18);
    float drainR = length(drainC);
    if (drainR < 1.0) {
      // Deep dark drain mouth with toxic waterfall trickle pouring out!
      vec3 holeCol = u_skyTop * 0.45;
      float hasFlow = step(0.28, dSeed);
      float trickle = hasFlow * step(abs(drainC.x), 0.14 + 0.05 * sin(sy * 35.0 - u_time * 6.0 + dIdx)) * step(0.0, drainC.y);
      holeCol = mix(holeCol, u_accentColor * 0.92, trickle * 0.80);
      col = mix(col, holeCol, 0.88);
    } else if (drainR < 1.18) {
      // Beveled stone drain ring rim catching green underglow
      vec3 ringCol = mix(u_celShadow * 0.45, u_accentColor * 0.42, clamp(drainC.y * 0.5 + 0.5, 0.0, 1.0));
      col = mix(col, ringCol, 0.86);
    } else {
      // Vaulted stone arch pillars between drain mouths
      float archTop = 0.16 + 0.12 * abs((dLocal - drainPeriod * 0.5) / (drainPeriod * 0.5));
      float brick = step(0.90, fract(sy * 22.0)) + step(0.94, fract(xFar / 18.0));
      if (sy < archTop || abs(dLocal - drainPeriod * 0.5) > drainPeriod * 0.37) {
        vec3 wallCol = mix(u_celShadow * 0.34, u_fogColor * 0.72, 0.45) * (1.0 - clamp(brick, 0.0, 1.0) * 0.22);
        col = mix(col, wallCol, 0.84);
      }
    }

    // Massive Horizontal Overhead Conduit Pipes (2 parallax depths!)
    // Upper pipe (0.14x parallax): sy 0.12..0.24
    float xPipe1 = uv.x * 480.0 + u_camera.x * 0.14;
    if (sy >= 0.11 && sy <= 0.24) {
      float pT = (sy - 0.11) / 0.13; // 0 top, 1 bottom
      float cylShade = sin(pT * 3.14159);
      float flange = step(0.84, fract(xPipe1 / 34.0));
      vec3 pipeCol = mix(u_celShadow * 0.25, u_fogColor * 0.85, cylShade * 0.75);
      // Toxic emerald underlight reflected on underside of pipe!
      pipeCol += u_accentColor * smoothstep(0.55, 0.96, pT) * 0.30;
      pipeCol = mix(pipeCol, u_celShadow * 0.18 + u_accentColor * 0.18, flange * 0.55);
      col = mix(col, pipeCol, 0.94);
    }
    // Secondary lower conduit pipe + vertical standpipes (0.20x parallax): sy 0.33..0.40
    float xPipe2 = uv.x * 480.0 + u_camera.x * 0.20;
    float vStand = step(0.91, fract(xPipe2 / 92.0)) * step(0.18, sy) * step(sy, 0.74);
    if (vStand > 0.5) {
      vec3 stCol = mix(u_celShadow * 0.24, u_accentColor * 0.22, 0.30);
      col = mix(col, stCol, 0.88);
    }
    if (sy >= 0.32 && sy <= 0.40) {
      float pT2 = (sy - 0.32) / 0.08;
      float cyl2 = sin(pT2 * 3.14159);
      float rib2 = step(0.86, fract(xPipe2 / 24.0));
      vec3 pCol2 = mix(u_celShadow * 0.20, u_fogColor * 0.72, cyl2 * 0.70);
      pCol2 += u_accentColor * smoothstep(0.52, 0.95, pT2) * 0.26;
      pCol2 = mix(pCol2, u_celShadow * 0.15, rib2 * 0.45);
      col = mix(col, pCol2, 0.92);
    }

    // Lower Sewer Walkway Viaduct Arches (0.18x parallax)
    float xMid = uv.x * 480.0 + u_camera.x * 0.18;
    float bayP = 68.0;
    float mLoc = mod(xMid, bayP);
    float archOpen = pointedArchOpening(mLoc, bayP, 0.76, 0.68, 0.14, sy);
    if (sy > 0.70 && archOpen < 0.5) {
      vec3 deckCol = mix(u_celShadow * 0.22, u_fogColor * 0.45, 0.40);
      deckCol += u_accentColor * step(sy, 0.72) * 0.12;
      col = mix(col, deckCol, 0.92);
    }

    // Foreground rising emerald toxic mist veil near sewer floor
    float lowVap = smoothstep(0.62, 1.0, sy) * (0.36 + 0.48 * vapor);
    col = mix(col, mix(u_fogColor * 1.15, u_accentColor * 0.70, 0.42), clamp(lowVap * 0.68, 0.0, 0.72));

  } else if (u_biomeStyle == 3) {
    // -------------------------------------------------------------------------
    // STYLE 3: RAMPARTS — Warm sunset-to-indigo dusk sky gradient, rolling
    // twilight cloud banks, distant ocean horizon glint & cliffside watchtowers!
    // -------------------------------------------------------------------------
    // Rich dusk sunset sky with warm horizon band at sy ~ 0.64
    float duskDelta = (sy - 0.62) * 4.6;
    float duskBand = exp(-(duskDelta * duskDelta));
    col += mix(u_accentColor, vec3(1.0, 0.62, 0.34), 0.5) * duskBand * 0.34;
    drawStars(px, sy, 0.30, 0.42, u_accentColor, col);

    // Low warm sunset/dusk moon glow over the coast
    vec2 duskOrb = vec2(0.70 - fract(u_camera.x * 0.000018) * 0.06, 0.52);
    drawMoon(uv, sy, duskOrb, 0.072, 1.05, mix(u_accentColor, vec3(1.0, 0.88, 0.64), 0.62), col);

    // Rolling twilight cloud banks with golden sunset under-rims
    vec2 cl1 = vec2(uv.x * 3.8 + u_camera.x * 0.00015 + u_time * 0.018, sy * 4.2);
    float cVal = fbm2(cl1);
    float cMask = smoothstep(0.40, 0.74, cVal) * (1.0 - smoothstep(0.44, 0.68, sy));
    float cUnder = smoothstep(0.44, 0.64, cVal) * smoothstep(0.16, 0.58, sy);
    vec3 cloudTone = mix(u_skyMid * 0.88, mix(u_accentColor, vec3(1.0, 0.74, 0.46), 0.5), cUnder * 0.65);
    col = mix(col, cloudTone, cMask * 0.56);

    // Distant Ocean Horizon + Animated Sunset Water Glint (sy >= 0.63)
    if (sy >= 0.63) {
      float seaT = clamp((sy - 0.63) / 0.37, 0.0, 1.0);
      vec3 seaCol = mix(u_skyTop * 1.15, u_fogColor * 0.72, seaT);
      // Shimmering horizontal sunset glint ripples across the ocean surface
      float waveX = uv.x * 42.0 + u_camera.x * 0.0014 + sin(sy * 90.0 + u_time * 1.8) * 1.2;
      float waveY = sy * 65.0 - u_time * 0.8;
      float glint = step(0.74, vnoise(vec2(waveX, waveY))) * exp(-abs(uv.x - duskOrb.x) * 3.4) * (1.0 - seaT * 0.65);
      seaCol += mix(u_accentColor, vec3(1.0, 0.86, 0.54), 0.65) * glint * 0.62;
      // Crisp horizon line highlight
      seaCol += u_accentColor * exp(-seaT * 26.0) * 0.32;
      col = mix(col, seaCol, 0.94);
    }

    // Far Cliffside Promontory & Distant Rampart Spires (0.06x parallax)
    float xFar = uv.x * 480.0 + u_camera.x * 0.06;
    float farCliff = 0.60 + (fbm2(vec2(xFar * 0.009 + 4.2, 1.8)) - 0.5) * 0.16;
    float fCell = floor(xFar / 68.0);
    float fLoc = fract(xFar / 68.0);
    float fSeed = hash11(fCell * 6.3 + 3.1);
    float fTowerH = 0.40 + fSeed * 0.18;
    float inFarTower = step(0.28, fLoc) * step(fLoc, 0.66) * step(fTowerH, sy) * step(0.42, fSeed);
    if (sy > farCliff || inFarTower > 0.5) {
      vec3 farSil = mix(u_celShadow * 0.52, u_skyMid * 0.55, 0.45);
      col = mix(col, farSil, 0.86);
    }

    // Midground Silhouetted Cliffside Watchtowers, Battlements & Connecting Bridges (0.16x parallax)
    float xMid = uv.x * 480.0 + u_camera.x * 0.16;
    float mPeriod = 98.0;
    float mCell = floor(xMid / mPeriod);
    float mLoc = fract(xMid / mPeriod);
    float mSeed = hash11(mCell * 8.17 + 1.4);
    float wtTop = 0.34 + mSeed * 0.20;
    float inWatchtower = step(0.22, mLoc) * step(mLoc, 0.58) * step(wtTop, sy);
    float merlon = step(0.50, fract(xMid / 7.0)) * 0.022 * step(0.20, mLoc) * step(mLoc, 0.60) * step(wtTop - 0.022, sy) * step(sy, wtTop + 0.01);
    // Pointed conical watchtower turret roof on taller towers
    float roofDist = abs(mLoc - 0.40);
    float roofT = clamp((sy - (wtTop - 0.14)) / 0.14, 0.0, 1.0);
    float inRoof = step(roofDist, roofT * 0.21) * step(wtTop - 0.14, sy) * step(sy, wtTop) * step(0.52, mSeed);
    // Connecting arched rampart wall bridge between watchtowers
    float bridgeDeck = 0.68 + (mSeed - 0.5) * 0.05;
    float bridgeOpen = pointedArchOpening(mod(xMid, mPeriod), mPeriod, bridgeDeck + 0.06, 0.42, 0.12, sy);
    float inBridge = step(bridgeDeck, sy) * (1.0 - bridgeOpen);

    if (inWatchtower > 0.5 || merlon > 0.5 || inRoof > 0.5 || inBridge > 0.5) {
      vec3 wtCol = mix(u_celShadow * 0.34, u_fogColor * 0.62, 0.42);
      // Warm dusk edge rim on watchtower left edge facing sunset
      float sunsetRim = step(abs(mLoc - 0.22), 0.018) * step(wtTop, sy);
      wtCol += u_accentColor * sunsetRim * 0.28;
      // Glowing warm amber watchtower slit windows
      float wx = fract(xMid / 10.0);
      float wy = fract(sy * 28.0);
      float slit = step(0.40, wx) * step(wx, 0.60) * step(0.25, wy) * step(wy, 0.72)
        * step(0.80, hash21(vec2(floor(xMid / 10.0), floor(sy * 28.0))))
        * step(wtTop + 0.04, sy) * inWatchtower;
      col = mix(wtCol, u_accentColor * 1.25, slit * 0.88);
    }

    col = mix(col, u_fogColor * 0.80, smoothstep(0.72, 1.0, sy) * 0.42);

  } else if (u_biomeStyle == 4) {
    // -------------------------------------------------------------------------
    // STYLE 4: BLACK BRIDGE — Storm-charged indigo clouds, periodic sheet-
    // lightning illuminating a massive distant Castle spire fortress & storm mist!
    // -------------------------------------------------------------------------
    // Irregular periodic sheet-lightning flash (brief crisp twin-flicker pulse)
    float lCycle = fract(u_time * 0.18 + 0.37);
    float dFlashA = (lCycle - 0.82) * 48.0;
    float dFlashB = (lCycle - 0.855) * 58.0;
    float flashA = exp(-(dFlashA * dFlashA));
    float flashB = 0.70 * exp(-(dFlashB * dFlashB));
    float bolt = clamp(flashA + flashB, 0.0, 1.0);

    // Heavy storm-charged indigo thunderhead clouds sweeping swiftly across sky
    vec2 stUv1 = vec2(uv.x * 4.5 + u_camera.x * 0.00020 + u_time * 0.042, sy * 3.2);
    vec2 stUv2 = vec2(uv.x * 8.2 + u_camera.x * 0.00028 + u_time * 0.068, sy * 5.0 - u_time * 0.01);
    float stormN = fbm2(stUv1) * 0.62 + fbm2(stUv2) * 0.38;
    float stormCloud = smoothstep(0.32, 0.72, stormN) * (1.0 - smoothstep(0.55, 0.96, sy));
    vec3 stormCol = mix(u_skyTop * 0.90, u_skyMid * 1.18, stormN);
    // Sheet-lightning illuminates upper storm cloud undersides in electric blue-white!
    vec3 boltCol = vec3(0.68, 0.86, 1.0);
    stormCol += boltCol * (bolt * smoothstep(0.38, 0.75, stormN) * (1.0 - sy * 0.72) * 0.78);
    col = mix(col, stormCol, 0.72 * stormCloud + 0.15);
    col += boltCol * (bolt * (1.0 - sy * 0.85) * 0.34);

    // Massive Distant Castle Spire Fortress looming across the chasm (0.045x parallax)
    float xCast = uv.x * 480.0 + u_camera.x * 0.045;
    float fortSpan = mod(xCast + 140.0, 340.0) - 170.0; // monumental fortress cluster centered every 340px
    float distCenter = abs(fortSpan);
    float baseRidge = 0.62 + (fbm2(vec2(xCast * 0.011, 2.2)) - 0.5) * 0.12;
    // Multi-tiered central citadel + flanking needle spires
    float centralKeep = step(distCenter, 62.0) * step(0.36 + distCenter * 0.0032, sy);
    float highSpire = step(abs(fortSpan), max(0.0, (sy - 0.14) * 58.0)) * step(0.14, sy) * step(sy, 0.42);
    float flankL = step(abs(fortSpan + 44.0), max(0.0, (sy - 0.24) * 44.0)) * step(0.24, sy) * step(sy, 0.50);
    float flankR = step(abs(fortSpan - 48.0), max(0.0, (sy - 0.22) * 46.0)) * step(0.22, sy) * step(sy, 0.50);
    float outerTurrets = step(abs(mod(xCast, 42.0) - 21.0), 7.5) * step(0.46, sy) * step(distCenter, 118.0);
    float inFortress = clamp(centralKeep + highSpire + flankL + flankR + outerTurrets + step(baseRidge, sy), 0.0, 1.0);

    if (inFortress > 0.5) {
      // Veiled in dark storm haze normally, dramatically silhouetted during lightning flash!
      vec3 fortCol = mix(u_skyTop * 0.70, u_fogColor * 0.85, 0.45);
      fortCol = mix(fortCol, vec3(0.04, 0.06, 0.14), bolt * 0.72);
      // Subtle lightning rim highlight along upper fortress battlements
      float fortRim = (1.0 - step(0.40, sy)) * bolt * 0.22;
      fortCol += boltCol * fortRim;
      // Tiny warm embers/windows deep in the fortress
      float fw = step(0.44, fract(xCast / 8.0)) * step(fract(xCast / 8.0), 0.56)
        * step(0.35, fract(sy * 36.0)) * step(fract(sy * 36.0), 0.65)
        * step(0.88, hash21(vec2(floor(xCast / 8.0), floor(sy * 36.0))))
        * step(0.42, sy) * step(distCenter, 68.0);
      col = mix(fortCol, u_accentColor * 1.15, fw * 0.75);
    }

    // Midground Monumental Black Bridge Piers, Battlements & Sagging Chains (0.16x parallax)
    float xMid = uv.x * 480.0 + u_camera.x * 0.16;
    float pPeriod = 96.0;
    float mLoc = mod(xMid, pPeriod);
    float archOpen = pointedArchOpening(mLoc, pPeriod, 0.72, 0.72, 0.18, sy);
    float inPier = step(0.66, sy) * (1.0 - archOpen);
    // Sagging iron bridge chains slung between battlements above deck
    float normChainX = (mLoc / pPeriod) * 2.0 - 1.0;
    float sagY = 0.62 - 0.10 * normChainX * normChainX;
    float inChain = step(abs(sy - sagY), 0.008);
    if (inPier > 0.5 || inChain > 0.5) {
      vec3 brCol = mix(u_celShadow * 0.22, u_fogColor * 0.50, 0.40);
      brCol += boltCol * step(sy, 0.68) * bolt * 0.25;
      col = mix(col, brCol, 0.92);
    }

    // Driving diagonal storm mist & wind-sheared rain sheets
    vec2 rainUv = vec2(uv.x * 7.5 - sy * 4.2 + u_time * 0.42 + u_camera.x * 0.0005, sy * 4.8 + u_time * 0.14);
    float stormMist = smoothstep(0.44, 0.82, fbm2(rainUv));
    col = mix(col, mix(u_fogColor * 1.15, boltCol * 0.65, bolt * 0.45), stormMist * (0.24 + smoothstep(0.50, 1.0, sy) * 0.30));

  } else if (u_biomeStyle == 5) {
    // -------------------------------------------------------------------------
    // STYLE 5: STILT VILLAGE — Eerie misty harbor sky, towering wooden stilt
    // houses & ship masts + warm distant harbor lantern pinpoints!
    // -------------------------------------------------------------------------
    drawStars(px, sy, 0.36, 0.36, u_accentColor, col);
    vec2 moonPos = vec2(0.28 - fract(u_camera.x * 0.000020) * 0.06, 0.21);
    drawMoon(uv, sy, moonPos, 0.082, 1.12, moonTint, col);

    // Eerie misty coastal fog bank clouds
    vec2 hCl = vec2(uv.x * 4.2 + u_camera.x * 0.00016 + u_time * 0.015, sy * 3.4);
    float hClM = smoothstep(0.38, 0.72, fbm2(hCl)) * (1.0 - smoothstep(0.45, 0.85, sy));
    col = mix(col, mix(u_skyMid * 1.20, u_fogColor * 1.30, 0.45), hClM * 0.46);

    // Far Harbor Ship Masts, Yardarms & Rigging Silhouettes (0.06x parallax)
    float xFar = uv.x * 480.0 + u_camera.x * 0.06;
    float sCell = floor(xFar / 78.0);
    float sLoc = fract(xFar / 78.0) - 0.5;
    float sSeed = hash11(sCell * 7.91 + 5.2);
    if (sSeed > 0.28) {
      float mastTop = 0.24 + sSeed * 0.16;
      float sway = sin(u_time * 0.9 + sCell * 2.1) * 0.010 * clamp((0.68 - sy) / 0.44, 0.0, 1.0);
      float mx = sLoc - sway;
      float mast = step(abs(mx), 0.012) * step(mastTop, sy) * step(sy, 0.72);
      float yard1 = step(abs(sy - (mastTop + 0.09)), 0.009) * step(abs(mx), 0.16);
      float yard2 = step(abs(sy - (mastTop + 0.19)), 0.010) * step(abs(mx), 0.22);
      // Hull silhouette near waterline
      float hull = step(abs(sLoc), 0.26 - max(0.0, (sy - 0.62) * 0.8)) * step(0.60, sy) * step(sy, 0.70);
      if (mast + yard1 + yard2 + hull > 0.5) {
        vec3 shipCol = mix(u_skyMid * 0.48, u_fogColor * 0.85, 0.52);
        col = mix(col, shipCol, 0.82);
      }
    }

    // Dark misty harbor water plane (sy >= 0.68)
    if (sy >= 0.68) {
      float wT = (sy - 0.68) / 0.32;
      vec3 watCol = mix(u_skyMid * 0.50, u_fogColor * 0.65, wT);
      col = mix(col, watCol, 0.86);
    }

    // Midground Towering Wooden Stilt Houses & Timber Pilings (0.15x parallax)
    float xMid = uv.x * 480.0 + u_camera.x * 0.15;
    float hPeriod = 72.0;
    float hCell = floor(xMid / hPeriod);
    float hLoc = fract(xMid / hPeriod);
    float hSeed = hash11(hCell * 13.7 + 2.1);
    float hSeed2 = hash11(hCell * 29.3 + 4.7);
    float houseFloor = 0.58 + (hSeed - 0.5) * 0.07;
    float houseTop = houseFloor - (0.16 + hSeed2 * 0.12);
    float roofPeak = houseTop - (0.09 + hSeed * 0.06);

    float inBody = step(0.14, hLoc) * step(hLoc, 0.82) * step(houseTop, sy) * step(sy, houseFloor);
    float roofDist = abs(hLoc - 0.48);
    float roofFrac = clamp((sy - roofPeak) / max(0.04, houseTop - roofPeak), 0.0, 1.0);
    float inGable = step(roofDist, roofFrac * 0.39) * step(roofPeak, sy) * step(sy, houseTop);
    // Tall vertical wooden stilts plunging into harbor water + diagonal cross-braces
    float stiltCol = (step(abs(hLoc - 0.22), 0.025) + step(abs(hLoc - 0.48), 0.022) + step(abs(hLoc - 0.74), 0.025)) * step(houseFloor, sy);
    float dockBeam = step(abs(sy - (houseFloor + 0.015)), 0.015);

    if (inBody > 0.5 || inGable > 0.5 || stiltCol > 0.5 || dockBeam > 0.5) {
      vec3 stiltWood = mix(u_celShadow * 0.24, u_fogColor * 0.48, 0.44);
      // Warm glowing lit shanty windows
      float wx = fract(xMid / 12.0);
      float wy = fract(sy * 26.0);
      float litWin = step(0.30, wx) * step(wx, 0.70) * step(0.28, wy) * step(wy, 0.74)
        * step(0.76, hash21(vec2(floor(xMid / 12.0), floor(sy * 26.0))))
        * inBody;
      col = mix(stiltWood, u_accentColor * 1.25, litWin * 0.90);
    }

    // Warm Distant Harbor Lantern Pinpoints + Soft Water Shimmer Reflections!
    float lanCell = floor(xMid / 36.0);
    float lanSeed = hash11(lanCell * 17.3 + 8.1);
    if (lanSeed > 0.34) {
      float lxPos = (lanCell + 0.25 + lanSeed * 0.5) * 36.0;
      float lyPos = 0.56 + (lanSeed - 0.5) * 0.14;
      vec2 lDelta = vec2((xMid - lxPos) / 14.0, (sy - lyPos) * 7.5);
      float lDist = length(lDelta);
      float lFlick = 0.85 + 0.15 * sin(u_time * 6.5 + lanCell * 5.1);
      vec3 lanCol = mix(u_accentColor, vec3(1.0, 0.82, 0.38), 0.45);
      col += lanCol * (exp(-lDist * 2.8) * 0.48 + step(lDist, 0.18) * 0.65) * lFlick;
      // Vertical shimmering water reflection beneath each harbor lantern
      if (sy > 0.69) {
        float reflX = abs((xMid - lxPos) + sin(sy * 85.0 + u_time * 3.0) * 1.5);
        float refl = exp(-reflX * 0.42) * exp(-(sy - 0.69) * 5.0) * 0.36 * lFlick;
        col += lanCol * refl;
      }
    }

    col = mix(col, u_fogColor * 0.92, smoothstep(0.60, 1.0, sy) * 0.54);

  } else if (u_biomeStyle == 6) {
    // -------------------------------------------------------------------------
    // STYLE 6: CLOCK TOWER / CLOCK ROOM — Stained-glass lancet glow shafts,
    // giant sweeping pendulum silhouette & 3-depth counter-rotating gears!
    // -------------------------------------------------------------------------
    // Tall pointed gothic stained-glass lancet windows in far cathedral wall (0.05x parallax)
    float xWin = uv.x * 480.0 + u_camera.x * 0.05;
    float wPeriod = 120.0;
    float wLoc = mod(xWin, wPeriod);
    float inLancet = pointedArchOpening(wLoc, wPeriod, 0.08, 0.34, 0.16, sy) * step(sy, 0.64);
    if (inLancet > 0.5) {
      // Stained-glass jewel lattice tint
      float leadX = step(0.88, fract(wLoc / 10.0));
      float leadY = step(0.88, fract(sy * 26.0));
      vec3 glassCol = mix(u_skyMid * 1.55, u_accentColor * 1.15, 0.45 + 0.35 * sin(sy * 12.0));
      glassCol = mix(glassCol, u_celShadow * 0.25, clamp(leadX + leadY, 0.0, 1.0) * 0.72);
      col = mix(col, glassCol, 0.86);
    }

    // Dramatic diagonal stained-glass lancet glow shafts slicing across the room!
    float shaftX = mod(xWin - sy * 110.0, wPeriod);
    float inShaft = smoothstep(wPeriod * 0.22, wPeriod * 0.50, shaftX) * (1.0 - smoothstep(wPeriod * 0.50, wPeriod * 0.78, shaftX));
    float shaftFade = smoothstep(0.06, 0.22, sy) * (1.0 - smoothstep(0.62, 1.0, sy));
    col += mix(u_accentColor, u_skyBottom * 1.4, 0.38) * (inShaft * shaftFade * 0.34);

    // Depth 1 (Far): Colossal slow counter-rotating clockwork gears (0.05x parallax)
    vec2 gp1 = vec2(mod(xWin * 1.05, 220.0), sy * 270.0);
    float gd1a = gearMask(gp1, vec2(62.0, 118.0), 66.0, 16.0, 0.14);
    float gd1b = gearMask(gp1, vec2(168.0, 168.0), 52.0, 14.0, -0.18);
    if (clamp(gd1a + gd1b, 0.0, 1.0) > 0.5) {
      vec3 g1Col = mix(u_skyMid * 0.48, u_accentColor * 0.36, 0.28);
      col = mix(col, g1Col, 0.78);
    }

    // Giant Sweeping Pendulum Silhouette (0.10x parallax)
    float xPend = uv.x * 480.0 + u_camera.x * 0.10;
    float pLocX = mod(xPend, 240.0) - 120.0;
    float pAng = sin(u_time * 1.18) * 0.36;
    vec2 pendPivot = vec2(0.0, -34.0);
    vec2 pendBob = pendPivot + vec2(sin(pAng), cos(pAng)) * 224.0;
    vec2 pendPt = vec2(pLocX, sy * 270.0);
    float rodD = sdSegment(pendPt, pendPivot, pendBob);
    float bobD = length(pendPt - pendBob);
    float inPend = step(rodD, 2.4) + step(bobD, 22.0) * (1.0 - step(bobD, 8.0) * step(pendPt.y, pendBob.y - 2.0));
    if (inPend > 0.5) {
      vec3 pendCol = mix(u_celShadow * 0.24, u_accentColor * 0.48, smoothstep(14.0, 22.0, bobD) * 0.45);
      col = mix(col, pendCol, 0.88);
    }

    // Depth 2 (Mid): Interlocking medium bronze/iron gears (0.12x parallax)
    float xG2 = uv.x * 480.0 + u_camera.x * 0.12;
    vec2 gp2 = vec2(mod(xG2 * 1.25, 176.0), sy * 270.0);
    float gd2a = gearMask(gp2, vec2(46.0, 134.0), 46.0, 12.0, -0.28);
    float gd2b = gearMask(gp2, vec2(120.0, 92.0), 34.0, 10.0, 0.38);
    if (clamp(gd2a + gd2b, 0.0, 1.0) > 0.5) {
      vec3 g2Col = mix(u_celShadow * 0.30, u_accentColor * 0.54, 0.36);
      col = mix(col, g2Col, 0.88);
    }

    // Depth 3 (Near-Mid): Crisp faster gears + gothic clockwork belfry arches (0.19x parallax)
    float xG3 = uv.x * 480.0 + u_camera.x * 0.19;
    vec2 gp3 = vec2(mod(xG3 * 1.35, 160.0), sy * 270.0);
    float gd3 = gearMask(gp3, vec2(84.0, 212.0), 38.0, 11.0, 0.46);
    float archOpen = pointedArchOpening(mod(xG3, 104.0), 104.0, 0.74, 0.70, 0.18, sy);
    float inBelfry = step(0.68, sy) * (1.0 - archOpen);
    if (gd3 > 0.5 || inBelfry > 0.5) {
      vec3 g3Col = mix(u_celShadow * 0.20, u_fogColor * 0.48, 0.42);
      g3Col += u_accentColor * (gd3 * 0.16);
      col = mix(col, g3Col, 0.92);
    }

    col = mix(col, u_fogColor * 0.85, smoothstep(0.62, 1.0, sy) * 0.44);

  } else {
    // -------------------------------------------------------------------------
    // STYLE 7: HIGH PEAK CASTLE / THRONE ROOM — Grand pointed gothic cathedral
    // spire skyline, warm golden lit arched windows & diagonal moonbeam god-rays!
    // -------------------------------------------------------------------------
    drawStars(px, sy, 0.46, 0.54, u_accentColor, col);
    vec2 moonPos = vec2(0.78 - fract(u_camera.x * 0.000024) * 0.07, 0.18);
    drawMoon(uv, sy, moonPos, 0.088, 1.15, moonTint, col);

    // Regal high twilight cloud wisps gilded by moonlight
    vec2 cUv = vec2(uv.x * 4.6 + u_camera.x * 0.00016 + u_time * 0.012, sy * 3.4);
    float cBand = smoothstep(0.42, 0.74, fbm2(cUv)) * (1.0 - smoothstep(0.38, 0.78, sy));
    col = mix(col, mix(u_skyMid * 1.18, moonTint * 0.80, 0.45), cBand * 0.42);

    // Far Grand Pointed Gothic Cathedral Spire Skyline (0.055x parallax)
    float xFar = uv.x * 480.0 + u_camera.x * 0.055;
    float fCell = floor(xFar / 46.0);
    float fLoc = fract(xFar / 46.0);
    float fSeed = hash11(fCell * 9.17 + seedTheme);
    float fBaseH = 0.44 + fSeed * 0.20;
    float inCitadel = step(0.14, fLoc) * step(fLoc, 0.86) * step(fBaseH, sy);
    // Soaring sharp cathedral needle spires + twin flanking pinnacles!
    float spMainT = clamp((sy - (fBaseH - 0.26)) / 0.26, 0.0, 1.0);
    float spMain = step(abs(fLoc - 0.50), spMainT * 0.22) * step(fBaseH - 0.26, sy) * step(sy, fBaseH);
    float spSubL = step(abs(fLoc - 0.22), clamp((sy - (fBaseH - 0.14)) / 0.14, 0.0, 1.0) * 0.08) * step(fBaseH - 0.14, sy) * step(sy, fBaseH) * step(0.35, fSeed);
    float spSubR = step(abs(fLoc - 0.78), clamp((sy - (fBaseH - 0.14)) / 0.14, 0.0, 1.0) * 0.08) * step(fBaseH - 0.14, sy) * step(sy, fBaseH) * step(0.35, fSeed);
    if (inCitadel + spMain + spSubL + spSubR > 0.5) {
      vec3 catCol = mix(u_skyMid * 0.48, u_fogColor * 0.78, 0.48);
      // Warm golden arched cathedral windows in far skyline
      float wx = fract(xFar / 11.5);
      float wy = fract(sy * 26.0);
      float archWin = step(0.34, wx) * step(wx, 0.66) * step(0.20 + abs(wx - 0.5) * 0.65, wy) * step(wy, 0.78)
        * step(0.74, hash21(vec2(floor(xFar / 11.5), floor(sy * 26.0))))
        * step(fBaseH + 0.03, sy);
      col = mix(catCol, mix(u_accentColor, vec3(1.0, 0.88, 0.46), 0.50) * 1.18, archWin * 0.90);
    }

    // Midground Royal Palatial Wall, Pointed Colonnade & Warm Golden Lit Arched Windows (0.14x parallax)
    float xMid = uv.x * 480.0 + u_camera.x * 0.14;
    float mPeriod = 78.0;
    float mLoc = mod(xMid, mPeriod);
    float mCell = floor(xMid / mPeriod);
    float mSeed = hash11(mCell * 6.41 + seedTheme);
    float wallDeck = 0.58 + (mSeed - 0.5) * 0.06;
    // Tall pointed palatial battlements & lower cloister arches
    float cloisterOpen = pointedArchOpening(mLoc, mPeriod, wallDeck + 0.16, 0.56, 0.16, sy);
    float merlon = step(0.55, fract(xMid / 8.0)) * 0.022;
    float inWall = step(wallDeck - merlon, sy) * (1.0 - cloisterOpen);
    if (inWall > 0.5) {
      vec3 palCol = mix(u_celShadow * 0.30, u_fogColor * 0.58, 0.44);
      // Crisp moonlit marble cornice bevel
      palCol += mix(u_accentColor, vec3(1.0, 0.96, 0.84), 0.55) * step(sy, wallDeck + 0.012) * 0.18;
      // Ornate tall golden arched castle windows spaced along upper wall
      float winOpen = pointedArchOpening(mLoc, mPeriod, wallDeck + 0.03, 0.24, 0.06, sy) * step(sy, wallDeck + 0.14);
      if (winOpen > 0.5) {
        float mullion = step(abs(mLoc - mPeriod * 0.5), 1.0) + step(abs(sy - (wallDeck + 0.095)), 0.006);
        vec3 goldGlow = mix(u_accentColor * 1.25, vec3(1.0, 0.90, 0.55), 0.55);
        palCol = mix(goldGlow, palCol * 0.55, clamp(mullion, 0.0, 1.0) * 0.80);
      }
      col = mix(col, palCol, 0.92);
    }

    // Dramatic Diagonal Moonbeam God-Rays slicing across the royal spires!
    float rayCoord = uv.x * 8.2 + sy * 4.4 + u_camera.x * 0.00042;
    float rayA = pow(max(0.0001, sin(rayCoord) * 0.5 + 0.5), 3.4);
    float rayB = pow(max(0.0001, sin(rayCoord * 0.43 + 1.2) * 0.5 + 0.5), 1.8);
    float rayMask = rayA * rayB * smoothstep(0.0, 0.16, sy) * (1.0 - sy * 0.52);
    col += mix(u_accentColor, vec3(0.92, 0.96, 1.0), 0.52) * (rayMask * 0.46);

    col = mix(col, u_fogColor * 0.82, smoothstep(0.60, 1.0, sy) * 0.46);
  }

  o_color = vec4(col, 1.0);
}
`;

// =============================================================================
// PASS 2 — G-BUFFER MRT SPRITE BATCH SHADER (ALBEDO + NORMAL + EMISSIVE)
// Enforces normal.x = -normal.x when v_flipX < 0.0 so flipped sprites light
// accurately from every dynamic torch and brazier!
// =============================================================================

export const GBUFFER_VERT = `#version 300 es
precision highp float;
precision highp int;

layout(location = 0) in vec2 a_pos;
layout(location = 1) in vec2 a_uv;
layout(location = 2) in vec4 a_color;
layout(location = 3) in vec4 a_params; // x=flipX, y=flashMix, z=emissiveBoost, w=normalStrength (<0 = bgWall)

uniform vec2 u_resolution;

out vec2 v_uv;
out vec4 v_color;
out float v_flipX;
out float v_flashMix;
out float v_emissiveBoost;
out float v_normalStrength;

void main() {
  vec2 ndc = (a_pos / u_resolution) * 2.0 - 1.0;
  ndc.y = -ndc.y; // World Y-down -> OpenGL NDC Y-up
  gl_Position = vec4(ndc, 0.0, 1.0);
  v_uv = a_uv;
  v_color = a_color;
  v_flipX = a_params.x;
  v_flashMix = a_params.y;
  v_emissiveBoost = a_params.z;
  v_normalStrength = a_params.w;
}
`;

export const GBUFFER_FRAG = `#version 300 es
precision highp float;
precision highp int;

in vec2 v_uv;
in vec4 v_color;
in float v_flipX;
in float v_flashMix;
in float v_emissiveBoost;
in float v_normalStrength;

uniform sampler2D u_albedoTex;
uniform sampler2D u_normalTex;
uniform sampler2D u_emissiveTex;

layout(location = 0) out vec4 o_albedo;
layout(location = 1) out vec4 o_normal;
layout(location = 2) out vec4 o_emissive;

void main() {
  vec4 albedoSample = texture(u_albedoTex, v_uv);
  float alpha = albedoSample.a * v_color.a;
  if (alpha < 0.12) {
    discard;
  }

  vec3 baseCol = albedoSample.rgb * v_color.rgb;
  // White-gold hit flash mix for tactile impact pop
  baseCol = mix(baseCol, vec3(1.0, 0.97, 0.90), clamp(v_flashMix, 0.0, 1.0));

  // Reconstruct tangent-space normal and invert X whenever sprite is horizontally flipped!
  vec3 n = texture(u_normalTex, v_uv).rgb * 2.0 - 1.0;
  if (v_flipX < 0.0) {
    n.x = -n.x;
  }
  float strength = abs(v_normalStrength);
  n = normalize(vec3(n.xy * strength, max(0.08, n.z)));

  // Surface flag in o_normal.a: 0.45 = recessed background masonry, 1.0 = foreground solid/character
  float surfaceFlag = v_normalStrength < 0.0 ? 0.45 : 1.0;

  vec4 emSample = texture(u_emissiveTex, v_uv);
  vec3 em = emSample.rgb * emSample.a;
  em += baseCol * max(0.0, v_emissiveBoost);
  em += vec3(0.95, 0.88, 0.72) * (v_flashMix * 0.7);

  o_albedo = vec4(baseCol, 1.0);
  o_normal = vec4(n * 0.5 + 0.5, surfaceFlag);
  o_emissive = vec4(clamp(em, 0.0, 1.0), 1.0);
}
`;

// =============================================================================
// PASS 3 — 64-LIGHT NORMAL-MAPPED CEL LIGHTING + BRIGHT-PASS EXTRACT
// =============================================================================

export const LIGHTING_FRAG = `#version 300 es
precision highp float;
precision highp int;

in vec2 v_uv;

uniform sampler2D u_backdropTex;
uniform sampler2D u_albedoTex;
uniform sampler2D u_normalTex;
uniform sampler2D u_emissiveTex;

uniform vec2 u_resolution;
uniform vec3 u_ambientColor;
uniform vec3 u_celShadowColor;
uniform vec3 u_fogColor;
uniform vec3 u_rimColor;
uniform int u_lightCount;
uniform vec4 u_lightPosRadius[${MAX_ACTIVE_LIGHTS}];       // xy = screen px (Y-down), z = radius, w = zHeight
uniform vec4 u_lightColorIntensity[${MAX_ACTIVE_LIGHTS}];  // rgb = color, w = intensity

layout(location = 0) out vec4 o_lit;
layout(location = 1) out vec4 o_bloom;

void main() {
  vec4 backdrop = texture(u_backdropTex, v_uv);
  vec4 gAlbedo = texture(u_albedoTex, v_uv);
  vec4 gNormal = texture(u_normalTex, v_uv);
  vec4 gEmissive = texture(u_emissiveTex, v_uv);

  // Convert gl_FragCoord (Y-up) into logical World Screen Pixel space (Y-down: 0..480, 0..270)
  vec2 pixPos = vec2(gl_FragCoord.x, u_resolution.y - gl_FragCoord.y);

  // Open Sky / Backdrop pixel: render backdrop + soft volumetric atmospheric light scatter
  if (gAlbedo.a < 0.05) {
    vec3 airScatter = vec3(0.0);
    int count = min(u_lightCount, ${MAX_ACTIVE_LIGHTS});
    for (int i = 0; i < ${MAX_ACTIVE_LIGHTS}; i++) {
      if (i >= count) break;
      vec4 lp = u_lightPosRadius[i];
      vec4 lc = u_lightColorIntensity[i];
      float dist = length(lp.xy - pixPos);
      if (dist < lp.z) {
        float t = 1.0 - dist / lp.z;
        airScatter += lc.rgb * (lc.a * t * t * t * 0.20);
      }
    }
    vec3 skyOut = backdrop.rgb + airScatter;
    float skyLum = dot(airScatter, vec3(0.299, 0.587, 0.114));
    o_lit = vec4(skyOut, 1.0);
    o_bloom = vec4(airScatter * smoothstep(0.18, 0.55, skyLum), 1.0);
    return;
  }

  vec3 N = normalize(gNormal.rgb * 2.0 - 1.0);
  bool isBgWall = gNormal.a < 0.72;

  // Directional moon/sky rim light (overhead upper-left in Y-down space => y < 0)
  vec3 skyDir = normalize(vec3(-0.34, -0.78, 0.52));
  float skyNdl = max(dot(N, skyDir), 0.0);
  float skyCel = 0.25 + 0.35 * smoothstep(0.14, 0.32, skyNdl) + 0.40 * smoothstep(0.52, 0.70, skyNdl);

  // Deep velvety Dead Cells celShadow in crevices vs cool ambient moon/sky on upward bevels
  vec3 baseLight = mix(u_celShadowColor * 0.36, u_ambientColor * 0.48, skyCel);
  // Crisp silhouette edge rim highlight
  float topRim = pow(max(0.0, -N.y), 2.0) * 0.20;
  baseLight += u_rimColor * topRim;

  // Dynamic Point Lights (up to 64 active lights with 3-band cel-stepped normal shading)
  vec3 pointAccum = vec3(0.0);
  int count = min(u_lightCount, ${MAX_ACTIVE_LIGHTS});
  for (int i = 0; i < ${MAX_ACTIVE_LIGHTS}; i++) {
    if (i >= count) break;
    vec4 lp = u_lightPosRadius[i];
    vec4 lc = u_lightColorIntensity[i];
    vec2 dxy = lp.xy - pixPos;
    float distSq = dot(dxy, dxy);
    float radSq = lp.z * lp.z;
    if (distSq >= radSq) continue;

    float dist = sqrt(distSq);
    float atten = 1.0 - dist / lp.z;
    atten = atten * atten * (3.0 - 2.0 * atten); // smooth cubic attenuation

    vec3 L = normalize(vec3(dxy, lp.w));
    float ndl = max(dot(N, L), 0.0);

    // 3-band stylized Dead Cells cel ramp with bevel grazing rim + metallic specular glint!
    float cel = 0.16
      + 0.40 * smoothstep(0.10, 0.24, ndl)
      + 0.44 * smoothstep(0.46, 0.62, ndl);
    float grazing = pow(clamp(1.0 - max(N.z, 0.0), 0.0, 1.0), 1.8) * smoothstep(0.14, 0.48, ndl) * 0.30;
    float specRim = 0.0;
    if (!isBgWall) {
      specRim = pow(max(dot(N, normalize(L + vec3(0.0, 0.0, 1.0))), 0.0), 14.0) * smoothstep(0.45, 0.78, ndl) * 0.28;
    }

    pointAccum += lc.rgb * (lc.a * atten * (cel + grazing + specRim));
  }

  // Relaxed soft-knee shoulder compression so warm braziers carve deep cool shadows dramatically!
  pointAccum = pointAccum / (1.0 + pointAccum * 0.34);

  vec3 totalLight = baseLight + pointAccum;
  if (isBgWall) {
    // Recessed background masonry sits deeper in cool shadow so foreground pops cleanly!
    totalLight *= 0.48;
  }

  vec3 lit = gAlbedo.rgb * totalLight;
  if (isBgWall) {
    lit = mix(lit, u_fogColor * 0.62, 0.28);
  }

  // Unshaded self-illuminated emissive pixels (homunculus head, braziers, runes, glowing eyes, acid)
  vec3 emBoost = gEmissive.rgb * 1.28;
  vec3 finalCol = lit + emBoost;

  // Bright-pass bloom contribution: surgical emissive glow + crisp high-intensity bevel catch
  float litLum = dot(lit, vec3(0.299, 0.587, 0.114));
  vec3 specBloom = lit * smoothstep(0.92, 1.45, litLum) * 0.30;
  vec3 bloomCol = gEmissive.rgb * 1.05 + specBloom;

  o_lit = vec4(finalCol, 1.0);
  o_bloom = vec4(clamp(bloomCol, 0.0, 1.35), 1.0);
}
`;

// =============================================================================
// PASS 3.5 — TRANSLUCENT & ADDITIVE VFX OVERLAY SHADER (LIT + BLOOM MRT)
// =============================================================================

export const VFX_VERT = `#version 300 es
precision highp float;
precision highp int;

layout(location = 0) in vec2 a_pos;
layout(location = 1) in vec2 a_uv;
layout(location = 2) in vec4 a_color;
layout(location = 3) in vec4 a_params; // x=flipX, y=flashMix, z=emissiveBoost, w=unused

uniform vec2 u_resolution;

out vec2 v_uv;
out vec4 v_color;
out float v_flashMix;
out float v_emissiveBoost;

void main() {
  vec2 ndc = (a_pos / u_resolution) * 2.0 - 1.0;
  ndc.y = -ndc.y;
  gl_Position = vec4(ndc, 0.0, 1.0);
  v_uv = a_uv;
  v_color = a_color;
  v_flashMix = a_params.y;
  v_emissiveBoost = a_params.z;
}
`;

export const VFX_FRAG = `#version 300 es
precision highp float;
precision highp int;

in vec2 v_uv;
in vec4 v_color;
in float v_flashMix;
in float v_emissiveBoost;

uniform sampler2D u_albedoTex;
uniform sampler2D u_emissiveTex;

layout(location = 0) out vec4 o_lit;
layout(location = 1) out vec4 o_bloom;

void main() {
  vec4 tex = texture(u_albedoTex, v_uv);
  float alpha = tex.a * v_color.a;
  if (alpha < 0.01) {
    discard;
  }
  vec3 col = tex.rgb * v_color.rgb;
  col = mix(col, vec3(1.0, 0.98, 0.92), clamp(v_flashMix, 0.0, 1.0));

  vec4 emTex = texture(u_emissiveTex, v_uv);
  float bloomAmt = max(emTex.a, v_emissiveBoost);
  vec3 bloomCol = col * clamp(bloomAmt, 0.0, 1.5);

  o_lit = vec4(col, alpha);
  o_bloom = vec4(bloomCol, alpha * clamp(bloomAmt, 0.0, 1.0));
}
`;

// =============================================================================
// PASS 4A — DRIFTING GROUND MIST / VOLUMETRIC FOG SHADER (smokeShader)
// =============================================================================

export const FOG_FRAG = `#version 300 es
precision highp float;
precision highp int;

in vec2 v_uv;

uniform vec2 u_resolution;
uniform vec2 u_camera;
uniform float u_time;
uniform vec3 u_fogColor;
uniform vec3 u_accentColor;
uniform float u_fogDensity;
uniform float u_hasEmissiveTex;
uniform sampler2D u_emissiveTex;
uniform vec4 u_heroLightZone; // optional: xy = screen UV (Y-down), z = radius UV, w = attenuation strength

layout(location = 0) out vec4 o_lit;
layout(location = 1) out vec4 o_bloom;

float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),
    mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

void main() {
  vec2 px = floor(v_uv * u_resolution);
  vec2 uv = (px + 0.5) / u_resolution;
  float sy = 1.0 - uv.y;

  // Dual drifting noise layers scrolling smoothly with camera + wind
  vec2 p1 = vec2(uv.x * 4.2 + u_camera.x * 0.0022 + u_time * 0.07, sy * 2.6 + u_camera.y * 0.0012);
  vec2 p2 = vec2(uv.x * 8.5 + u_camera.x * 0.0034 - u_time * 0.045, sy * 5.2 + u_time * 0.02);
  float smoke = vnoise(p1) * 0.62 + vnoise(p2) * 0.38;

  // Concentrate mist in dark lower floor crevices while preserving mid-screen hero/boss clarity
  float creviceBand = smoothstep(0.62, 1.0, sy);
  float wisp = smoothstep(0.44, 0.86, smoke);
  vec2 combatCenter = (vec2(uv.x, sy) - vec2(0.5, 0.56)) * vec2(2.1, 2.7);
  float centerClarity = 1.0 - 0.36 * exp(-dot(combatCenter, combatCenter));

  // Optional bright-zone attenuation from G-buffer emissive mask or hero/boss torch zone
  float brightAtten = 1.0;
  if (u_hasEmissiveTex > 0.5) {
    vec3 em = texture(u_emissiveTex, v_uv).rgb;
    float lightLum = dot(em, vec3(0.299, 0.587, 0.114));
    brightAtten *= 1.0 - clamp(lightLum * 0.55, 0.0, 0.65);
  }
  if (u_heroLightZone.w > 0.01) {
    vec2 dHero = (vec2(uv.x, sy) - u_heroLightZone.xy) * vec2(u_resolution.x / u_resolution.y, 1.0);
    float prox = 1.0 - smoothstep(0.0, max(0.05, u_heroLightZone.z), length(dHero));
    brightAtten *= 1.0 - clamp(prox * u_heroLightZone.w * 0.55, 0.0, 0.65);
  }

  float alpha = (creviceBand * 0.34 + wisp * 0.09) * wisp * u_fogDensity * centerClarity * brightAtten;

  vec3 fogTint = mix(u_fogColor * 1.15, u_accentColor * 0.55, wisp * 0.22);
  o_lit = vec4(fogTint, clamp(alpha, 0.0, 0.38));
  o_bloom = vec4(0.0, 0.0, 0.0, 0.0);
}
`;

// =============================================================================
// PASS 4B — SEPARABLE 9-TAP KAWASE/GAUSSIAN BLOOM BLUR SHADER
// =============================================================================

export const BLUR_FRAG = `#version 300 es
precision highp float;
precision highp int;

in vec2 v_uv;

uniform sampler2D u_srcTex;
uniform vec2 u_texelStep; // (1/w, 0) for horizontal pass, (0, 1/h) for vertical pass

out vec4 o_color;

void main() {
  vec3 sum = texture(u_srcTex, v_uv).rgb * 0.227027;
  sum += texture(u_srcTex, v_uv + u_texelStep * 1.384615).rgb * 0.316216;
  sum += texture(u_srcTex, v_uv - u_texelStep * 1.384615).rgb * 0.316216;
  sum += texture(u_srcTex, v_uv + u_texelStep * 3.230769).rgb * 0.070270;
  sum += texture(u_srcTex, v_uv - u_texelStep * 3.230769).rgb * 0.070270;
  o_color = vec4(sum, 1.0);
}
`;

// =============================================================================
// PASS 4C — CRISP NEAREST UPSCALE + ADDITIVE BLOOM + GRADE + FLASH COMPOSITE
// =============================================================================

export const COMPOSITE_FRAG = `#version 300 es
precision highp float;
precision highp int;

in vec2 v_uv;

uniform sampler2D u_sceneTex;
uniform sampler2D u_bloomTex;
uniform float u_bloomStrength;
uniform float u_damageFlash;
uniform float u_parryFlash;
uniform vec3 u_gradeTint;
uniform float u_curseIntensity;
uniform float u_lowHpPulse;
uniform float u_zoom;
uniform float u_chromaSplit;
uniform float u_time;

out vec4 o_color;

void main() {
  // Clean center-weighted pixel-preserving zoom (default 1.0 when u_zoom <= 0.01)
  float effZoom = (u_zoom <= 0.01) ? 1.0 : clamp(u_zoom, 0.5, 2.5);
  vec2 sampleUv = clamp((v_uv - 0.5) / effZoom + 0.5, vec2(0.0005), vec2(0.9995));

  // Sample 480x270 lit world with gl.NEAREST — plus optional RGB chromatic split on parry impact!
  vec3 scene;
  if (u_chromaSplit > 0.0001) {
    float split = clamp(u_chromaSplit, 0.0, 0.015);
    float edgeBoost = 0.65 + 0.70 * length(v_uv - 0.5);
    float dx = split * edgeBoost;
    float rCh = texture(u_sceneTex, clamp(sampleUv + vec2(dx, 0.0), vec2(0.0005), vec2(0.9995))).r;
    float gCh = texture(u_sceneTex, sampleUv).g;
    float bCh = texture(u_sceneTex, clamp(sampleUv - vec2(dx, 0.0), vec2(0.0005), vec2(0.9995))).b;
    scene = vec3(rCh, gCh, bCh);
  } else {
    scene = texture(u_sceneTex, sampleUv).rgb;
  }

  // Sample silky half-res blurred bloom additively
  vec3 bloom = texture(u_bloomTex, sampleUv).rgb;
  vec3 hdr = scene + bloom * (u_bloomStrength * 0.72);

  // ACES Filmic tone-mapping curve: velvety dark gothic shadows + saturated glowing highlights!
  vec3 col = (hdr * (2.51 * hdr + 0.03)) / (hdr * (2.43 * hdr + 0.59) + 0.14);
  col = mix(col, col * u_gradeTint, 0.14);

  // Crisp subtle corner vignette for theatrical Dead Cells framing
  vec2 centered = v_uv * 2.0 - 1.0;
  float r2 = dot(centered * vec2(0.88, 1.0), centered * vec2(0.88, 1.0));
  float vig = 1.0 - smoothstep(0.58, 1.55, r2) * 0.34;
  col *= vig;

  // Pulsing organic creeping crimson Curse border vignette
  if (u_curseIntensity > 0.01) {
    float ci = clamp(u_curseIntensity, 0.0, 1.5);
    float pulse = 0.68 + 0.32 * sin(u_time * 4.2);
    float ang = atan(centered.y, centered.x);
    float creep = sin(ang * 7.0 + u_time * 1.4) * 0.09
                + sin(ang * 13.0 - u_time * 2.1) * 0.05
                + sin(centered.x * 9.0 + centered.y * 7.0 + u_time * 1.7) * 0.04;
    float curseEdge = smoothstep(0.42, 1.25, r2 + creep);
    float innerRim = smoothstep(0.56, 1.18, r2 + creep * 1.35);
    vec3 dreadDark = vec3(0.24, 0.02, 0.12);
    vec3 crimsonGlow = vec3(0.88, 0.06, 0.18);
    vec3 curseCol = mix(crimsonGlow, dreadDark, smoothstep(0.75, 1.35, r2));
    col = mix(col, col * 0.52 + curseCol * 0.68, clamp(curseEdge * ci * pulse * 0.72, 0.0, 0.85));
    col += crimsonGlow * (innerRim * ci * pulse * 0.22);
  }

  // Subtle dark-red low-HP heartbeat vignette
  if (u_lowHpPulse > 0.01) {
    float lp = clamp(u_lowHpPulse, 0.0, 1.0);
    float beatPhase = fract(u_time * 1.15);
    float dB1 = (beatPhase - 0.15) * 11.0;
    float dB2 = (beatPhase - 0.34) * 13.0;
    float beat = exp(-(dB1 * dB1)) + 0.65 * exp(-(dB2 * dB2));
    float hb = 0.42 + 0.58 * beat;
    float hpEdge = smoothstep(0.48, 1.32, r2);
    vec3 lowHpCol = vec3(0.62, 0.04, 0.08);
    col = mix(col, lowHpCol, clamp(hpEdge * lp * hb * 0.48, 0.0, 0.62));
  }

  // Crimson damage edge pulse
  if (u_damageFlash > 0.005) {
    float edge = smoothstep(0.25, 1.15, r2);
    col = mix(col, vec3(0.95, 0.12, 0.16), u_damageFlash * (0.20 + edge * 0.52));
  }

  // Radiant golden parry flash ring!
  if (u_parryFlash > 0.005) {
    float ringD = (sqrt(max(0.0, r2)) - (1.05 - u_parryFlash * 0.65)) * 4.5;
    float ring = exp(-(ringD * ringD));
    col += vec3(1.0, 0.88, 0.42) * (u_parryFlash * 0.32 + ring * u_parryFlash * 0.72);
  }

  o_color = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

// =============================================================================
// Shader Compilation & Linking Utility
// =============================================================================

export function compileProgram(
  gl: WebGL2RenderingContext,
  vertSource: string,
  fragSource: string,
  label: string
): WebGLProgram {
  const vs = gl.createShader(gl.VERTEX_SHADER);
  const fs = gl.createShader(gl.FRAGMENT_SHADER);
  if (!vs || !fs) {
    throw new Error(`WebGL2 failed to allocate shader objects for ${label}`);
  }

  gl.shaderSource(vs, vertSource);
  gl.compileShader(vs);
  if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(vs) ?? 'unknown vertex error';
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    throw new Error(`[${label}] Vertex shader compile error: ${log}`);
  }

  gl.shaderSource(fs, fragSource);
  gl.compileShader(fs);
  if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(fs) ?? 'unknown fragment error';
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    throw new Error(`[${label}] Fragment shader compile error: ${log}`);
  }

  const prog = gl.createProgram();
  if (!prog) {
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    throw new Error(`WebGL2 failed to create program for ${label}`);
  }

  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);

  gl.deleteShader(vs);
  gl.deleteShader(fs);

  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog) ?? 'unknown link error';
    gl.deleteProgram(prog);
    throw new Error(`[${label}] Program link error: ${log}`);
  }

  return prog;
}
