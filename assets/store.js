// 데이터 모델과 저장소.
//
// 저장 위치는 두 가지다.
//  - local : 브라우저(localStorage). 어디서나 동작하지만 기기마다 따로 쌓인다.
//  - cloud : Claude 아티팩트로 띄웠을 때의 공유 문서 저장소. PC·폰이 같은 장부를 본다.
// 어느 쪽이든 아래 API는 동일하다.

import { toYMD, today, monthKey, uid, addMonths, startOfMonth, daysInMonth, pad } from './util.js';
import * as fb from './firebase.js';

const LS_KEY = 'hab.ledger.v1';

export const ACCOUNT_TYPES = {
  bank: { label: '입출금', emoji: '🏦', liability: false },
  cash: { label: '현금', emoji: '💵', liability: false },
  // 전세·월세 보증금은 계약이 끝나면 돌려받는 돈이라 자산이다
  deposit: { label: '보증금', emoji: '🔑', liability: false },
  savings: { label: '적금·예금', emoji: '🐖', liability: false },
  invest: { label: '투자', emoji: '📈', liability: false },
  card: { label: '신용카드', emoji: '💳', liability: true },
  loan: { label: '대출', emoji: '🧾', liability: true },
};

function defaultConfig() {
  const opening = startOfMonth(addMonths(today(), -2));
  return {
    settings: {
      household: '우리집 가계부',
      openingDate: opening,
      startPage: 'dashboard',
      sharedAccountId: 'a_living',
    },
    // 지출을 사람별로 나누는 기능은 걷어냈다(통장을 사람별로 나눠 쓰기로 했다).
    // 이미 서버에 올라간 장부와 옛 기록이 이 항목을 갖고 있어 자리만 남겨 둔다.
    members: [
      { id: 'm_me', name: '나', emoji: '🙋', slot: 1 },
      { id: 'm_partner', name: '예비신부', emoji: '💍', slot: 2 },
      { id: 'm_dog', name: '강아지', emoji: '🐶', slot: 3 },
    ],
    accounts: [
      { id: 'a_salary1', name: '내 급여통장', type: 'bank', opening: 4200000 },
      { id: 'a_salary2', name: '신부 급여통장', type: 'bank', opening: 3100000 },
      { id: 'a_living', name: '공동 생활비 통장', type: 'bank', opening: 2000000 },
      { id: 'a_card', name: '신용카드', type: 'card', opening: 0 },
      { id: 'a_cash', name: '현금', type: 'cash', opening: 180000 },
      { id: 'a_savings', name: '적금·청약', type: 'savings', opening: 12400000 },
      { id: 'a_invest', name: '주식·ETF', type: 'invest', opening: 8600000 },
      { id: 'a_deposit', name: '전세보증금', type: 'deposit', opening: 220000000 },
      { id: 'a_jeonse', name: '전세자금대출', type: 'loan', opening: -150000000, principal: 150000000 },
      { id: 'a_loan_car', name: '자동차 대출', type: 'loan', opening: -12800000, principal: 20000000 },
      { id: 'a_loan_credit', name: '신용대출', type: 'loan', opening: -7300000, principal: 10000000 },
    ],
    categories: [
      { id: 'c_food', name: '식비', emoji: '🍚', kind: 'expense', budget: 700000 },
      { id: 'c_cafe', name: '카페·간식', emoji: '☕', kind: 'expense', budget: 150000 },
      { id: 'c_home', name: '주거·관리비', emoji: '🏠', kind: 'expense', budget: 300000 },
      { id: 'c_loan', name: '대출이자', emoji: '💸', kind: 'expense', budget: 450000 },
      { id: 'c_living', name: '생필품', emoji: '🧻', kind: 'expense', budget: 200000 },
      { id: 'c_tel', name: '통신', emoji: '📱', kind: 'expense', budget: 120000 },
      { id: 'c_move', name: '교통·차량', emoji: '🚌', kind: 'expense', budget: 250000 },
      { id: 'c_dog', name: '반려견', emoji: '🐶', kind: 'expense', budget: 200000 },
      { id: 'c_date', name: '데이트·문화', emoji: '🎬', kind: 'expense', budget: 300000 },
      { id: 'c_beauty', name: '의류·미용', emoji: '👕', kind: 'expense', budget: 200000 },
      { id: 'c_health', name: '의료·건강', emoji: '💊', kind: 'expense', budget: 100000 },
      { id: 'c_event', name: '경조사', emoji: '💌', kind: 'expense', budget: 150000 },
      { id: 'c_insure', name: '보험', emoji: '🛡️', kind: 'expense', budget: 260000 },
      { id: 'c_wedding', name: '결혼준비', emoji: '💒', kind: 'expense', budget: 800000 },
      { id: 'c_etc', name: '기타', emoji: '📦', kind: 'expense', budget: 100000 },
      { id: 'i_salary', name: '급여', emoji: '💼', kind: 'income', budget: null },
      { id: 'i_bonus', name: '상여·수당', emoji: '🎁', kind: 'income', budget: null },
      { id: 'i_side', name: '용돈·부수입', emoji: '💰', kind: 'income', budget: null },
      { id: 'i_interest', name: '이자·배당', emoji: '📈', kind: 'income', budget: null },
    ],
  };
}

