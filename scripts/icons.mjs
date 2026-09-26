// Draws the PNG app icons into src/static/. Dependency-free: shapes are signed-distance
// functions, anti-aliased by 4×4 supersampling, and the PNG encoder is node:zlib + CRC32.
// Run with `npm run icons` and commit the output. The hand-written src/static/favicon.svg is
// a pixel-aligned simplification of the same motif.
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const OUT = new URL('../src/static/', import.meta.url);

const BG = '#0b0c0e';
const GREY_OUTER = '#2c2f35';
const GREY_INNER = '#3b3f47';
const ORANGE = '#f7931a';

// Motif in its own units: centred on (0, 0), the lens is 1 wide.
// Five lines of "text"; the middle one is orange and framed by the lens.
const LENS = { h: 0.3, r: 0.09, stroke: 0.026 };
const BAR = 0.085;
const MID_BAR = 0.11;
const LEFT = -0.37;
const ROWS = [
  // centre y, right end x, thickness, colour
  [-0.42, 0.06, BAR, GREY_OUTER],
  [-0.27, 0.29, BAR, GREY_INNER],
  [0, 0.21, MID_BAR, ORANGE],
  [0.27, 0.37, BAR, GREY_INNER],
  [0.42, 0.0, BAR, GREY_OUTER],
];

// scale: motif width as a fraction of the icon; corner: background corner radius
// (0 = full-bleed square); alpha: write RGBA (true) or opaque RGB (false).
const ICONS = [
  { file: 'icon-192.png', size: 192, scale: 0.66, corner: 0.2, alpha: true },
  { file: 'icon-512.png', size: 512, scale: 0.66, corner: 0.2, alpha: true },
  // Maskable: full bleed; everything must stay inside the central safe circle (radius 40%).
  { file: 'icon-maskable-512.png', size: 512, scale: 0.6, corner: 0, alpha: false, safe: 0.4 },
  // iOS adds its own rounded corners and needs an opaque image.
  { file: 'apple-touch-icon.png', size: 180, scale: 0.64, corner: 0, alpha: false },
];

// Signed distance (negative inside) to a rounded rectangle given by centre, half-size, radius.
function roundRect(cx, cy, hw, hh, r) {
  return (x, y) => {
    const qx = Math.abs(x - cx) - hw + r;
    const qy = Math.abs(y - cy) - hh + r;
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
  };
}

// The outline of a shape: a band of width w centred on its edge.
const outline = (sdf, w) => (x, y) => Math.abs(sdf(x, y)) - w / 2;

function motifShapes(size, scale) {
  const u = size * scale; // pixels per motif unit
  const c = size / 2;
  const shapes = [];
  for (const [y, right, t, colour] of ROWS) {
    const hw = ((right - LEFT) * u) / 2;
    shapes.push({ colour, sdf: roundRect(c + ((LEFT + right) / 2) * u, c + y * u, hw, (t * u) / 2, (t * u) / 2) });
  }
  const lens = roundRect(c, c, (u - LENS.stroke * u) / 2, (LENS.h * u - LENS.stroke * u) / 2, (LENS.r - LENS.stroke / 2) * u);
  shapes.push({ colour: ORANGE, sdf: outline(lens, LENS.stroke * u) });
  return shapes;
}

const SS = 4; // samples per pixel along each axis

function render({ size, scale, corner }) {
  const rgba = new Float64Array(size * size * 4); // premultiplied, 0..1
  const bg = corner
    ? roundRect(size / 2, size / 2, size / 2, size / 2, corner * size)
    : () => -Infinity;
  for (const { colour, sdf } of [{ colour: BG, sdf: bg }, ...motifShapes(size, scale)]) {
    const [r, g, b] = rgb(colour);
    for (let py = 0; py < size; py++) {
      for (let px = 0; px < size; px++) {
        // Quick reject/accept: a pixel lies within 0.71 px of its centre.
        const d = sdf(px + 0.5, py + 0.5);
        if (d > 0.75) continue;
        let a = 1;
        if (d > -0.75) {
          a = 0;
          for (let j = 0; j < SS; j++) {
            for (let i = 0; i < SS; i++) {
              // Each sample is a tiny box: partial coverage from the distance keeps edges smooth.
              const ds = sdf(px + (i + 0.5) / SS, py + (j + 0.5) / SS) * SS;
              a += Math.min(1, Math.max(0, 0.5 - ds));
            }
          }
          a /= SS * SS;
        }
        const o = (py * size + px) * 4;
        rgba[o] = r * a + rgba[o] * (1 - a);
        rgba[o + 1] = g * a + rgba[o + 1] * (1 - a);
        rgba[o + 2] = b * a + rgba[o + 2] * (1 - a);
        rgba[o + 3] = a + rgba[o + 3] * (1 - a);
      }
    }
  }
  return rgba;
}

