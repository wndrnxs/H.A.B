// 앱 부팅과 껍데기(사이드바 · 상단바 · 하단 탭 · 추가 버튼).

import { store } from './store.js';
import {
  ui, PAGES, bindRender, setUi, renderPage, openTxnSheet, applyTheme, toast,
} from './views.js';
import { el, today, periodLabel, shiftPeriod } from './util.js';

const root = document.getElementById('app-root');

function safeTheme() {
  try { return localStorage.getItem('hab.theme') || 'system'; } catch { return 'system'; }
}

function navButton(p, current) {
  return el('button', {
    'aria-current': p.id === current ? 'page' : null,
    onclick: () => setUi({ page: p.id }),
  }, [el('span', { class: 'ic', text: p.icon }), el('span', { text: p.name })]);
}

function periodControls() {
  return el('div', { class: 'period' }, [
    el('div', { class: 'seg', role: 'group', 'aria-label': '조회 단위' }, [
      ['day', '일'], ['week', '주'], ['month', '월'],
    ].map(([g, n]) => el('button', {
      'aria-pressed': ui.grain === g ? 'true' : 'false', text: n,
      onclick: () => setUi({ grain: g }),
    }))),
    el('button', { class: 'iconbtn', 'aria-label': '이전 기간', text: '‹', onclick: () => setUi({ anchor: shiftPeriod(ui.grain, ui.anchor, -1) }) }),
    el('span', { class: 'lab', text: periodLabel(ui.grain, ui.anchor) }),
    el('button', { class: 'iconbtn', 'aria-label': '다음 기간', text: '›', onclick: () => setUi({ anchor: shiftPeriod(ui.grain, ui.anchor, 1) }) }),
    el('button', { class: 'btn sm ghost', text: '오늘', onclick: () => setUi({ anchor: today() }) }),
  ]);
}

function render() {
  const page = PAGES.find((p) => p.id === ui.page) || PAGES[0];
  const showPeriod = ['dashboard', 'txns', 'stats'].includes(ui.page);

  const rail = el('aside', { class: 'rail' }, [
    el('div', { class: 'brand' }, [
      el('span', { class: 'brand-mark', text: '家' }),
      el('div', {}, [
        el('div', { class: 'brand-name', text: store.config.settings.household }),
        el('div', { class: 'brand-sub', text: 'HOUSEHOLD ACCOUNT BOOK' }),
      ]),
    ]),
    el('nav', { class: 'nav', 'aria-label': '주요 화면' }, PAGES.map((p) => navButton(p, page.id))),
    el('button', { class: 'btn primary', text: '＋ 내역 적기', onclick: () => openTxnSheet(null) }),
    el('div', { class: 'rail-foot' }, [
      el('div', { class: 'eyebrow', text: '함께 쓰는 사람' }),
      el('div', { class: 'members-mini' }, store.config.members.map((m) => el('div', { class: 'm', text: `${m.emoji} ${m.name}` }))),
      el('span', { class: 'sync-pill' }, [
        el('span', { class: `sync-dot ${store.status === 'cloud' ? '' : 'local'}` }),
        store.status === 'cloud' ? '클라우드 동기화 중' : '이 브라우저에 저장',
      ]),
    ]),
  ]);

  const topbar = el('header', { class: 'topbar' }, [
    el('h1', { text: page.name }),
    showPeriod ? periodControls() : null,
    el('span', { class: 'spacer' }),
    el('button', { class: 'btn sm', text: '＋ 적기', onclick: () => openTxnSheet(null), style: 'display:none' }),
  ]);

  const view = el('div', { class: 'view', id: 'view' }, renderPage());

  const tabbar = el('nav', { class: 'tabbar', 'aria-label': '주요 화면' }, PAGES.map((p) => el('button', {
    'aria-current': p.id === page.id ? 'page' : null,
    onclick: () => { setUi({ page: p.id }); window.scrollTo({ top: 0 }); },
  }, [el('span', { class: 'ic', text: p.icon }), el('span', { text: p.name })])));

  const fab = el('button', { class: 'fab', 'aria-label': '내역 적기', text: '＋', onclick: () => openTxnSheet(null) });

  root.replaceChildren(
    el('div', { class: 'app' }, [rail, el('main', { class: 'main' }, [topbar, view])]),
    tabbar,
    fab,
  );
}

bindRender(render);
store.on(() => render());

applyTheme(safeTheme());
render();

store.init().then(() => {
  render();
}).catch((err) => {
  console.error(err);
  toast('장부를 불러오는 데 문제가 있었어요. 이 브라우저에 저장된 내용으로 계속합니다.');
});

// 홈 화면에 추가했을 때 오프라인으로도 열리도록 — 정적 호스팅에서만 동작한다
if ('serviceWorker' in navigator && location.protocol === 'https:' && !window.claude) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(new URL('../sw.js', import.meta.url)).catch(() => {});
  });
}