/**
 * '전부 지우고 새로 시작' 이 만드는 장부.
 * 분류·계좌·구성원 틀은 남기되 금액은 전부 0 으로 비운다. defaultConfig 를 그대로
 * 쓰면 예시용 시작 잔액(전세보증금 2.2억 같은)이 되살아나 초기화가 안 된 것처럼 보인다.
 */
export function emptyConfig() {
  const base = defaultConfig();
  return {
    ...base,
    settings: { ...base.settings, openingDate: startOfMonth(today()) },
    accounts: base.accounts.map((a) => ({ ...a, opening: 0 })),
  };
}

// ---------------------------------------------------------------- 예시 데이터

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 첫 실행 화면이 비어 있지 않도록 최근 3개월치 예시 내역을 만든다. 모두 sample:true 로 표시되어 한 번에 지울 수 있다. */
function sampleTxns(config) {
  const rnd = mulberry32(20260916);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const between = (lo, hi, unit = 100) => Math.round((lo + rnd() * (hi - lo)) / unit) * unit;
  const out = [];
  const now = today();
  let n = 0;
  const push = (date, kind, amount, extra) => {
    if (date > now) return;
    out.push({
      id: `s${(n += 1)}`,
      date,
      kind,
      amount,
      categoryId: null,
      accountId: null,
      toAccountId: null,
      memberId: null,
      memo: '',
      sample: true,
      updatedAt: 1,
      ...extra,
    });
  };

  for (let mOff = -2; mOff <= 0; mOff += 1) {
    const anchor = startOfMonth(addMonths(now, mOff));
    const [y, m] = anchor.split('-').map(Number);
    const dim = daysInMonth(y, m);
    const day = (d) => `${y}-${pad(m)}-${pad(Math.min(d, dim))}`;

    // 고정 수입
    push(day(25), 'income', 3210000, { categoryId: 'i_salary', accountId: 'a_salary1', memberId: 'm_me', memo: '급여' });
    push(day(25), 'income', 2780000, { categoryId: 'i_salary', accountId: 'a_salary2', memberId: 'm_partner', memo: '급여' });
    if (mOff === -1) push(day(25), 'income', 1500000, { categoryId: 'i_bonus', accountId: 'a_salary1', memberId: 'm_me', memo: '분기 성과급' });
    push(day(21), 'income', between(9000, 24000, 10), { categoryId: 'i_interest', accountId: 'a_savings', memo: '예금 이자' });

    // 고정 지출 — 전세는 '이자만 지출, 원금상환은 이체'로 적는다
    push(day(25), 'expense', between(425000, 445000, 10), { categoryId: 'c_loan', accountId: 'a_living', memo: '전세자금대출 이자' });
    push(day(25), 'transfer', 300000, { accountId: 'a_living', toAccountId: 'a_jeonse', memo: '전세대출 원금상환' });
    // 자동차·신용 대출은 원리금균등이라 매달 같은 돈을 내고, 이자와 원금 비중만 조금씩 바뀐다
    push(day(10), 'expense', between(38000, 44000, 10), { categoryId: 'c_loan', accountId: 'a_living', loanId: 'a_loan_car', memo: '자동차 대출 이자' });
    push(day(10), 'transfer', 412000, { accountId: 'a_living', toAccountId: 'a_loan_car', memo: '자동차 대출 원금상환' });
    push(day(17), 'expense', between(29000, 34000, 10), { categoryId: 'c_loan', accountId: 'a_living', loanId: 'a_loan_credit', memo: '신용대출 이자' });
    push(day(17), 'transfer', 318000, { accountId: 'a_living', toAccountId: 'a_loan_credit', memo: '신용대출 원금상환' });
    push(day(5), 'expense', between(120000, 210000, 1000), { categoryId: 'c_home', accountId: 'a_living', memo: '관리비·공과금' });
    push(day(12), 'expense', 55000, { categoryId: 'c_tel', accountId: 'a_living', memberId: 'm_me', memo: '휴대폰 요금' });
    push(day(12), 'expense', 49000, { categoryId: 'c_tel', accountId: 'a_living', memberId: 'm_partner', memo: '휴대폰 요금' });
    push(day(15), 'expense', 128000, { categoryId: 'c_insure', accountId: 'a_salary1', memberId: 'm_me', memo: '실손·종신보험' });
    push(day(15), 'expense', 96000, { categoryId: 'c_insure', accountId: 'a_salary2', memberId: 'm_partner', memo: '실손보험' });
    push(day(17), 'expense', 39000, { categoryId: 'c_insure', accountId: 'a_living', memberId: 'm_dog', memo: '펫보험' });
    push(day(26), 'transfer', 800000, { accountId: 'a_salary1', toAccountId: 'a_savings', memo: '적금 자동이체' });
    push(day(26), 'transfer', 500000, { accountId: 'a_salary2', toAccountId: 'a_invest', memo: '적립식 ETF' });
    // 공동 통장 분담금 — 누가 넣었는지 남겨 두면 통계에서 분담 비율이 보인다
    push(day(27), 'transfer', 2400000, { accountId: 'a_salary1', toAccountId: 'a_living', memberId: 'm_me', memo: '생활비 분담금' });
    push(day(27), 'transfer', 1900000, { accountId: 'a_salary2', toAccountId: 'a_living', memberId: 'm_partner', memo: '생활비 분담금' });

    // 반려견
    push(day(8), 'expense', between(52000, 78000, 500), { categoryId: 'c_dog', accountId: 'a_card', memberId: 'm_dog', memo: pick(['사료 정기배송', '사료 + 간식']) });
    push(day(19), 'expense', between(12000, 32000, 500), { categoryId: 'c_dog', accountId: 'a_card', memberId: 'm_dog', memo: pick(['간식', '배변패드', '장난감']) });
    if (mOff !== -1) push(day(between(9, 24, 1)), 'expense', between(45000, 160000, 1000), { categoryId: 'c_dog', accountId: 'a_card', memberId: 'm_dog', memo: pick(['동물병원 진료', '심장사상충 예방약', '미용']) });

    // 결혼 준비
    const weddingDays = [between(3, 12, 1), between(14, 26, 1)];
    const weddingMemo = [
      ['예식장 계약금', 1500000], ['스드메 계약', 1200000], ['웨딩밴드', 980000],
      ['청첩장 제작', 210000], ['신혼여행 항공권', 1740000], ['가전 렌탈 선금', 560000],
    ];
    for (const d of weddingDays) {
      const w = pick(weddingMemo);
      push(day(d), 'expense', w[1], { categoryId: 'c_wedding', accountId: rnd() < 0.5 ? 'a_salary1' : 'a_salary2', memo: w[0] });
    }

    // 변동 지출
    for (let d = 1; d <= dim; d += 1) {
      const date = day(d);
      const dow = new Date(y, m - 1, d).getDay();
      const weekend = dow === 0 || dow === 6;

      const meals = weekend ? 2 : rnd() < 0.75 ? 2 : 1;
      for (let i = 0; i < meals; i += 1) {
        const home = rnd() < 0.45;
        push(date, 'expense', home ? between(6000, 19000, 100) : between(13000, 48000, 100), {
          categoryId: 'c_food',
          accountId: rnd() < 0.8 ? 'a_card' : 'a_cash',
          memberId: rnd() < 0.5 ? 'm_me' : 'm_partner',
          memo: home ? pick(['장보기', '마트 식료품', '배달']) : pick(['점심', '저녁 외식', '회사 근처 식당', '분식']),
        });
      }
      if (rnd() < 0.55) {
        push(date, 'expense', between(4200, 13000, 100), {
          categoryId: 'c_cafe', accountId: 'a_card',
          memberId: rnd() < 0.5 ? 'm_me' : 'm_partner',
          memo: pick(['카페', '아이스아메리카노', '디저트', '편의점']),
        });
      }
      if (rnd() < 0.42) {
        push(date, 'expense', between(1500, 9000, 100), {
          categoryId: 'c_move', accountId: 'a_card',
          memberId: rnd() < 0.5 ? 'm_me' : 'm_partner',
          memo: pick(['지하철', '버스', '택시']),
        });
      }
      if (weekend && rnd() < 0.6) {
        push(date, 'expense', between(18000, 95000, 500), {
          categoryId: 'c_date', accountId: 'a_card',
          memo: pick(['영화', '전시 관람', '드라이브', '나들이', '보드게임 카페']),
        });
      }
      if (rnd() < 0.18) {
        push(date, 'expense', between(8000, 52000, 500), {
          categoryId: 'c_living', accountId: 'a_card',
          memo: pick(['생필품', '세제·휴지', '주방용품', '생활잡화']),
        });
      }
      if (rnd() < 0.07) {
        push(date, 'expense', between(25000, 140000, 1000), {
          categoryId: 'c_beauty', accountId: 'a_card',
          memberId: rnd() < 0.5 ? 'm_me' : 'm_partner',
          memo: pick(['미용실', '의류', '화장품', '운동화']),
        });
      }
      if (rnd() < 0.05) {
        push(date, 'expense', between(9000, 60000, 1000), {
          categoryId: 'c_health', accountId: 'a_card',
          memberId: rnd() < 0.5 ? 'm_me' : 'm_partner',
          memo: pick(['병원 진료', '약국', '영양제']),
        });
      }
      if (rnd() < 0.035) {
        push(date, 'expense', pick([50000, 100000, 100000, 150000, 200000]), {
          categoryId: 'c_event', accountId: 'a_cash',
          memo: pick(['결혼식 축의금', '돌잔치', '조의금']),
        });
      }
      if (rnd() < 0.04) {
        push(date, 'expense', between(30000, 90000, 1000), {
          categoryId: 'c_move', accountId: 'a_card', memo: '주유',
        });
      }
    }
  }

  // 카드 대금 결제 — 전월 카드 사용액을 다음 달 14일에 생활비 통장에서 낸다
  const cardByMonth = new Map();
  for (const t of out) {
    if (t.kind === 'expense' && t.accountId === 'a_card') {
      const k = monthKey(t.date);
      cardByMonth.set(k, (cardByMonth.get(k) || 0) + t.amount);
    }
  }
  for (const [k, amount] of cardByMonth) {
    const next = addMonths(`${k}-01`, 1);
    push(`${next.slice(0, 8)}14`, 'transfer', amount, {
      accountId: 'a_living', toAccountId: 'a_card', memo: `${Number(k.slice(5))}월 카드대금`,
    });
  }

  return out;
}

