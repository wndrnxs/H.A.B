// 손으로 그린 SVG 차트. 외부 라이브러리 없이 테마 토큰(var(--...))을 그대로 쓰기 때문에
// 라이트/다크 전환이 자동으로 따라온다.

import { wonShort, won, debounce } from './util.js';

const NS = 'http://www.w3.org/2000/svg';

function s(tag, attrs = {}, children = []) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    node.setAttribute(k, String(v));
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

function label(x, y, text, opts = {}) {
  return s('text', {
    x, y,
    'text-anchor': opts.anchor || 'middle',
    'dominant-baseline': opts.baseline || 'auto',
    class: `ct ${opts.class || ''}`,
    style: `fill:${opts.color || 'var(--ink-3)'};font-size:${opts.size || 11}px;${opts.weight ? `font-weight:${opts.weight};` : ''}${opts.mono ? 'font-family:var(--font-mono);' : ''}`,
  }, text);
}

/** 컨테이너 폭에 맞춰 다시 그린다. 폭이 실제로 바뀔 때만 호출된다. */
export function mount(container, render) {
  let lastWidth = 0;
  const draw = () => {
    const w = Math.max(220, Math.round(container.clientWidth));
    if (w === lastWidth) return;
    lastWidth = w;
    container.replaceChildren();
    const out = render(w);
    if (out) container.append(out);
  };
  const ro = new ResizeObserver(debounce(draw, 60));
  ro.observe(container);
  draw();
  if (!lastWidth) requestAnimationFrame(draw);
  return () => ro.disconnect();
}

function tooltipFor(container) {
  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.hidden = true;
  container.append(tip);
  return {
    show(html, x, y) {
      tip.innerHTML = html;
      tip.hidden = false;
      const w = container.clientWidth;
      const tw = tip.offsetWidth;
      tip.style.left = `${Math.max(4, Math.min(w - tw - 4, x - tw / 2))}px`;
      tip.style.top = `${Math.max(0, y)}px`;
    },
    hide() { tip.hidden = true; },
  };
}

function niceTicks(max, count = 4) {
  if (max <= 0) return [0];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((v) => v >= raw) || mag * 10;
  const ticks = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(v);
  return ticks;
}

/**
 * 자산 추이용 면적 + 선 그래프. 한 계열이므로 범례 없이 제목이 계열을 설명한다.
 * 십자선과 툴팁, 마지막 점 강조를 기본 제공한다.
 */
