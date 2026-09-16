// 앱 아이콘(PNG)을 만든다. 외부 의존성 없이 zlib 만으로 PNG 를 직접 쓴다.
//   node tools/make-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const BG = [0x1f, 0x5c, 0x4a];
const FG = [0xff, 0xff, 0xff];
const ACCENT = [0xf2, 0xc6, 0x4b];

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n += 1) {
    c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 3 + 1));
  let p = 0;
  for (let y = 0; y < size; y += 1) {
    raw[p] = 0; p += 1;
    for (let x = 0; x < size; x += 1) {
      const [r, g, b] = pixel(x, y, size);
      raw[p] = r; raw[p + 1] = g; raw[p + 2] = b; p += 3;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// 초록 바탕 위의 흰 막대 세 개 — 가계부의 지출 그래프.
// 마스크 적용 아이콘을 대비해 그림은 가운데 60% 안에만 둔다.
function draw(x, y, size) {
  const u = size / 100;
  const cx = x / u;
  const cy = y / u;
  const bars = [
    { x: 26, w: 12, h: 22, color: FG },
    { x: 44, w: 12, h: 36, color: FG },
    { x: 62, w: 12, h: 29, color: ACCENT },
  ];
  const baseline = 72;
  for (const b of bars) {
    if (cx >= b.x && cx < b.x + b.w && cy <= baseline && cy >= baseline - b.h) {
      const top = baseline - b.h;
      const r = 5;
      const dx = Math.min(cx - b.x, b.x + b.w - cx);
      if (cy < top + r && dx < r) {
        const d = Math.hypot(r - dx, top + r - cy);
        if (d > r) return BG;
      }
      return b.color;
    }
  }
  if (cy > baseline && cy <= baseline + 3 && cx >= 24 && cx <= 76) return FG;
  return BG;
}

mkdirSync(new URL('../icons/', import.meta.url), { recursive: true });
for (const size of [192, 512]) {
  const out = new URL(`../icons/icon-${size}.png`, import.meta.url);
  writeFileSync(out, png(size, draw));
  console.log(`icons/icon-${size}.png`);
}