export function buildSampleData() {
  const config = defaultConfig();
  const months = {};
  for (const t of sampleTxns(config)) {
    const k = monthKey(t.date);
    (months[k] ||= {})[t.id] = t;
  }
  return { config, months };
}

// -------------------------------------------------------------------- 어댑터

const localAdapter = {
  name: 'local',
  async load() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  },
  async save(data) {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(data));
    } catch {
      /* 시크릿 창이나 저장 공간 차단 시 — 메모리에만 남는다 */
    }
  },
  async putConfig(_config, data) { return this.save(data); },
  async putMonth(_key, _items, data) { return this.save(data); },
  async clear() {
    try { localStorage.removeItem(LS_KEY); } catch { /* 무시 */ }
  },
  subscribe() { return () => {}; },
};

function cloudAdapter(db) {
  return {
    name: 'cloud',
    async load() {
      const [cfgSnap, txSnap] = await Promise.all([
        db.doc('meta/config').get(),
        db.collection('tx').get(),
      ]);
      if (!cfgSnap.exists && txSnap.empty) return null;
      const months = {};
      for (const d of txSnap.docs) months[d.id] = { ...(d.data().items || {}) };
      return { config: cfgSnap.exists ? cfgSnap.data().config : null, months };
    },
    async putConfig(config) {
      await db.doc('meta/config').set({ config });
    },
    // 항목 단위 병합 — 두 사람이 같은 달을 동시에 손대도 서로의 입력을 덮어쓰지 않는다
    async putItems(key, items) {
      const ref = db.doc(`tx/${key}`);
      try {
        await ref.update({ items });
      } catch {
        const snap = await ref.get();
        await ref.set({ items: { ...(snap.exists ? snap.data().items : {}), ...items } });
      }
    },
    async putMonth(key, items) {
      await db.doc(`tx/${key}`).set({ items });
    },
    async clear() {
      const snap = await db.collection('tx').get();
      await Promise.all(snap.docs.map((d) => db.doc(`tx/${d.id}`).delete()));
      await db.doc('meta/config').delete().catch(() => {});
    },
    subscribe(onConfig, onMonths) {
      const stops = [
        db.doc('meta/config').onSnapshot((s) => { if (s.exists) onConfig(s.data().config); }, () => {}),
        db.collection('tx').onSnapshot((s) => {
          const months = {};
          for (const d of s.docs) months[d.id] = { ...(d.data().items || {}) };
          onMonths(months);
        }, () => {}),
      ];
      return () => stops.forEach((f) => f());
    },
  };
}

