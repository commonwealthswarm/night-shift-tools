// Synthetic PNG fixtures for tests: a deterministic image (not an Indus sign, not from any source) and a small decoder,
// so tests can compare the pixels a model actually received rather than trusting a URL or a hash alone.
// Kept identical to night-shift's api/test/png-fixture.mjs.
import { deflateSync, inflateSync } from "node:zlib";
import { createHash } from "node:crypto";

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

// rgb(x, y) -> [r, g, b]
export function encodePng(width, height, rgb) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) { const [r, g, b] = rgb(x, y); const o = y * (width * 3 + 1) + 1 + x * 3; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

// A stroke drawing on white with a coloured code strip, unique per `tag`, so a swapped image can't pass.
export function fixturePixels(tag = "fixture") {
  const h = createHash("sha256").update(tag).digest();
  return (x, y) => {
    if (y < 4) { const k = h[x % 32]; return [k, 255 - k, (k * 7) & 255]; }
    const stroke = (x >= 10 && x <= 12 && y >= 6 && y <= 28) || (y >= 26 && y <= 28 && x >= 10 && x <= 38) || (x >= 36 && x <= 38 && y >= 6 && y <= 28) || (Math.abs(x - 24) <= 1 && y >= 10 && y <= 20 && (h[0] & 1));
    return stroke ? [0, 0, 0] : [255, 255, 255];
  };
}
export const FIXTURE_W = 48, FIXTURE_H = 32;
export function fixturePng(tag) { return encodePng(FIXTURE_W, FIXTURE_H, fixturePixels(tag)); }
export const sha256 = buf => createHash("sha256").update(buf).digest("hex");

// Decodes 8-bit, non-interlaced greyscale, RGB, grey+alpha or RGBA PNGs to RGB triples.
export function decodePng(buf) {
  buf = Buffer.from(buf);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let off = 8, width = 0, height = 0, depth = 0, type = 0, interlace = 0; const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off), t = buf.toString("ascii", off + 4, off + 8), data = buf.subarray(off + 8, off + 8 + len);
    if (t === "IHDR") { width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]; type = data[9]; interlace = data[12]; }
    else if (t === "IDAT") idat.push(data);
    else if (t === "IEND") break;
    off += 12 + len;
  }
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[type];
  if (depth !== 8 || !ch || interlace) throw new Error(`unsupported PNG (depth ${depth}, type ${type}, interlace ${interlace})`);
  const raw = inflateSync(Buffer.concat(idat)), stride = width * ch, out = Buffer.alloc(width * height * ch);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? out[y * stride + i - ch] : 0, b = y ? out[(y - 1) * stride + i] : 0, c = i >= ch && y ? out[(y - 1) * stride + i - ch] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      out[y * stride + i] = (line[i] + pred) & 255;
    }
  }
  const rgb = [];
  for (let i = 0; i < width * height; i++) { const o = i * ch; rgb.push(ch < 3 ? [out[o], out[o], out[o]] : [out[o], out[o + 1], out[o + 2]]); }
  return { width, height, rgb };
}

export function samePixels(decoded, w, h, rgb) {
  if (decoded.width !== w || decoded.height !== h) return false;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const a = decoded.rgb[y * w + x], b = rgb(x, y); if (a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2]) return false; }
  return true;
}
