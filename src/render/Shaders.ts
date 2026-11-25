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
uniform float u_hasFarTex;
uniform sampler2D u_scrollerFarTex;
uniform float u_hasMidTex;
uniform sampler2D u_scrollerMidTex;

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
  float hole = step(radius * 0.32, r);
  float innerRing = step(radius * 0.58, r) + step(r, radius * 0.44);
  float spokes = step(0.18, abs(sin(a * 3.0)));
  float body = outer * hole * clamp(innerRing + (1.0 - spokes), 0.0, 1.0);
  return body;
}

// Pixel-crisp Dead Cells Custom Pack scroller sampler (handles 128x128 seamless
// tiles, 256x128 wide arch banners, and 512x512 landscape panoramas cleanly!)
vec4 sampleScrollerLayer(
  sampler2D tex,
  vec2 px,
  float sy,
  float speedX,
  float speedY,
  bool isMid
) {
  vec2 sz = max(vec2(1.0), vec2(textureSize(tex, 0)));
  float py = u_resolution.y - 1.0 - px.y;
  float u;
  float v;
  if (sz.y <= 160.0 && abs(sz.x - sz.y) < 4.0) {
    // 128x128 seamless 2D dungeon wallpaper (e.g. prisonStartScrollerA.png)
    u = fract((px.x + u_camera.x * speedX) / sz.x);
    v = fract((py + u_camera.y * speedY) / sz.y);
  } else if (sz.y <= 200.0) {
    // 256x128 repeating gothic arch panoramas (archeSmallBg_0 / archeSmallFg_0)
    float scale = isMid ? 1.72 : (u_resolution.y / sz.y);
    float tileW = max(64.0, sz.x * scale);
    float tileH = sz.y * scale;
    u = fract((px.x + u_camera.x * speedX) / tileW);
    if (isMid) {
      float topOff = u_resolution.y - tileH;
      if (py < topOff) return vec4(0.0);
      v = clamp((py - topOff) / tileH, 0.002, 0.998);
    } else {
      v = clamp(sy, 0.002, 0.998);
    }
  } else {
    // Tall 512x512 cliff / castle / skylight panoramas (scrollerBg_0 / scrollerLayer1_0)
    u = fract((px.x + u_camera.x * speedX) / max(128.0, sz.x));
    float span = min(sz.y, u_resolution.y * (isMid ? 1.35 : 1.55));
    float yBase = (sz.y - span) * (isMid ? 0.60 : 0.46) + u_camera.y * speedY * 0.12;
    v = clamp((yBase + sy * span) / sz.y, 0.002, 0.998);
  }
  return texture(tex, vec2(u, v));
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

  // Owned Custom Pack Multi-Layer Dead Cells Parallax Scrollers (UNMISTAKABLE 0.88-0.94 blend!)
  if (u_hasFarTex > 0.5) {
    // Subtle sky moon glow behind transparent outdoor scroller sky edges
    vec2 moonPos = vec2(0.76 - fract(u_camera.x * 0.000025) * 0.08, 0.20);
    vec2 mDelta = (vec2(uv.x, sy) - moonPos) * vec2(u_resolution.x / u_resolution.y, 1.0);
    float mDist = length(mDelta);
    vec3 moonTint = mix(u_accentColor, vec3(1.0, 0.96, 0.88), 0.65);
    col += moonTint * (exp(-mDist * 3.4) * 0.36);

    vec3 atmosTint = mix(
      vec3(1.0),
      mix(u_skyMid * 1.45 + vec3(0.20), u_accentColor * 0.45 + vec3(0.68), 0.35),
      0.22
    );

    vec4 farTex = sampleScrollerLayer(u_scrollerFarTex, px, sy, 0.07, 0.035, false);
    col = mix(col, farTex.rgb * atmosTint, clamp(farTex.a * 0.92, 0.0, 0.94));

    if (u_hasMidTex > 0.5) {
      vec4 midTex = sampleScrollerLayer(u_scrollerMidTex, px, sy, 0.17, 0.06, true);
      vec3 midTint = mix(vec3(1.0), atmosTint, 0.72);
      col = mix(col, midTex.rgb * midTint, clamp(midTex.a * 0.90, 0.0, 0.92));
    }

    // Subtle atmospheric horizon depth mist so foreground gameplay silhouettes pop cleanly
    float horizonMist = smoothstep(0.58, 1.0, sy);
    col = mix(col, u_fogColor * 0.82, horizonMist * 0.28);

    o_color = vec4(col, 1.0);
    return;
  }

  // Crisp subtle 1px twinkling stars in high sky (NEVER chunky 2px snow blocks!)
  float starCell = hash21(floor(vec2(px.x + floor(u_camera.x * 0.02), px.y)));
  float starTwinkle = 0.55 + 0.45 * sin(u_time * 2.6 + starCell * 42.0);
  if (starCell > 0.9965 && sy < 0.46) {
    col += mix(u_accentColor, vec3(0.92, 0.96, 1.0), 0.75) * starTwinkle * (1.0 - sy * 1.9) * 0.55;
  }

  // Celestial full moon with sculpted craters & lush atmospheric halo
  vec2 moonPos = vec2(0.76 - fract(u_camera.x * 0.000025) * 0.08, 0.21);
  vec2 mDelta = (vec2(uv.x, sy) - moonPos) * vec2(u_resolution.x / u_resolution.y, 1.0);
  float mDist = length(mDelta);
  float moonDisc = 1.0 - smoothstep(0.082, 0.090, mDist);
  float moonCrater = fbm2(mDelta * 36.0 + vec2(3.1, 1.7));
  float moonHalo = exp(-mDist * 3.8) * 0.52 + exp(-mDist * 1.6) * 0.16;
  vec3 moonTint = mix(u_accentColor, vec3(1.0, 0.96, 0.88), 0.65);
  col += moonTint * moonHalo;
  if (moonDisc > 0.01) {
    vec3 discCol = moonTint * (0.85 + moonCrater * 0.32);
    col = mix(col, discCol, moonDisc * 0.92);
  }

  // Drifting pixel-crisp nocturnal storm clouds (Layer 0)
  vec2 cloudCoord = vec2(uv.x * 4.8 + u_camera.x * 0.00018 + u_time * 0.014, sy * 3.4);
  float cl = fbm2(cloudCoord);
  float cloudBand = smoothstep(0.42, 0.72, cl) * (1.0 - smoothstep(0.40, 0.86, sy));
  vec3 cloudCol = mix(u_skyMid * 1.15, moonTint * 0.72, exp(-mDist * 2.5) * 0.55);
  col = mix(col, cloudCol, cloudBand * 0.44);

  // Diagonal volumetric moonbeam / cathedral skylight god-rays!
  float rayCoord = uv.x * 9.5 + sy * 4.2 + u_camera.x * 0.00045;
  float rayWave = pow(max(0.0, sin(rayCoord) * 0.5 + 0.5), 3.2) * pow(max(0.0, sin(rayCoord * 0.41 + 1.4) * 0.5 + 0.5), 1.8);
  float rayFade = (1.0 - sy * 0.68) * smoothstep(0.0, 0.18, sy);
  col += mix(u_accentColor, vec3(0.85, 0.94, 1.0), 0.45) * (rayWave * rayFade * 0.32);

  // Layer 1 (Far Mountain Ridges & Gothic Castle Silhouettes — 0.06x parallax)
  float xFar = uv.x * 480.0 + u_camera.x * 0.06;
  float ridgeNoise = fbm2(vec2(xFar * 0.008 + float(u_themeId) * 3.1, 1.5));
  float farRidge = 0.56 + (ridgeNoise - 0.5) * 0.22;
  if (sy > farRidge) {
    vec3 ridgeCol = mix(u_skyMid * 0.55, u_fogColor * 0.85, 0.55);
    col = mix(col, ridgeCol, 0.85);
  }

  float farCell = floor(xFar / 52.0);
  float farLocal = fract(xFar / 52.0);
  float towerSeed = hash11(farCell * 7.13 + float(u_themeId) * 1.9);
  float farH = 0.48 + towerSeed * 0.22;

  if (u_themeId == 6) {
    // Clock Tower / Clock Room: colossal interlocking rotating bronze/iron clockwork gears!
    vec2 gp = vec2(mod(xFar * 1.4, 170.0), sy * 270.0);
    float g1 = gearMask(gp, vec2(48.0, 118.0), 54.0, 14.0, 0.22);
    float g2 = gearMask(gp, vec2(124.0, 162.0), 40.0, 12.0, -0.32);
    float g3 = gearMask(gp, vec2(138.0, 74.0), 30.0, 10.0, 0.44);
    float gm = clamp(g1 + g2 + g3, 0.0, 1.0);
    if (gm > 0.5) {
      vec3 gearCol = mix(u_celShadow * 0.35, u_accentColor * 0.55, 0.38);
      col = mix(col, gearCol, 0.88);
    }
  } else {
    // Gothic citadel keeps, needle spires (pointing UP!) & warm lit castle windows
    float inKeep = step(0.18, farLocal) * step(farLocal, 0.82);
    float spireDist = abs(farLocal - 0.5);
    float spireT = clamp((sy - (farH - 0.16)) / 0.16, 0.0, 1.0); // 0 at sharp tip, 1 at base!
    float inSpire = step(spireDist, spireT * 0.22) * step(farH - 0.16, sy) * step(sy, farH) * step(0.42, towerSeed);
    float merlon = step(0.5, fract(xFar / 6.0)) * 0.018 * inKeep;
    if ((sy > farH - merlon && inKeep > 0.5) || inSpire > 0.5) {
      vec3 silCol = mix(u_celShadow * 0.36, u_fogColor * 0.72, 0.52);
      // Warm glowing castle slit windows
      float wx = fract(xFar / 9.0);
      float wy = fract(sy * 32.0);
      float win = step(0.38, wx) * step(wx, 0.62) * step(0.28, wy) * step(wy, 0.72)
        * step(0.84, hash21(vec2(floor(xFar / 9.0), floor(sy * 32.0))))
        * step(farH + 0.03, sy);
      col = mix(silCol, u_accentColor * 1.15, win * 0.85);
    }
  }

  // Layer 2 (Midground Dark Ruined Viaduct Arches / Rooftops rising from horizon — 0.16x parallax)
  float xMid = uv.x * 480.0 + u_camera.x * 0.16;
  float bayPeriod = (u_themeId == 2) ? 68.0 : 84.0;
  float mLocal = mod(xMid, bayPeriod);
  float mIdx = floor(xMid / bayPeriod);
  float baySeed = hash11(mIdx * 5.71 + float(u_themeId));
  // Grounded horizon viaduct deck with semicircular open archways underneath (NO inverted white hills!)
  float horizonDeck = 0.68 + (baySeed - 0.5) * 0.06;
  float archNormX = (mLocal - bayPeriod * 0.5) / (bayPeriod * 0.34);
  float archCurve = horizonDeck + 0.08 + (1.0 - sqrt(max(0.0, 1.0 - archNormX * archNormX))) * 0.14;
  float inArchOpening = step(abs(archNormX), 0.98) * step(archCurve, sy);
  float inViaduct = step(horizonDeck, sy) * (1.0 - inArchOpening);

  if (inViaduct > 0.5) {
    vec3 midCol = mix(u_celShadow * 0.28, u_fogColor * 0.55, 0.45);
    // Subtle moonlit top stone bevel along viaduct parapet
    float topRim = step(sy, horizonDeck + 0.012);
    midCol += mix(u_accentColor, vec3(0.8, 0.9, 1.0), 0.5) * topRim * 0.14;
    col = mix(col, midCol, 0.92);
  }

  // Biome-specific ambient midground details
  if (u_themeId == 2) {
    // Sewer ribbed horizontal aqueduct conduit across upper background
    if (sy > 0.18 && sy < 0.25) {
      float rib = step(0.84, fract(xMid / 18.0));
      col = mix(u_celShadow * 0.34, u_accentColor * 0.30, rib * 0.45);
    }
  } else if (u_themeId == 4) {
    // Black Bridge distant lightning flash through storm clouds
    float bolt = smoothstep(0.965, 1.0, sin(u_time * 1.7 + 0.4) * sin(u_time * 5.3));
    col += vec3(0.45, 0.72, 1.0) * bolt * (1.0 - sy) * 0.32;
  } else if (u_themeId == 0 || u_themeId == 9) {
    // Prison / Passage faint iron window bars & distant flickering sconce ember
    float bar = step(0.88, fract(mLocal / 11.0)) * step(0.32, sy) * step(sy, 0.72);
    col = mix(col, u_celShadow * 0.20, bar * 0.42);
    vec2 torchP = vec2((mLocal - bayPeriod * 0.5) / 22.0, (sy - 0.58) * 5.5);
    float td = length(torchP);
    float flick = 0.85 + 0.15 * sin(u_time * 9.0 + mIdx * 4.3);
    col += u_accentColor * exp(-td * 2.6) * 0.24 * flick;
  }

  // Layer 3 (Atmospheric Depth Horizon Haze — keeps foreground silhouettes razor readable!)
  float horizonMist = smoothstep(0.52, 1.0, sy);
  col = mix(col, u_fogColor * 0.85, horizonMist * 0.52);

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
  vec3 baseLight = mix(u_celShadowColor * 0.42, u_ambientColor * 0.48, skyCel);
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

    // 3-band stylized Dead Cells cel ramp with bevel grazing rim!
    float cel = 0.16
      + 0.40 * smoothstep(0.10, 0.24, ndl)
      + 0.44 * smoothstep(0.46, 0.62, ndl);
    float grazing = pow(clamp(1.0 - max(N.z, 0.0), 0.0, 1.0), 1.8) * smoothstep(0.14, 0.48, ndl) * 0.30;

    pointAccum += lc.rgb * (lc.a * atten * (cel + grazing));
  }

  // Soft-knee shoulder compression on overlapping lights so pillars & hero NEVER blow out white!
  pointAccum = pointAccum / (1.0 + pointAccum * 0.42);

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

  // Concentrated near ground floor + wispy mid-air tendrils
  float lowBand = smoothstep(0.56, 1.0, sy);
  float wisp = smoothstep(0.42, 0.85, smoke);
  float alpha = (lowBand * 0.34 + wisp * 0.12) * wisp * u_fogDensity;

  vec3 fogTint = mix(u_fogColor * 1.15, u_accentColor * 0.55, wisp * 0.22);
  o_lit = vec4(fogTint, clamp(alpha, 0.0, 0.42));
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