// ---------------------------------------------------------------------- 저장소

class Store {
  constructor() {
    this.config = defaultConfig();
    this.months = {};
    this.adapter = localAdapter;
    this.status = 'local';         // local | cloud(아티팩트) | firebase
    this.listeners = new Set();
    this.ready = false;
    this.unsub = null;
    // 파이어베이스 공유 상태 — 설정 화면이 이것만 보고 그린다
    this.share = {
      available: fb.isConfigured(), user: null, householdId: null,
      joinOpen: false, members: 0, ownerUid: null, busy: false, error: null,
    };
  }

  isRemote() {
    return this.status === 'cloud' || this.status === 'firebase';
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    for (const fn of this.listeners) fn(this);
  }

  async init() {
    // 1) 파이어베이스로 둘이 함께 쓰는 중이면 그것부터
    if (this.share.available) {
      try {
        const user = await fb.currentUser();
        this.share.user = user ? { uid: user.uid, email: user.email, name: user.displayName } : null;
        if (user) {
          const hid = await this.findHousehold(user);
          if (hid) {
            await this.attachFirebase(hid, 'member');
            this.ready = true;
            this.watchAuth().catch(() => {});
            this.emit();
            return;
          }
        }
      } catch (err) {
        // 연결에 실패하면 이 브라우저에 있는 장부로 조용히 돌아간다
        this.share.error = err?.message || '함께 쓰기 연결에 실패했어요.';
        if (this.unsub) { this.unsub(); this.unsub = null; }
        this.adapter = localAdapter;
        this.status = 'local';
        this.share.householdId = null;
      }
    }

    // 2) 아티팩트로 띄웠으면 공유 문서 저장소, 아니면 이 브라우저
    const db = await resolveCloudDb();
    if (db) {
      this.adapter = cloudAdapter(db);
      this.status = 'cloud';
    }
    let loaded = await this.adapter.load();
    let needsSeed = false;
    if (!loaded && this.status === 'cloud') {
      // 클라우드가 비어 있으면 이 기기에 있던 장부를 그대로 올린다
      loaded = await localAdapter.load();
      needsSeed = !!loaded;
    }
    if (!loaded) {
      loaded = buildSampleData();
      needsSeed = true;
    }
    this.apply(loaded);
    if (this.status === 'cloud') {
      // 이미 클라우드에 있던 장부를 그대로 다시 올리지 않는다 (다른 기기의 입력을 덮어쓸 수 있다)
      if (needsSeed) await this.pushAll();
      this.unsub = this.adapter.subscribe(
        (config) => { if (config) { this.config = migrate(config); this.emit(); } },
        (months) => { this.months = months; this.emit(); },
      );
    } else {
      await this.persist();
    }
    this.ready = true;
    if (this.share.available) this.watchAuth().catch(() => {});
    this.emit();
  }

