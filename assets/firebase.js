// Firebase 연동 — 로그인(구글), 가계부(household) 만들기·참여, Firestore 저장 어댑터.
//
// SDK 는 필요할 때 CDN 에서 동적으로 불러온다. 설정값이 비어 있으면 아무것도 하지
// 않으므로, 파이어베이스를 안 쓰는 사람에게는 코드가 존재하지 않는 것과 같다.

import { firebaseConfig, isConfigured } from './firebase-config.js';

const SDK = 'https://www.gstatic.com/firebasejs/12.19.0/';
// 초대 코드에서 헷갈리는 0·O·1·I 는 뺐다
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

let sdkPromise = null;
function loadSdk() {
  if (!sdkPromise) {
    sdkPromise = Promise.all([
      import(`${SDK}firebase-app.js`),
      import(`${SDK}firebase-auth.js`),
      import(`${SDK}firebase-firestore.js`),
    ]).then(([app, auth, fs]) => ({ app, auth, fs }));
  }
  return sdkPromise;
}

let ctx = null;
let sdkError = null;

export async function boot() {
  if (!isConfigured()) return null;
  if (ctx) return ctx;
  let sdk;
  try {
    sdk = await loadSdk();
  } catch (err) {
    // 비행기 모드거나 CDN 이 막힌 환경 — 혼자 쓰기로 조용히 내려앉는다
    sdkPromise = null;
    sdkError = err;
    return null;
  }
  const app = sdk.app.getApps()[0] || sdk.app.initializeApp(firebaseConfig);
  const auth = sdk.auth.getAuth(app);
  let db;
  try {
    // 오프라인에서도 열리고, 여러 탭을 동시에 열어도 안전하게
    db = sdk.fs.initializeFirestore(app, {
      localCache: sdk.fs.persistentLocalCache({ tabManager: sdk.fs.persistentMultipleTabManager() }),
    });
  } catch {
    db = sdk.fs.getFirestore(app);
  }
  ctx = { sdk, app, auth, db };
  return ctx;
}

export { isConfigured };

// ── 로그인 ───────────────────────────────────────────────────────────────

/** 처음 한 번, 이미 로그인돼 있는지 확인한다. 응답이 없으면 8초 뒤 비로그인으로 본다. */
export async function currentUser() {
  const c = await boot();
  if (!c) return null;
  await c.sdk.auth.getRedirectResult(c.auth).catch(() => {});
  return new Promise((resolve) => {
    let done = false;
    let stop = null;
    const finish = (u) => {
      if (done) return;
      done = true;
      if (stop) stop();
      resolve(u);
    };
    const timer = setTimeout(() => finish(null), 8000);
    stop = c.sdk.auth.onAuthStateChanged(c.auth, (u) => { clearTimeout(timer); finish(u); });
  });
}

export async function onAuthChange(fn) {
  const c = await boot();
  if (!c) return () => {};
  return c.sdk.auth.onAuthStateChanged(c.auth, fn);
}

export async function signIn() {
  const c = await boot();
  if (!c) throw new Error(sdkError ? '지금은 네트워크가 막혀 Firebase에 닿지 못했어요. 연결을 확인하고 다시 시도해 주세요.' : 'Firebase 설정값이 아직 비어 있어요.');
  const provider = new c.sdk.auth.GoogleAuthProvider();
  try {
    await c.sdk.auth.signInWithPopup(c.auth, provider);
  } catch (err) {
    const code = err?.code || '';
    // 팝업이 막히는 브라우저(주로 아이폰 사파리)에서는 화면 전환 방식으로
    if (code.includes('popup-blocked') || code.includes('operation-not-supported')) {
      await c.sdk.auth.signInWithRedirect(c.auth, provider);
      return;
    }
    if (code.includes('popup-closed') || code.includes('cancelled-popup')) return;
    throw new Error(authMessage(code, err));
  }
}

export async function signOut() {
  const c = await boot();
  if (c) await c.sdk.auth.signOut(c.auth);
}

function authMessage(code, err) {
  if (code.includes('unauthorized-domain')) {
    return '이 주소가 Firebase에 등록돼 있지 않아요. 콘솔 → Authentication → 설정 → 승인된 도메인에 주소를 추가해 주세요.';
  }
  if (code.includes('operation-not-allowed')) {
    return 'Google 로그인이 꺼져 있어요. 콘솔 → Authentication → Sign-in method 에서 Google을 켜 주세요.';
  }
  if (code.includes('network')) return '네트워크가 불안정해요. 잠시 뒤 다시 시도해 주세요.';
  return err?.message || '로그인에 실패했어요.';
}

// ── 가계부(household) ────────────────────────────────────────────────────

function randomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('');
}

export function prettyCode(code) {
  return code ? `${code.slice(0, 4)}-${code.slice(4)}` : '';
}

