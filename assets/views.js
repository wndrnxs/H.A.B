// 화면 렌더링. 상태는 ui 객체 하나에 모으고, 바뀌면 전체를 다시 그린다.
// 데이터 양이 가계부 규모(수천 건)라 이 정도면 충분히 빠르고, 코드가 단순해진다.

import { store, ACCOUNT_TYPES, buildSampleData } from './store.js';
import { prettyCode } from './firebase.js';
import { APP_VERSION } from './version.js';
import { applyAccent, normalize, deriveAccent, maxChroma, oklchToRgbClipped, MAX_CHROMA, PRESETS } from './accent.js';
import { areaChart, barChart, groupedBarChart, donutChart } from './charts.js';
import {
  el, won, wonShort, wonPlain, today, toYMD, fromYMD, addMonths, addDays, startOfMonth, endOfMonth,
  periodRange, periodLabel, shiftPeriod, previousRange, prettyDate, shortDate, eachDay, monthKey,
  daysBetween, untilParts,
  WEEKDAYS, sum, groupBy, uid,
} from './util.js';

export const ui = {
  page: 'dashboard',
  grain: 'month',
  anchor: today(),
  filter: { kind: 'all', categoryId: 'all', accountId: 'all', q: '' },
  tables: {},
};

let rerender = () => {};
export function bindRender(fn) { rerender = fn; }
export function setUi(patch) { Object.assign(ui, patch); rerender(); }
export function setFilter(patch) { Object.assign(ui.filter, patch); rerender(); }

export const PAGES = [
  { id: 'dashboard', name: '대시보드', icon: '◎' },
  { id: 'assets', name: '자산', icon: '▤' },
  { id: 'goals', name: '목표', icon: '⚑' },
  { id: 'txns', name: '내역', icon: '☰' },
  { id: 'settings', name: '설정', icon: '⚙' },
];

// ── 작은 부품들 ──────────────────────────────────────────────────────────

function card(opts, children) {
  const head = el('div', { class: 'card-head' }, [
    el('h2', { text: opts.title }),
    opts.sub ? el('span', { class: 'sub', text: opts.sub }) : null,
    el('span', { class: 'spacer' }),
    ...(opts.actions || []),
  ]);
  return el('section', { class: `card ${opts.class || ''}` }, [opts.title ? head : null, ...[].concat(children)]);
}

function chartBox(render, height) {
  const box = el('div', { class: 'chart-wrap', style: height ? `min-height:${height}px` : '' });
  requestAnimationFrame(() => render(box));
  return box;
}

/** 차트 옆에 같은 숫자를 표로도 볼 수 있게 한다 (색만으로 정보를 전달하지 않기 위해) */
function withTable(key, chartNode, buildTable) {
  const open = !!ui.tables[key];
  const btn = el('button', {
    class: 'btn sm ghost', text: open ? '표 닫기' : '표로 보기',
    'aria-expanded': open ? 'true' : 'false',
    onclick: () => { ui.tables[key] = !open; rerender(); },
  });
  return { btn, node: el('div', {}, [chartNode, open ? el('div', { class: 'tablebox' }, [buildTable()]) : null]) };
}

function dataTable(head, rows) {
  return el('table', { class: 'data' }, [
    el('thead', {}, [el('tr', {}, head.map((h) => el('th', { text: h })))]),
    el('tbody', {}, rows.map((r) => el('tr', {}, r.map((c, i) => el('td', { class: i ? 'n' : '', text: c }))))),
  ]);
}

function deltaTag(now, before, invert) {
  if (!before) return null;
  const diff = now - before;
  const rate = (diff / Math.abs(before)) * 100;
  if (Math.abs(rate) < 0.5) return el('span', { class: 'delta', text: '지난 기간과 비슷' });
  const up = diff > 0;
  const good = invert ? up : !up;
  return el('span', {
    class: `delta ${good ? 'down' : 'up'}`,
    text: `${up ? '▲' : '▼'} ${Math.abs(rate).toFixed(0)}% (${won(Math.abs(diff))})`,
  });
}

/** 이번 기간이 아직 진행 중이면 지난 기간도 같은 일수만큼만 잘라서 비교한다 */
function comparePrev(grain, anchor) {
  const cur = periodRange(grain, anchor);
  const prev = previousRange(grain, anchor);
  const now = today();
  if (now < cur.from || now >= cur.to) return { ...prev, partial: false };
  const elapsed = eachDay(cur.from, now).length;
  return { from: prev.from, to: addDays(prev.from, elapsed - 1), partial: true };
}

/**
 * 천 단위 쉼표가 붙는 금액 입력칸. 화면에는 1,000,000 으로 보이고 저장은 숫자로 한다.
 * allowNegative 를 켜면 마이너스 통장처럼 음수도 적을 수 있다.
 */
/**
 * 쉼표를 다시 붙이면서도 커서가 튀지 않게 한다.
 * 값을 통째로 바꿔 쓰면 커서가 맨 끝으로 가버려서, 가운데 숫자를 지울 수가 없다.
 * 커서 앞에 숫자가 몇 개였는지를 세어 두었다가 같은 자리로 되돌린다.
 */
function reformatWithCaret(input, format) {
  const caret = input.selectionStart ?? input.value.length;
  const digitsBefore = (input.value.slice(0, caret).match(/\d/g) || []).length;
  const next = format(input.value);
  input.value = next;
  let pos = 0;
  let seen = 0;
  while (pos < next.length && seen < digitsBefore) {
    if (/\d/.test(next[pos])) seen += 1;
    pos += 1;
  }
  try { input.setSelectionRange(pos, pos); } catch { /* 선택 조작을 막는 입력칸도 있다 */ }
}

function moneyInput({ value, onCommit, label, placeholder, width, allowNegative = false }) {
  const show = (v) => (v === null || v === undefined || v === '' ? '' : wonPlain(v));
  const parse = (raw) => {
    const neg = allowNegative && raw.trim().startsWith('-');
    const digits = raw.replace(/[^\d]/g, '').slice(0, 15);
    if (digits === '') return null;
    return neg ? -Number(digits) : Number(digits);
  };
  return el('input', {
    type: 'text', inputmode: 'numeric', 'aria-label': label, placeholder,
    value: show(value), style: width ? `width:${width}` : null,
    oninput: (e) => reformatWithCaret(e.target, (raw) => show(parse(raw))),
    onchange: (e) => {
      const v = parse(e.target.value);
      e.target.value = show(v);
      onCommit(v);
    },
  });
}

function catOf(t) {
  return store.category(t.categoryId);
}

function txnIcon(t) {
  if (t.kind === 'transfer') return '🔁';
  return catOf(t)?.emoji || (t.kind === 'income' ? '💰' : '📦');
}

function txnTitle(t) {
  if (t.memo) return t.memo;
  if (t.kind === 'transfer') return '계좌 이체';
  return catOf(t)?.name || '분류 없음';
}

function txnSub(t) {
  const bits = [];
  if (t.kind === 'transfer') {
    bits.push(`${store.account(t.accountId)?.name || '?'} → ${store.account(t.toAccountId)?.name || '?'}`);
  } else {
    if (catOf(t)) bits.push(catOf(t).name);
    if (store.account(t.accountId)) bits.push(store.account(t.accountId).name);
  }
  return bits.join(' · ');
}

function txnRow(t) {
  const sign = t.kind === 'income' ? '+' : t.kind === 'expense' ? '-' : '';
  return el('button', { class: 'txn', onclick: () => openTxnSheet(t) }, [
    el('span', { class: 'ico', text: txnIcon(t) }),
    el('span', { class: 'body' }, [
      el('span', { class: 't1' }, [
        txnTitle(t),
        t.recurringId ? el('span', { class: 'tag', text: '고정' }) : null,
        t.sample ? el('span', { class: 'tag', text: '예시' }) : null,
      ]),
      el('span', { class: 't2', text: txnSub(t) }),
    ]),
    el('span', { class: `amt num ${t.kind === 'income' ? 'in' : t.kind === 'transfer' ? 'tr' : 'out'}`, text: `${sign}${wonPlain(t.amount)}` }),
  ]);
}

function txnList(list, emptyText) {
  if (!list.length) return el('p', { class: 'empty', text: emptyText || '이 기간에는 내역이 없어요.' });
  const wrap = el('div', {});
  for (const [date, items] of groupBy(list, (t) => t.date)) {
    const spent = sum(items.filter((t) => t.kind === 'expense'), (t) => t.amount);
    const got = sum(items.filter((t) => t.kind === 'income'), (t) => t.amount);
    const d = fromYMD(date);
    wrap.append(el('div', { class: 'daygroup' }, [
      el('div', { class: 'dayhead' }, [
        el('span', { class: 'd', text: `${d.getMonth() + 1}월 ${d.getDate()}일` }),
        el('span', { class: 'w', text: `${WEEKDAYS[d.getDay()]}요일` }),
        el('span', { class: 'spacer' }),
        el('span', { class: 't num', text: [got ? `+${wonPlain(got)}` : null, spent ? `-${wonPlain(spent)}` : null].filter(Boolean).join('  ') }),
      ]),
      ...items.map(txnRow),
    ]));
  }
  return wrap;
}

// 기간 안의 지출을 카테고리별로 묶어 큰 순으로. 9번째부터는 '기타'로 접는다.
function categoryBreakdown(list, limit = 8) {
  const byCat = new Map();
  for (const t of list) {
    if (t.kind !== 'expense') continue;
    const c = catOf(t);
    const key = c?.id || 'none';
    if (!byCat.has(key)) byCat.set(key, { id: key, name: c?.name || '분류 없음', emoji: c?.emoji || '📦', value: 0 });
    byCat.get(key).value += t.amount;
  }
  const all = [...byCat.values()].sort((a, b) => b.value - a.value);
  const head = all.slice(0, limit - 1);
  const tail = all.slice(limit - 1);
  const rows = head.map((r, i) => ({ ...r, slot: i + 1 }));
  if (tail.length) rows.push({ id: '_etc', name: `기타 ${tail.length}개 분류`, emoji: '⋯', value: sum(tail, (r) => r.value), slot: limit });
  return { rows, all };
}

/** bars 를 끄면 금액만 적는다. 비중은 옆의 도넛과 '표로 보기' 가 맡는다. */
function catBars(rows, total, prevMap, { bars = true } = {}) {
  if (!rows.length) return el('p', { class: 'empty', text: '지출 내역이 없어요.' });
  const max = Math.max(...rows.map((r) => r.value), 1);
  return el('div', {}, rows.map((r) => {
    const prev = prevMap?.get(r.id);
    return el('div', { class: `catrow ${bars ? '' : 'plain'}` }, [
      el('span', { class: 'name' }, [
        el('span', { class: 'swatch', style: `background:var(--s${r.slot})` }),
        `${r.emoji} ${r.name}`,
      ]),
      el('span', { class: 'val num', text: wonPlain(r.value) }),
      bars ? el('span', { class: 'track' }, [el('span', { class: 'fill', style: `width:${(r.value / max) * 100}%;background:var(--s${r.slot})` })]) : null,
      bars ? el('span', { class: 'meta' }, [
        el('span', { text: `${((r.value / (total || 1)) * 100).toFixed(1)}%` }),
        prev !== undefined ? deltaTag(r.value, prev) : null,
      ]) : null,
    ]);
  }));
}

// ── 대시보드 ─────────────────────────────────────────────────────────────

function viewDashboard() {
  const { from, to } = periodRange(ui.grain, ui.anchor);
  const prev = comparePrev(ui.grain, ui.anchor);
  const list = store.inRange(from, to);
  const prevList = store.inRange(prev.from, prev.to);
  const spent = sum(list.filter((t) => t.kind === 'expense'), (t) => t.amount);
  const income = sum(list.filter((t) => t.kind === 'income'), (t) => t.amount);
  const prevSpent = sum(prevList.filter((t) => t.kind === 'expense'), (t) => t.amount);
  const nw = store.netWorth(to, { excludeHidden: true });
  const days = eachDay(from, to);
  const elapsed = Math.max(1, days.filter((d) => d <= today()).length);
  const { rows } = categoryBreakdown(list);
  const out = [];

  if (store.hasSamples()) {
    out.push(el('div', { class: 'banner' }, [
      el('span', { text: '지금 보이는 숫자는 감을 잡으라고 넣어 둔 예시 내역이에요.' }),
      el('span', { class: 'spacer' }),
      el('button', {
        class: 'btn sm',
        text: '예시 지우고 시작하기',
        onclick: async () => { await store.clearSamples(); toast('예시 내역을 지웠어요'); },
      }),
    ]));
  }

  const heroCard = card({ class: 'lift' }, [
    el('div', { class: 'hero' }, [
      el('div', { class: 'hero-main' }, [
        el('span', { class: 'eyebrow', text: `${periodLabel(ui.grain, ui.anchor)} 수지` }),
        el('span', { class: `hero-figure ${income - spent < 0 ? 'v out' : ''}`, text: won(income - spent) }),
        el('span', { class: 'hero-note', text: `수입에서 지출을 뺀 금액 · 하루 평균 ${won(spent / elapsed)} 씀` }),
      ]),
      el('div', { class: 'hero-side' }, [
        el('div', { class: 'kv' }, [el('span', { class: 'k', text: '수입' }), el('span', { class: 'v in', text: won(income) })]),
        el('div', { class: 'kv' }, [el('span', { class: 'k', text: '지출' }), el('span', { class: 'v out', text: won(spent) })]),
        el('div', { class: 'kv' }, [
          el('span', { class: 'k', text: prev.partial ? '지난 기간 같은 날까지' : '지난 기간 대비' }),
          el('span', {}, [deltaTag(spent, prevSpent) || el('span', { class: 'delta', text: '—' })]),
        ]),
      ]),
    ]),
  ]);

  // 지출이 아니라 '자산 쪽으로 옮긴 돈'. 적금·투자 입금과 대출 원금상환이 여기 든다.
  // 카드대금은 뺀다 — 그 돈은 이미 쓴 시점에 지출로 한 번 세었다.
  const buildKinds = new Set(['savings', 'invest', 'deposit', 'loan']);
  const built = list.filter((x) => x.kind === 'transfer' && buildKinds.has(store.account(x.toAccountId)?.type));
  const toSavings = sum(built.filter((x) => store.account(x.toAccountId).type !== 'loan'), (x) => x.amount);
  const toLoans = sum(built.filter((x) => store.account(x.toAccountId).type === 'loan'), (x) => x.amount);

  heroCard.append(el('div', { class: 'tiles' }, [
    tile('순자산', won(nw.net), nw.hidden.length ? `${nw.hidden.join(' · ')} 제외` : '자산 − 부채'),
    tile('총자산', won(nw.assets), '통장 · 현금 · 투자'),
    tile('부채', won(nw.debts), '카드값 · 대출 남은 돈'),
    tile('건수', `${list.length}건`, `${elapsed}일 동안`),
    tile('자산으로 돌린 돈', won(toSavings + toLoans),
      toSavings + toLoans
        ? [toSavings ? `적금·투자 ${wonShort(toSavings)}` : null, toLoans ? `대출 원금 ${wonShort(toLoans)}` : null].filter(Boolean).join(' · ')
        : '적금·투자 입금과 대출 원금상환'),
  ]));
  out.push(heroCard);

  const months = monthSeries(12);
  const netPoints = months.map((m) => ({
    key: m.key, label: `${Number(m.key.slice(5))}월`, full: `${m.key.slice(0, 4)}년 ${Number(m.key.slice(5))}월`,
    value: store.netWorth(m.end, { excludeHidden: true }).net,
  }));
  const netTable = withTable('dash-net', chartBox((b) => areaChart(b, netPoints, { height: 168, aria: '최근 12개월 순자산 추이' }), 168),
    () => dataTable(['월', '순자산'], netPoints.map((p) => [p.full, won(p.value)])));

  // 넷을 두 줄로 나란히. 한 장씩 가로로 늘어놓으면 오른쪽이 계속 빈다.
  out.push(pair(
    card({
      title: '자산 흐름',
      sub: nw.hidden.length ? `최근 12개월 · ${nw.hidden.join(' · ')} 제외` : '최근 12개월 순자산',
      actions: [netTable.btn],
    }, [netTable.node]),
    card({ title: '어디에 많이 썼나', sub: periodLabel(ui.grain, ui.anchor) }, [
      chartBox((b) => donutChart(b, rows.map((r) => ({ label: r.name, value: r.value, slot: r.slot, emoji: r.emoji })), { size: 168 }), 168),
      el('div', { class: 'legend' }, rows.slice(0, 6).map((r) => el('span', { class: 'li' }, [
        el('span', { class: 'sw', style: `background:var(--s${r.slot})` }),
        `${r.name} ${((r.value / (spent || 1)) * 100).toFixed(0)}%`,
      ]))),
    ]),
  ));

  out.push(pair(goalsBriefCard(), budgetCard()));
  out.push(card({
    title: '최근 내역',
    actions: [el('button', { class: 'btn sm ghost', text: '전체 보기 →', onclick: () => setUi({ page: 'txns' }) })],
  }, [txnList(store.txns().slice(0, 7))]));

  return out;
}