  /** 로그인·로그아웃이 다른 탭이나 리다이렉트로 일어나도 따라간다 */
  async watchAuth() {
    const stop = await fb.onAuthChange(async (user) => {
      this.share.user = user ? { uid: user.uid, email: user.email, name: user.displayName } : null;
      if (!user && this.status === 'firebase') {
        await this.detachFirebase();
      } else if (user && this.status !== 'firebase') {
        const hid = await this.findHousehold(user);
        if (hid) await this.attachFirebase(hid, 'member');
      }
      this.emit();
    });
    return stop;
  }

  /**
   * 이 계정이 속한 가계부를 찾는다.
   * 서버의 users/{uid} 가 먼저고, 그게 없으면 이 기기가 기억하는 코드로 되살린다.
   * 둘 다 없을 때만 '새로 만들기 / 초대 코드' 화면을 보여 준다.
   */
  async findHousehold(user) {
    try {
      const hid = await fb.myHouseholdId(user.uid);
      if (hid) return hid;
    } catch {
      this.share.error = '가계부 정보를 불러오지 못했어요. 연결을 확인하고 새로고침해 주세요.';
      return null;
    }
    const remembered = fb.rememberedHousehold();
    if (remembered) {
      const back = await fb.relinkHousehold(user, remembered).catch(() => null);
      if (back) return back;
    }
    return null;
  }

