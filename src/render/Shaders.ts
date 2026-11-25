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
uniform float u_hasScrollerTex;
uniform sampler2D u_scrollerTex;

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

void main() {
  // Snap to crisp logical 480x270 pixel grid (Y-down screen uv: sy=0 top, sy=1 bottom)
  vec2 px = floor(v_uv * u_resolution);
  vec2 uv = (px + 0.5) / u_resolution;
  float sy = 1.0 - uv.y;

  // 3-stop atmospheric sky gradient
  vec3 col = sy < 0.52
    ? mix(u_skyTop, u_skyMid, smoothstep(0.0, 0.52, sy))
    : mix(u_skyMid, u_skyBottom, smoothstep(0.52, 1.0, sy));

  // Optional Owned Custom Pack scroller texture blend
  if (u_hasScrollerTex > 0.5) {
    vec2 scUv = vec2(uv.x + u_camera.x * 0.00025, 1.0 - uv.y);
    vec4 scTex = texture(u_scrollerTex, scUv);
    col = mix(col, scTex.rgb * mix(u_skyMid, vec3(1.0), 0.45), scTex.a * 0.62);
  }

  // Celestial moon / eclipse / skylight glow
  vec2 moonPos = vec2(0.76 - fract(u_camera.x * 0.00003) * 0.08, 0.22);
  vec2 mDelta = (vec2(uv.x, sy) - moonPos) * vec2(u_resolution.x / u_resolution.y, 1.0);
  float mDist = length(mDelta);
  float moonDisc = 1.0 - smoothstep(0.068, 0.075, mDist);
  float moonHalo = exp(-mDist * 4.8) * 0.42;
  col += mix(u_accentColor, vec3(1.0, 0.96, 0.88), 0.55) * (moonHalo + moonDisc * 0.65);

  // Drifting pixel-crisp nocturnal clouds (Layer 0)
  vec2 cloudCoord = vec2(uv.x * 5.5 + u_camera.x * 0.00018 + u_time * 0.015, sy * 3.8);
  float cl = fbm2(cloudCoord);
  float cloudBand = smoothstep(0.46, 0.72, cl) * (1.0 - smoothstep(0.42, 0.82, sy));
  col = mix(col, mix(u_skyMid * 1.25, u_accentColor, 0.2), cloudBand * 0.36);

  // Diagonal atmospheric moonbeam / skylight god-rays
  float rayCoord = uv.x * 11.0 + sy * 4.5 + u_camera.x * 0.0005;
  float rayWave = pow(max(0.0, sin(rayCoord) * 0.5 + 0.5), 4.0) * pow(max(0.0, sin(rayCoord * 0.37 + 1.4) * 0.5 + 0.5), 2.0);
  float rayFade = (1.0 - sy * 0.75) * smoothstep(0.0, 0.25, sy);
  col += mix(u_accentColor, u_skyTop * 1.4, 0.5) * (rayWave * rayFade * 0.22);

  // Layer 1 (Far Architectural Silhouettes — 0.08x parallax)
  float xFar = uv.x * 480.0 + u_camera.x * 0.08;
  float farCell = floor(xFar / 44.0);
  float farLocal = fract(xFar / 44.0);
  float farH = 0.44 + hash11(farCell * 3.17 + float(u_themeId)) * 0.24;

  // Theme-tailored far silhouette profiles
  if (u_themeId == 1 || u_themeId == 3 || u_themeId == 7) {
    // Gothic spires & battlements (Promenade / Ramparts / Castle)
    float spire = step(abs(farLocal - 0.5), (1.0 - clamp((sy - (farH - 0.14)) / 0.16, 0.0, 1.0)) * 0.26);
    if (sy > farH || (sy > farH - 0.14 && spire > 0.5 && hash11(farCell + 9.0) > 0.35)) {
      vec3 silCol = mix(u_celShadow * 0.55, u_fogColor * 0.85, 0.55);
      // Warm distant castle windows
      float wx = fract(xFar / 11.0);
      float wy = fract(sy * 30.0);
      float win = step(0.32, wx) * step(wx, 0.68) * step(0.25, wy) * step(wy, 0.72) * step(0.84, hash21(vec2(floor(xFar / 11.0), floor(sy * 30.0))));
      col = mix(silCol, u_accentColor * 1.25, win * 0.85);
    }
  } else if (u_themeId == 6) {
    // Clock Tower / Clock Room giant interlocking rotating gears!
    vec2 gp = vec2(mod(xFar, 180.0), sy * 270.0);
    float g1 = gearMask(gp, vec2(52.0, 125.0), 46.0, 12.0, 0.25);
    float g2 = gearMask(gp, vec2(126.0, 170.0), 34.0, 10.0, -0.34);
    float g3 = gearMask(gp, vec2(150.0, 82.0), 26.0, 8.0, 0.42);
    float gm = clamp(g1 + g2 + g3, 0.0, 1.0);
    if (gm > 0.5) {
      col = mix(u_celShadow * 0.5, u_accentColor * 0.45, 0.35);
    }
  } else {
    // Dungeon vaults / Sewer conduits / Bridge keep / Stilt cliffs / Throne monoliths
    float battlement = step(0.5, fract(xFar / 14.0)) * 0.03;
    if (sy > farH - battlement) {
      col = mix(u_celShadow * 0.48, u_fogColor * 0.85, 0.5);
    }
  }

  // Layer 2 (Midground Gothic Arches / Pillars / Pipes — 0.20x parallax)
  float xMid = uv.x * 480.0 + u_camera.x * 0.20;
  float pillarPeriod = (u_themeId == 2) ? 72.0 : 88.0;
  float mLocal = mod(xMid, pillarPeriod);
  float mIdx = floor(xMid / pillarPeriod);
  float isPillar = step(mLocal, 14.0) + step(pillarPeriod - 14.0, mLocal);
  float archDx = (mLocal - pillarPeriod * 0.5) / (pillarPeriod * 0.36);
  float archTop = 0.26 + archDx * archDx * 0.22;
  float isArch = step(sy, archTop);

  if (isPillar > 0.5 || isArch > 0.5) {
    vec3 midCol = mix(u_celShadow * 0.36, u_fogColor * 0.65, 0.45);
    // Rim catch from moon/accent on pillar edges
    float edgeHighlight = step(12.0, mLocal) * step(mLocal, 14.5);
    midCol += u_accentColor * edgeHighlight * 0.16;
    col = mix(col, midCol, 0.88);
  } else if (u_themeId == 0 || u_themeId == 9) {
    // Prison / Passage faint iron bars & warm distant torch pinpoint in arches
    float bar = step(0.86, fract(mLocal / 10.0)) * step(0.28, sy) * step(sy, 0.72);
    col = mix(col, u_celShadow * 0.25, bar * 0.55);
    vec2 torchP = vec2((mLocal - pillarPeriod * 0.5) / 20.0, (sy - 0.54) * 5.0);
    float td = length(torchP);
    float flick = 0.85 + 0.15 * sin(u_time * 9.0 + mIdx * 4.3);
    col += u_accentColor * exp(-td * 2.4) * 0.32 * flick;
  } else if (u_themeId == 2) {
    // Sewer horizontal ribbed aqueduct pipe across upper midground
    if (sy > 0.16 && sy < 0.25) {
      float rib = step(0.82, fract(xMid / 18.0));
      col = mix(u_celShadow * 0.4, u_accentColor * 0.32, rib * 0.45);
    }
  } else if (u_themeId == 4) {
    // Black Bridge distant lightning shimmer
    float bolt = smoothstep(0.96, 1.0, sin(u_time * 1.7 + 0.4) * sin(u_time * 5.3));
    col += vec3(0.45, 0.72, 1.0) * bolt * (1.0 - sy) * 0.28;
  }

  // Layer 3 (Atmospheric Depth Horizon Haze — keeps foreground silhouettes razor readable!)
  float horizonMist = smoothstep(0.45, 1.0, sy);
  col = mix(col, u_fogColor * 0.92, horizonMist * 0.58);

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

  // Deep biome celShadow in crevices transitioning to ambient sky light on upward bevels
  vec3 baseLight = mix(u_celShadowColor * 0.62, u_ambientColor * 0.64, skyCel);
  // Crisp silhouette edge rim highlight
  float topRim = pow(max(0.0, -N.y), 2.0) * 0.24;
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
    float cel = 0.20
      + 0.38 * smoothstep(0.10, 0.24, ndl)
      + 0.42 * smoothstep(0.46, 0.62, ndl);
    float grazing = pow(clamp(1.0 - max(N.z, 0.0), 0.0, 1.0), 1.8) * smoothstep(0.12, 0.45, ndl) * 0.36;

    pointAccum += lc.rgb * (lc.a * atten * (cel + grazing));
  }

  vec3 totalLight = baseLight + pointAccum;
  if (isBgWall) {
    // Recessed background masonry sits deeper in shadow + tinted by biome fog for instant depth!
    totalLight *= 0.62;
  }

  vec3 lit = gAlbedo.rgb * totalLight;
  if (isBgWall) {
    lit = mix(lit, u_fogColor * 0.72, 0.24);
  }

  // Unshaded self-illuminated emissive pixels (homunculus head, braziers, runes, glowing eyes, acid)
  vec3 emBoost = gEmissive.rgb * 1.45;
  vec3 finalCol = lit + emBoost;

  // Bright-pass bloom contribution: strong emissives + intensely torch-lit bevel highlights
  float litLum = dot(lit, vec3(0.299, 0.587, 0.114));
  vec3 specBloom = lit * smoothstep(0.88, 1.35, litLum) * 0.45;
  vec3 bloomCol = gEmissive.rgb * 1.15 + specBloom;

  o_lit = vec4(finalCol, 1.0);
  o_bloom = vec4(clamp(bloomCol, 0.0, 1.5), 1.0);
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
  vec3 col = scene + bloom * u_bloomStrength;

  // Subtle gothic filmic shoulder rolloff so overlapping torchlights stay rich, not clipped
  col = col / (1.0 + col * 0.16);
  col = mix(col, col * u_gradeTint, 0.12);

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