export function areaChart(container, points, opts = {}) {
  return mount(container, (w) => {
    const h = opts.height || 210;
    const padL = 46;
    const padR = 12;
    const padT = 14;
    const padB = 24;
    const iw = w - padL - padR;
    const ih = h - padT - padB;
    if (points.length < 2) return null;

    const vals = points.map((p) => p.value);
    const rawMin = Math.min(...vals);
    const rawMax = Math.max(...vals);
    // 변화를 보는 그래프라 0 에 고정하지 않는다. 대신 축에 실제 금액을 적어 둔다.
    const span = rawMax - rawMin || Math.max(1, Math.abs(rawMax) * 0.1);
    const min = rawMin - span * 0.35;
    const max = rawMax + span * 0.25;
    const X = (i) => padL + (iw * i) / (points.length - 1);
    const Y = (v) => padT + ih - ((v - min) / (max - min)) * ih;

    const svg = s('svg', {
      viewBox: `0 0 ${w} ${h}`, width: w, height: h,
      role: 'img', 'aria-label': opts.aria || '기간별 추이 그래프',
      class: 'chart-svg',
    });

    const seen = new Set();
    for (const t of niceTicks(max - min, 3).map((v) => v + min)) {
      if (t > max) continue;
      const text = wonShort(t);
      svg.append(s('line', { x1: padL, x2: w - padR, y1: Y(t), y2: Y(t), style: 'stroke:var(--grid);stroke-width:1' }));
      // 반올림 때문에 같은 글자가 두 번 찍히면 축이 거짓말을 한다 — 둘째부터 생략
      if (seen.has(text)) continue;
      seen.add(text);
      svg.append(label(padL - 8, Y(t) + 4, text, { anchor: 'end', size: 10, mono: true }));
    }

    const line = points.map((p, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(p.value).toFixed(1)}`).join(' ');
    const base = padT + ih;
    const gid = `g${Math.random().toString(36).slice(2, 8)}`;
    const grad = s('linearGradient', { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 }, [
      s('stop', { offset: '0%', style: 'stop-color:var(--accent);stop-opacity:.28' }),
      s('stop', { offset: '100%', style: 'stop-color:var(--accent);stop-opacity:.02' }),
    ]);
    svg.append(s('defs', {}, [grad]));
    svg.append(s('path', { d: `${line} L${X(points.length - 1)},${base} L${X(0)},${base} Z`, style: `fill:url(#${gid});stroke:none` }));
    svg.append(s('path', { d: line, style: 'fill:none;stroke:var(--accent);stroke-width:2;stroke-linejoin:round;stroke-linecap:round' }));

    // 마지막 점 강조 — "지금 여기"를 표시
    const lastI = points.length - 1;
    svg.append(s('circle', { cx: X(lastI), cy: Y(points[lastI].value), r: 4.5, style: 'fill:var(--accent);stroke:var(--surface);stroke-width:2' }));

    const every = Math.max(1, Math.ceil(points.length / (w < 420 ? 4 : 7)));
    points.forEach((p, i) => {
      if (i % every === 0 || i === lastI) svg.append(label(X(i), h - 6, p.label, { size: 10 }));
    });

    const cross = s('line', { y1: padT, y2: padT + ih, style: 'stroke:var(--ink-3);stroke-width:1;stroke-dasharray:3 3', opacity: 0 });
    const dot = s('circle', { r: 4, style: 'fill:var(--surface);stroke:var(--accent);stroke-width:2', opacity: 0 });
    svg.append(cross, dot);

    const tip = tooltipFor(container);
    const hit = s('rect', { x: padL, y: padT, width: iw, height: ih, style: 'fill:transparent' });
    const move = (ev) => {
      const r = svg.getBoundingClientRect();
      const px = ((ev.clientX ?? ev.touches?.[0]?.clientX) - r.left) * (w / r.width);
      const i = Math.max(0, Math.min(points.length - 1, Math.round(((px - padL) / iw) * (points.length - 1))));
      const p = points[i];
      cross.setAttribute('x1', X(i)); cross.setAttribute('x2', X(i)); cross.setAttribute('opacity', 1);
      dot.setAttribute('cx', X(i)); dot.setAttribute('cy', Y(p.value)); dot.setAttribute('opacity', 1);
      tip.show(`<b>${p.full || p.label}</b><span>${won(p.value)}</span>${p.note ? `<em>${p.note}</em>` : ''}`, X(i) * (r.width / w), Y(p.value) - 8);
    };
    const leave = () => { cross.setAttribute('opacity', 0); dot.setAttribute('opacity', 0); tip.hide(); };
    hit.addEventListener('pointermove', move);
    hit.addEventListener('pointerdown', move);
    hit.addEventListener('pointerleave', leave);
    svg.append(hit);
    return svg;
  });
}

/** 일자별 지출 세로 막대. 선택된 날짜는 액센트로 강조된다. */
export function barChart(container, points, opts = {}) {
  return mount(container, (w) => {
    const h = opts.height || 150;
    const padT = 16;
    const padB = 22;
    const ih = h - padT - padB;
    const max = Math.max(...points.map((p) => p.value), 1);
    const n = points.length;
    const slot = w / n;
    const bw = Math.max(3, Math.min(opts.maxBar || 30, slot - 2));
    const svg = s('svg', {
      viewBox: `0 0 ${w} ${h}`, width: w, height: h, class: 'chart-svg',
      role: 'img', 'aria-label': opts.aria || '일자별 지출 막대 그래프',
    });
    svg.append(s('line', { x1: 0, x2: w, y1: padT + ih, y2: padT + ih, style: 'stroke:var(--grid);stroke-width:1' }));

    const tip = tooltipFor(container);
    points.forEach((p, i) => {
      const bh = p.value > 0 ? Math.max(2, (p.value / max) * ih) : 0;
      const x = i * slot + (slot - bw) / 2;
      const y = padT + ih - bh;
      const on = p.key && p.key === opts.highlightKey;
      const g = s('g', { class: 'bar-g' });
      if (bh > 0) {
        g.append(s('rect', {
          x, y, width: bw, height: bh, rx: Math.min(4, bw / 2),
          style: `fill:${on ? 'var(--accent)' : 'var(--bar)'}`,
        }));
      }
      g.append(s('rect', { x: i * slot, y: padT, width: slot, height: ih, style: 'fill:transparent' }));
      g.addEventListener('pointerenter', (ev) => {
        const r = svg.getBoundingClientRect();
        tip.show(`<b>${p.full || p.label}</b><span>${won(p.value)}</span>`, (x + bw / 2) * (r.width / w), Math.max(0, y - 6));
      });
      g.addEventListener('pointerleave', () => tip.hide());
      if (opts.onPick && p.key) {
        g.style.cursor = 'pointer';
        g.addEventListener('click', () => opts.onPick(p.key));
      }
      svg.append(g);
    });

    // 한 주(7칸)처럼 칸이 적으면 요일을 모두 적는다
    const every = n <= 8 ? 1 : Math.max(1, Math.ceil(n / (w < 420 ? 6 : 12)));
    points.forEach((p, i) => {
      if (i % every === 0) svg.append(label(i * slot + slot / 2, h - 6, p.label, { size: 10 }));
    });
    return svg;
  });
}

/** 월별 수입·지출 묶음 막대. 계열이 둘이라 범례를 함께 둔다. */
export function groupedBarChart(container, groups, opts = {}) {
  return mount(container, (w) => {
    const h = opts.height || 190;
    const padT = 14;
    const padB = 26;
    const padL = 44;
    const ih = h - padT - padB;
    const iw = w - padL;
    const max = Math.max(...groups.flatMap((g) => g.values), 1);
    const slot = iw / groups.length;
    const bw = Math.max(5, Math.min(22, (slot - 10) / 2 - 1));
    const svg = s('svg', {
      viewBox: `0 0 ${w} ${h}`, width: w, height: h, class: 'chart-svg',
      role: 'img', 'aria-label': opts.aria || '월별 수입과 지출 비교 그래프',
    });
    for (const t of niceTicks(max, 3)) {
      const y = padT + ih - (t / max) * ih;
      svg.append(s('line', { x1: padL, x2: w, y1: y, y2: y, style: 'stroke:var(--grid);stroke-width:1' }));
      svg.append(label(padL - 8, y + 4, wonShort(t), { anchor: 'end', size: 10, mono: true }));
    }
    const tip = tooltipFor(container);
    const colors = opts.colors || ['var(--in)', 'var(--out)'];

    groups.forEach((g, i) => {
      g.values.forEach((v, k) => {
        const bh = v > 0 ? Math.max(2, (v / max) * ih) : 0;
        // 막대 사이 2px 여백 — 두 계열이 붙어 보이지 않게 한다
        const x = padL + i * slot + slot / 2 - bw - 1 + k * (bw + 2);
        const y = padT + ih - bh;
        const node = s('rect', { x, y, width: bw, height: bh, rx: Math.min(4, bw / 2), style: `fill:${colors[k]}` });
        node.addEventListener('pointerenter', () => {
          const r = svg.getBoundingClientRect();
          tip.show(`<b>${g.full || g.label} · ${opts.series[k]}</b><span>${won(v)}</span>`, (x + bw / 2) * (r.width / w), Math.max(0, y - 6));
        });
        node.addEventListener('pointerleave', () => tip.hide());
        svg.append(node);
      });
      svg.append(label(padL + i * slot + slot / 2, h - 8, g.label, { size: 10 }));
    });
    return svg;
  });
}

/** 카테고리 비중 도넛. 조각 사이를 2px 띄워 인접색이 붙지 않게 한다. */
export function donutChart(container, slices, opts = {}) {
  return mount(container, (w) => {
    const size = Math.min(opts.size || 190, w);
    const r = size / 2;
    const thickness = opts.thickness || 26;
    const total = slices.reduce((a, b) => a + b.value, 0);
    const svg = s('svg', {
      viewBox: `0 0 ${size} ${size}`, width: size, height: size, class: 'chart-svg donut',
      role: 'img', 'aria-label': opts.aria || '카테고리별 지출 비중',
    });
    if (total <= 0) {
      svg.append(s('circle', { cx: r, cy: r, r: r - thickness / 2, style: `fill:none;stroke:var(--grid);stroke-width:${thickness}` }));
      svg.append(label(r, r + 4, '내역 없음', { size: 12 }));
      return svg;
    }
    const tip = tooltipFor(container);
    const radius = r - thickness / 2;
    const circ = 2 * Math.PI * radius;
    let offset = 0;
    slices.forEach((sl) => {
      const frac = sl.value / total;
      const len = Math.max(0, circ * frac - 2);
      const arc = s('circle', {
        cx: r, cy: r, r: radius,
        style: `fill:none;stroke:var(--s${sl.slot});stroke-width:${thickness};stroke-dasharray:${len} ${circ - len};stroke-dashoffset:${-offset};transform:rotate(-90deg);transform-origin:center`,
      });
      arc.addEventListener('pointerenter', () => {
        tip.show(`<b>${sl.emoji || ''} ${sl.label}</b><span>${won(sl.value)}</span><em>${(frac * 100).toFixed(1)}%</em>`, r, r - 30);
      });
      arc.addEventListener('pointerleave', () => tip.hide());
      svg.append(arc);
      offset += circ * frac;
    });
    svg.append(label(r, r - 6, opts.centerLabel || '총 지출', { size: 11 }));
    svg.append(label(r, r + 16, wonShort(total), { size: 19, color: 'var(--ink)', weight: 600, mono: true }));
    return svg;
  });
}