  /**
   * 파이어베이스 가계부에 붙는다.
   *  - 'owner'  : 지금 이 기기에서 보던 장부를 통째로 올린다 (새로 만들 때)
   *  - 'member' : 서버에 있는 장부를 받아 온다 (초대받아 들어갈 때)
   */
  async attachFirebase(hid, role) {
    if (this.unsub) { this.unsub(); this.unsub = null; }
    const adapter = await fb.firebaseAdapter(hid);
    this.adapter = adapter;
    this.status = 'firebase';
    this.share.householdId = hid;

    if (role === 'owner') {
      await this.pushAll();
    } else {
      // 남의(또는 예전 내) 장부에 붙을 때는 절대 올리지 않는다.
      // 로그아웃 뒤 빈 장부를 들고 붙었다가 서버를 지워버리는 사고를 막는다.
      const loaded = await adapter.load();
      if (!loaded) throw new Error('가계부를 찾지 못했어요. 초대 코드를 다시 확인해 주세요.');
      this.apply({ config: loaded.config || this.config, months: loaded.months || {} });
    }
    fb.rememberHousehold(hid);

    this.unsub = adapter.subscribe(
      (config) => { this.config = migrate(config); this.emit(); },
      (months) => { this.months = months; this.emit(); },
      (meta) => { Object.assign(this.share, meta); this.emit(); },
    );
    this.emit();
  }

  /**
   * 로그아웃 — 이 기기에 남은 사본을 지운다.
   * 장부는 서버에 그대로 있으니 다시 로그인하면 돌아온다. 남의 폰이나 공용 PC 에서
   * 로그아웃했는데 우리집 지출이 계속 보이면 안 된다.
   */
  async detachFirebase() {
    if (this.unsub) { this.unsub(); this.unsub = null; }
    this.adapter = localAdapter;
    this.status = 'local';
    this.share.householdId = null;
    this.share.members = 0;
    this.share.joinOpen = false;
    this.share.ownerUid = null;
    await localAdapter.clear();
    this.apply({ config: emptyConfig(), months: {} });
    this.emit();
  }

  apply(data) {
    this.config = migrate(data.config || defaultConfig());
    this.months = data.months || {};
  }

