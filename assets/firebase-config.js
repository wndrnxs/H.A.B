// Firebase 콘솔 → 프로젝트 설정(⚙) → 내 앱 → 웹 앱 에서 가져온 값.
//
// 이 값들은 비밀이 아닙니다. 웹 앱에서는 브라우저에 그대로 내려가는 '프로젝트 주소'에
// 가깝고, 구글도 공개를 전제로 설명합니다. 실제 보호는 저장소 루트의 firestore.rules 가
// 합니다 — 로그인한 우리 가족만 우리 장부를 읽고 쓸 수 있게 막아 둡니다.
export const firebaseConfig = {
  apiKey: 'AIzaSyDTD6sTos7YaXkV6sq_UnVjI3Q9t5FYQCc',
  authDomain: 'house-ab.firebaseapp.com',
  projectId: 'house-ab',
  storageBucket: 'house-ab.firebasestorage.app',
  messagingSenderId: '912272687387',
  appId: '1:912272687387:web:83634de3d008d14bad93be',
  measurementId: 'G-GD3VNZWSV4',
};

export function isConfigured() {
  return Boolean(firebaseConfig.apiKey && firebaseConfig.projectId);
}
