// Firebase 콘솔 → 프로젝트 설정(⚙) → 내 앱 → 웹 앱 에서 복사한 값을 그대로 붙여넣으세요.
//
// 이 값들은 비밀이 아닙니다. 웹 앱에서는 브라우저에 그대로 내려가는 '프로젝트 주소'에
// 가깝고, 구글도 공개를 전제로 설명합니다. 실제 보호는 저장소 루트의 firestore.rules 가
// 합니다 — 로그인한 우리 가족만 우리 장부를 읽고 쓸 수 있게 막아 둡니다.
export const firebaseConfig = {
  apiKey: '',
  authDomain: '',
  projectId: '',
  storageBucket: '',
  messagingSenderId: '',
  appId: '',
};

export function isConfigured() {
  return Boolean(firebaseConfig.apiKey && firebaseConfig.projectId);
}
