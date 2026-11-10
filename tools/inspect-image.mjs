// Analiza una imagen: colores distintos, % no-negro y si hay "texto" (pixeles claros).
import fs from 'node:fs';
import zlib from 'node:zlib';

const file = process.argv[2];
const buf = fs.readFileSync(file);
if (buf.readUInt32BE(0) !== 0x89504e47) { console.log('no es PNG'); process.exit(1); }
let pos = 8, w = 0, h = 0, bitDepth = 0, colorType = 0; const idat = [];
while (pos < buf.length) {
  const len = buf.readUInt32BE(pos); const type = buf.toString('ascii', pos + 4, pos + 8);
  const data = buf.subarray(pos + 8, pos + 8 + len);
  if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; }
  if (type === 'IDAT') idat.push(data);
  pos += 12 + len;
  if (type === 'IEND') break;
}
const raw = zlib.inflateSync(Buffer.concat(idat));
const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
const bpp = channels * (bitDepth / 8);
const stride = w * bpp;
const out = Buffer.alloc(h * stride);
let rp = 0;
for (let y = 0; y < h; y++) {
  const filter = raw[rp++];
  const line = raw.subarray(rp, rp + stride); rp += stride;
  const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
  const cur = out.subarray(y * stride, (y + 1) * stride);
  for (let x = 0; x < stride; x++) {
    const a = x >= bpp ? cur[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0, v = line[x];
    let val;
    if (filter === 0) val = v; else if (filter === 1) val = v + a; else if (filter === 2) val = v + b;
    else if (filter === 3) val = v + ((a + b) >> 1);
    else { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); val = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
    cur[x] = val & 0xff;
  }
}
const colors = new Set(); let nonDark = 0, bright = 0, total = 0;
for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
  const i = y * stride + x * bpp;
  const r = out[i], g = out[i + 1] ?? r, b = out[i + 2] ?? r;
  total++; colors.add((r >> 3) + ',' + (g >> 3) + ',' + (b >> 3));
  if (r + g + b > 90) nonDark++;
  if (r + g + b > 480) bright++;
}
console.log(`${file}: ${w}x${h} tipo=${colorType} depth=${bitDepth}`);
console.log(`  colores_distintos=${colors.size}  pixeles_no_oscuros=${(100 * nonDark / total).toFixed(1)}%  pixeles_brillantes(texto/UI)=${(100 * bright / total).toFixed(2)}%`);