out vec4 o_color;

void main() {
  // Sample 480x270 lit world with gl.NEAREST — razor-sharp pixel art!
  vec3 scene = texture(u_sceneTex, v_uv).rgb;

  // Sample silky half-res blurred bloom additively
  vec3 bloom = texture(u_bloomTex, v_uv).rgb;
  vec3 hdr = scene + bloom * (u_bloomStrength * 0.72);

  // ACES Filmic tone-mapping curve: velvety dark gothic shadows + saturated glowing highlights!
  vec3 col = (hdr * (2.51 * hdr + 0.03)) / (hdr * (2.43 * hdr + 0.59) + 0.14);
  col = mix(col, col * u_gradeTint, 0.14);

  // Crisp subtle corner vignette for theatrical Dead Cells framing
  vec2 centered = v_uv * 2.0 - 1.0;
  float r2 = dot(centered * vec2(0.88, 1.0), centered * vec2(0.88, 1.0));
  float vig = 1.0 - smoothstep(0.58, 1.55, r2) * 0.34;
  col *= vig;

  // Crimson damage edge pulse
  if (u_damageFlash > 0.005) {
    float edge = smoothstep(0.25, 1.15, r2);
    col = mix(col, vec3(0.95, 0.12, 0.16), u_damageFlash * (0.20 + edge * 0.52));
  }

  // Radiant golden parry flash ring!
  if (u_parryFlash > 0.005) {
    float ring = exp(-pow((sqrt(r2) - (1.05 - u_parryFlash * 0.65)) * 4.5, 2.0));
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