/**
 * 둘이 돈을 모아 쓰는 통장 현황. 이체는 수입도 지출도 아니라서
 * 그냥 두면 "이번 달 누가 얼마 넣었나"가 어디에도 안 보인다. 그걸 여기서 보여준다.
 */
function sharedAccountCard() {
  const id = store.config.settings.sharedAccountId;
  const acct = id ? store.account(id) : null;
  if (!acct) return null;

  const from = startOfMonth(ui.anchor);
  const to = endOfMonth(ui.anchor);
  const list = store.inRange(from, to);
  const inflow = list.filter((t) => (t.kind === 'transfer' && t.toAccountId === id) || (t.kind === 'income' && t.accountId === id));
  const filled = sum(inflow, (t) => t.amount);
  const spent = sum(list.filter((t) => t.kind === 'expense' && t.accountId === id), (t) => t.amount);
  const moved = sum(list.filter((t) => t.kind === 'transfer' && t.accountId === id), (t) => t.amount);
  const balance = store.balances(to)[id] || 0;
  const recent = store.txns().filter((x) => x.accountId === id || x.toAccountId === id).slice(0, 4);

  const lastFilled = (() => {
    for (let back = 1; back <= 6; back += 1) {
      const a = startOfMonth(addMonths(ui.anchor, -back));
      const got = sum(
        store.inRange(a, endOfMonth(a)).filter((x) => (x.kind === 'transfer' && x.toAccountId === id) || (x.kind === 'income' && x.accountId === id)),
        (x) => x.amount,
      );
      if (got > 0) return { amount: got, month: Number(a.slice(5, 7)) };
    }
    return null;
  })();

  return card({
    title: '공동 생활비',
    sub: `${acct.name} · ${Number(from.slice(5, 7))}월`,
    actions: [el('button', {
      class: 'btn sm ghost', text: '내역 보기 →',
      onclick: () => { setFilter({ accountId: id, kind: 'all' }); setUi({ page: 'txns' }); },
    })],
  }, [
    el('div', { class: 'hero-side', style: 'margin-bottom:8px' }, [
      el('div', { class: 'kv' }, [el('span', { class: 'k', text: '채운 돈' }), el('span', { class: 'v in', text: won(filled) })]),
      el('div', { class: 'kv' }, [el('span', { class: 'k', text: '여기서 쓴 돈' }), el('span', { class: 'v out', text: won(spent) })]),
      el('div', { class: 'kv' }, [el('span', { class: 'k', text: '옮긴 돈' }), el('span', { class: 'v', text: won(moved) }), el('span', { class: 'k', text: '카드값·상환 등' })]),
      el('div', { class: 'kv' }, [el('span', { class: 'k', text: '남은 잔액' }), el('span', { class: `v ${balance < 0 ? 'out' : ''}`, text: won(balance) })]),
    ]),
    filled > 0
      ? el('div', { class: 'stack', role: 'img', 'aria-label': `채운 돈 대비 나간 돈 ${Math.round(((spent + moved) / filled) * 100)}퍼센트` }, [
        el('span', { style: `width:${Math.min(100, ((spent + moved) / filled) * 100)}%;background:var(--accent)` }),
      ])
      : el('p', {
        class: 'empty', style: 'padding:4px 0;text-align:left',
        text: lastFilled
          ? `이번 달은 아직 채운 내역이 없어요. ${lastFilled.month}월에는 ${won(lastFilled.amount)}을 넣었어요.`
          : '이 통장으로 돈을 옮길 때 이체로 적어 두면, 이번 달 채운 돈과 쓴 돈이 여기에 보여요.',
      }),
    spent + moved > filled && filled > 0
      ? el('p', { style: 'font-size:12px;color:var(--warn);margin:6px 0 0', text: `이번 달은 채운 돈보다 ${won(spent + moved - filled)} 더 나갔어요.` })
      : null,
    // 옆 카드 높이를 맞추느라 비는 자리를 이 통장에서 오간 돈으로 채운다
    recent.length
      ? el('div', { class: 'tight', style: 'margin-top:8px' }, [
        el('div', { class: 'eyebrow', style: 'margin:0 0 2px', text: '최근 오간 돈' }),
        ...recent.map(txnRow),
      ])
      : null,
  ]);
}

/** 대시보드에 올리는 목표 요약 — 가까운 목표 순으로 몇 개만 */
function goalsBriefCard() {
  const goals = (store.config.goals || []).map(readGoal)
    .filter((g) => !g.done)
    .sort((a, b) => (a.end || '').localeCompare(b.end || ''));
  const go = el('button', { class: 'btn sm ghost', text: '목표 보기 →', onclick: () => setUi({ page: 'goals' }) });

  if (!goals.length) {
    return card({ title: '목표', sub: '모으는 중인 돈', actions: [go] }, [
      el('p', { class: 'empty', style: 'padding:18px 10px', text: '신혼여행, 전세 보증금처럼 기한이 있는 목돈을 넣어 두면 매달 얼마씩 모아야 하는지 여기에 보여요.' }),
      el('button', { class: 'btn primary', style: 'align-self:flex-start', text: '＋ 목표 만들기', onclick: () => setUi({ page: 'goals' }) }),
    ]);
  }

  return card({
    title: '목표',
    sub: `${goals.length}개 · 매달 ${won(sum(goals, (g) => g.perMonth))}`,
    actions: [go],
  }, goals.slice(0, 4).map((g) => {
    const dday = g.overdue ? `D+${Math.abs(g.parts.totalDays)}` : g.parts.totalDays === 0 ? 'D-DAY' : `D-${g.parts.totalDays}`;
    const state = g.overdue ? 'crit' : g.ratio >= 0.8 ? 'good' : 'accent';
    return el('button', { class: 'catrow goalrow', onclick: () => setUi({ page: 'goals' }) }, [
      el('span', { class: 'name', text: `${g.emoji || '⚑'} ${g.name}` }),
      el('span', { class: 'val num', text: `${won(g.perMonth)}/월` }),
      el('span', { class: 'track' }, [
        el('span', { class: 'fill', style: `width:${g.ratio * 100}%;background:var(--${state})` }),
      ]),
      el('span', { class: 'meta' }, [
        el('span', { text: `${(g.ratio * 100).toFixed(0)}% · ${won(g.saved)} / ${won(g.target)}` }),
        el('span', { style: `color:var(--${g.overdue ? 'crit' : 'ink-3'})`, text: `${dday} · ${g.targetDate}` }),
      ]),
    ]);
  }));
}

/** 카드 둘을 같은 폭으로 나란히. 한쪽이 없으면 남은 하나가 통째로 쓴다. */
function pair(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return el('div', { class: 'split even' }, [a, b]);
}

function tile(k, v, d) {
  return el('div', { class: 'tile' }, [
    el('span', { class: 'k', text: k }),
    el('span', { class: 'v', text: v }),
    d ? el('span', { class: 'd', text: d }) : null,
  ]);
}

function budgetCard() {
  const mFrom = startOfMonth(ui.anchor);
  const mTo = endOfMonth(ui.anchor);
  const list = store.inRange(mFrom, mTo).filter((t) => t.kind === 'expense');
  const byCat = new Map();
  for (const t of list) byCat.set(t.categoryId, (byCat.get(t.categoryId) || 0) + t.amount);
  const cats = store.config.categories
    .filter((c) => c.kind === 'expense' && c.budget)
    .map((c) => ({ ...c, used: byCat.get(c.id) || 0 }))
    .sort((a, b) => b.used / b.budget - a.used / a.budget)
    .slice(0, 6);
  const totalBudget = sum(store.config.categories.filter((c) => c.kind === 'expense' && c.budget), (c) => c.budget);
  const totalUsed = sum(list, (t) => t.amount);

  return card({
    title: '이번 달 예산',
    sub: `${Number(mFrom.slice(5, 7))}월 · ${won(totalUsed)} / ${won(totalBudget)}`,
    actions: [el('button', { class: 'btn sm ghost', text: '예산 고치기', onclick: () => setUi({ page: 'settings' }) })],
  }, cats.length ? cats.map((c) => {
    const ratio = c.used / c.budget;
    const state = ratio >= 1 ? 'crit' : ratio >= 0.8 ? 'warn' : 'good';
    const mark = { good: '○', warn: '△', crit: '●' }[state];
    const word = { good: '여유', warn: '빠듯', crit: '초과' }[state];
    return el('div', { class: 'catrow' }, [
      el('span', { class: 'name', text: `${c.emoji} ${c.name}` }),
      el('span', { class: 'val num', text: `${wonShort(c.used)} / ${wonShort(c.budget)}` }),
      el('span', { class: 'track' }, [el('span', { class: 'fill', style: `width:${Math.min(100, ratio * 100)}%;background:var(--${state})` })]),
      el('span', { class: 'meta' }, [
        el('span', { style: `color:var(--${state});font-weight:600`, text: `${mark} ${word} · ${(ratio * 100).toFixed(0)}%` }),
        el('span', { text: ratio >= 1 ? `${won(c.used - c.budget)} 넘김` : `${won(c.budget - c.used)} 남음` }),
      ]),
    ]);
  }) : [el('p', { class: 'empty', text: '설정에서 분류별 예산을 정하면 여기에 진행 상황이 보여요.' })]);
}

// ── 내역 ─────────────────────────────────────────────────────────────────

