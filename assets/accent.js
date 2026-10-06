// 앱의 강조색. 버튼·선택 상태·진행 막대가 모두 이 색을 쓴다.
//
// 사용자는 색상환에서 '색조(hue)' 와 '선명도(chroma)' 만 고르고, 밝기는 앱이 정한다.
// 밝기까지 자유롭게 두면 흰 글씨가 묻히거나 다크 모드에서 색이 사라진다.
// 라이트에는 어두운 색, 다크에는 밝은 색을 같은 색조로 만들어 둘 다 읽히게 한다.
//
// 색 계산은 OKLCH 로 한다. HSL 은 같은 밝기값이라도 노랑이 파랑보다 훨씬 밝게
// 보여서, 색조에 따라 대비가 들쭉날쭉해진다. OKLCH 는 사람 눈에 보이는 밝기가
// 고르다.

/** OKLCH → sRGB 16진수. 화면 밖으로 나가는 색은 선명도를 낮춰 끌어들인다. */
export function oklchToHex(L, C, H) {
  for (let c = C; c >= 0; c -= 0.004) {
    const rgb = oklchToRgb(L, c, H);
    if (rgb) return `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  }
  return '#000000';
}

function oklchToRgb(L, C, H, allowClip = false) {
  const h = (H * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
  const out = [];
  for (const v of lin) {
    if (!allowClip && (v < -0.0005 || v > 1.0005)) return null;
    const x = Math.min(1, Math.max(0, v));
    const g = x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
    out.push(Math.round(g * 255));
  }
  return out;
}

/** 색상환을 그릴 때 쓰는, 범위를 벗어나도 잘라서 돌려주는 판 */
export function oklchToRgbClipped(L, C, H) {
  return oklchToRgb(L, C, H, true);
}

/**
 * 이 밝기·색조에서 화면이 낼 수 있는 가장 선명한 값.
 * 색상환을 그릴 때 이 값으로 잘라 두면, 화면에 보이는 색과 실제로 입혀지는 색이
 * 같아진다(안 그러면 바깥쪽 테두리가 실제보다 선명하게 보인다).
 */
export function maxChroma(L, H) {
  let lo = 0;
  let hi = 0.4;
  for (let i = 0; i < 16; i += 1) {
    const mid = (lo + hi) / 2;
    if (oklchToRgb(L, mid, H)) lo = mid; else hi = mid;
  }
  return lo;
}

export const MAX_CHROMA = 0.17;

// 빠르게 고르라고 둔 몇 가지. 색상환의 한 지점을 가리킬 뿐이다.
export const PRESETS = [
  { key: 'green', name: '파인그린', h: 162, c: 0.09 },
  { key: 'navy', name: '네이비', h: 258, c: 0.12 },
  { key: 'plum', name: '자두', h: 350, c: 0.12 },
  { key: 'brick', name: '벽돌', h: 32, c: 0.13 },
  { key: 'mustard', name: '머스터드', h: 86, c: 0.11 },
  { key: 'slate', name: '먹색', h: 240, c: 0.02 },
];

export const DEFAULT_ACCENT = { h: 162, c: 0.09 };
const LS_KEY = 'hab.accent.v2';

/**
 * 색조와 선명도 하나로 라이트·다크 두 벌을 만든다.
 * 밝기는 고정이다. 라이트는 흰 글씨가 읽히도록 어둡게, 다크는 어두운 바탕에서
 * 드러나도록 밝게.
 */
export function deriveAccent(h, c) {
  const cc = Math.max(0, Math.min(MAX_CHROMA, c));
  return {
    light: {
      base: oklchToHex(0.42, cc, h),
      ink: '#ffffff',
      soft: oklchToHex(0.945, Math.min(cc, 0.045), h),
    },
    dark: {
      base: oklchToHex(0.78, cc * 0.85, h),
      ink: oklchToHex(0.17, Math.min(cc, 0.05), h),
      soft: oklchToHex(0.27, Math.min(cc, 0.06), h),
    },
  };
}

function block(selector, v) {
  return `${selector}{--accent:${v.base};--accent-ink:${v.ink};--accent-soft:${v.soft};}`;
}

/**
 * 고른 색을 <style> 한 장으로 밀어 넣는다.
 * :root 에 인라인으로 박으면 다크 모드 규칙을 이겨 버려서 한 가지 색만 남는다.
 * 원래 토큰과 같은 세 갈래(기본 · 기기 설정 · 직접 고른 다크)로 적어야 셋 다 맞는다.
 */
export function applyAccent(accent) {
  const { h, c } = normalize(accent);
  const a = deriveAccent(h, c);
  let tag = document.getElementById('accent-theme');
  if (!tag) {
    tag = document.createElement('style');
    tag.id = 'accent-theme';
    document.head.append(tag);
  }
  tag.textContent = [
    block(':root', a.light),
    `@media (prefers-color-scheme: dark){${block(':root:not([data-theme="light"])', a.dark)}}`,
    block(':root[data-theme="dark"]', a.dark),
  ].join('');
  try { localStorage.setItem(LS_KEY, JSON.stringify({ h, c })); } catch { /* 저장 못 해도 이번 화면에는 적용된다 */ }
}

/** 옛 설정(색 이름)과 새 설정(색조·선명도)을 모두 받아 준다 */
export function normalize(accent) {
  if (accent && typeof accent === 'object' && Number.isFinite(accent.h)) {
    return { h: ((accent.h % 360) + 360) % 360, c: Math.max(0, Math.min(MAX_CHROMA, accent.c ?? DEFAULT_ACCENT.c)) };
  }
  const preset = PRESETS.find((p) => p.key === accent);
  return preset ? { h: preset.h, c: preset.c } : { ...DEFAULT_ACCENT };
}

/** 장부를 불러오기 전에도 색이 맞도록 마지막으로 쓴 값을 기억해 둔다 */
export function rememberedAccent() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return normalize(JSON.parse(raw));
  } catch { /* 무시 */ }
  return { ...DEFAULT_ACCENT };
}