  async persist() {
    if (!this.isRemote()) await localAdapter.save({ config: this.config, months: this.months });
  }

  async pushAll() {
    await this.adapter.putConfig(this.config);
    for (const [k, items] of Object.entries(this.months)) await this.adapter.putMonth(k, items);
  }

  // ---- 함께 쓰기(파이어베이스) ----

  async shareRun(job) {
    this.share.busy = true;
    this.share.error = null;
    this.emit();
    try {
      await job();
    } catch (err) {
      this.share.error = err?.message || '잘 되지 않았어요.';
    } finally {
      this.share.busy = false;
      this.emit();
    }
  }

  shareSignIn() {
    return this.shareRun(() => fb.signIn());
  }

  shareSignOut() {
    return this.shareRun(() => fb.signOut());
  }

  /** 지금 이 기기에서 보던 장부를 그대로 올리면서 새 가계부를 연다 */
  shareCreate() {
    return this.shareRun(async () => {
      const user = this.share.user;
      if (!user) throw new Error('먼저 로그인해 주세요.');
      const hid = await fb.createHousehold(user, this.config);
      await this.attachFirebase(hid, 'owner');
    });
  }

  shareJoin(code) {
    return this.shareRun(async () => {
      const user = this.share.user;
      if (!user) throw new Error('먼저 로그인해 주세요.');
      const hid = await fb.joinHousehold(user, code);
      await this.attachFirebase(hid, 'member');
    });
  }

  shareSetOpen(open) {
    return this.shareRun(async () => {
      await fb.setJoinOpen(this.share.householdId, open);
      this.share.joinOpen = !!open;
    });
  }

  /**
   * 가계부에서 완전히 나간다. 구성원 목록에서도 빠지므로, 돌아오려면 초대 코드가
   * 다시 필요하다. 단순히 이 기기에서 그만 보고 싶은 것이라면 로그아웃이면 된다.
   */
  shareLeave() {
    return this.shareRun(async () => {
      if (this.share.user) await fb.leaveHousehold(this.share.user, this.share.householdId);
      await fb.signOut();
      await this.detachFirebase();
    });
  }

  // ---- 읽기 ----

  /** 살아있는 거래 전체 (삭제 표시 제외), 최신순 */
  txns() {
    const out = [];
    for (const items of Object.values(this.months)) {
      for (const t of Object.values(items)) if (t && !t.deleted) out.push(t);
    }
    out.sort((a, b) => (a.date === b.date ? (b.updatedAt || 0) - (a.updatedAt || 0) : b.date.localeCompare(a.date)));
    return out;
  }

  inRange(from, to) {
    return this.txns().filter((t) => t.date >= from && t.date <= to);
  }

  category(id) {
    return this.config.categories.find((c) => c.id === id) || null;
  }

  account(id) {
    return this.config.accounts.find((a) => a.id === id) || null;
  }

  hasSamples() {
    return this.txns().some((t) => t.sample);
  }

  /** 계좌별 잔액 (asOf 날짜 기준, 미지정 시 전체 반영) */
  balances(asOf) {
    const bal = {};
    for (const a of this.config.accounts) bal[a.id] = a.opening || 0;
    for (const t of this.txns()) {
      if (asOf && t.date > asOf) continue;
      if (t.kind === 'income' && t.accountId in bal) bal[t.accountId] += t.amount;
      else if (t.kind === 'expense' && t.accountId in bal) bal[t.accountId] -= t.amount;
      else if (t.kind === 'transfer') {
        if (t.accountId in bal) bal[t.accountId] -= t.amount;
        if (t.toAccountId in bal) bal[t.toAccountId] += t.amount;
      }
    }
    return bal;
  }

