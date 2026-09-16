// 공용 유틸리티 — 날짜 계산, 금액 표기, DOM 헬퍼
// 모든 날짜는 'YYYY-MM-DD' 문자열(로컬 기준)로 다룬다. UTC 변환을 거치지 않아
// 자정 근처에서 날짜가 밀리는 문제가 없다.

export const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

export function pad(n) {
  return String(n).padStart(2, '0');
}

export function toYMD(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function fromYMD(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function today() {
  return toYMD(new Date());
}

export function addDays(ymd, n) {
  const d = fromYMD(ymd);
  d.setDate(d.getDate() + n);
  return toYMD(d);
}

export function addMonths(ymd, n) {
  const d = fromYMD(ymd);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  // 31일 → 2월처럼 날짜가 넘칠 때는 해당 달의 마지막 날로 맞춘다
  d.setDate(Math.min(day, daysInMonth(d.getFullYear(), d.getMonth() + 1)));
  return toYMD(d);
}

export function daysInMonth(year, month1) {
  return new Date(year, month1, 0).getDate();
}

/** 월요일 시작 주 (한국 달력 관행) */
export function startOfWeek(ymd) {
  const d = fromYMD(ymd);
  const shift = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - shift);
  return toYMD(d);
}

export function startOfMonth(ymd) {
  return ymd.slice(0, 8) + '01';
}

export function endOfMonth(ymd) {
  const d = fromYMD(ymd);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(daysInMonth(d.getFullYear(), d.getMonth() + 1))}`;
}

export function monthKey(ymd) {
  return ymd.slice(0, 7);
}

export function eachDay(from, to) {
  const out = [];
  let cur = from;
  while (cur <= to) {
    out.push(cur);
    cur = addDays(cur, 1);
  }
  return out;
}

/**
 * 조회 기간 한 덩어리. grain 은 'day' | 'week' | 'month'.
 * anchor 안의 어느 날짜든 그 날이 속한 일/주/월 전체로 확장된다.
 */
export function periodRange(grain, anchor) {
  if (grain === 'day') {
    return { from: anchor, to: anchor };
  }
  if (grain === 'week') {
    const from = startOfWeek(anchor);
    return { from, to: addDays(from, 6) };
  }
  return { from: startOfMonth(anchor), to: endOfMonth(anchor) };
}

export function shiftPeriod(grain, anchor, dir) {
  if (grain === 'day') return addDays(anchor, dir);
  if (grain === 'week') return addDays(startOfWeek(anchor), dir * 7);
  return addMonths(startOfMonth(anchor), dir);
}

export function periodLabel(grain, anchor) {
  const { from, to } = periodRange(grain, anchor);
  const d = fromYMD(from);
  if (grain === 'day') {
    const t = fromYMD(anchor);
    return `${t.getMonth() + 1}월 ${t.getDate()}일 (${WEEKDAYS[t.getDay()]})`;
  }
  if (grain === 'week') {
    const e = fromYMD(to);
    return `${d.getMonth() + 1}.${d.getDate()} – ${e.getMonth() + 1}.${e.getDate()}`;
  }
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월`;
}

/** 직전 동일 길이 기간 — "지난달 대비" 비교용 */
export function previousRange(grain, anchor) {
  return periodRange(grain, shiftPeriod(grain, anchor, -1));
}

export function prettyDate(ymd) {
  const d = fromYMD(ymd);
  return `${d.getMonth() + 1}월 ${d.getDate()}일 ${WEEKDAYS[d.getDay()]}요일`;
}

export function shortDate(ymd) {
  const d = fromYMD(ymd);
  return `${d.getMonth() + 1}.${pad(d.getDate())}`;
}

// ---- 금액 ----

const nf = new Intl.NumberFormat('ko-KR');

export function won(n) {
  const v = Math.round(n || 0);
  return `${v < 0 ? '-' : ''}${nf.format(Math.abs(v))}원`;
}

export function wonPlain(n) {
  return nf.format(Math.round(n || 0));
}

/** 축약 표기 — 차트 축과 좁은 칸에서만 쓴다 */
export function wonShort(n) {
  const v = Math.round(n || 0);
  const a = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (a >= 100000000) return `${sign}${trim(a / 100000000)}억`;
  // 1,000만 이상은 소수점을 떼야 읽힌다 (3,082만 > 3081.7만)
  if (a >= 10000000) return `${sign}${nf.format(Math.round(a / 10000))}만`;
  if (a >= 10000) return `${sign}${trim(a / 10000)}만`;
  if (a === 0) return '0';
  return `${sign}${nf.format(a)}`;
}

function trim(x) {
  const r = Math.round(x * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

export function pct(part, whole) {
  if (!whole) return 0;
  return (part / whole) * 100;
}

// ---- DOM ----

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export function uid(prefix = 'x') {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function groupBy(items, keyFn) {
  const map = new Map();
  for (const it of items) {
    const k = keyFn(it);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(it);
  }
  return map;
}

export function sum(items, pick = (x) => x) {
  return items.reduce((a, b) => a + (pick(b) || 0), 0);
}