function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

// Largest distance from the icon centre that any motif pixel reaches, as a fraction of the size.
function motifExtent(size, scale) {
  const shapes = motifShapes(size, scale);
  let max = 0;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const x = px + 0.5;
      const y = py + 0.5;
      if (shapes.some((s) => s.sdf(x, y) < 0.5)) max = Math.max(max, Math.hypot(x - size / 2, y - size / 2) + 0.71);
    }
  }
  return max / size;
}

function toBytes(rgba, size, alpha) {
  const ch = alpha ? 4 : 3;
  const out = new Uint8Array(size * size * ch);
  for (let i = 0; i < size * size; i++) {
    const a = rgba[i * 4 + 3];
    for (let k = 0; k < 3; k++) {
      // Un-premultiply for straight-alpha PNG; opaque icons have a = 1 everywhere.
      const v = alpha ? (a > 0 ? rgba[i * 4 + k] / a : 0) : rgba[i * 4 + k];
      out[i * ch + k] = Math.round(Math.min(1, Math.max(0, v)) * 255);
    }
    if (alpha) out[i * ch + 3] = Math.round(a * 255);
  }
  return out;
}

// --- PNG encoder -------------------------------------------------------------------------

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(bytes) {
  let c = -1;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const buf = Buffer.alloc(12 + data.length);
  buf.writeUInt32BE(data.length, 0);
  buf.write(type, 4, 'latin1');
  buf.set(data, 8);
  buf.writeUInt32BE(crc32(buf.subarray(4, 8 + data.length)), 8 + data.length);
  return buf;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

// Per row, pick the filter with the smallest sum of absolute differences (the libpng heuristic).
function filterRows(pixels, width, height, ch) {
  const stride = width * ch;
  const out = new Uint8Array((stride + 1) * height);
  const zero = new Uint8Array(stride);
  const trial = new Uint8Array(stride);
  const best = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const row = pixels.subarray(y * stride, (y + 1) * stride);
    const up = y ? pixels.subarray((y - 1) * stride, y * stride) : zero;
    let bestType = 0;
    let bestSum = Infinity;
    for (let type = 0; type < 5; type++) {
      let sum = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= ch ? row[i - ch] : 0;
        const b = up[i];
        const c = i >= ch ? up[i - ch] : 0;
        const pred = type === 0 ? 0 : type === 1 ? a : type === 2 ? b : type === 3 ? (a + b) >> 1 : paeth(a, b, c);
        const v = (row[i] - pred) & 255;
        trial[i] = v;
        sum += v < 128 ? v : 256 - v;
      }
      if (sum < bestSum) {
        bestSum = sum;
        bestType = type;
        best.set(trial);
      }
    }
    out[y * (stride + 1)] = bestType;
    out.set(best, y * (stride + 1) + 1);
  }
  return out;
}

function encodePng(pixels, width, height, alpha) {
  const ch = alpha ? 4 : 3;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = alpha ? 6 : 2; // colour type: RGBA or RGB
  // bytes 10–12: compression 0, filter method 0, no interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(filterRows(pixels, width, height, ch), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- main --------------------------------------------------------------------------------

for (const icon of ICONS) {
  if (icon.safe) {
    const extent = motifExtent(icon.size, icon.scale);
    if (extent > icon.safe) throw new Error(`${icon.file}: motif reaches ${extent.toFixed(3)} of the size, outside the safe zone`);
  }
  const png = encodePng(toBytes(render(icon), icon.size, icon.alpha), icon.size, icon.size, icon.alpha);
  writeFileSync(new URL(icon.file, OUT), png);
  console.log(`${icon.file}  ${icon.size}×${icon.size}  ${icon.alpha ? 'RGBA' : 'RGB'}  ${png.length} bytes`);
}
