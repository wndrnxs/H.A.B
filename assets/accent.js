// 앱의 강조색. 버튼·선택 상태·진행 막대가 모두 이 색을 쓴다.
//
// 라이트와 다크에서 쓰는 값이 다르다. 밝은 바탕에는 어두운 색을, 어두운 바탕에는
// 밝은 색을 쓴다. 한쪽만 바꾸면 다른 쪽에서 글씨가 묻힌다.
//   base : 바탕이 밝을 때 쓰는 강조색
//   ink  : 그 색 위에 얹는 글씨색
//   soft : 선택된 칩이나 메뉴에 깔리는 옅은 바탕
export const ACCENTS = {
  green: {
    name: '파인그린',
    light: { base: '#1f5c4a', ink: '#ffffff', soft: '#e0ebe4' },
    dark: { base: '#57bd97', ink: '#0c1a14', soft: '#1d382e' },
  },
  navy: {
    name: '네이비',
    light: { base: '#1f4b8c', ink: '#ffffff', soft: '#e1e8f4' },
    dark: { base: '#79aef2', ink: '#0b1830', soft: '#1a2c4a' },
  },
  plum: {
    name: '자두',
    light: { base: '#7c2f57', ink: '#ffffff', soft: '#f2e2ea' },
    dark: { base: '#e088b2', ink: '#2a0d1c', soft: '#3d1a2b' },
  },
  brick: {
    name: '벽돌',
    light: { base: '#a23f2b', ink: '#ffffff', soft: '#f6e3de' },
    dark: { base: '#ef9077', ink: '#2c0f08', soft: '#45211a' },
  },
  mustard: {
    name: '머스터드',
    light: { base: '#8a6512', ink: '#ffffff', soft: '#f5ecd8' },
    dark: { base: '#dfae45', ink: '#241a03', soft: '#3c2f10' },
  },
  slate: {
    name: '먹색',
    light: { base: '#333f46', ink: '#ffffff', soft: '#e4e8ea' },
    dark: { base: '#a8bdc7', ink: '#11191e', soft: '#28333a' },
  },
};

export const DEFAULT_ACCENT = 'green';
const LS_KEY = 'hab.accent';

function block(selector, v) {
  return `${selector}{--accent:${v.base};--accent-ink:${v.ink};--accent-soft:${v.soft};}`;
}

/**
 * 고른 색을 <style> 한 장으로 밀어 넣는다.
 * :root 에 인라인으로 박으면 다크 모드 규칙을 이겨 버려서 한 가지 색만 남는다.
 * 원래 토큰과 같은 세 갈래(기본 · 기기 설정 · 직접 고른 다크)로 적어야 셋 다 맞는다.
 */
export function applyAccent(key) {
  const a = ACCENTS[key] || ACCENTS[DEFAULT_ACCENT];
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
  try { localStorage.setItem(LS_KEY, key); } catch { /* 저장 못 해도 이번 화면에는 적용된다 */ }
}

/** 장부를 불러오기 전에도 색이 맞도록 마지막으로 쓴 값을 기억해 둔다 */
export function rememberedAccent() {
  try { return localStorage.getItem(LS_KEY) || DEFAULT_ACCENT; } catch { return DEFAULT_ACCENT; }
}