function filtered(list) {
  const f = ui.filter;
  const q = f.q.trim().toLowerCase();
  return list.filter((t) => {
    if (f.kind !== 'all' && t.kind !== f.kind) return false;
    if (f.categoryId !== 'all' && t.categoryId !== f.categoryId) return false;
    if (f.accountId !== 'all' && t.accountId !== f.accountId && t.toAccountId !== f.accountId) return false;
    if (q && !`${txnTitle(t)} ${txnSub(t)}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

function viewTxns() {
  const { from, to } = periodRange(ui.grain, ui.anchor);
  const prev = comparePrev(ui.grain, ui.anchor);
  const list = filtered(store.inRange(from, to));
  const prevSpent = sum(filtered(store.inRange(prev.from, prev.to)).filter((t) => t.kind === 'expense'), (t) => t.amount);
  const spent = sum(list.filter((t) => t.kind === 'expense'), (t) => t.amount);
  const income = sum(list.filter((t) => t.kind === 'income'), (t) => t.amount);
  const f = ui.filter;

  // 일 단위로 볼 때도 그 날이 한 달 중 어디쯤인지 보이도록 달 전체를 그린다
  const barFrom = ui.grain === 'day' ? startOfMonth(ui.anchor) : from;
  const barTo = ui.grain === 'day' ? endOfMonth(ui.anchor) : to;
  const dayMap = new Map();
  for (const t of filtered(store.inRange(barFrom, barTo))) {
    if (t.kind !== 'expense') continue;
    dayMap.set(t.date, (dayMap.get(t.date) || 0) + t.amount);
  }
  const points = eachDay(barFrom, barTo).map((d) => ({
    key: d, label: ui.grain === 'week' ? WEEKDAYS[fromYMD(d).getDay()] : String(fromYMD(d).getDate()),
    full: prettyDate(d), value: dayMap.get(d) || 0,
  }));

  const out = [];
  out.push(card({ class: 'lift' }, [
    el('div', { class: 'hero' }, [
      el('div', { class: 'hero-main' }, [
        el('span', { class: 'eyebrow', text: `${periodLabel(ui.grain, ui.anchor)} 지출` }),
        el('span', { class: 'hero-figure', text: won(spent) }),
        el('span', { class: 'hero-note' }, [
          deltaTag(spent, prevSpent) || el('span', { text: '지난 기간과 비교할 내역이 없어요' }),
          el('span', { text: prev.partial ? ' · 지난 기간 같은 날까지와 비교' : ' · 지난 기간 전체와 비교' }),
        ]),
      ]),
      el('div', { class: 'hero-side' }, [
        el('div', { class: 'kv' }, [el('span', { class: 'k', text: '수입' }), el('span', { class: 'v in', text: won(income) })]),
        el('div', { class: 'kv' }, [el('span', { class: 'k', text: '합계' }), el('span', { class: 'v', text: won(income - spent) })]),
        el('div', { class: 'kv' }, [el('span', { class: 'k', text: '건수' }), el('span', { class: 'v', text: `${list.length}` })]),
      ]),
    ]),
    chartBox((b) => barChart(b, points, {
      height: 112, highlightKey: ui.grain === 'day' ? ui.anchor : null,
      onPick: (key) => setUi({ grain: 'day', anchor: key }),
      aria: '일자별 지출 막대 그래프',
    }), 112),
  ]));

  const cats = store.config.categories.filter((c) => (f.kind === 'income' ? c.kind === 'income' : c.kind === 'expense'));
  out.push(card({ title: '골라 보기' }, [
    el('div', { class: 'chips', style: 'margin-bottom:8px' }, [
      chip('전체', f.kind === 'all', () => setFilter({ kind: 'all' })),
      chip('지출', f.kind === 'expense', () => setFilter({ kind: 'expense' })),
      chip('수입', f.kind === 'income', () => setFilter({ kind: 'income' })),
      chip('이체', f.kind === 'transfer', () => setFilter({ kind: 'transfer' })),
    ]),
    el('div', { class: 'row2' }, [
      el('select', {
        'aria-label': '분류로 거르기', id: 'filter-cat',
        onchange: (e) => setFilter({ categoryId: e.target.value }),
      }, [
        el('option', { value: 'all', text: '모든 분류', selected: f.categoryId === 'all' }),
        ...cats.map((c) => el('option', { value: c.id, text: `${c.emoji} ${c.name}`, selected: f.categoryId === c.id })),
      ]),
      el('select', {
        'aria-label': '결제수단으로 거르기', id: 'filter-acct',
        onchange: (e) => setFilter({ accountId: e.target.value }),
      }, [
        el('option', { value: 'all', text: '모든 결제수단', selected: f.accountId === 'all' }),
        ...store.config.accounts.map((a) => el('option', { value: a.id, text: a.name, selected: f.accountId === a.id })),
      ]),
    ]),
    el('div', { class: 'field', style: 'margin:10px 0 0' }, [
      el('input', {
        type: 'search', id: 'filter-q', placeholder: '메모·분류 검색 (예: 사료, 축의금)', value: f.q,
        oninput: (e) => { ui.filter.q = e.target.value; scheduleSearch(); },
      }),
    ]),
  ]));

  out.push(card({ title: `${periodLabel(ui.grain, ui.anchor)} 내역`, sub: `${list.length}건` }, [txnList(list)]));
  return out;
}

let searchTimer;
function scheduleSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    rerender();
    const inp = document.getElementById('filter-q');
    if (inp) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
  }, 260);
}

function chip(text, on, onclick) {
  return el('button', { class: 'chip', 'aria-pressed': on ? 'true' : 'false', text, onclick });
}

// ── 통계 ─────────────────────────────────────────────────────────────────

/** 최근 n개월. 기록이 시작되기 전의 밋밋한 구간은 그리지 않는다. */
function monthSeries(n) {
  const all = store.txns();
  const oldest = all.length ? all[all.length - 1].date : null;
  const startKey = oldest ? monthKey(addMonths(startOfMonth(oldest), -1)) : null;
  const months = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    const anchor = startOfMonth(addMonths(ui.anchor, -i));
    months.push({ key: monthKey(anchor), start: anchor, end: endOfMonth(anchor) });
  }
  const kept = startKey ? months.filter((m) => m.key >= startKey) : months;
  return kept.length >= 2 ? kept : months.slice(-Math.min(3, months.length));
}

/**
 * 지출 분석 — 예전 '통계' 화면의 내용이다. 메뉴를 넷으로 줄이면서 자산 화면으로 옮겼다.
 * 분류별과 결제수단별은 막대를 빼고 금액만 적는다. 비중은 도넛과 표가 맡는다.
 */
function spendingCards() {
  const { from, to } = periodRange(ui.grain, ui.anchor);
  const prev = comparePrev(ui.grain, ui.anchor);
  const list = store.inRange(from, to);
  const spent = sum(list.filter((t) => t.kind === 'expense'), (t) => t.amount);
  // 계열색은 여덟 개까지다. 아홉 번째는 색이 없어 막대가 비어 보였다.
  const { rows, all } = categoryBreakdown(list);
  const prevBreak = categoryBreakdown(store.inRange(prev.from, prev.to), 99);
  const prevMap = new Map(prevBreak.all.map((r) => [r.id, r.value]));

  const catTable = withTable('stats-cat', catBars(rows, spent, prevMap, { bars: false }),
    () => dataTable(['분류', '금액', '비중', '지난 기간'], all.map((r) => [
      `${r.emoji} ${r.name}`, won(r.value), `${((r.value / (spent || 1)) * 100).toFixed(1)}%`,
      prevMap.has(r.id) ? won(prevMap.get(r.id)) : '—',
    ])));

  const byAccount = store.visibleAccounts().map((a, i) => ({
    id: a.id, name: a.name, emoji: ACCOUNT_TYPES[a.type]?.emoji || '💳', slot: (i % 8) + 1,
    value: sum(list.filter((t) => t.kind === 'expense' && t.accountId === a.id), (t) => t.amount),
  })).filter((a) => a.value > 0).sort((a, b) => b.value - a.value);

  const months = monthSeries(12);
  const groups = months.map((m) => {
    const ml = store.inRange(m.start, m.end);
    return {
      label: `${Number(m.key.slice(5))}`, full: `${m.key.slice(0, 4)}년 ${Number(m.key.slice(5))}월`,
      values: [
        sum(ml.filter((t) => t.kind === 'income'), (t) => t.amount),
        sum(ml.filter((t) => t.kind === 'expense'), (t) => t.amount),
      ],
    };
  });

  return [
    // 분류·결제수단·도넛을 한 카드 세 칸에 나란히. 따로 두면 각자 오른쪽이 비었다.
    card({ title: '지출 들여다보기', sub: `${periodLabel(ui.grain, ui.anchor)} · 총 ${won(spent)}`, actions: [catTable.btn] }, [
      el('div', { class: 'split3' }, [
        el('div', {}, [el('div', { class: 'eyebrow', style: 'margin:0 0 4px', text: '분류별' }), catTable.node]),
        el('div', {}, [
          el('div', { class: 'eyebrow', style: 'margin:0 0 4px', text: '결제수단별' }),
          byAccount.length ? catBars(byAccount, spent, null, { bars: false }) : el('p', { class: 'empty', text: '지출 내역이 없어요.' }),
        ]),
        chartBox((b) => donutChart(b, rows.map((r) => ({ label: r.name, value: r.value, slot: r.slot, emoji: r.emoji })), { size: 186 }), 186),
      ]),
    ]),
    el('div', { class: 'split' }, [
      card({ title: '월별 수입과 지출', sub: '최근 12개월' }, [
        el('div', { class: 'legend', style: 'margin:0 0 6px' }, [
          el('span', { class: 'li' }, [el('span', { class: 'sw', style: 'background:var(--in)' }), '수입']),
          el('span', { class: 'li' }, [el('span', { class: 'sw', style: 'background:var(--out)' }), '지출']),
        ]),
        chartBox((b) => groupedBarChart(b, groups, { series: ['수입', '지출'], height: 158 }), 158),
      ]),
      bigSpendCard(),
    ]),
  ];
}

// ── 자산 ─────────────────────────────────────────────────────────────────

/**
 * 갚는 중인 대출 현황.
 *
 * 매달 내는 돈은 '이자 + 원금' 이다. 이자만 지출이고 원금은 빚이 줄어드는 것이라
 * 지출이 아니다. 그래서 이 앱은 이자를 지출로, 원금을 통장→대출계좌 이체로 적는다.
 * 여기서는 그렇게 쌓인 기록을 대출별로 모아 얼마나 갚았는지 보여 준다.
 */
function loanCard() {
  const loans = store.visibleAccounts().filter((a) => a.type === 'loan');
  if (!loans.length) return null;

  const bal = store.balances();
  const all = store.txns();
  const now = today();

  const rows = loans.map((a) => {
    const remaining = Math.max(0, -(bal[a.id] || 0));
    const principal = Number(a.principal) || 0;
    const repaid = principal ? Math.max(0, principal - remaining) : 0;
    const ratio = principal ? Math.min(1, repaid / principal) : 0;

    // 최근 3개월(이번 달 제외)에 넣은 원금으로 갚는 속도를 잡는다.
    // 기록이 없는 달까지 나누면 속도가 실제보다 느리게 나와 완주 예상이 엉뚱해진다.
    const monthly = [];
    for (let back = 1; back <= 3; back += 1) {
      const s = startOfMonth(addMonths(now, -back));
      const e = endOfMonth(s);
      const paid = sum(all.filter((x) => x.kind === 'transfer' && x.toAccountId === a.id && x.date >= s && x.date <= e), (x) => x.amount);
      if (paid > 0) monthly.push(paid);
    }
    const pace = monthly.length ? sum(monthly) / monthly.length : 0;
    const interest = sum(all.filter((x) => x.kind === 'expense' && x.loanId === a.id), (x) => x.amount);

    let eta = null;
    if (remaining > 0 && pace > 0) {
      const months = Math.ceil(remaining / pace);
      if (months <= 600) {
        const d = fromYMD(addMonths(now, months));
        eta = `이 속도면 ${d.getFullYear()}년 ${d.getMonth() + 1}월쯤 끝나요`;
      }
    }
    return { a, remaining, principal, repaid, ratio, pace, interest, eta, months: monthly.length };
  });

  const totalLeft = sum(rows, (r) => r.remaining);

  return card({
    title: '갚는 중인 대출',
    sub: `남은 빚 ${won(totalLeft)}`,
    actions: [el('button', { class: 'btn sm', text: '＋ 상환 적기', onclick: () => openRepaySheet() })],
  }, rows.map((r) => el('div', { class: 'catrow' }, [
    el('span', { class: 'name', text: `${ACCOUNT_TYPES[r.a.type].emoji} ${r.a.name}` }),
    el('span', { class: 'val num', text: won(r.remaining) }),
    r.principal
      ? el('span', { class: 'track' }, [el('span', { class: 'fill', style: `width:${r.ratio * 100}%;background:var(--good)` })])
      : null,
    el('span', { class: 'meta' }, r.principal
      ? [
        el('span', {
          style: 'color:var(--good);font-weight:600',
          text: `${(r.ratio * 100).toFixed(r.ratio > 0 && r.ratio < 0.1 ? 1 : 0)}% 갚음`,
        }),
        el('span', { text: `처음 ${wonShort(r.principal)} · 갚은 원금 ${wonShort(r.repaid)}` }),
        r.interest ? el('span', { text: `낸 이자 ${wonShort(r.interest)}` }) : null,
      ]
      : [
        el('span', { text: '처음 빌린 금액을 넣으면 얼마나 갚았는지 보여요.' }),
        el('button', {
          class: 'btn sm', style: 'padding:2px 8px',
          text: '입력', onclick: () => openPrincipalSheet(r.a),
        }),
      ]),
    r.pace > 0
      ? el('span', { class: 'meta' }, [
        el('span', { text: `최근 ${r.months}개월 평균 원금 ${wonShort(r.pace)}/월` }),
        r.eta ? el('span', { text: r.eta }) : null,
      ])
      : null,
  ])));
}

/**
 * 계좌에 남기는 메모.
 * '전세보증금 2.2억 중 내 돈 1.2억 · 배우자 8천 · 다음 집 계약금 2천' 처럼
 * 잔액 하나로는 설명되지 않는 것을 적어 둔다.
 */
function openAccountNoteSheet(account) {
  const ta = el('textarea', {
    rows: 5, id: 'acct-note', placeholder: '예: 내 돈 1억 2천 + 배우자 8천. 이 중 2천은 다음 집 계약금.',
    style: 'width:100%;font-size:14px;line-height:1.6;resize:vertical',
  }, [account.note || '']);
  openSheet(`${account.name} 메모`, [
    el('p', { style: 'font-size:13px;color:var(--ink-2);margin:0 0 10px', text: '이 계좌 잔액이 어떤 돈인지 적어 두세요. 자산 화면의 계좌 이름 아래에 보입니다.' }),
    el('div', { class: 'field' }, [ta]),
  ], [
    el('button', {
      class: 'btn primary', text: '저장',
      onclick: async () => {
        await store.saveConfig({
          accounts: store.config.accounts.map((x) => (x.id === account.id ? { ...x, note: ta.value.trim() || null } : x)),
        });
        closeSheet();
        toast(ta.value.trim() ? '메모를 남겼어요' : '메모를 지웠어요');
      },
    }),
  ]);
}

/** 처음 빌린 금액만 받는 작은 시트 */
function openPrincipalSheet(account) {
  let value = Number(account.principal) || null;
  openSheet(`${account.name} — 처음 빌린 금액`, [
    el('p', { style: 'font-size:13px;color:var(--ink-2);margin:0 0 12px', text: '대출을 처음 받았을 때의 금액이에요. 지금 남은 빚이 아니라요. 이걸 알아야 몇 퍼센트 갚았는지 계산할 수 있어요.' }),
    el('div', { class: 'field amount' }, [
      el('label', { for: 'loan-principal', text: '처음 빌린 금액 (원)' }),
      moneyInput({ value, label: '처음 빌린 금액', placeholder: '0', onCommit: (v) => { value = v; } }),
    ]),
  ], [
    el('button', {
      class: 'btn primary', text: '저장',
      onclick: async () => {
        const i = store.config.accounts.findIndex((x) => x.id === account.id);
        if (i >= 0) await store.saveConfig({
          accounts: store.config.accounts.map((x, k) => (k === i ? { ...x, principal: Math.abs(value || 0) || null } : x)),
        });
        closeSheet();
        toast('처음 빌린 금액을 저장했어요');
      },
    }),
  ]);
}

/**
 * 대출 상환 한 번을 두 건으로 나눠 적는다.
 * 통장에서 빠지는 총액은 하나지만, 이자는 지출이고 원금은 빚이 줄어드는 이체다.
 */
function openRepaySheet(preset) {
  const loans = store.config.accounts.filter((a) => a.type === 'loan');
  const payFrom = store.config.accounts.filter((a) => a.type === 'bank' || a.type === 'cash');
  const interestCat = store.config.categories.find((c) => c.id === 'c_loan')
    || store.config.categories.find((c) => c.kind === 'expense' && c.name.includes('이자'))
    || store.config.categories.find((c) => c.kind === 'expense');

  const draft = {
    loanId: preset || loans[0]?.id || null,
    accountId: payFrom[0]?.id || store.config.accounts[0]?.id || null,
    date: today(),
    total: '',
    interest: '',
  };
  const body = el('div', {});

  const draw = () => {
    const principalPart = Math.max(0, (Number(draft.total) || 0) - (Number(draft.interest) || 0));
    body.replaceChildren(
      el('div', { class: 'row2' }, [
        el('div', { class: 'field' }, [
          el('label', { for: 'rp-loan', text: '어느 대출' }),
          el('select', { id: 'rp-loan', onchange: (e) => { draft.loanId = e.target.value; } },
            loans.map((a) => el('option', { value: a.id, text: a.name, selected: draft.loanId === a.id }))),
        ]),
        el('div', { class: 'field' }, [
          el('label', { for: 'rp-from', text: '어디서 빠져나가나' }),
          el('select', { id: 'rp-from', onchange: (e) => { draft.accountId = e.target.value; } },
            payFrom.map((a) => el('option', { value: a.id, text: a.name, selected: draft.accountId === a.id }))),
        ]),
      ]),
      el('div', { class: 'field' }, [
        el('label', { for: 'rp-date', text: '날짜' }),
        el('input', { id: 'rp-date', type: 'date', value: draft.date, onchange: (e) => { draft.date = e.target.value || today(); } }),
      ]),
      el('div', { class: 'field amount' }, [
        el('label', { text: '이번 달 낸 돈 (총액)' }),
        moneyInput({ value: draft.total === '' ? null : draft.total, placeholder: '0', label: '총 납입액', onCommit: (v) => { draft.total = v ?? ''; draw(); } }),
      ]),
      el('div', { class: 'field' }, [
        el('label', { text: '그중 이자' }),
        moneyInput({ value: draft.interest === '' ? null : draft.interest, placeholder: '0', label: '이자', onCommit: (v) => { draft.interest = v ?? ''; draw(); } }),
        el('span', { class: 'hint', text: '은행 앱이나 상환 안내에 이자와 원금이 나뉘어 적혀 있어요.' }),
      ]),
      el('div', { class: 'banner', style: 'margin-top:4px' }, [
        el('span', {}, [
          '원금 ', el('b', { class: 'num', text: won(principalPart) }), ' 이 빚에서 줄고, 이자 ',
          el('b', { class: 'num', text: won(Number(draft.interest) || 0) }), ' 만 지출로 잡혀요.',
        ]),
      ]),
    );
  };
  draw();

  openSheet('대출 상환 적기', [body], [
    el('button', {
      class: 'btn primary', text: '저장',
      onclick: async () => {
        const total = Number(draft.total) || 0;
        const interest = Number(draft.interest) || 0;
        if (total <= 0) { toast('이번 달 낸 총액을 넣어 주세요'); return; }
        if (interest > total) { toast('이자가 총액보다 클 수는 없어요'); return; }
        if (!draft.loanId || !draft.accountId) { toast('대출과 출금 계좌를 골라 주세요'); return; }
        const loan = store.account(draft.loanId);
        const principalPart = total - interest;
        if (interest > 0) {
          await store.saveTxn({
            kind: 'expense', date: draft.date, amount: interest,
            categoryId: interestCat?.id || null, accountId: draft.accountId,
            loanId: draft.loanId, memo: `${loan?.name || '대출'} 이자`,
          });
        }
        if (principalPart > 0) {
          await store.saveTxn({
            kind: 'transfer', date: draft.date, amount: principalPart,
            accountId: draft.accountId, toAccountId: draft.loanId,
            memo: `${loan?.name || '대출'} 원금상환`,
          });
        }
        closeSheet();
        toast('상환을 적었어요');
      },
    }),
  ]);
}

function viewAssets() {
  const nw = store.netWorth(null, { excludeHidden: true });
  const hiddenAccounts = store.hiddenAccounts();
  const months = monthSeries(12);
  const points = months.map((m) => ({
    key: m.key, label: `${Number(m.key.slice(5))}월`, full: `${m.key.slice(0, 4)}년 ${Number(m.key.slice(5))}월`,
    value: store.netWorth(m.end, { excludeHidden: true }).net,
  }));
  const first = points[0]?.value || 0;
  const grown = nw.net - first;
  const t = withTable('assets-net', chartBox((b) => areaChart(b, points, { height: 186, aria: '최근 12개월 순자산 추이' }), 186),
    () => dataTable(['월', '순자산', '전월 대비'], points.map((p, i) => [p.full, won(p.value), i ? won(p.value - points[i - 1].value) : '—'])));

  const groupsOrder = ['bank', 'cash', 'deposit', 'savings', 'invest', 'card', 'loan'];
  const byType = groupsOrder
    .map((type) => ({ type, items: store.visibleAccounts().filter((a) => a.type === type) }))
    .filter((g) => g.items.length);

  const assetAccounts = store.visibleAccounts()
    .filter((a) => !ACCOUNT_TYPES[a.type]?.liability)
    .map((a) => ({ id: a.id, name: a.name, emoji: ACCOUNT_TYPES[a.type].emoji, value: Math.max(0, nw.bal[a.id] || 0) }))
    .filter((a) => a.value > 0)
    .sort((a, b) => b.value - a.value)
    .map((a, i) => ({ ...a, slot: (i % 8) + 1 }));

  return [
    card({ class: 'lift' }, [
      el('div', { class: 'hero' }, [
        el('div', { class: 'hero-main' }, [
          el('span', { class: 'eyebrow', text: '우리집 순자산' }),
          el('span', { class: 'hero-figure', text: won(nw.net) }),
          el('span', { class: 'hero-note', text: `1년 전 대비 ${grown >= 0 ? '+' : ''}${won(grown)}${nw.hidden.length ? ` · ${nw.hidden.join(' · ')} 제외` : ''}` }),
        ]),
        el('div', { class: 'hero-side' }, [
          el('div', { class: 'kv' }, [el('span', { class: 'k', text: '자산' }), el('span', { class: 'v', text: won(nw.assets) })]),
          el('div', { class: 'kv' }, [el('span', { class: 'k', text: '부채' }), el('span', { class: 'v out', text: won(nw.debts) })]),
        ]),
      ]),
    ]),
    pair(card({ title: '자산 흐름', sub: '매월 말 순자산', actions: [t.btn] }, [t.node]), sharedAccountCard()),
    loanCard(),
    el('div', { class: 'split' }, [
      card({ title: '계좌별 잔액', actions: [el('button', { class: 'btn sm ghost', text: '계좌 관리', onclick: () => setUi({ page: 'settings' }) })] },
        [el('div', { class: 'acctcols' }, byType.map((g) => el('div', { class: 'acctgroup' }, [
          el('div', { class: 'eyebrow', style: 'margin:7px 0 1px', text: ACCOUNT_TYPES[g.type].label }),
          ...g.items.map((a) => {
            const v = nw.bal[a.id] || 0;
            return el('div', { class: 'acct' }, [
              el('span', { class: 'ico', text: ACCOUNT_TYPES[a.type].emoji }),
              el('span', { class: 'body' }, [
                el('span', { class: 'n' }, [a.name, a.offDashboard ? el('span', { class: 'tag', text: '숨김' }) : null]),
                a.note ? el('span', { class: 'note', text: a.note }) : null,
              ]),
              el('span', { class: `b num ${v < 0 ? 'neg' : ''}`, text: won(v) }),
            ]);
          }),
        ])))]),
      el('div', { class: 'colstack' }, [
        card({ title: '자산 구성', sub: '어디에 얼마나 들어있나' }, [
          assetAccounts.length ? donutWithList(assetAccounts, '총자산') : el('p', { class: 'empty', text: '계좌를 등록하면 구성이 보여요.' }),
        ]),
        debtCard(nw.bal),
      ]),
    ]),
    ...spendingCards(),
    hiddenCard(hiddenAccounts, nw.bal),
  ];
}

/** 도넛으로 비중을 보이고 바로 아래에 항목과 금액을 적는다 */
function donutWithList(rows, centerLabel) {
  const total = sum(rows, (r) => r.value);
  return el('div', {}, [
    chartBox((b) => donutChart(b, rows.map((r) => ({ label: r.name, value: r.value, slot: r.slot, emoji: r.emoji })), {
      size: 164, thickness: 22, centerLabel,
    }), 164),
    el('div', { style: 'margin-top:8px' }, catBars(rows, total, null, { bars: false })),
  ]);
}

/** 빚이 어디에 얼마나 있나 — 자산 구성의 짝 */
function debtCard(bal) {
  const rows = store.visibleAccounts()
    .map((a) => ({
      id: a.id, name: a.name, type: a.type, emoji: ACCOUNT_TYPES[a.type]?.emoji || '🧾',
      value: Math.max(0, -(bal[a.id] || 0)),
      // 처음 빌린 금액을 안 적었으면 지금 남은 빚을 원금으로 본다(진행률 0%)
      principal: Math.max(Number(a.principal) || 0, Math.max(0, -(bal[a.id] || 0))),
    }))
    .filter((r) => r.value > 0 || (r.type === 'loan' && r.principal > 0))
    .sort((a, b) => b.value - a.value)
    .map((r, i) => ({ ...r, slot: (i % 8) + 1, repaid: r.principal - r.value }));
  if (!rows.length) return null;

  // 카드값이나 마이너스 잔고는 '갚아 나가는 빚' 이 아니라 진행률에서 뺀다
  const loans = rows.filter((r) => r.type === 'loan');
  const principal = sum(loans, (r) => r.principal);
  const loanLeft = sum(loans, (r) => r.value);
  const repaid = Math.max(0, principal - loanLeft);
  const ratio = principal ? repaid / principal : 0;
  const remaining = sum(rows, (r) => r.value);

  if (!loans.length) {
    return card({ title: '부채 구성', sub: `갚아야 할 돈 ${won(remaining)}` }, [catBars(rows, remaining, null, { bars: false })]);
  }

  return card({ title: '부채 구성', sub: `대출 ${wonShort(principal)} 중 ${wonShort(repaid)} 갚음` }, [
    el('div', { class: 'progress' }, [
      el('div', { class: 'progress-head' }, [
        el('span', { style: 'color:var(--good);font-weight:600', text: `${(ratio * 100).toFixed(ratio > 0 && ratio < 0.1 ? 1 : 0)}% 갚음` }),
        el('span', { class: 'spacer' }),
        el('span', { class: 'num', style: 'color:var(--out);font-weight:600', text: `${won(loanLeft)} 남음` }),
      ]),
      el('span', {
        class: 'track', role: 'img',
        'aria-label': `전체 대출 ${won(principal)} 중 ${won(repaid)} 상환, ${Math.round(ratio * 100)}퍼센트`,
      }, [el('span', { class: 'fill', style: `width:${ratio * 100}%;background:var(--good)` })]),
    ]),
    catBars(rows, remaining, null, { bars: false }),
  ]);
}

/** 이번 기간에 크게 나간 몇 건 — 숫자만 보면 놓치는 것들 */
function bigSpendCard() {
  const { from, to } = periodRange(ui.grain, ui.anchor);
  const rows = store.inRange(from, to).filter((x) => x.kind === 'expense')
    .sort((a, b) => b.amount - a.amount).slice(0, 5);
  if (!rows.length) return null;
  return card({ title: '크게 나간 돈', sub: `${periodLabel(ui.grain, ui.anchor)} 상위 ${rows.length}건` }, [
    el('div', { class: 'tight' }, rows.map((x) => el('button', { class: 'txn', onclick: () => openTxnSheet(x) }, [
      el('span', { class: 'ico', text: txnIcon(x) }),
      el('span', { class: 'body' }, [
        el('span', { class: 't1', text: txnTitle(x) }),
        el('span', { class: 't2', text: `${shortDate(x.date)} · ${catOf(x)?.name || '분류 없음'}` }),
      ]),
      el('span', { class: 'amt num', text: wonPlain(x.amount) }),
    ]))),
  ]);
}

/** 숨겨 둔 계좌 — 위 숫자에는 안 들어가지만 어딘가에는 남아 있어야 한다 */
function hiddenCard(accounts, bal) {
  if (!accounts.length) return null;
  const total = sum(accounts, (a) => bal[a.id] || 0);
  return card({
    title: '숨긴 계좌',
    sub: `위 숫자에는 넣지 않았어요 · 합계 ${won(total)}`,
    actions: [el('button', { class: 'btn sm ghost', text: '계좌 관리', onclick: () => setUi({ page: 'settings' }) })],
  }, accounts.map((a) => {
    const v = bal[a.id] || 0;
    return el('div', { class: 'acct', style: 'opacity:.72' }, [
      el('span', { class: 'ico', text: ACCOUNT_TYPES[a.type].emoji }),
      el('span', { class: 'body' }, [
        el('span', { class: 'n', text: a.name }),
        el('span', { class: 't', text: ACCOUNT_TYPES[a.type].label }),
        a.note ? el('span', { class: 'note', text: a.note }) : null,
      ]),
      el('span', { class: `b num ${v < 0 ? 'neg' : ''}`, text: won(v) }),
    ]);
  }));
}

// ── 목표 ─────────────────────────────────────────────────────────────────

/**
 * 목표 하나를 오늘 기준으로 풀어 본다.
 * 모은 돈은 계좌를 연결했으면 그 잔액을, 아니면 직접 적은 값을 쓴다.
 */
function readGoal(g) {
  const now = today();
  const target = Math.max(0, Number(g.targetAmount) || 0);
  const linked = g.accountId ? store.account(g.accountId) : null;
  const saved = linked
    ? Math.max(0, store.balances()[g.accountId] || 0)
    : Math.max(0, Number(g.saved) || 0);
  const left = Math.max(0, target - saved);
  const ratio = target ? Math.min(1, saved / target) : 0;
  const end = g.targetDate || now;
  const start = g.startDate || now;
  const overdue = end < now;
  const done = target > 0 && saved >= target;
  const notStarted = start > now;

  // 아직 시작 전이면 시작일부터, 이미 시작했으면 오늘부터 남은 기간을 센다
  const parts = untilParts(notStarted ? start : now, end);
  // 달마다 한 번 넣는다고 보면, 남은 달 수에 이번 달 몫 하나를 더한 만큼 넣을 수 있다
  const rounds = overdue ? 0 : parts.months + (parts.days > 0 ? 1 : 0);
  const perMonth = done || rounds <= 0 ? 0 : Math.ceil(left / rounds / 1000) * 1000;
  const perDay = done || parts.totalDays <= 0 ? 0 : Math.ceil(left / parts.totalDays / 100) * 100;
  const startsIn = notStarted ? daysBetween(now, start) : 0;

  // 시작일부터 목표일까지 고르게 모은다고 보면 지금쯤 얼마가 있어야 하나
  const span = Math.max(1, daysBetween(start, end));
  const gone = Math.max(0, Math.min(span, daysBetween(start, now)));
  const onPlan = target * (gone / span);
  const ahead = saved - onPlan;

  return {
    ...g, target, saved, left, ratio, parts, overdue, done, notStarted, startsIn,
    rounds, perMonth, perDay, linked, start, end, onPlan, ahead, span, gone,
  };
}

function goalCard(g) {
  const state = g.done ? 'good' : g.overdue ? 'crit' : g.ratio >= 0.8 ? 'good' : 'accent';
  const dday = g.overdue
    ? `D+${Math.abs(g.parts.totalDays)}`
    : g.parts.totalDays === 0 ? 'D-DAY' : `D-${g.parts.totalDays}`;
  const span = g.overdue
    ? '목표일이 지났어요'
    : g.parts.months > 0
      ? `${g.parts.months}개월${g.parts.days ? ` ${g.parts.days}일` : ''} 남음`
      : `${g.parts.days}일 남음`;
  // 계획보다 앞서는지 뒤처지는지. 목표의 2% 안쪽 차이는 '계획대로' 로 본다.
  const slack = Math.max(10000, g.target * 0.02);
  const round1k = (v) => Math.round(v / 1000) * 1000;
  const pace = g.done || g.notStarted || g.target <= 0 ? null
    : g.ahead > slack ? { text: `계획보다 ${won(round1k(g.ahead))} 앞서요`, color: 'good' }
      : g.ahead < -slack ? { text: `계획보다 ${won(round1k(-g.ahead))} 뒤처져요`, color: 'crit' }
        : { text: '계획대로 가고 있어요', color: 'good' };

  return card({ class: 'lift' }, [
    el('div', { class: 'card-head' }, [
      el('h2', { text: `${g.emoji || '⚑'} ${g.name}` }),
      el('span', { class: 'sub', text: `${g.targetDate} · ${dday}` }),
      el('span', { class: 'spacer' }),
      el('button', { class: 'btn sm', text: '고치기', onclick: () => openGoalSheet(g) }),
    ]),

    el('div', { class: 'hero' }, [
      el('div', { class: 'hero-main' }, [
        el('span', { class: 'eyebrow', text: g.done ? '다 모았어요' : g.overdue ? '아직 모자란 돈' : g.notStarted ? `${g.startsIn}일 뒤부터 매달` : '매달 넣어야 하는 돈' }),
        el('span', { class: 'hero-figure', text: g.done ? won(g.saved) : g.overdue ? won(g.left) : won(g.perMonth) }),
        el('span', { class: 'hero-note', text: g.done
          ? '목표를 채웠어요. 축하해요!'
          : g.overdue
            ? `${dday} · 목표일을 다시 잡거나 모은 돈을 올려 주세요`
            : g.notStarted
              ? `${g.start}부터 ${g.rounds}번 넣으면 돼요`
              : `${g.rounds}번 더 넣으면 돼요 · 하루로 치면 ${won(g.perDay)}` }),
      ]),
      el('div', { class: 'hero-side' }, [
        el('div', { class: 'kv' }, [el('span', { class: 'k', text: '목표' }), el('span', { class: 'v', text: won(g.target) })]),
        el('div', { class: 'kv' }, [el('span', { class: 'k', text: '모은 돈' }), el('span', { class: 'v in', text: won(g.saved) })]),
        el('div', { class: 'kv' }, [el('span', { class: 'k', text: '남은 돈' }), el('span', { class: 'v out', text: won(g.left) })]),
        el('div', { class: 'kv' }, [el('span', { class: 'k', text: '남은 기간' }), el('span', { class: 'v', text: span })]),
      ]),
    ]),

    el('div', { class: 'progress', style: 'margin:12px 0 0' }, [
      el('div', { class: 'progress-head' }, [
        el('span', { style: `color:var(--${state === 'accent' ? 'accent' : state});font-weight:600`, text: `${(g.ratio * 100).toFixed(g.ratio > 0 && g.ratio < 0.1 ? 1 : 0)}% 모음` }),
        el('span', { class: 'spacer' }),
        el('span', { class: 'k', style: 'font-size:12px;color:var(--ink-3)', text: `${g.start} → ${g.end}${g.linked ? ` · ${g.linked.name} 잔액으로 자동 계산` : ''}` }),
      ]),
      el('span', { class: 'track' }, [
        el('span', { class: 'fill', style: `width:${g.ratio * 100}%;background:var(--${state === 'accent' ? 'accent' : state})` }),
        // 시작일부터 목표일까지 고르게 모았다면 지금쯤 와 있어야 할 자리
        pace ? el('span', {
          class: 'mark', style: `left:${Math.min(100, (g.onPlan / (g.target || 1)) * 100)}%`,
          title: `계획대로라면 지금쯤 ${won(g.onPlan)}`,
        }) : null,
      ]),
      pace ? el('div', { class: 'progress-head' }, [
        el('span', { style: `color:var(--${pace.color});font-weight:600`, text: pace.text }),
        el('span', { class: 'spacer' }),
        el('span', { style: 'color:var(--ink-3)', text: `계획대로라면 지금쯤 ${won(Math.round(g.onPlan / 1000) * 1000)}` }),
      ]) : null,
    ]),
  ]);
}

function viewGoals() {
  const goals = (store.config.goals || []).map(readGoal)
    .sort((a, b) => (a.done !== b.done ? (a.done ? 1 : -1) : (a.targetDate || '').localeCompare(b.targetDate || '')));
  const out = [];

  const live = goals.filter((g) => !g.done);
  out.push(card({ class: 'lift' }, [
    el('div', { class: 'hero' }, [
      el('div', { class: 'hero-main' }, [
        el('span', { class: 'eyebrow', text: '모으는 중인 목표' }),
        el('span', { class: 'hero-figure', text: live.length ? won(sum(live, (g) => g.perMonth)) : '목표 없음' }),
        el('span', { class: 'hero-note', text: live.length
          ? `${live.length}개 목표를 다 맞추려면 매달 이만큼 넣어야 해요`
          : '목표일과 목표 금액을 넣으면 매달 얼마씩 모아야 하는지 계산해 드려요' }),
      ]),
      el('div', { class: 'hero-side' }, [
        el('div', { class: 'kv' }, [el('span', { class: 'k', text: '목표 합계' }), el('span', { class: 'v', text: won(sum(goals, (g) => g.target)) })]),
        el('div', { class: 'kv' }, [el('span', { class: 'k', text: '모은 돈' }), el('span', { class: 'v in', text: won(sum(goals, (g) => g.saved)) })]),
        el('div', { class: 'kv' }, [el('span', { class: 'k', text: '남은 돈' }), el('span', { class: 'v out', text: won(sum(goals, (g) => g.left)) })]),
      ]),
    ]),
    el('div', { style: 'margin-top:12px' }, [
      el('button', { class: 'btn primary', text: '＋ 목표 만들기', onclick: () => openGoalSheet(null) }),
    ]),
  ]));

  if (!goals.length) {
    out.push(card({}, [el('p', { class: 'empty', style: 'padding:24px 10px', text: '아직 목표가 없어요. 신혼여행 자금, 전세 보증금, 차 바꾸기 같은 것을 넣어 보세요.' })]));
    return out;
  }

  // 둘씩 나란히 — 한 장씩 늘어놓으면 오른쪽이 빈다
  for (let i = 0; i < goals.length; i += 2) {
    out.push(pair(goalCard(goals[i]), goals[i + 1] ? goalCard(goals[i + 1]) : null));
  }
  return out;
}

/** 목표 하나를 만들거나 고친다 */
function openGoalSheet(existing) {
  const draft = existing ? { ...existing } : {
    id: uid('g_'), name: '', emoji: '⚑', targetAmount: '',
    startDate: today(), targetDate: addMonths(today(), 12), saved: '', accountId: null,
  };
  const body = el('div', {});

  const draw = () => {
    const preview = readGoal({ ...draft, targetAmount: Number(draft.targetAmount) || 0, saved: Number(draft.saved) || 0 });
    body.replaceChildren(
      el('div', { class: 'field' }, [
        el('label', { for: 'g-name', text: '무엇을 위해 모으나요' }),
        el('div', { class: 'listline', style: 'border:0;padding:0;gap:8px' }, [
          el('button', {
            class: 'emoji-btn', type: 'button', text: draft.emoji, 'aria-label': '아이콘 바꾸기',
            onclick: () => openEmojiSheet(draft.emoji, (emo) => openGoalSheet({ ...draft, emoji: emo })),
          }),
          el('input', {
            id: 'g-name', type: 'text', value: draft.name, placeholder: '예: 신혼여행, 전세 보증금, 차 바꾸기',
            oninput: (e) => { draft.name = e.target.value; },
          }),
        ]),
      ]),
      el('div', { class: 'field amount' }, [
        el('label', { text: '목표 금액 (원)' }),
        moneyInput({ value: draft.targetAmount === '' ? null : draft.targetAmount, placeholder: '0', label: '목표 금액', onCommit: (v) => { draft.targetAmount = v ?? ''; draw(); } }),
      ]),
      el('div', { class: 'row2' }, [
        el('div', { class: 'field' }, [
          el('label', { for: 'g-start', text: '모으기 시작하는 날' }),
          el('input', { id: 'g-start', type: 'date', value: draft.startDate, onchange: (e) => { draft.startDate = e.target.value || today(); draw(); } }),
        ]),
        el('div', { class: 'field' }, [
          el('label', { for: 'g-date', text: '목표일' }),
          el('input', { id: 'g-date', type: 'date', value: draft.targetDate, min: draft.startDate, onchange: (e) => { draft.targetDate = e.target.value || today(); draw(); } }),
        ]),
      ]),
      el('div', { class: 'field' }, [
        el('label', { text: '모은 돈을 어떻게 셀까요' }),
        el('div', { class: 'picker' }, [
          el('button', {
            'aria-pressed': !draft.accountId ? 'true' : 'false', text: '내가 직접 입력',
            onclick: () => { draft.accountId = null; draw(); },
          }),
          el('button', {
            'aria-pressed': draft.accountId ? 'true' : 'false', text: '통장 잔액에서 자동으로',
            onclick: () => { draft.accountId = draft.accountId || store.config.accounts[0]?.id || null; draw(); },
          }),
        ]),
      ]),
      draft.accountId
        ? el('div', { class: 'field' }, [
          el('label', { for: 'g-acct', text: '어느 통장' }),
          el('select', { id: 'g-acct', onchange: (e) => { draft.accountId = e.target.value; draw(); } },
            store.config.accounts.map((a) => el('option', { value: a.id, text: a.name, selected: draft.accountId === a.id }))),
          el('span', { class: 'hint', text: '이 통장에 돈을 넣을 때마다 모은 돈이 저절로 올라가요. 목표에 따로 적을 필요가 없습니다.' }),
        ])
        : el('div', { class: 'field amount' }, [
          el('label', { text: '지금까지 모은 돈 (원)' }),
          moneyInput({ value: draft.saved === '' ? null : draft.saved, placeholder: '0', label: '모은 돈', onCommit: (v) => { draft.saved = v ?? ''; draw(); } }),
          el('span', { class: 'hint', text: '돈을 넣을 때마다 이 숫자를 직접 고쳐 주셔야 해요.' }),
        ]),
      el('div', { class: 'banner' }, [
        preview.target > 0 && !preview.overdue
          ? el('span', {}, [
            preview.notStarted ? `${preview.start}부터 ` : '',
            '매달 ', el('b', { class: 'num', text: won(preview.perMonth) }), ' 씩 ',
            el('b', { text: `${preview.rounds}번` }), ' 넣으면 목표일에 맞출 수 있어요.',
          ])
          : el('span', { text: preview.overdue ? '목표일이 오늘보다 앞서 있어요.' : '목표 금액을 넣으면 매달 얼마씩 모아야 하는지 계산해 드려요.' }),
      ]),
    );
  };
  draw();

  const save = async () => {
    if (!draft.name.trim()) { toast('목표 이름을 넣어 주세요'); return; }
    if (!draft.targetAmount || Number(draft.targetAmount) <= 0) { toast('목표 금액을 넣어 주세요'); return; }
    if (draft.targetDate <= draft.startDate) { toast('목표일은 시작일보다 뒤여야 해요'); return; }
    const item = {
      id: draft.id,
      name: draft.name.trim(),
      emoji: draft.emoji || '⚑',
      targetAmount: Number(draft.targetAmount),
      startDate: draft.startDate || today(),
      targetDate: draft.targetDate,
      accountId: draft.accountId || null,
      saved: draft.accountId ? 0 : Number(draft.saved) || 0,
      createdAt: existing?.createdAt || Date.now(),
    };
    const list = store.config.goals || [];
    await store.saveConfig({
      goals: list.some((x) => x.id === item.id) ? list.map((x) => (x.id === item.id ? item : x)) : [...list, item],
    });
    closeSheet();
    toast(existing ? '목표를 고쳤어요' : '목표를 만들었어요');
  };

  openSheet(existing ? '목표 고치기' : '목표 만들기', [body], [
    el('button', { class: 'btn primary', text: '저장', onclick: save }),
  ], existing ? [el('button', {
    class: 'btn danger', text: '삭제',
    onclick: () => confirmThen(`'${existing.name}' 목표를 지울까요?`, async () => {
      await store.saveConfig({ goals: (store.config.goals || []).filter((x) => x.id !== existing.id) });
      closeSheet();
      toast('목표를 지웠어요');
    }),
  })] : []);
}

// ── 설정 ─────────────────────────────────────────────────────────────────

/**
 * 제목을 그 자리에서 고치는 입력칸.
 * 입력칸은 폭이 고정되면 긴 이름이 잘리니, 글자 수를 틀(.titlefit)에 알려 주고
 * 틀이 넓어지는 만큼 칸도 같이 넓어지게 한다.
 */
function titleInput(value, label, onCommit) {
  return el('span', { class: 'titlefit', 'data-value': value }, [
    el('input', {
      class: 'titleinput', type: 'text', value, 'aria-label': label,
      oninput: (e) => { e.target.parentElement.dataset.value = e.target.value; },
      onchange: (e) => onCommit(e.target.value.trim() || '이름 없음'),
    }),
  ]);
}

const wheelCache = new Map();

/**
 * 색상환 한 장을 그린다. 중심에서 멀어지면 선명해지고, 각도가 색조다.
 * 화면이 낼 수 없는 색은 선명도를 깎아 그린다 — 눌렀을 때 입혀지는 색과
 * 보이는 색을 같게 하려는 것이다.
 */
function paintWheel(canvas, px, L, cScale) {
  const ctx = canvas.getContext('2d');
  const key = `${px}|${L}|${cScale}`;
  const hit = wheelCache.get(key);
  if (hit) { ctx.putImageData(hit, 0, 0); return; }

  const img = ctx.createImageData(px, px);
  const mid = px / 2;
  const cap = [];
  for (let h = 0; h < 360; h += 1) cap.push(maxChroma(L, h));
  for (let y = 0; y < px; y += 1) {
    for (let x = 0; x < px; x += 1) {
      const dx = x - mid + 0.5;
      const dy = y - mid + 0.5;
      const d = Math.hypot(dx, dy);
      if (d > mid) continue;
      const h = ((Math.atan2(-dy, dx) * 180) / Math.PI + 360) % 360;
      const c = Math.min((d / mid) * MAX_CHROMA * cScale, cap[Math.round(h) % 360]);
      const [r, g, b] = oklchToRgbClipped(L, c, h);
      const i = (y * px + x) * 4;
      img.data[i] = r;
      img.data[i + 1] = g;
      img.data[i + 2] = b;
      img.data[i + 3] = Math.round(Math.min(1, mid - d) * 255);
    }
  }
  wheelCache.set(key, img);
  ctx.putImageData(img, 0, 0);
}

/**
 * 강조색 고르기.
 * 색상환에서 색조와 선명도만 집고 밝기는 앱이 정한다. 그래서 어떤 색을 골라도
 * 버튼 위의 글씨가 읽히고, 다크 모드에서도 색이 묻히지 않는다.
 * 환에 보이는 색이 곧 지금 테마에서 입혀지는 색이다.
 */
function accentField() {
  const SIZE = 156;
  const px = SIZE * 2;
  const root = document.documentElement;
  const set = root.getAttribute('data-theme');
  const dark = set === 'dark' || (!set && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const L = dark ? 0.78 : 0.42;
  const cScale = dark ? 0.85 : 1;

  let sel = normalize(store.config.settings.accent);

  const canvas = el('canvas', { width: String(px), height: String(px), style: `width:${SIZE}px;height:${SIZE}px` });
  const dot = el('span', { class: 'wheel-dot' });
  const readout = el('span', { class: 'hint' });

  const pick = (h, c, save) => {
    sel = {
      h: ((h % 360) + 360) % 360,
      c: Math.max(0, Math.min(MAX_CHROMA, c)),
    };
    applyAccent(sel);
    show();
    if (save) {
      store.saveConfig({ settings: { ...store.config.settings, accent: sel } });
      // 저장하면 화면을 다시 그리니, 방향키로 고르던 중이었다면 환으로 초점을 돌려준다
      setTimeout(() => {
        const again = document.getElementById('accent-wheel');
        if (again && document.activeElement !== again) again.focus();
      }, 0);
    }
  };

  const presets = el('div', { class: 'swatches' }, PRESETS.map((pr) => {
    const a = deriveAccent(pr.h, pr.c);
    return el('button', {
      class: 'swatchbtn', type: 'button', 'data-key': pr.key, 'aria-label': pr.name,
      style: `--sw:${a.light.base};--swd:${a.dark.base}`,
      onclick: () => pick(pr.h, pr.c, true),
    }, [el('span', { class: 'chip-name', text: pr.name })]);
  }));

  function show() {
    const r = sel.c / MAX_CHROMA;
    const a = (sel.h * Math.PI) / 180;
    dot.style.left = `${50 + Math.cos(a) * r * 50}%`;
    dot.style.top = `${50 - Math.sin(a) * r * 50}%`;
    readout.textContent = `색조 ${Math.round(sel.h)}° · 선명도 ${Math.round(r * 100)}%`;
    for (const btn of presets.children) {
      const pr = PRESETS.find((x) => x.key === btn.dataset.key);
      const dh = Math.abs(((pr.h - sel.h + 540) % 360) - 180);
      btn.setAttribute('aria-pressed', dh < 2 && Math.abs(pr.c - sel.c) < 0.006 ? 'true' : 'false');
    }
  }

  const fromPoint = (e, save) => {
    const box = wrap.getBoundingClientRect();
    const dx = e.clientX - box.left - box.width / 2;
    const dy = e.clientY - box.top - box.height / 2;
    const r = Math.min(1, Math.hypot(dx, dy) / (box.width / 2));
    pick((Math.atan2(-dy, dx) * 180) / Math.PI, r * MAX_CHROMA, save);
  };

  let keyTimer = 0;
  const wrap = el('div', {
    class: 'wheelwrap', id: 'accent-wheel', tabindex: '0', role: 'application',
    'aria-label': '강조색 색상환. 좌우 방향키로 색을, 위아래 방향키로 선명도를 바꿔요',
    style: `width:${SIZE}px;height:${SIZE}px`,
    onpointerdown: (e) => {
      e.preventDefault();
      wrap.focus();
      fromPoint(e, false);
      // 끌고 있는 동안에는 바로 입혀서 보여 주고, 손을 뗄 때 한 번만 저장한다
      const move = (ev) => fromPoint(ev, false);
      const up = (ev) => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        fromPoint(ev, true);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    },
    onkeydown: (e) => {
      const step = {
        ArrowRight: [4, 0], ArrowLeft: [-4, 0], ArrowUp: [0, 0.01], ArrowDown: [0, -0.01],
      }[e.key];
      if (!step) return;
      e.preventDefault();
      pick(sel.h + step[0], sel.c + step[1], false);
      // 누를 때마다 저장하면 화면이 계속 다시 그려진다. 손을 멈춘 뒤에 한 번만.
      clearTimeout(keyTimer);
      keyTimer = setTimeout(() => pick(sel.h, sel.c, true), 500);
    },
  }, [canvas, dot]);

  paintWheel(canvas, px, L, cScale);
  show();

  return el('div', { class: 'field' }, [
    el('label', { text: '강조색' }),
    el('div', { class: 'accentpick' }, [
      wrap,
      el('div', { class: 'side' }, [
        presets,
        readout,
        el('span', { class: 'hint', text: '버튼과 선택 표시에 쓰이는 색이에요. 밝기는 앱이 맞춰 주니 색만 고르면 돼요. 함께 쓰는 사람 모두에게 같은 색으로 보입니다.' }),
      ]),
    ]),
  ]);
}


/** 묶음 하나가 매달 움직이는 돈. 꺼 둔 항목은 세지 않는다. */
function recurringTotals(items) {
  const on = items.filter((r) => r.active);
  const by = (kind) => sum(on.filter((r) => r.kind === kind), (r) => r.amount);
  const expense = by('expense');
  const transfer = by('transfer');
  const income = by('income');
  // 이체는 통장만 바꾸는 돈이라 자산이 줄지 않지만, 통장에서 빠져나가는 건 같다.
  return { expense, transfer, income, out: expense + transfer, count: on.length };
}

/** 합계 몇 개를 한 줄에 늘어놓는다 */
function sumstrip(rows) {
  return el('div', { class: 'sumstrip' }, rows.map(([k, v, tone, lead]) => el('div', { class: lead ? 'kv lead' : 'kv' }, [
    el('span', { class: 'k', text: k }),
    el('span', { class: 'v', style: tone ? `color:var(--${tone})` : null, text: won(v) }),
  ])));
}

/** 묶음의 합계 줄. 수입은 들어오는 게 있을 때만 보여 준다. */
function recurringStrip(t) {
  return sumstrip([
    ['총 고정지출', t.out, null, true],
    ['총 지출', t.expense, 'out'],
    ['총 이체', t.transfer, 'ink-3'],
    ...(t.income ? [['총 수입', t.income, 'in']] : []),
  ]);
}

const RECURRING_NOTE = '총 고정지출은 지출과 이체를 더한, 매달 통장에서 빠져나가는 돈이에요. 이체는 다른 통장으로 옮기는 것이라 자산이 줄지는 않아요.';

/** 고정 내역 묶음 한 장. 제목을 그 자리에서 고칠 수 있다. */
function recurringGroupCard(group, items, showNote) {
  const groups = store.config.recurringGroups || [];
  const t = recurringTotals(items);

  const head = el('div', { class: 'card-head' }, [
    titleInput(group.name, '묶음 이름', (name) => store.saveConfig({
      recurringGroups: groups.map((x) => (x.id === group.id ? { ...x, name } : x)),
    })),
    el('span', {
      class: 'sub',
      text: items.length
        ? `${items.length}건${t.count < items.length ? ` · 켠 것 ${t.count}건` : ''}`
        : '아직 비어 있어요',
    }),
    el('span', { class: 'spacer' }),
    el('button', { class: 'btn sm', text: '+ 추가', onclick: () => openRecurringSheet(null, group.id) }),
    groups.length > 1 ? el('button', {
      class: 'btn sm danger', text: '묶음 삭제',
      onclick: () => confirmThen(
        items.length
          ? `'${group.name}' 묶음을 지울까요? 안에 있던 ${items.length}건은 '${groups.find((x) => x.id !== group.id).name}' 으로 옮겨져요.`
          : `'${group.name}' 묶음을 지울까요?`,
        async () => {
          const fallback = groups.find((x) => x.id !== group.id).id;
          await store.saveConfig({
            recurringGroups: groups.filter((x) => x.id !== group.id),
            recurring: (store.config.recurring || []).map((r) => (
              (r.groupId || groups[0]?.id) === group.id ? { ...r, groupId: fallback } : r)),
          });
          toast('묶음을 지웠어요');
        },
      ),
    }) : null,
  ]);

  const rows = items.length
    ? [sortableList('recurring', items, (r) => el('div', { class: 'listline' }, [
      el('button', {
        class: 'chip', 'aria-pressed': r.active ? 'true' : 'false',
        text: r.active ? '켬' : '끔', title: '끄면 다음 달부터 적히지 않아요',
        onclick: () => store.saveConfig({
          recurring: store.config.recurring.map((x) => (x.id === r.id ? { ...x, active: !x.active } : x)),
        }),
      }),
      el('button', {
        class: 'btn sm ghost', style: 'flex:1;justify-content:flex-start;text-align:left',
        text: `${r.name || '이름 없음'}`, onclick: () => openRecurringSheet(r),
      }),
      el('span', { class: 'tag', text: { expense: '지출', income: '수입', transfer: '이체' }[r.kind] || '지출' }),
      el('span', { class: 'tag', text: `매월 ${r.day}일` }),
      r.kind === 'transfer'
        ? el('span', { class: 'tag', text: `${store.account(r.accountId)?.name || '?'} → ${store.account(r.toAccountId)?.name || '?'}` })
        : null,
      el('span', { class: 'spacer' }),
      el('span', { class: 'num', style: `font-weight:600;color:var(--${r.kind === 'income' ? 'in' : r.kind === 'transfer' ? 'ink-3' : 'out'})`, text: won(r.amount) }),
      el('button', { class: 'btn sm', text: '고치기', onclick: () => openRecurringSheet(r) }),
    ]))]
    : [el('p', { class: 'empty', text: '월세·통신비처럼 매달 나가는 돈, 급여처럼 들어오는 돈, 급여일에 다른 통장으로 보내는 이체를 넣어 두면 직접 적지 않아도 돼요.' })];

  const totals = items.length
    ? [recurringStrip(t), showNote && t.transfer ? el('span', { class: 'hint', text: RECURRING_NOTE }) : null]
    : [];

  return el('section', { class: 'card' }, [head, ...totals, ...rows]);
}

/** 매달 자동으로 적히는 항목 하나를 만들거나 고친다 */
function openRecurringSheet(existing, groupId) {
  const cats = () => store.config.categories;
  const groups = store.config.recurringGroups || [];
  const draft = existing ? { ...existing } : {
    id: uid('rc_'), name: '', amount: '', kind: 'expense',
    groupId: groupId || groups[0]?.id || null,
    categoryId: cats().find((c) => c.kind === 'expense')?.id || null,
    accountId: store.config.accounts[0]?.id || null,
    toAccountId: store.config.accounts[1]?.id || null,
    day: 1, active: true, lastRun: null,
  };
  let backfill = !existing;
  const body = el('div', {});

  const draw = () => {
    const kindCats = cats().filter((c) => c.kind === draft.kind);
    if (draft.kind !== 'transfer' && !kindCats.some((c) => c.id === draft.categoryId)) draft.categoryId = kindCats[0]?.id || null;
    body.replaceChildren(
      el('div', { class: 'picker', style: 'margin-bottom:14px' }, [
        ['expense', '지출'], ['income', '수입'], ['transfer', '이체'],
      ].map(([k, n]) => el('button', {
        'aria-pressed': draft.kind === k ? 'true' : 'false', text: n,
        onclick: () => { draft.kind = k; draw(); },
      }))),
      groups.length > 1 ? el('div', { class: 'field' }, [
        el('label', { text: '어느 묶음에' }),
        el('div', { class: 'picker' }, groups.map((g) => el('button', {
          'aria-pressed': (draft.groupId || groups[0]?.id) === g.id ? 'true' : 'false', text: g.name,
          onclick: () => { draft.groupId = g.id; draw(); },
        }))),
      ]) : null,
      el('div', { class: 'field' }, [
        el('label', { for: 'rc-name', text: '이름' }),
        el('input', {
          id: 'rc-name', type: 'text', value: draft.name, placeholder: '예: 월세, 통신비, 적금 자동이체',
          oninput: (e) => { draft.name = e.target.value; },
        }),
      ]),
      el('div', { class: 'row2' }, [
        el('div', { class: 'field amount' }, [
          el('label', { text: '금액 (원)' }),
          moneyInput({ value: draft.amount === '' ? null : draft.amount, placeholder: '0', label: '금액', onCommit: (v) => { draft.amount = v ?? ''; } }),
        ]),
        el('div', { class: 'field' }, [
          el('label', { for: 'rc-day', text: '매월 며칠' }),
          el('select', { id: 'rc-day', onchange: (e) => { draft.day = Number(e.target.value); } },
            Array.from({ length: 31 }, (_, i) => el('option', { value: i + 1, text: `${i + 1}일`, selected: draft.day === i + 1 }))),
          el('span', { class: 'hint', text: '없는 날이면 그 달 마지막 날에 적혀요.' }),
        ]),
      ]),
      el('div', { class: 'field' }, [
        el('label', { for: 'rc-acct', text: draft.kind === 'transfer' ? '보내는 계좌' : '결제수단' }),
        el('select', { id: 'rc-acct', onchange: (e) => { draft.accountId = e.target.value; } },
          store.config.accounts.map((a) => el('option', { value: a.id, text: a.name, selected: draft.accountId === a.id }))),
      ]),
      draft.kind === 'transfer'
        ? el('div', { class: 'field' }, [
          el('label', { for: 'rc-to', text: '받는 계좌' }),
          el('select', { id: 'rc-to', onchange: (e) => { draft.toAccountId = e.target.value; } },
            store.config.accounts.map((a) => el('option', { value: a.id, text: a.name, selected: draft.toAccountId === a.id }))),
        ])
        : el('div', { class: 'field' }, [
          el('label', { text: '분류' }),
          el('div', { class: 'picker' }, kindCats.map((c) => el('button', {
            'aria-pressed': draft.categoryId === c.id ? 'true' : 'false', text: `${c.emoji} ${c.name}`,
            onclick: () => { draft.categoryId = c.id; draw(); },
          }))),
        ]),
      existing ? null : el('div', { class: 'banner' }, [
        el('label', { style: 'display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer' }, [
          el('input', { type: 'checkbox', checked: backfill, onchange: (e) => { backfill = e.target.checked; } }),
          '이번 달 것부터 적기',
        ]),
      ]),
    );
  };
  draw();

  const save = async () => {
    if (!draft.name.trim()) { toast('이름을 넣어 주세요'); return; }
    if (!draft.amount || Number(draft.amount) <= 0) { toast('금액을 넣어 주세요'); return; }
    if (draft.kind === 'transfer' && draft.accountId === draft.toAccountId) { toast('보내는 계좌와 받는 계좌가 같아요'); return; }
    const item = {
      ...draft, name: draft.name.trim(), amount: Number(draft.amount),
      groupId: draft.groupId || groups[0]?.id || null,
    };
    if (!existing) item.lastRun = backfill ? monthKey(addMonths(today(), -1)) : monthKey(today());
    const list = existing
      ? store.config.recurring.map((r) => (r.id === item.id ? item : r))
      : [...(store.config.recurring || []), item];
    await store.saveConfig({ recurring: list });
    const made = await store.runRecurring();
    closeSheet();
    toast(made ? `저장했어요 · ${made}건을 적었어요` : '저장했어요');
  };

  openSheet(existing ? '반복 내역 고치기' : '매달 반복되는 내역 만들기', [body], [
    el('button', { class: 'btn primary', text: '저장', onclick: save }),
  ], existing ? [el('button', {
    class: 'btn danger', text: '삭제',
    onclick: () => confirmThen('이 고정 내역을 지울까요? 이미 적힌 기록은 그대로 남아요.', async () => {
      await store.saveConfig({ recurring: store.config.recurring.filter((r) => r.id !== existing.id) });
      closeSheet();
      toast('고정 내역을 지웠어요');
    }),
  })] : []);
}

function viewSettings() {
  const cfg = store.config;
  const out = [];

  out.push(shareCard());

  out.push(card({ title: '우리집' }, [
    el('div', { class: 'field' }, [
      el('label', { for: 'set-house', text: '가계부 이름' }),
      el('input', {
        id: 'set-house', type: 'text', value: cfg.settings.household,
        onchange: (e) => store.saveConfig({ settings: { ...cfg.settings, household: e.target.value.trim() || '우리집 가계부' } }),
      }),
    ]),
    el('div', { class: 'field' }, [
      el('label', { for: 'set-shared', text: '공동 생활비 통장' }),
      el('select', {
        id: 'set-shared',
        onchange: (e) => store.saveConfig({ settings: { ...cfg.settings, sharedAccountId: e.target.value || null } }),
      }, [
        el('option', { value: '', text: '쓰지 않음', selected: !cfg.settings.sharedAccountId }),
        ...cfg.accounts.map((a) => el('option', { value: a.id, text: a.name, selected: cfg.settings.sharedAccountId === a.id })),
      ]),
      el('span', { class: 'hint', text: '둘이 돈을 모아 쓰는 통장을 고르면 대시보드에 분담과 잔액이 따로 보여요.' }),
    ]),
    accentField(),
    el('div', { class: 'field' }, [
      el('label', { text: '화면 테마' }),
      el('div', { class: 'picker' }, ['system', 'light', 'dark'].map((v) => el('button', {
        'aria-pressed': (localStorage.getItem('hab.theme') || 'system') === v ? 'true' : 'false',
        text: { system: '기기 설정', light: '밝게', dark: '어둡게' }[v],
        onclick: () => { applyTheme(v); rerender(); },
      }))),
    ]),
  ]));

  // 묶음마다 한 장씩. 공동 · 내 것 · 신부 것처럼 사람이나 성격별로 나눠 담는다.
  const groups = store.config.recurringGroups || [];
  const rec = store.config.recurring || [];
  if (groups.length > 1 && rec.length) {
    const all = recurringTotals(rec);
    out.push(el('section', { class: 'card flat' }, [
      el('div', { class: 'card-head' }, [
        el('h2', { text: '고정 내역 전체' }),
        el('span', { class: 'sub', text: `묶음 ${groups.length}개 · 켠 것 ${all.count}건` }),
      ]),
      recurringStrip(all),
      el('span', { class: 'hint', text: RECURRING_NOTE }),
    ]));
  }
  for (const g of groups) {
    out.push(recurringGroupCard(g, rec.filter((r) => (r.groupId || groups[0]?.id) === g.id), groups.length === 1));
  }
  out.push(el('div', {}, [
    el('button', {
      class: 'btn', text: '＋ 고정 내역 묶음 추가',
      onclick: () => openSheet('새 묶음', [
        el('p', { style: 'font-size:13px;color:var(--ink-2);margin:0 0 12px', text: '고정 내역을 사람이나 성격별로 나눠 담는 상자예요. 예: 내 고정지출, 신부 고정지출, 강아지.' }),
        el('div', { class: 'field' }, [
          el('label', { for: 'rg-name', text: '묶음 이름' }),
          el('input', { id: 'rg-name', type: 'text', placeholder: '예: 내 고정지출' }),
        ]),
      ], [
        el('button', {
          class: 'btn primary', text: '만들기',
          onclick: async () => {
            const name = document.getElementById('rg-name').value.trim();
            if (!name) { toast('묶음 이름을 넣어 주세요'); return; }
            await store.saveConfig({ recurringGroups: [...groups, { id: uid('rg_'), name }] });
            closeSheet();
            toast('묶음을 만들었어요');
          },
        }),
      ]),
    }),
  ]));

  out.push(card({
    title: '분류와 예산',
    sub: '끌어서 순서를 바꾸고, 아이콘을 눌러 고릅니다 · 월 예산을 비우면 예산 관리에서 빠져요',
    actions: [
      el('button', {
        class: 'btn sm', text: '+ 지출',
        onclick: () => store.saveConfig({ categories: [...cfg.categories, { id: uid('c_'), name: '새 지출 분류', emoji: '🏷️', kind: 'expense', budget: null }] }),
      }),
      el('button', {
        class: 'btn sm', text: '+ 수입',
        onclick: () => store.saveConfig({ categories: [...cfg.categories, { id: uid('i_'), name: '새 수입 분류', emoji: '💰', kind: 'income', budget: null }] }),
      }),
    ],
  }, [sortableList('categories', cfg.categories, (c, i) => el('div', { class: 'listline' }, [
    el('button', {
      class: 'emoji-btn', type: 'button', text: c.emoji, 'aria-label': `${c.name} 아이콘 바꾸기`,
      onclick: () => openEmojiSheet(c.emoji, (emo) => patchList('categories', i, { emoji: emo })),
    }),
    el('input', {
      type: 'text', value: c.name, 'aria-label': '분류 이름',
      onchange: (e) => patchList('categories', i, { name: e.target.value.trim() || '이름 없음' }),
    }),
    el('span', { class: 'spacer' }),
    c.kind === 'expense' ? moneyInput({
      value: c.budget, placeholder: '월 예산', width: '130px', label: `${c.name} 월 예산`,
      onCommit: (v) => patchList('categories', i, { budget: v === null ? null : Math.abs(v) }),
    }) : el('span', { class: 'tag', text: '수입' }),
    el('button', {
      class: 'btn sm danger', text: '삭제',
      onclick: () => confirmThen(`'${c.name}' 분류를 지울까요? 이 분류로 적어둔 내역은 '분류 없음'이 돼요.`,
        () => store.saveConfig({ categories: cfg.categories.filter((x) => x.id !== c.id) })),
    }),
  ]))]));

  out.push(card({
    title: '계좌와 결제수단',
    sub: '끌어서 순서를 바꿉니다 · 대출·카드는 남은 빚을 양수로 · 숫자에서 빼고 싶은 계좌는 “장부에 표시”를 꺼요',
    actions: [el('button', {
      class: 'btn sm', text: '+ 계좌',
      onclick: () => store.saveConfig({ accounts: [...cfg.accounts, { id: uid('a_'), name: '새 계좌', type: 'bank', opening: 0 }] }),
    })],
  }, [sortableList('accounts', cfg.accounts, (a, i) => el('div', { class: 'listline' }, [
    el('input', {
      type: 'text', value: a.name, 'aria-label': '계좌 이름',
      onchange: (e) => patchList('accounts', i, { name: e.target.value.trim() || '이름 없음' }),
    }),
    el('select', {
      'aria-label': '계좌 종류', onchange: (e) => patchList('accounts', i, { type: e.target.value }),
    }, Object.entries(ACCOUNT_TYPES).map(([k, v]) => el('option', { value: k, text: `${v.emoji} ${v.label}`, selected: a.type === k }))),
    el('span', { class: 'spacer' }),
    // 대출·카드는 '얼마를 빚졌나'를 양수로 받아 적는다. 내부에서는 음수로 저장된다.
    moneyInput({
      value: ACCOUNT_TYPES[a.type]?.liability ? -(a.opening || 0) : a.opening || 0,
      width: '140px', allowNegative: !ACCOUNT_TYPES[a.type]?.liability,
      label: ACCOUNT_TYPES[a.type]?.liability ? `${a.name} 남은 빚` : `${a.name} 시작 잔액`,
      placeholder: ACCOUNT_TYPES[a.type]?.liability ? '남은 빚' : '시작 잔액',
      onCommit: (v) => patchList('accounts', i, {
        opening: ACCOUNT_TYPES[a.type]?.liability ? -Math.abs(v || 0) : Math.round(v || 0),
      }),
    }),
    // 점은 늘 자리를 잡고 있고 보이기만 켜고 끈다. 글자가 늘면 그 줄만 너비가 달라진다.
    el('button', {
      class: `btn sm notebtn ${a.note ? 'has' : ''}`,
      title: a.note || '이 계좌 잔액이 어떤 돈인지 적어 둡니다',
      onclick: () => openAccountNoteSheet(a),
    }, ['메모', el('span', { class: 'dot', text: '●' })]),
    el('button', {
      class: 'chip', 'aria-pressed': a.offDashboard ? 'false' : 'true',
      text: '장부에 표시', title: '끄면 대시보드와 자산 화면의 순자산 계산에서 빠집니다. 거래 기록은 그대로 남습니다.',
      onclick: () => patchList('accounts', i, { offDashboard: !a.offDashboard }),
    }),
    el('button', {
      class: 'btn sm danger', text: '삭제',
      onclick: () => confirmThen(`'${a.name}' 계좌를 지울까요?`,
        () => store.saveConfig({ accounts: cfg.accounts.filter((x) => x.id !== a.id) })),
    }),
  ]))]));

  const json = JSON.stringify(store.exportData(), null, 0);
  const whereText = {
    firebase: '이 장부는 Firebase에 저장돼 두 사람이 실시간으로 함께 씁니다',
    cloud: '이 장부는 클라우드에 저장돼 PC와 폰이 같은 내용을 봅니다',
    local: '이 장부는 이 브라우저에 저장됩니다',
  }[store.status];
  out.push(card({ title: '데이터', sub: whereText }, [
    el('p', { class: 'hint', style: 'font-size:12.5px;color:var(--ink-3);margin:0 0 12px', text: `거래 ${store.txns().length}건 · 분류 ${cfg.categories.length}개 · 계좌 ${cfg.accounts.length}개 · 순자산 ${won(store.netWorth().net)}` }),
    el('div', { class: 'quick' }, [
      el('button', {
        class: 'btn', text: '백업 복사',
        onclick: async () => {
          try { await navigator.clipboard.writeText(json); toast('백업 JSON을 클립보드에 복사했어요'); }
          catch { toast('복사에 실패했어요. 아래 상자에서 직접 선택해 주세요'); showBackupBox(json); }
        },
      }),
      el('button', { class: 'btn', text: '파일로 내려받기', onclick: () => downloadBackup(json) }),
      el('button', { class: 'btn', text: '백업 불러오기', onclick: openImportSheet }),
      store.hasSamples() ? el('button', { class: 'btn', text: '예시 내역 지우기', onclick: async () => { await store.clearSamples(); toast('예시 내역을 지웠어요'); } }) : null,
      !store.hasSamples() ? el('button', {
        class: 'btn', text: '예시 내역 다시 넣기',
        onclick: () => confirmThen('예시 내역을 다시 채워 넣을까요? 지금 기록은 그대로 남습니다.', async () => {
          const sample = buildSampleData();
          for (const items of Object.values(sample.months)) {
            for (const t of Object.values(items)) {
              const key = monthKey(t.date);
              (store.months[key] ||= {})[t.id] = t;
              await store.writeMonth(key, { [t.id]: t });
            }
          }
          store.emit();
          toast('예시 내역을 넣었어요');
        }),
      }) : null,
      el('button', { class: 'btn', text: '앱 업데이트 확인', onclick: forceUpdate }),
      el('button', {
        class: 'btn danger', text: '전부 지우고 새로 시작',
        onclick: () => confirmThen(
          store.status === 'firebase'
            ? '모든 거래와 계좌 잔액을 지우고 처음 상태로 되돌립니다. 함께 쓰는 중이라 상대방 화면에서도 사라지고, 되돌릴 수 없어요. 계속할까요?'
            : '모든 거래를 지우고 계좌 잔액을 0원으로 되돌립니다. 되돌릴 수 없어요. 계속할까요?',
          async () => {
            await store.resetAll();
            toast('처음 상태로 되돌렸어요');
          },
        ),
      }),
    ]),
    el('div', { id: 'backup-box' }),
    el('p', {
      style: 'font-size:11.5px;color:var(--ink-3);margin:14px 0 0',
      text: `앱 버전 ${APP_VERSION}`,
    }),
  ]));

  return out;
}

/**
 * 오프라인용 캐시를 통째로 버리고 다시 받는다.
 * 고친 코드가 배포됐는데 옛날 화면이 계속 보일 때 쓰는 탈출구.
 * 장부(브라우저 저장분·서버 저장분)는 건드리지 않는다.
 */
async function forceUpdate() {
  toast('최신 버전을 받는 중…');
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      for (const r of regs) {
        r.active?.postMessage('flush');
        await r.unregister();
      }
    }
    if (window.caches) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch {
    // 캐시를 못 지워도 새로고침은 해본다
  }
  // 주소에 시간을 붙여 브라우저 캐시까지 우회한다
  const url = new URL(location.href);
  url.searchParams.set('v', Date.now().toString(36));
  location.replace(url.toString());
}

/** 둘이 같은 장부를 실시간으로 쓰기 위한 연결 상태와 조작 */
function shareCard() {
  const s = store.share;
  const busy = s.busy;

  const status = s.error
    ? el('p', { style: 'font-size:13px;color:var(--crit);margin:0 0 12px', text: s.error })
    : null;

  // 1. 아직 Firebase 설정값을 안 넣은 상태
  if (!s.available) {
    return card({ title: '둘이 함께 쓰기', sub: '아직 연결 전' }, [
      el('p', { style: 'font-size:13.5px;line-height:1.7;color:var(--ink-2);margin:0 0 10px' },
        ['지금은 이 장부가 이 브라우저에만 있어요. Firebase를 연결하면 두 사람이 각자 폰에서 같은 장부를 실시간으로 쓸 수 있어요.']),
      el('ol', { style: 'font-size:13px;line-height:1.9;color:var(--ink-2);margin:0;padding-left:20px' }, [
        el('li', { text: 'Firebase 콘솔에서 웹 앱을 하나 만들고 설정값을 복사합니다.' }),
        el('li', { text: '저장소의 assets/firebase-config.js 에 붙여넣고 올립니다.' }),
        el('li', { text: 'Authentication에서 Google 로그인을 켜고, firestore.rules 를 배포합니다.' }),
      ]),
      el('p', { style: 'font-size:12px;color:var(--ink-3);margin:12px 0 0', text: '자세한 순서는 저장소 README의 “둘이 함께 쓰기” 항목에 적어 뒀어요.' }),
    ]);
  }

  // 2. 설정은 됐지만 로그인 전
  if (!s.user) {
    return card({ title: '둘이 함께 쓰기', sub: 'Firebase 준비됨' }, [
      status,
      el('p', { style: 'font-size:13.5px;color:var(--ink-2);margin:0 0 12px', text: '구글 계정으로 로그인하면 두 사람이 같은 장부를 씁니다.' }),
      el('button', { class: 'btn primary', text: busy ? '여는 중…' : 'Google로 로그인', disabled: busy, onclick: () => store.shareSignIn() }),
    ]);
  }

  const who = el('div', { class: 'listline', style: 'border:0;padding:0 0 12px' }, [
    el('span', { class: 'sync-pill' }, [el('span', { class: 'sync-dot' }), s.user.email || s.user.name || '로그인됨']),
    el('span', { class: 'spacer' }),
    el('button', {
      class: 'btn sm ghost', text: '로그아웃', disabled: busy,
      onclick: () => confirmThen(
        '로그아웃하면 이 기기에 있던 사본이 지워집니다. 장부는 서버에 그대로 있으니 다시 로그인하면 돌아와요.',
        () => store.shareSignOut(),
      ),
    }),
  ]);

  // 3. 로그인은 했는데 아직 가계부가 없음
  if (store.status !== 'firebase') {
    const codeInput = el('input', { type: 'text', placeholder: '초대 코드 (예: 7KQ2-M9XF)', style: 'text-transform:uppercase', id: 'join-code' });
    return card({ title: '둘이 함께 쓰기', sub: '가계부를 고르세요' }, [
      who,
      status,
      el('div', { class: 'field' }, [
        el('label', { text: '처음이라면' }),
        el('button', {
          class: 'btn primary', style: 'align-self:flex-start', disabled: busy,
          text: busy ? '만드는 중…' : '새 가계부 만들기',
          onclick: () => store.shareCreate(),
        }),
        el('span', { class: 'hint', text: '지금 이 기기에서 보고 있는 내역이 그대로 올라갑니다. 만들고 나면 초대 코드가 나와요.' }),
      ]),
      el('div', { class: 'field' }, [
        el('label', { for: 'join-code', text: '초대를 받았다면 · 쓰던 가계부로 돌아간다면' }),
        codeInput,
        el('button', {
          class: 'btn', style: 'align-self:flex-start', disabled: busy,
          text: '초대 코드로 참여하기',
          onclick: () => store.shareJoin(codeInput.value),
        }),
        el('span', { class: 'hint', text: '참여하면 이 기기의 내역 대신 그 장부를 함께 보게 됩니다. 이 기기 내역이 서버를 덮어쓰지는 않아요.' }),
      ]),
    ]);
  }

  // 4. 연결 완료
  const code = prettyCode(s.householdId);
  return card({ title: '둘이 함께 쓰기', sub: `${s.members}명이 같은 장부를 보는 중` }, [
    who,
    status,
    el('div', { class: 'field' }, [
      el('label', { text: '초대 코드' }),
      el('div', { class: 'listline', style: 'border:0;padding:0;gap:8px' }, [
        el('span', { class: 'num', style: 'font-size:20px;font-weight:600;letter-spacing:.08em', text: code }),
        el('button', {
          class: 'btn sm', text: '복사',
          onclick: async () => {
            try { await navigator.clipboard.writeText(code); toast('초대 코드를 복사했어요'); }
            catch { toast('복사가 막혀 있어요. 코드를 직접 적어 주세요'); }
          },
        }),
      ]),
      el('span', { class: 'hint', text: '상대방이 같은 주소에 들어가 로그인한 뒤 이 코드를 넣으면 합류합니다. 어딘가 적어 두면 마음이 편합니다.' }),
    ]),
    el('div', { class: 'field' }, [
      el('label', { text: '초대 열어두기' }),
      el('div', { class: 'picker' }, [
        el('button', { 'aria-pressed': s.joinOpen ? 'true' : 'false', text: '열림', disabled: busy, onclick: () => store.shareSetOpen(true) }),
        el('button', { 'aria-pressed': !s.joinOpen ? 'true' : 'false', text: '닫힘', disabled: busy, onclick: () => store.shareSetOpen(false) }),
      ]),
      el('span', { class: 'hint', text: '합류가 끝나면 닫아 두세요. 닫으면 코드를 알아도 아무도 들어오거나 들여다볼 수 없어요.' }),
    ]),
    el('p', { style: 'font-size:12px;color:var(--ink-3);margin:2px 0 10px;line-height:1.6' },
      ['이 기기에서 그만 보고 싶을 때는 위의 ', el('b', { text: '로그아웃' }),
        ' 이면 됩니다. 같은 구글 계정으로 다시 로그인하면 초대 코드 없이 장부가 그대로 돌아와요.']),
    el('button', {
      class: 'btn danger', style: 'align-self:flex-start', disabled: busy,
      text: '이 가계부에서 나가기',
      onclick: () => confirmThen(
        `구성원 목록에서 빠집니다. 다시 들어오려면 초대 코드 ${code} 가 필요해요. 장부 자체는 남은 구성원에게 그대로 남습니다. 계속할까요?`,
        () => store.shareLeave(),
      ),
    }),
  ]);
}

/**
 * 목록을 손으로 끌어 순서를 바꾼다.
 * HTML5 드래그는 폰에서 안 먹어서 포인터 이벤트로 직접 처리한다.
 * 손잡이(⠿)를 잡았을 때만 움직이므로 입력칸은 그대로 쓸 수 있다.
 */
function attachSortable(list, onReorder) {
  const rowOf = (node) => node.closest('.listline');
  const commit = () => onReorder([...list.children].map((n) => n.dataset.id));

  list.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('.grip');
    if (!handle) return;
    e.preventDefault();
    const row = rowOf(handle);
    row.classList.add('dragging');
    list.classList.add('sorting');

    // 이동 이벤트는 window 에서 듣는다. setPointerCapture 를 쓰면 행을 옮기는
    // 순간(DOM 에서 빠졌다 들어오면서) 캡처가 풀려 드래그가 한 번에 끊긴다.
    const move = (ev) => {
      for (const sib of list.children) {
        if (sib === row) continue;
        const r = sib.getBoundingClientRect();
        if (ev.clientY < r.top || ev.clientY > r.bottom) continue;
        const target = ev.clientY > r.top + r.height / 2 ? sib.nextSibling : sib;
        // 제자리면 건드리지 않는다 — 괜한 DOM 이동은 깜빡임만 만든다
        if (target !== row && row.nextSibling !== target) list.insertBefore(row, target);
        break;
      }
    };
    const up = () => {
      row.classList.remove('dragging');
      list.classList.remove('sorting');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      commit();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });

  // 마우스를 못 쓰는 경우를 위해 방향키로도 옮긴다
  list.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    const handle = e.target.closest('.grip');
    if (!handle) return;
    e.preventDefault();
    const row = rowOf(handle);
    const sib = e.key === 'ArrowUp' ? row.previousElementSibling : row.nextElementSibling;
    if (!sib) return;
    list.insertBefore(...(e.key === 'ArrowUp' ? [row, sib] : [sib, row]));
    commit();
    handle.focus();
  });
}

/** 설정의 목록 하나를 끌어서 정렬 가능한 형태로 감싼다 */
function sortableList(key, items, renderRow) {
  const list = el('div', { class: 'sortable' }, items.map((item, i) => {
    const row = renderRow(item, i);
    row.dataset.id = item.id;
    row.prepend(el('button', {
      class: 'grip', type: 'button', text: '⠿',
      'aria-label': `순서 바꾸기 — 방향키로도 옮길 수 있어요`,
      title: '끌어서 순서 바꾸기',
    }));
    return row;
  }));
  attachSortable(list, (order) => {
    const byId = new Map(store.config[key].map((x) => [x.id, x]));
    const next = order.map((id) => byId.get(id)).filter(Boolean);
    for (const item of store.config[key]) if (!next.includes(item)) next.push(item);
    store.saveConfig({ [key]: next });
  });
  return list;
}

// 가계부에서 자주 쓰는 것들만 추렸다. 없는 건 직접 입력으로.
const EMOJI_GROUPS = [
  ['먹는 것', ['🍚', '🍜', '🍕', '🍗', '🍣', '🥗', '🍱', '🍔', '🍰', '☕', '🧋', '🍺', '🍎', '🥕', '🛒', '🧊']],
  ['집', ['🏠', '🏡', '🛋️', '🛏️', '🚿', '💡', '🔧', '🧻', '🧼', '🪴', '🧺', '🔑']],
  ['이동', ['🚌', '🚇', '🚗', '🚕', '⛽', '✈️', '🚲', '🛵', '🅿️', '🛣️']],
  ['생활', ['📱', '💻', '📶', '👕', '👟', '👜', '💄', '✂️', '🎁', '📚', '🎮', '🎬', '🎤', '🏕️', '🏋️', '⚽']],
  ['건강', ['💊', '🏥', '🦷', '👓', '🩺', '🧘']],
  ['반려동물', ['🐶', '🐱', '🐾', '🦴', '🐕', '🧸']],
  ['돈', ['💰', '💵', '💳', '🏦', '📈', '🛡️', '🧾', '💸', '🪙', '🐖', '💼', '🎫']],
  ['행사', ['💒', '💍', '🎂', '💌', '🎓', '🧧', '🎄', '🎉']],
  ['그 밖', ['📦', '🏷️', '⭐', '❤️', '🔖', '🙂', '👶', '🌏']],
];

/** 아이콘 고르기 — 목록에서 누르거나 직접 붙여넣는다 */
function openEmojiSheet(current, onPick) {
  const custom = el('input', {
    type: 'text', value: current, maxlength: 4, style: 'width:90px;text-align:center;font-size:20px',
    'aria-label': '직접 입력',
  });
  const body = [
    ...EMOJI_GROUPS.flatMap(([name, list]) => [
      el('div', { class: 'eyebrow', style: 'margin:12px 0 6px', text: name }),
      el('div', { class: 'emoji-grid' }, list.map((emo) => el('button', {
        class: 'emoji-btn', type: 'button', text: emo,
        'aria-pressed': emo === current ? 'true' : 'false',
        onclick: () => { closeSheet(); onPick(emo); },
      }))),
    ]),
    el('div', { class: 'field', style: 'margin-top:16px' }, [
      el('label', { text: '직접 입력' }),
      el('div', { class: 'listline', style: 'border:0;padding:0;gap:8px' }, [
        custom,
        el('button', {
          class: 'btn sm', text: '이걸로',
          onclick: () => { const v = custom.value.trim(); closeSheet(); onPick(v || current); },
        }),
      ]),
    ]),
  ];
  openSheet('아이콘 고르기', body, []);
}

function patchList(key, index, patch) {
  const next = store.config[key].map((item, i) => (i === index ? { ...item, ...patch } : item));
  store.saveConfig({ [key]: next });
}

function showBackupBox(json) {
  const box = document.getElementById('backup-box');
  if (!box) return;
  box.replaceChildren(el('textarea', { rows: 6, style: 'width:100%;margin-top:12px;font-family:var(--font-mono);font-size:11px', readonly: true }, [json]));
  box.querySelector('textarea').select();
}

function downloadBackup(json) {
  try {
    const blob = new Blob([json], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `가계부-백업-${today()}.json`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast('백업 파일을 내려받았어요');
  } catch {
    showBackupBox(json);
    toast('내려받기가 막혀 있어요. 아래 내용을 복사해 두세요');
  }
}

function openImportSheet() {
  const ta = el('textarea', { rows: 7, placeholder: '백업 JSON을 붙여넣으세요', style: 'width:100%;font-family:var(--font-mono);font-size:11px' });
  const file = el('input', { type: 'file', accept: 'application/json,.json', onchange: async (e) => {
    const f = e.target.files?.[0];
    if (f) ta.value = await f.text();
  } });
  openSheet('백업 불러오기', [
    el('p', { style: 'font-size:13px;color:var(--ink-2);margin:0 0 12px', text: '지금 장부를 백업 내용으로 통째로 바꿉니다.' }),
    el('div', { class: 'field' }, [el('label', { text: '파일 선택' }), file]),
    el('div', { class: 'field' }, [el('label', { text: '또는 붙여넣기' }), ta]),
  ], [
    el('button', {
      class: 'btn primary', text: '불러오기',
      onclick: async () => {
        try {
          await store.replaceAll(JSON.parse(ta.value));
          closeSheet();
          toast('백업을 불러왔어요');
        } catch (err) {
          toast(err.message || '읽을 수 없는 파일이에요');
        }
      },
    }),
  ]);
}

export function applyTheme(mode) {
  try { localStorage.setItem('hab.theme', mode); } catch { /* 저장 못 해도 이번 화면에는 적용된다 */ }
  const root = document.documentElement;
  if (mode === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', mode);
}

// ── 거래 입력 시트 ───────────────────────────────────────────────────────

export function openSheet(title, body, actions, extra) {
  closeSheet();
  const scrim = el('div', { class: 'scrim', id: 'scrim', onclick: (e) => { if (e.target === scrim) closeSheet(); } }, [
    el('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, [
      el('div', { class: 'sheet-head' }, [
        el('h2', { text: title }),
        el('span', { class: 'spacer' }),
        el('button', { class: 'iconbtn', 'aria-label': '닫기', text: '✕', onclick: closeSheet }),
      ]),
      ...[].concat(body),
      el('div', { class: 'sheet-actions' }, [
        ...(extra || []),
        el('span', { class: 'spacer' }),
        el('button', { class: 'btn', text: '취소', onclick: closeSheet }),
        ...actions,
      ]),
    ]),
  ]);
  document.body.append(scrim);
  document.addEventListener('keydown', escClose);
}

function escClose(e) { if (e.key === 'Escape') closeSheet(); }

export function closeSheet() {
  document.getElementById('scrim')?.remove();
  document.removeEventListener('keydown', escClose);
}

function confirmThen(message, fn) {
  openSheet('잠깐 확인할게요', [el('p', { style: 'font-size:14px;line-height:1.6;margin:0', text: message })], [
    el('button', { class: 'btn primary', text: '네, 진행할게요', onclick: async () => { closeSheet(); await fn(); rerender(); } }),
  ]);
}

export function openTxnSheet(existing) {
  const draft = existing ? { ...existing } : {
    kind: 'expense', date: ui.grain === 'day' ? ui.anchor : today(), amount: '',
    categoryId: store.config.categories.find((c) => c.kind === 'expense')?.id || null,
    accountId: store.config.accounts[0]?.id || null,
    toAccountId: store.config.accounts[1]?.id || null,
    memo: '',
  };
  const body = el('div', {});

  const draw = () => {
    const cats = store.config.categories.filter((c) => c.kind === draft.kind);
    if (draft.kind !== 'transfer' && !cats.some((c) => c.id === draft.categoryId)) draft.categoryId = cats[0]?.id || null;
    body.replaceChildren(
      el('div', { class: 'picker', style: 'margin-bottom:14px' }, [
        ['expense', '지출'], ['income', '수입'], ['transfer', '이체'],
      ].map(([k, n]) => el('button', {
        'aria-pressed': draft.kind === k ? 'true' : 'false', text: n,
        onclick: () => { draft.kind = k; draw(); },
      }))),
      el('div', { class: 'field amount' }, [
        el('label', { for: 'tx-amount', text: '금액 (원)' }),
        el('input', {
          id: 'tx-amount', type: 'text', inputmode: 'numeric', placeholder: '0',
          value: draft.amount === '' ? '' : wonPlain(draft.amount),
          oninput: (e) => reformatWithCaret(e.target, (raw) => {
            const digits = raw.replace(/[^\d]/g, '').slice(0, 12);
            draft.amount = digits === '' ? '' : Number(digits);
            return digits === '' ? '' : wonPlain(Number(digits));
          }),
        }),
      ]),
      el('div', { class: 'quick', style: 'margin:-6px 0 14px' }, [1000, 5000, 10000, 50000, 100000].map((v) => el('button', {
        class: 'btn sm', text: `+${wonShort(v)}`,
        onclick: () => { draft.amount = (Number(draft.amount) || 0) + v; draw(); },
      })).concat([el('button', { class: 'btn sm ghost', text: '지우기', onclick: () => { draft.amount = ''; draw(); } })])),
      el('div', { class: 'row2' }, [
        el('div', { class: 'field' }, [
          el('label', { for: 'tx-date', text: '날짜' }),
          el('input', { id: 'tx-date', type: 'date', value: draft.date, onchange: (e) => { draft.date = e.target.value || today(); } }),
        ]),
        el('div', { class: 'field' }, [
          el('label', { for: 'tx-acct', text: draft.kind === 'transfer' ? '보내는 계좌' : '결제수단' }),
          el('select', { id: 'tx-acct', onchange: (e) => { draft.accountId = e.target.value; } },
            store.config.accounts.map((a) => el('option', { value: a.id, text: `${ACCOUNT_TYPES[a.type].emoji} ${a.name}`, selected: draft.accountId === a.id }))),
        ]),
      ]),
      draft.kind === 'transfer'
        ? el('div', { class: 'field' }, [
          el('label', { for: 'tx-to', text: '받는 계좌' }),
          el('select', { id: 'tx-to', onchange: (e) => { draft.toAccountId = e.target.value; } },
            store.config.accounts.map((a) => el('option', { value: a.id, text: `${ACCOUNT_TYPES[a.type].emoji} ${a.name}`, selected: draft.toAccountId === a.id }))),
        ])
        : el('div', { class: 'field' }, [
          el('label', { text: '분류' }),
          el('div', { class: 'picker' }, cats.map((c) => el('button', {
            'aria-pressed': draft.categoryId === c.id ? 'true' : 'false', text: `${c.emoji} ${c.name}`,
            onclick: () => { draft.categoryId = c.id; draw(); },
          }))),
        ]),
      el('div', { class: 'field' }, [
        el('label', { for: 'tx-memo', text: '메모' }),
        el('input', { id: 'tx-memo', type: 'text', value: draft.memo || '', placeholder: '예: 봄이 사료, 장보기', onchange: (e) => { draft.memo = e.target.value; }, oninput: (e) => { draft.memo = e.target.value; } }),
      ]),
    );
  };
  draw();

  const save = async () => {
    if (!draft.amount || Number(draft.amount) <= 0) { toast('금액을 입력해 주세요'); return; }
    if (draft.kind === 'transfer' && draft.accountId === draft.toAccountId) { toast('보내는 계좌와 받는 계좌가 같아요'); return; }
    await store.saveTxn(draft);
    closeSheet();
    toast(existing ? '내역을 고쳤어요' : '내역을 적었어요');
  };

  openSheet(existing ? '내역 고치기' : '내역 적기', [body], [
    el('button', { class: 'btn primary', text: '저장', onclick: save }),
  ], existing ? [el('button', {
    class: 'btn danger', text: '삭제',
    onclick: async () => { await store.deleteTxn(existing.id); closeSheet(); toast('내역을 지웠어요'); },
  })] : []);

  setTimeout(() => document.getElementById('tx-amount')?.focus(), 30);
}

// ── 토스트 ───────────────────────────────────────────────────────────────

let toastTimer;
export function toast(message) {
  document.getElementById('toast')?.remove();
  const node = el('div', { class: 'toast', id: 'toast', role: 'status', text: message });
  document.body.append(node);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.remove(), 2600);
}

// ── 화면 선택 ────────────────────────────────────────────────────────────

export function renderPage() {
  switch (ui.page) {
    case 'txns': return viewTxns();
    case 'assets': return viewAssets();
    case 'goals': return viewGoals();
    case 'settings': return viewSettings();
    default: return viewDashboard();
  }
}

export { periodRange, periodLabel, shiftPeriod };