  /**
   * 순자산. dashboard 를 켜면 '메인에 표시' 를 꺼 둔 계좌는 빼고 센다.
   * 전세보증금처럼 액수가 크고 움직이지 않는 것이 매달의 변화를 덮어버릴 때 쓴다.
   */
  netWorth(asOf, { dashboard = false } = {}) {
    const bal = this.balances(asOf);
    let assets = 0;
    let debts = 0;
    let hidden = [];
    // 종류가 아니라 잔고의 부호로 가른다. 마이너스 통장도, 더 낸 카드값도 이러면 맞는다.
    for (const a of this.config.accounts) {
      if (dashboard && a.offDashboard) { hidden.push(a.name); continue; }
      const v = bal[a.id] || 0;
      if (v < 0) debts += v;
      else assets += v;
    }
    return { assets, debts, net: assets + debts, bal, hidden };
  }

  // ---- 쓰기 ----

  async saveTxn(input) {
    const t = {
      id: input.id || uid('t'),
      date: input.date,
      kind: input.kind,
      amount: Math.abs(Math.round(Number(input.amount) || 0)),
      categoryId: input.kind === 'transfer' ? null : input.categoryId || null,
      accountId: input.accountId || null,
      toAccountId: input.kind === 'transfer' ? input.toAccountId || null : null,
      memberId: input.memberId || null,
      // 이자 지출이 어느 대출에 대한 것인지. 대출별 낸 이자 합계를 내는 데 쓴다.
      loanId: input.loanId || null,
      memo: (input.memo || '').trim(),
      sample: false,
      updatedAt: Date.now(),
    };
    const prevKey = input.id ? this.findMonth(input.id) : null;
    const key = monthKey(t.date);
    if (prevKey && prevKey !== key) await this.removeFrom(prevKey, input.id);
    (this.months[key] ||= {})[t.id] = t;
    this.emit();
    await this.writeMonth(key, { [t.id]: t });
    return t;
  }

  async deleteTxn(id) {
    const key = this.findMonth(id);
    if (!key) return;
    await this.removeFrom(key, id);
    this.emit();
  }

  findMonth(id) {
    return Object.keys(this.months).find((k) => this.months[k][id]) || null;
  }

  async removeFrom(key, id) {
    const tomb = { id, deleted: true, updatedAt: Date.now() };
    if (this.isRemote()) {
      this.months[key][id] = tomb;
      await this.adapter.putItems(key, { [id]: tomb });
    } else {
      delete this.months[key][id];
      await this.persist();
    }
  }

  async writeMonth(key, items) {
    if (this.isRemote()) await this.adapter.putItems(key, items);
    else await this.persist();
  }

  async saveConfig(next) {
    this.config = migrate({ ...this.config, ...next });
    this.emit();
    if (this.isRemote()) await this.adapter.putConfig(this.config);
    else await this.persist();
  }

  async clearSamples() {
    for (const [key, items] of Object.entries(this.months)) {
      const gone = Object.values(items).filter((t) => t && t.sample);
      if (!gone.length) continue;
      if (this.isRemote()) {
        const patch = {};
        for (const t of gone) patch[t.id] = { id: t.id, deleted: true, updatedAt: Date.now() };
        Object.assign(items, patch);
        await this.adapter.putItems(key, patch);
      } else {
        for (const t of gone) delete items[t.id];
      }
    }
    await this.persist();
    this.emit();
  }

  async replaceAll(data) {
    if (!data || typeof data !== 'object' || !data.config) throw new Error('가계부 파일 형식이 아닙니다.');
    await this.adapter.clear();
    this.apply(data);
    if (this.isRemote()) await this.pushAll();
    else await this.persist();
    this.emit();
  }

  async resetAll() {
    await this.replaceAll({ config: emptyConfig(), months: {} });
  }

  exportData() {
    return { kind: 'hab.ledger', version: 1, exportedAt: new Date().toISOString(), config: this.config, months: this.months };
  }
}

function migrate(config) {
  const base = defaultConfig();
  return {
    settings: { ...base.settings, ...(config.settings || {}) },
    members: config.members?.length ? config.members : base.members,
    accounts: config.accounts?.length ? config.accounts : base.accounts,
    categories: config.categories?.length ? config.categories : base.categories,
  };
}

async function resolveCloudDb() {
  try {
    if (!window.claude || typeof window.claude.use !== 'function') return null;
    return await window.claude.use('db');
  } catch {
    return null;
  }
}

export const store = new Store();
export { defaultConfig };
export const _internal = { sampleTxns, defaultConfig };