export function normalizeCode(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export async function myHouseholdId(uid) {
  const c = await boot();
  if (!c) return null;
  const { doc, getDoc } = c.sdk.fs;
  const snap = await getDoc(doc(c.db, 'users', uid));
  return snap.exists() ? snap.data().householdId || null : null;
}

/** 새 가계부를 연다. 코드가 겹치면 규칙이 막아 주므로(이미 있는 문서는 create 가 아니다) 다시 뽑는다. */
export async function createHousehold(user, config) {
  const c = await boot();
  const { doc, setDoc } = c.sdk.fs;
  let lastErr = null;
  for (let i = 0; i < 5; i += 1) {
    const code = randomCode();
    try {
      await setDoc(doc(c.db, 'households', code), {
        name: config.settings.household || '우리집 가계부',
        ownerUid: user.uid,
        memberUids: [user.uid],
        joinOpen: true,
        config,
      });
      await setDoc(doc(c.db, 'users', user.uid), { householdId: code, email: user.email || '' });
      return code;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(rulesMessage(lastErr, '가계부를 만들지 못했어요.'));
}

export async function joinHousehold(user, rawCode) {
  const c = await boot();
  const { doc, getDoc, updateDoc, setDoc, arrayUnion } = c.sdk.fs;
  const code = normalizeCode(rawCode);
  if (code.length < 6) throw new Error('초대 코드를 다시 확인해 주세요.');
  const ref = doc(c.db, 'households', code);
  let snap;
  try {
    snap = await getDoc(ref);
  } catch (err) {
    throw new Error(rulesMessage(err, '그 초대 코드로는 들어갈 수 없어요.'));
  }
  if (!snap.exists()) throw new Error('그런 초대 코드가 없어요. 글자를 다시 확인해 주세요.');
  const data = snap.data();
  if (!(data.memberUids || []).includes(user.uid)) {
    if (!data.joinOpen) throw new Error('초대가 닫혀 있어요. 상대방에게 설정에서 초대를 다시 열어 달라고 해주세요.');
    try {
      await updateDoc(ref, { memberUids: arrayUnion(user.uid) });
    } catch (err) {
      throw new Error(rulesMessage(err, '참여하지 못했어요.'));
    }
  }
  await setDoc(doc(c.db, 'users', user.uid), { householdId: code, email: user.email || '' });
  return code;
}

export async function setJoinOpen(code, open) {
  const c = await boot();
  const { doc, updateDoc } = c.sdk.fs;
  await updateDoc(doc(c.db, 'households', code), { joinOpen: !!open });
}

export async function leaveHousehold(user) {
  const c = await boot();
  const { doc, deleteDoc } = c.sdk.fs;
  await deleteDoc(doc(c.db, 'users', user.uid)).catch(() => {});
}

function rulesMessage(err, fallback) {
  const code = err?.code || '';
  if (code.includes('permission-denied')) {
    return `${fallback} Firestore 규칙이 막고 있어요. 저장소의 firestore.rules 를 배포했는지 확인해 주세요.`;
  }
  if (code.includes('unavailable')) return '네트워크가 불안정해요. 잠시 뒤 다시 시도해 주세요.';
  return err?.message || fallback;
}

// ── 저장 어댑터 ──────────────────────────────────────────────────────────

export async function firebaseAdapter(code) {
  const c = await boot();
  const { doc, collection, getDoc, getDocs, setDoc, deleteDoc, onSnapshot } = c.sdk.fs;
  const hRef = doc(c.db, 'households', code);
  const txCol = collection(c.db, 'households', code, 'tx');

  const readMonths = (snap) => {
    const months = {};
    snap.forEach((d) => { months[d.id] = { ...(d.data().items || {}) }; });
    return months;
  };

  return {
    name: 'firebase',
    async load() {
      const [h, tx] = await Promise.all([getDoc(hRef), getDocs(txCol)]);
      if (!h.exists()) return null;
      return { config: h.data().config || null, months: readMonths(tx) };
    },
    async putConfig(config) {
      await setDoc(hRef, { config, name: config.settings.household || '우리집 가계부' }, { merge: true });
    },
    // 항목 단위 병합 — 둘이 같은 달을 동시에 손대도 서로의 입력이 살아남는다
    async putItems(key, items) {
      await setDoc(doc(txCol, key), { items }, { merge: true });
    },
    async putMonth(key, items) {
      await setDoc(doc(txCol, key), { items });
    },
    async clear() {
      const tx = await getDocs(txCol);
      await Promise.all(tx.docs.map((d) => deleteDoc(d.ref)));
    },
    subscribe(onConfig, onMonths, onMeta) {
      const stops = [
        onSnapshot(hRef, (s) => {
          if (!s.exists()) return;
          const d = s.data();
          if (d.config) onConfig(d.config);
          if (onMeta) onMeta({ joinOpen: !!d.joinOpen, members: (d.memberUids || []).length, ownerUid: d.ownerUid });
        }, () => {}),
        onSnapshot(txCol, (s) => onMonths(readMonths(s)), () => {}),
      ];
      return () => stops.forEach((f) => f());
    },
  };
}
