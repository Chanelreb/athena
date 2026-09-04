// Generates Athena's app icons — a warm crescent moon on the app's dark
// gradient — as PNGs, with no dependencies (hand-rolled PNG encoder via zlib).
//   node gen-icons.js   ->   writes icons/*.png
// Re-run if you change the mark. Full-bleed square so it survives home-screen masking.
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const OUT = path.join(__dirname, 'icons');
fs.mkdirSync(OUT, { recursive: true });

// --- minimal PNG encoder (RGBA, 8-bit) ---
const CRC_TABLE = (() => {
  const t = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
  return t;
})();
function crc32(buf){ let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function chunk(type, data){
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function encodePNG(size, rgba){
  const sig = Buffer.from([137,80,78,71,13,10,26,10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGBA
  const stride = size * 4;
  const raw = Buffer.alloc(size * (1 + stride));
  for (let y = 0; y < size; y++){ raw[y * (1 + stride)] = 0; rgba.copy(raw, y * (1 + stride) + 1, y * stride, (y + 1) * stride); }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

const lerp = (a, b, t) => a + (b - a) * t;

function drawIcon(size){
  const buf = Buffer.alloc(size * size * 4);
  const cx = size * 0.47, cy = size * 0.50, R = size * 0.32;   // moon disc
  const bx = size * 0.62, by = size * 0.44, R2 = size * 0.30;  // the bite that makes the crescent
  const A = [229, 168, 126];                                   // --live warm accent
  for (let y = 0; y < size; y++){
    const tg = y / size;
    const bg = [Math.round(lerp(0x35, 0x2C, tg)), Math.round(lerp(0x31, 0x29, tg)), Math.round(lerp(0x3D, 0x32, tg))];
    for (let x = 0; x < size; x++){
      const dA = Math.hypot(x - cx, y - cy), dB = Math.hypot(x - bx, y - by);
      const aA = Math.max(0, Math.min(1, (R - dA) + 0.5));   // ~1px soft edge
      const aB = Math.max(0, Math.min(1, (R2 - dB) + 0.5));
      const a = aA * (1 - aB);
      const i = (y * size + x) * 4;
      buf[i]   = Math.round(lerp(bg[0], A[0], a));
      buf[i+1] = Math.round(lerp(bg[1], A[1], a));
      buf[i+2] = Math.round(lerp(bg[2], A[2], a));
      buf[i+3] = 255;
    }
  }
  return encodePNG(size, buf);
}

[[512, 'icon-512.png'], [192, 'icon-192.png'], [180, 'apple-touch-icon.png'], [32, 'favicon-32.png']]
  .forEach(([s, name]) => { fs.writeFileSync(path.join(OUT, name), drawIcon(s)); console.log('wrote icons/' + name); });
