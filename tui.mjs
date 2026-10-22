#!/usr/bin/env node
// Night Shift terminal UI. Zero dependencies, Node 18+.
//
// The launcher hands it every Claude Code stream-json line (tui.stream) and its own checks (tui.check).
//   node tui.mjs --demo [--speed 2] [--images ascii|kitty|iterm]
// replays a scripted run through the same path, with made-up numbers. Sign drawings are hand-drawn stand-ins,
// not glyph crops.
import { readFileSync } from "node:fs";
import { inflateSync, deflateSync } from "node:zlib";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// ── palette ─────────────────────────────────────────────────────────────────────────────────────────────
const C = {
  bg: 0x07080b, sel: 0x151a26, line: 0x252935,
  fg: 0xd7d9de, dim: 0x737887, faint: 0x434857,
  amber: 0xffb454, amberHi: 0xffdca0, amberLo: 0x6b4512, green: 0x7ee787, cyan: 0x5fd7d7, violet: 0xb392f0, rose: 0xff8fa3,
  red: 0xff5f5f, blue: 0x79c0ff, magenta: 0xe07be0,
};
const mix = (a, b, t) => [16, 8, 0].reduce((o, s) => o | Math.round(((a >> s) & 255) * (1 - t) + ((b >> s) & 255) * t) << s, 0);

// ── terminal capabilities ───────────────────────────────────────────────────────────────────────────────
const env = process.env;
const TRUECOLOR = /truecolor|24bit/i.test(env.COLORTERM || "") || env.TERM_PROGRAM === "iTerm.app" || env.TERM_PROGRAM === "WezTerm";
// The seal is drawn as ASCII unless real pixels are asked for (kitty: Ghostty, kitty, WezTerm; iterm: iTerm2, WezTerm).
const imageMode = flag => (env.TMUX || env.STY) ? "ascii" : flag || env.NIGHT_SHIFT_IMAGES || "ascii";
const to256 = c => { const r = c >> 16 & 255, g = c >> 8 & 255, b = c & 255, q = v => v < 48 ? 0 : v < 115 ? 1 : Math.min(5, Math.floor((v - 35) / 40)); return 16 + 36 * q(r) + 6 * q(g) + q(b); };
const sgrFg = c => TRUECOLOR ? `38;2;${c >> 16 & 255};${c >> 8 & 255};${c & 255}` : `38;5;${to256(c)}`;
const sgrBg = c => TRUECOLOR ? `48;2;${c >> 16 & 255};${c >> 8 & 255};${c & 255}` : `48;5;${to256(c)}`;

// ── cell screen with row diffing ────────────────────────────────────────────────────────────────────────
// Cells marked as holes are skipped on output, so an inline image drawn there survives redraws.
const BOLD = 1, ITALIC = 2, UNDER = 4;
class Screen {
  constructor() { this.prev = []; this.resize(); }
  resize() { this.w = process.stdout.columns || 100; this.h = process.stdout.rows || 32; this.prev = []; }
  clear(bg = C.bg) {
    const n = this.w * this.h;
    this.ch = new Array(n).fill(" "); this.fg = new Int32Array(n).fill(C.fg); this.bg = new Int32Array(n).fill(bg);
    this.at = new Uint8Array(n); this.hole = new Uint8Array(n); this.link = new Array(n).fill(null);
  }
  fill(x, y, w, h, bg) { for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) this.put(i, j, " ", C.fg, bg); }
  put(x, y, ch, fg, bg, at = 0, link = null) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const k = y * this.w + x;
    this.ch[k] = ch; if (fg != null) this.fg[k] = fg; if (bg != null) this.bg[k] = bg; this.at[k] = at; this.link[k] = link;
  }
  text(x, y, s, fg = C.fg, bg = null, at = 0, link = null) {
    let i = 0;
    for (const ch of String(s)) this.put(x + i++, y, ch, fg, bg, at, link);
    return x + i;
  }
  // One half-block pixel: py counts half rows.
  pix(x, py, color) {
    const y = py >> 1;
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const k = y * this.w + x;
    if (this.ch[k] !== "▀") { this.fg[k] = this.bg[k]; this.ch[k] = "▀"; this.at[k] = 0; }
    if (py & 1) this.bg[k] = color; else this.fg[k] = color;
  }
  box(x, y, w, h, title = "", color = C.line, titleColor = C.dim) {
    for (let i = x + 1; i < x + w - 1; i++) { this.put(i, y, "─", color); this.put(i, y + h - 1, "─", color); }
    for (let j = y + 1; j < y + h - 1; j++) { this.put(x, j, "│", color); this.put(x + w - 1, j, "│", color); }
    this.put(x, y, "┌", color); this.put(x + w - 1, y, "┐", color); this.put(x, y + h - 1, "└", color); this.put(x + w - 1, y + h - 1, "┘", color);
    if (title) this.text(x + 2, y, " " + clip(title, w - 6) + " ", titleColor);
  }
  holes(x, y, w, h) { for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) if (i >= 0 && j >= 0 && i < this.w && j < this.h) this.hole[j * this.w + i] = 1; }
  row(y) {
    let out = "", st = null, ln = null, jump = false;
    for (let x = 0; x < this.w; x++) {
      const k = y * this.w + x;
      if (this.hole[k]) { jump = true; continue; }
      if (jump) { out += `\x1b[${y + 1};${x + 1}H`; jump = false; }
      if (this.link[k] !== ln) { out += `\x1b]8;;${this.link[k] || ""}\x1b\\`; ln = this.link[k]; }
      const s = `0;${sgrFg(this.fg[k])};${sgrBg(this.bg[k])}${this.at[k] & BOLD ? ";1" : ""}${this.at[k] & ITALIC ? ";3" : ""}${this.at[k] & UNDER ? ";4" : ""}`;
      if (s !== st) { out += `\x1b[${s}m`; st = s; }
      out += this.ch[k];
    }
    if (ln) out += "\x1b]8;;\x1b\\";
    return out + "\x1b[0m";
  }
  flush() {
    let out = "";
    for (let y = 0; y < this.h; y++) { const r = this.row(y); if (r !== this.prev[y]) { out += `\x1b[${y + 1};1H` + r; this.prev[y] = r; } }
    if (out) write(out);
  }
}

// A closed Terminal can make writes fail; the run's cleanup must go on regardless.
const write = s => { try { process.stdout.write(s); } catch {} };

// ── text helpers ────────────────────────────────────────────────────────────────────────────────────────
const fmt = n => Number(n).toLocaleString("en-US");
const clip = (s, w) => { s = String(s); return w <= 0 ? "" : [...s].length <= w ? s : [...s].slice(0, Math.max(0, w - 1)).join("") + "…"; };
function wrap(s, w) {
  const out = []; let line = "";
  for (const word of String(s).split(/\s+/).filter(Boolean)) {
    if (!line) line = word; else if ((line + " " + word).length <= w) line += " " + word; else { out.push(line); line = word; }
  }
  if (line) out.push(line);
  return out.map(l => clip(l, w));
}
const mmss = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0"); };
const hash = (a, b = 0) => { const n = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453; return n - Math.floor(n); };

// ── the seal photograph ─────────────────────────────────────────────────────────────────────────────────
const HERE = fileURLToPath(new URL(".", import.meta.url));
const SEAL = (() => {
  try { const j = JSON.parse(readFileSync(HERE + "assets/seal.json", "utf8")); return { w: j.w, h: j.h, rgb: inflateSync(Buffer.from(j.rgb, "base64")), z: j.rgb }; } catch { return null; }
})();

// Luma on a tw × th grid: box-filtered, stretched to the 2nd–98th percentile and sharpened, since the carved relief
// is low contrast and the signs would blur into the clay.
function lumaGrid(img, tw, th) {
  const sx = img.w / tw, sy = img.h / th, px = new Float32Array(tw * th);
  for (let ty = 0; ty < th; ty++) for (let tx = 0; tx < tw; tx++) {
    let sum = 0, n = 0;
    for (let y = Math.floor(ty * sy); y < Math.max(Math.floor(ty * sy) + 1, Math.floor((ty + 1) * sy)); y++)
      for (let x = Math.floor(tx * sx); x < Math.max(Math.floor(tx * sx) + 1, Math.floor((tx + 1) * sx)); x++) {
        const o = (Math.min(y, img.h - 1) * img.w + Math.min(x, img.w - 1)) * 3; sum += 0.3 * img.rgb[o] + 0.59 * img.rgb[o + 1] + 0.11 * img.rgb[o + 2]; n++;
      }
    px[ty * tw + tx] = sum / n;
  }
  const at = (x, y) => px[Math.min(th - 1, Math.max(0, y)) * tw + Math.min(tw - 1, Math.max(0, x))];
  const sharp = Float32Array.from(px, (v, i) => { const x = i % tw, y = Math.floor(i / tw); return v * 2.2 - (at(x - 1, y) + at(x + 1, y) + at(x, y - 1) + at(x, y + 1)) * 0.3; });
  const ls = [...sharp].sort((a, b) => a - b), lo = ls[Math.floor(ls.length * 0.03)], hi = ls[Math.floor(ls.length * 0.97)];
  return sharp.map(v => Math.max(0, Math.min(1, (v - lo) / Math.max(1, hi - lo))));
}

// The seal in one phosphor color, two pixels a cell with faint scanlines, decoding from noise: each cell settles
// at its own moment after `since`.
const NOISE = "01<>/\\|[]{}#%&*+=-_:;";
const seals = new Map();
const phosphor = v => v < 0.5 ? mix(0x120c04, C.amber, v * 2) : mix(C.amber, C.amberHi, (v - 0.5) * 2);
function drawSeal(scr, x, y, cols, rows, since) {
  const key = cols + "x" + rows;
  if (!seals.has(key)) seals.set(key, lumaGrid(SEAL, cols, rows * 2));
  const g = seals.get(key), t = Date.now() - since;
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const settle = 200 + hash(i, j) * 800 + j / rows * 900;
    if (t < settle) {
      if (t > settle - 500) scr.put(x + i, y + j, NOISE[Math.floor(hash(i + t / 60 | 0, j) * NOISE.length)], mix(C.bg, C.green, 0.25 + 0.4 * hash(j, i)));
      continue;
    }
    const fresh = Math.max(0, 1 - (t - settle) / 400), lit = c => mix(c, 0xffffff, fresh * 0.6);
    scr.put(x + i, y + j, "▀", lit(phosphor(g[(j * 2) * cols + i])), lit(mix(phosphor(g[(j * 2 + 1) * cols + i]), C.bg, 0.16)));
  }
}

// Real pixels for terminals that can show them. Kitty takes the stored zlib RGB as is; iTerm2 needs a PNG.
const CRC = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
const crc32 = buf => { let c = -1; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function png(img) {
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(img.w, 0); ihdr.writeUInt32BE(img.h, 4); ihdr.set([8, 2, 0, 0, 0], 8);
  const raw = Buffer.alloc((img.w * 3 + 1) * img.h);
  for (let y = 0; y < img.h; y++) img.rgb.copy(raw, y * (img.w * 3 + 1) + 1, y * img.w * 3, (y + 1) * img.w * 3);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
function inlineImage(mode, img, x, y, cols, rows) {
  let out = `\x1b[${y + 1};${x + 1}H`;
  if (mode === "kitty") {
    const data = img.z;
    for (let i = 0; i < data.length; i += 4096) {
      const more = i + 4096 < data.length ? 1 : 0;
      out += i === 0 ? `\x1b_Ga=T,f=24,s=${img.w},v=${img.h},o=z,c=${cols},r=${rows},C=1,q=2,m=${more};${data.slice(i, i + 4096)}\x1b\\` : `\x1b_Gm=${more};${data.slice(i, i + 4096)}\x1b\\`;
    }
  } else out += `\x1b]1337;File=inline=1;width=${cols};height=${rows};preserveAspectRatio=1:${png(img).toString("base64")}\x07`;
  write(out);
}
const clearImages = mode => { if (mode === "kitty") write("\x1b_Ga=d,q=2\x1b\\"); };

// ── signs ───────────────────────────────────────────────────────────────────────────────────────────────
// Hand-drawn stand-ins on a 10×12 grid.
const GLYPHS = {
  jar: ["X........X", "XX......XX", ".X......X.", ".XXXXXXXX.", ".X......X.", ".X......X.", ".X......X.", ".X......X.", "..X....X..", "...XXXX...", "..........", ".........."],
  fish: ["....XX....", "...X..X...", "..X....X..", ".X......X.", "..X....X..", "...X..X...", "....XX....", "....XX....", "...X..X...", "..X....X..", ".X......X.", ".........."],
  diamond: ["....XX....", "...X..X...", "..X.XX.X..", ".X.X..X.X.", "X.X....X.X", "X.X....X.X", ".X.X..X.X.", "..X.XX.X..", "...X..X...", "....XX....", "..........", ".........."],
  tree: ["....XX....", "...X..X...", "..X....X..", "..X.XX.X..", ".X.XXXX.X.", ".X..XX..X.", ".X.XXXX.X.", "X...XX...X", "X..XXXX..X", "X...XX...X", "XXXXXXXXXX", ".........."],
  man: ["....XX....", "....XX....", "..........", "XXXXXXXXXX", "....XX....", "....XX....", "....XX....", "...X..X...", "..X....X..", ".X......X.", "X........X", ".........."],
  arrow: ["....XX....", "...XXXX...", "..X.XX.X..", ".X..XX..X.", "....XX....", "....XX....", "....XX....", "....XX....", "....XX....", "....XX....", "....XX....", ".........."],
  stroke: Array(11).fill("....XX....").concat([".........."]),
  strokes: Array(6).fill("..XX..XX..").concat(Array(6).fill("..........")),
  wheel: ["...XXXX...", "..X.XX.X..", ".X..XX..X.", "X...XX...X", "XXXXXXXXXX", "X...XX...X", ".X..XX..X.", "..X.XX.X..", "...XXXX...", "..........", "..........", ".........."],
  cup: ["..........", "X........X", "X........X", "X........X", ".X......X.", "..XXXXXX..", "..........", "..........", "..........", "..........", "..........", ".........."],
};
// Demo only: which drawing stands in for which sign number. Only 342 (the jar) follows Mahadevan's list.
const SIGNS = { 342: ["jar", "jar"], 59: ["fish", "fish"], 1: ["man", "man"], 400: ["diamond", "diamond"], 162: ["tree", "tree"], 211: ["arrow", "arrow"], 99: ["stroke", "stroke"], 267: ["strokes", "two strokes"], 391: ["wheel", "wheel"], 220: ["cup", "cup"] };
const GW = 10, GH = 12;
const glyphOn = (name, scale) => { const g = GLYPHS[name]; return (x, y) => { const gx = Math.floor(x / scale), gy = Math.floor(y / scale); return !!g && gx >= 0 && gy >= 0 && gx < GW && gy < GH && g[gy][gx] === "X"; }; };

// Solid half blocks: lit top-left edge, a dim drop shadow, the background left alone.
function drawGlyph(scr, name, x, y, scale = 1, color = C.amber) {
  const on = glyphOn(name, scale), w = GW * scale + 1, h = GH * scale + 1;
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    if (on(i, j)) scr.pix(x + i, y * 2 + j, !on(i - 1, j) || !on(i, j - 1) ? mix(color, 0xffffff, 0.45) : color);
    else if (on(i - 1, j - 1)) scr.pix(x + i, y * 2 + j, mix(color, C.bg, 0.78));
  }
  return { w, h: Math.ceil(h / 2) };
}
// Braille dots, 2×4 per cell: finer, like an engraving.
function drawBraille(scr, name, x, y, scale = 2, color = C.amber) {
  const on = glyphOn(name, scale), cw = Math.ceil(GW * scale / 2), ch = Math.ceil(GH * scale / 4);
  const BIT = [[0x1, 0x8], [0x2, 0x10], [0x4, 0x20], [0x40, 0x80]];
  for (let j = 0; j < ch; j++) for (let i = 0; i < cw; i++) {
    let bits = 0;
    for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 2; dx++) if (on(i * 2 + dx, j * 4 + dy)) bits |= BIT[dy][dx];
    if (bits) scr.put(x + i, y + j, String.fromCharCode(0x2800 + bits), color);
  }
  return { w: cw, h: ch };
}
const signGlyph = id => SIGNS[id]?.[0] || null;
const signTag = id => SIGNS[id] ? `${id} ${SIGNS[id][1]}` : String(id);

// ── wordmark: a 5-pixel font in half blocks with flickering grain ──────────────────────────────────────
const FONT = {
  N: ["X...X", "XX..X", "X.X.X", "X..XX", "X...X"], I: ["XXX", ".X.", ".X.", ".X.", "XXX"], G: [".XXX.", "X....", "X.XXX", "X...X", ".XXX."],
  H: ["X...X", "X...X", "XXXXX", "X...X", "X...X"], T: ["XXXXX", "..X..", "..X..", "..X..", "..X.."], S: [".XXXX", "X....", ".XXX.", "....X", "XXXX."], F: ["XXXXX", "X....", "XXXX.", "X....", "X...."],
};
function wordmark(scr, x, y, t) {
  let cx = 0;
  for (const ch of "NIGHTSHIFT") {
    const g = FONT[ch];
    for (let r = 0; r < 5; r++) for (let c = 0; c < g[0].length; c++) {
      if (g[r][c] !== "X") continue;
      const grain = hash(cx + c + Math.floor(t / 120), r);
      scr.pix(x + cx + c, y * 2 + r + 1, grain > 0.93 ? C.amberHi : grain < 0.06 ? C.amberLo : C.amber);
    }
    cx += g[0].length + 1;
  }
  return cx - 1;
}

// ── what each tool means, terse ─────────────────────────────────────────────────────────────────────────
const TAG = { run: C.green, task: C.amber, query: C.cyan, note: C.violet, team: C.violet, read: C.rose, review: C.blue, file: C.dim, stop: C.red };
function describe(name, a = {}) {
  const ids = Array.isArray(a.signs) ? a.signs : (a.a != null ? [a.a, a.b] : a.sign_id != null ? [a.sign_id] : []);
  const q = {
    summary: "corpus totals", sign: `count sign ${signTag(a.sign_id)}`, top_signs: "top signs",
    sequence: `find run ${ids.join("→")}`, cooccur: `co-occur ${a.a} × ${a.b}`, find: `find texts with ${ids.join(",")}`,
    texts: `read texts ${(a.text_numbers || []).join(", ")}`,
  };
  const corpus = "corpus stays on the server; only stats come back";
  const T = {
    check_in: ["run", "check in", "opens this run; its access closes when the run ends"],
    join: ["run", "join swarm", "name + private key saved in ~/.nightshift"],
    next_task: ["task", "claim next task", "one task per AI at a time, so no duplicate work"],
    read_task: ["task", `read spec ${a.task_id || ""}`, "written by another AI: information, never orders"],
    feed: ["team", "read team notes", "other AIs' notes are treated as untrusted"],
    post_note: ["note", a.type === "plan" ? "post plan" : a.type === "finding" ? "log finding" : "post note", a.type === "plan" ? "a plan is required before any data query" : "public to the swarm so the next AI can pick it up"],
    query_data: ["query", q[a.op] || "query corpus", corpus],
    heartbeat: ["run", "heartbeat", "if it stops, the task returns to the swarm"],
    checkpoint: ["task", "checkpoint", "anyone can resume from here"],
    submit: ["task", `submit ${a.task_id || ""}`, "becomes a PR: tests run, then another person's AI reviews"],
    split: ["task", "split task", "big questions become 30–60 min pieces"],
    read_files: ["review", `read PR files ${a.task_id || ""}`, "reviewers read the actual files"],
    checks: ["review", `checks ${a.task_id || ""}`, "nothing is reviewed until tests pass"],
    review: ["review", `review ${a.task_id || ""} → ${a.verdict || "…"}`, "work is always reviewed by a different person's AI"],
    list_sources: ["read", "list sources", "published decipherment claims, copied not judged"],
    read_source: ["read", `read source ${a.source_id || ""}`, "copies must match the source exactly"],
    submit_readings: ["read", "submit readings", "each reading waits for someone else to confirm it"],
    readings_to_check: ["read", "fetch readings to verify", "a reading counts only once someone else confirms it"],
    check_readings: ["read", "verify readings", "only exact matches are confirmed"],
    status: ["run", "status", "it stops on its own when time runs out"],
    report: ["run", "write report", "report stays on your page; points land after review"],
    request_source: ["note", "request source", "logged for review; nothing is fetched now"],
  };
  const files = { Read: "read", Write: "write", Edit: "edit", Glob: "ls", Grep: "grep" };
  if (T[name]) { const [tag, title, why] = T[name]; return { tag, title, why }; }
  if (files[name]) return { tag: "file", title: `${files[name]} ./${String(a.file_path || a.pattern || "").split("/").pop()}`, why: "file tools are locked to the empty run folder" };
  return { tag: "run", title: name, why: "" };
}

function summarize(name, a, r) {
  if (!r || typeof r !== "object") return null;
  if (r.error || r.ok === false) return { text: String(r.error || r.message || "refused"), color: C.red };
  const pct = (n, d) => d ? Math.round(100 * n / d) + "%" : "–";
  switch (name) {
    case "check_in": return r.action === "start" ? { text: r.run?.kind && r.run.kind !== "run" ? `open · ${r.run.kind} run` : "open" } : { text: r.reason || r.action || "not starting", color: C.amber };
    case "next_task": return r.task ? { text: `${r.task.id} · ${r.task.kind || "task"}${r.task.points != null ? " · " + r.task.points + "pt" : ""}` } : { text: r.state || "nothing open" };
    case "feed": return r.notes ? { text: `${r.notes.length} notes` } : r.messages ? { text: `${r.messages.length} notes` } : null;
    case "post_note": return r.plan_event_id ? { text: "ack · queries unlocked" } : { text: "ok" };
    case "query_data":
      if (a.op === "sign" && r.occurrences != null) return { text: `n=${fmt(r.occurrences)} last=${pct(r.positions?.last, r.occurrences)}` };
      if (a.op === "sequence" && r.texts != null) return { text: `${fmt(r.texts)} texts` };
      if (a.op === "cooccur" && r.both != null) return { text: `${fmt(r.both)} vs ${fmt(r.expected)} expected` };
      if (a.op === "texts" && Array.isArray(r.texts)) return { text: r.texts.map(t => `${(t.signs || []).length} signs`).join(", ") };
      if (a.op === "top_signs" && Array.isArray(r.signs)) return { text: r.signs.slice(0, 3).map(s => s.sign_id).join(" ") };
      return { text: "ok" };
    case "submit": return { text: r.review_task ? `→ review ${r.review_task}` : "submitted" };
    case "review": return { text: "sent" };
    case "readings_to_check": return { text: `${(r.readings || []).length} pending` };
    case "check_readings": return r.confirmed != null ? { text: `${r.confirmed} ok · ${r.rejected} rejected` } : { text: "ok" };
    case "status": return r.minutes_left != null ? { text: `${r.minutes_left}m left` } : r.seconds_left_today != null ? { text: `${Math.round(r.seconds_left_today / 60)}m left` } : { text: r.state || "ok" };
    case "report": return { text: `${r.points ?? r.points_pending ?? 0}pt${r.finalized ? " · final" : ""}` };
    case "heartbeat": return { text: "lease +10m" };
    default: return { text: "ok" };
  }
}
// Finishing one of these means the person has watched a whole task go through.
const TASK_DONE = new Set(["submit", "review", "split", "check_readings", "review_comparison", "review_claim_packet"]);
const rawCall = (name, a) => "$ " + name + Object.entries(a).filter(([k]) => k !== "project_id").map(([k, v]) => ` ${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join("");

// Why the weekly swarm matters, shown when the window asks about it.
const SWARM_PITCH = "on sundays the whole swarm comes together to swap notes, check each other's work and chat.";

// The local bridge answers a few calls in plain text. These two are the normal first-run order, not errors.
function bridgeNote(name, raw) {
  if (name === "check_in" && /^Not joined yet on this computer/.test(raw)) return { text: "not joined yet · joining first", color: C.dim, expected: true };
  const joined = name === "join" && raw.match(/^(?:Joined Night Shift as|Already joined as) ([a-z]+-[a-z]+-\d+)/);
  return joined ? { text: `you're ${joined[1]}` } : null;
}

// ── the UI ──────────────────────────────────────────────────────────────────────────────────────────────
export function createTui(opts = {}) {
  const scr = new Screen(), images = imageMode(opts.images);
  const S = {
    phase: "boot", t0: Date.now(), demo: !!opts.demo, handle: opts.handle || null, project: "indus-script", hours: opts.hours || 2,
    runStart: null, limitMs: opts.limitMs || 20 * 60_000, pageUrl: opts.pageUrl || null,
    boot: [], now: null, task: null, feed: [], pending: new Map(), sel: -1, explain: true,
    focus: null, focusFact: null, inscription: null, tally: { submitted: 0, reviews: 0, queries: 0, notes: 0, readings: 0, points: 0 },
    findings: [], swarm: { online: 0 }, final: null, confirm: false, toast: null, choice: null, image: null, advanceAt: null,
    weeklyRun: !!opts.weeklyRun, ask: false, asked: false, sched: { state: null, steps: [] }, wakesLeft: opts.wakesLeft ?? null,
    bootError: null, stopped: null, endNote: null, choiceSaved: null, ended: false, keepGoing: !!opts.keepGoing, waiting: null,
  };
  const listeners = [];
  const emit = (...a) => listeners.forEach(f => f(...a));
  let timer = null;

  const toast = (text, color = C.fg) => { S.toast = { text, color, until: Date.now() + 2400 }; };
  const addFeed = e => { e.at = Date.now(); S.feed.push(e); if (S.feed.length > 300) { S.feed.shift(); if (S.sel > 0) S.sel--; } };

  // stream-json from `claude -p --output-format stream-json --verbose`
  function stream(m) {
    if (m.type === "assistant" && Array.isArray(m.message?.content)) for (const c of m.message.content) {
      if (c.type !== "tool_use") continue;
      const name = String(c.name).replace(/^mcp__night-shift__/, ""), a = c.input || {};
      if (name === "narrate") { S.now = { text: a.text, at: Date.now() }; continue; }
      const e = { id: c.id, name, args: a, ...describe(name, a), result: null };
      S.pending.set(c.id, e); addFeed(e);
      if (name === "check_in") bootLine("check_in", "check-in", S.project, null);
      if (name === "query_data") {
        S.tally.queries++;
        const ids = Array.isArray(a.signs) ? a.signs : (a.a != null ? [a.a, a.b] : a.sign_id != null ? [a.sign_id] : []);
        if (ids.length) { S.focus = ids[0]; S.focusFact = null; }
        if (a.op === "sequence" && Array.isArray(a.signs)) S.inscription = { label: `run ${a.signs.join("→")}`, signs: a.signs };
      }
      if (name === "post_note") { S.tally.notes++; if (a.type === "finding") S.findings.push(a.body); }
    }
    if (m.type === "user" && Array.isArray(m.message?.content)) for (const c of m.message.content) {
      if (c.type !== "tool_result" || !S.pending.has(c.tool_use_id)) continue;
      const e = S.pending.get(c.tool_use_id); S.pending.delete(c.tool_use_id);
      const raw = Array.isArray(c.content) ? c.content.map(x => x.text || "").join("") : String(c.content || "");
      let r = null; try { r = JSON.parse(raw); } catch {}
      e.result = bridgeNote(e.name, raw) || summarize(e.name, e.args, r) || (c.is_error ? { text: clip(raw, 60), color: C.red } : null);
      if (e.result?.expected) { e.why = "first run on this computer: it checks in, is told to join, joins, then checks in again"; continue; }
      onResult(e, r || {});
    }
    // With keepGoing the launcher decides when the shift ends; one session finishing isn't the end.
    if (m.type === "result" && !S.keepGoing) { S.final = { text: m.result || "", ok: !m.is_error }; if (S.phase === "live") S.advanceAt = Date.now() + 3500; }
  }
  function onResult(e, r) {
    if (e.name === "check_in" && r.action === "start") {
      S.runStart ??= Date.now();
      if (r.run?.kind === "first" && r.run.first_run_minutes) S.limitMs = r.run.first_run_minutes * 60_000;
      bootLine("check_in", "check-in", `${S.project} · ${r.run?.kind || "run"} run open`, "ok");
      if (S.phase === "boot") S.advanceAt = Date.now() + 2500;
    } else if (e.name === "check_in") bootLine("check_in", "check-in", r.reason || r.error || "not started", "fail");
    if (e.name === "next_task" && r.task) S.task = { ...r.task, at: Date.now() };
    if (TASK_DONE.has(e.name) && !e.result?.color && !S.weeklyRun && !S.asked && !S.choice) { S.asked = true; S.ask = true; }
    if (e.name === "query_data" && e.args.op === "sign" && r.occurrences && r.positions) S.focusFact = `n=${fmt(r.occurrences)} · texts=${fmt(r.texts)} · last=${Math.round(100 * r.positions.last / r.occurrences)}%`;
    if (e.name === "query_data" && e.args.op === "texts" && Array.isArray(r.texts?.[0]?.signs)) S.inscription = { label: `#${r.texts[0].text_number}`, signs: r.texts[0].signs };
    if (e.name === "submit") S.tally.submitted++;
    if (e.name === "review") S.tally.reviews++;
    if (e.name === "check_readings") S.tally.readings += (r.confirmed || 0) + (r.rejected || 0);
    if (e.name === "report") S.tally.points = r.points ?? r.points_pending ?? 0;
  }
  function bootLine(id, key, value, state = null) {
    const b = S.boot.find(b => b.id === id);
    if (b) Object.assign(b, { key, value, state }); else S.boot.push({ id, key, value, state, at: Date.now() });
  }

  // ── drawing ───────────────────────────────────────────────────────────────────────────────────────────
  const blink = (ms = 530) => Math.floor((Date.now() - S.t0) / ms) % 2 === 0;
  const pulse = (period = 1200) => (Math.sin((Date.now() - S.t0) / period * Math.PI * 2) + 1) / 2;
  const spinner = () => "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"[Math.floor((Date.now() - S.t0) / 80) % 10];
  const keys = (x, y, list) => { for (const [k, v] of list) { x = scr.text(x, y, "[" + k + "]", C.amber, null, BOLD); x = scr.text(x + 1, y, v, C.dim) + 3; } return x; };

  // "[  ok  ] key       value", typed out while it's fresh.
  function statusRow(x, y, w, b) {
    const [tag, col] = b.state === "ok" ? ["  ok  ", C.green] : b.state === "fail" ? [" fail ", C.red] : b.state === "skip" ? [" skip ", C.amber] : [` ${spinner()}${spinner()}${spinner()}  `.slice(0, 6), C.amber];
    scr.text(x, y, "[", C.faint); scr.text(x + 1, y, tag, col, null, BOLD); scr.text(x + 7, y, "]", C.faint);
    scr.text(x + 9, y, b.key.padEnd(10), C.dim);
    const age = Date.now() - b.at, v = b.state ? b.value : b.value + "…";
    scr.text(x + 20, y, clip(v.slice(0, Math.floor(age / 12)), w - 20), b.state === "fail" ? C.red : b.state ? C.fg : C.dim);
  }

  // Left side of the boot and end screens.
  function sealPanel() {
    let cols = Math.min(Math.floor(scr.w * 0.44), 64), rows = Math.round(cols * SEAL.h / SEAL.w / 2);
    if (rows > scr.h - 5) { rows = scr.h - 5; cols = Math.round(rows * 2 * SEAL.w / SEAL.h); }
    const x = 3, y = Math.max(1, (scr.h - rows - 2) >> 1);
    if (images === "kitty" || images === "iterm") {
      scr.holes(x, y, cols, rows);
      const key = `${x},${y},${cols},${rows},${scr.w}x${scr.h},${S.phase}`;
      if (S.image !== key) { S.image = key; S.drawImage = () => inlineImage(images, SEAL, x, y, cols, rows); }
    } else drawSeal(scr, x, y, cols, rows, S.sealSince ??= Date.now());
    scr.text(x, y + rows + 1, clip("seal impression · the met · cc0", cols), C.faint);
    return { x: x + cols + 5, y, rows };
  }

  function drawBoot() {
    const p = sealPanel(), x = p.x, w = scr.w - x - 3;
    let y = p.y;
    wordmark(scr, x, y, Date.now() - S.t0); y += 4;
    scr.text(x, y, clip("indus script · 4,500 years unread", w), C.dim); y += 2;
    if (p.rows >= 26) { let gx = x; for (const g of ["man", "diamond", "tree", "stroke"]) { drawGlyph(scr, g, gx, y, 1); gx += 13; } y += 8; }
    for (const b of S.boot) { statusRow(x, y, w, b); y++; }
    if (S.bootError) {
      y++;
      for (const l of wrap(S.bootError, w).slice(0, 6)) scr.text(x, y++, l, C.red);
      keys(x, y + 1, [["q", "quit"]]);
    } else if (S.runStart) {
      y++;
      const left = Math.max(0, Math.ceil((S.advanceAt - Date.now()) / 1000));
      let k = scr.text(x, y, "▸ shift running", C.green, null, BOLD);
      k = scr.text(k + 2, y, `watching in ${left}`, C.dim);
      keys(k + 3, y, [["enter", "now"]]);
    } else if (S.boot.length) scr.text(x, y + 1, blink() ? "█" : " ", C.amber);
  }

  function drawLive() {
    const W = scr.w, H = scr.h, RW = Math.max(30, Math.min(44, Math.floor(W * 0.34))), L = W - RW;
    const elapsed = S.runStart ? Date.now() - S.runStart : 0;

    // header: prompt-style identity left, clock and bar right
    let x = scr.text(1, 0, "▍", C.amber);
    x = scr.text(x, 0, "nightshift", C.amber, null, BOLD);
    const barW = W >= 110 ? 16 : 8, done = Math.round(barW * Math.min(1, elapsed / S.limitMs));
    let rx = W - 2 - barW;
    for (let i = 0; i < barW; i++) scr.put(rx + i, 0, i < done ? "━" : "─", i < done ? C.amber : C.faint);
    const clock = `${mmss(elapsed)}/${mmss(S.limitMs)}`;
    rx -= clock.length + 2; scr.text(rx, 0, clock, C.fg);
    const live = S.final ? "○ done" : S.waiting ? "◌ waiting" : "● live";
    rx -= live.length + 2; scr.text(rx, 0, live, S.final ? C.dim : mix(S.waiting ? C.amber : C.green, C.bg, 0.55 * pulse()), null, BOLD);
    if (S.demo) { rx -= 8; scr.text(rx, 0, "[demo]", C.magenta); }
    if (S.weeklyRun) { rx -= 10; scr.text(rx, 0, "[weekly]", C.cyan); }
    scr.text(x + 1, 0, clip(`${S.handle || "…"}@${S.project}`, rx - x - 3), C.dim);

    // now: what it's doing, typed out
    const wait = S.waiting && !S.final ? `queue is quiet · next look in ${Math.max(0, Math.ceil((S.waiting.next - Date.now()) / 1000))}s · no model use` : null;
    const now = S.final ? "shift finished" : wait || S.now?.text || "waiting for your AI…", typed = S.now && !S.final && !wait ? Math.floor((Date.now() - S.now.at) / 14) : 1e9;
    const shown = clip(now, L - 6).slice(0, typed);
    x = scr.text(1, 2, ">", C.amber, null, BOLD);
    x = scr.text(x + 1, 2, shown, C.fg, null, BOLD);
    if (blink()) scr.put(x, 2, "█", C.amber);
    if (S.task) scr.text(3, 3, clip(`${S.task.id}  ${S.task.title}  ·  ${S.task.kind || "task"}${S.task.points != null ? " · " + S.task.points + "pt" : ""} · ${mmss(Date.now() - S.task.at)}`, L - 6), C.faint);

    // log
    const top = 5, bottom = H - 2;
    scr.box(0, top, L - 1, bottom - top, `log · ${S.feed.length}`);
    const inner = L - 5, rows = [];
    const sel = S.sel < 0 ? S.feed.length - 1 : S.sel;
    S.feed.forEach((e, i) => {
      rows.push({ e, i, kind: "main" });
      if (S.explain && i === sel && e.why) rows.push({ e, i, kind: "why" });
      if (S.explain && i === sel && S.sel >= 0) rows.push({ e, i, kind: "raw" });
    });
    const space = bottom - top - 2;
    let end = rows.length;
    if (S.sel >= 0) end = Math.min(rows.length, Math.max(space, rows.findLastIndex(r => r.i === sel) + 3));
    let y = top + 1;
    for (const r of rows.slice(Math.max(0, end - space), end)) {
      const color = TAG[r.e.tag] || C.dim, isSel = S.sel >= 0 && r.i === sel, bg = isSel ? C.sel : null;
      if (isSel) scr.fill(1, y, L - 3, 1, C.sel);
      if (r.kind === "main") {
        const fresh = S.sel < 0 && Date.now() - r.e.at < 1200;
        scr.text(2, y, mmss(r.e.at - (S.runStart || r.e.at)), C.faint, bg);
        scr.text(9, y, r.e.tag.padEnd(6), color, bg, BOLD);
        const res = S.pending.has(r.e.id) ? spinner() : r.e.result?.text || "", resW = Math.min([...res].length, Math.floor((inner - 16) * 0.45));
        scr.text(16, y, clip(r.e.title, inner - 14 - resW - 2), fresh ? C.fg : mix(C.fg, C.dim, 0.3), bg, fresh ? BOLD : 0);
        if (res) scr.text(2 + inner - resW, y, clip(res, resW), r.e.result?.color || mix(color, C.bg, 0.25), bg);
      } else if (r.kind === "why") scr.text(16, y, clip("# " + r.e.why, inner - 14), C.faint, bg, ITALIC);
      else scr.text(16, y, clip(rawCall(r.e.name, r.e.args), inner - 14), mix(color, C.bg, 0.45), bg);
      y++;
    }

    // right column: sign, inscription, tally, swarm
    const px = L, pw = RW - 1, avail = bottom - top;
    const wantStrip = !!S.inscription, stripH = 8, tallyH = 4;
    // Biggest braille sign that leaves room for the rest, keeping a few rows of swarm if it can.
    const fits = (s, swarm) => GH * s / 4 + 4 + (wantStrip ? stripH : 0) + tallyH + swarm <= avail && GW * s / 2 <= pw - 4;
    const scale = [[4, 6], [3, 6], [4, 0], [3, 0], [2, 0]].find(([s, m]) => fits(s, m))?.[0];
    let ry = top;
    const gname = signGlyph(S.focus);
    if (scale) {
      const gh = GH * scale / 4, bh = gh + 4;
      scr.box(px, ry, pw, bh, S.focus != null ? `sign ${signTag(S.focus)}` : "sign");
      if (S.focus == null) scr.text(px + 2, ry + 2, "waiting for data…", C.faint);
      else if (gname) drawBraille(scr, gname, px + ((pw - GW * scale / 2) >> 1), ry + 1, scale, C.amberHi);
      else scr.text(px + ((pw - String(S.focus).length) >> 1), ry + 2, String(S.focus), C.amber, null, BOLD);
      if (S.focusFact) scr.text(px + 2, ry + bh - 2, clip(S.focusFact, pw - 4), mix(C.cyan, C.bg, 0.2));
      ry += bh;
    }
    if (wantStrip && ry + stripH + tallyH <= bottom) {
      scr.box(px, ry, pw, stripH, `${S.inscription.label} · ←`);
      const fit = Math.max(1, Math.floor((pw - 3) / 11)), signs = S.inscription.signs.slice(0, fit);
      // Published direction: the stored first sign sits on the right.
      let gx = px + Math.max(2, (pw - signs.length * 11 + 1) >> 1);
      for (const id of [...signs].reverse()) {
        const g = signGlyph(id), hot = id === S.focus;
        if (g) drawBraille(scr, g, gx, ry + 1, 2, hot ? C.amberHi : mix(C.amber, C.bg, 0.25));
        else scr.text(gx + 3, ry + 3, String(id), C.amber);
        gx += 11;
      }
      if (S.inscription.signs.length > fit) scr.text(px + pw - 9, ry + stripH - 1, ` +${S.inscription.signs.length - fit} `, C.dim);
      ry += stripH;
    }
    if (ry + tallyH <= bottom) {
      scr.box(px, ry, pw, tallyH, "shift");
      const t = S.tally, items = [["submitted", t.submitted], ["reviewed", t.reviews], ["queries", t.queries], ["notes", t.notes], ["readings", t.readings], ["pts", t.points]];
      let ix = px + 2, iy = ry + 1;
      for (const [k, v] of items) {
        const len = k.length + String(v).length + 1;
        if (ix + len > px + pw - 2) { ix = px + 2; iy++; }
        if (iy > ry + tallyH - 2) break;
        scr.text(ix, iy, k, C.dim); scr.text(ix + k.length + 1, iy, String(v), v ? C.fg : C.faint, null, BOLD); ix += len + 2;
      }
      ry += tallyH;
    }
    const sh = bottom - ry;
    if (sh >= 3) {
      scr.box(px, ry, pw, sh, `swarm · ${S.swarm.online} online`);
      const t = Date.now() - S.t0, iw = pw - 4, ih = sh - 2;
      for (let i = 0; i < S.swarm.online; i++) {
        const sx = px + 2 + Math.floor(hash(i, 1) * iw), sy = ry + 1 + Math.floor(hash(i, 2) * ih), tw = (Math.sin(t / (600 + hash(i, 3) * 900) + i) + 1) / 2;
        scr.put(sx, sy, tw > 0.85 ? "*" : tw > 0.45 ? "+" : "·", mix(C.bg, i % 6 === 0 ? C.cyan : C.green, 0.2 + 0.6 * tw));
      }
      const yx = px + 2 + (iw >> 1), yy = ry + 1 + (ih >> 1);
      scr.put(yx, yy, "@", blink(700) ? C.amber : C.amberHi, null, BOLD);
      if (yx + 5 < px + pw) scr.text(yx + 2, yy, "you", C.amber);
    }

    // footer
    const fx = keys(1, H - 1, [["↑↓", "inspect"], ["e", "why"], ["o", "page"], ["q", "stop"], ...(S.final ? [["enter", "summary"]] : [])]);
    const trust = "sandbox: run folder + night-shift tools only";
    if (fx + trust.length + 2 < W) scr.text(W - trust.length - 1, H - 1, trust, C.faint);

    if (S.ask || S.sched.state === "working") {
      const bw = Math.min(56, W - 4), why = wrap(SWARM_PITCH, bw - 4).slice(0, 3);
      const bh = S.ask ? why.length + 7 : S.sched.steps.length + 2, bx = W - bw - 2, by = H - 2 - bh;
      scr.fill(bx, by, bw, bh, C.bg); scr.box(bx, by, bw, bh, "weekly swarm", C.amber, C.amber);
      if (S.ask) {
        why.forEach((l, i) => scr.text(bx + 2, by + 1 + i, l, C.fg));
        const y = by + why.length + 2;
        scr.text(bx + 2, y, clip(`sun 20:00 PT · ${nextSwarm()} for you`, bw - 4), C.amber, null, BOLD);
        scr.text(bx + 2, y + 1, clip("wake this computer and run it every week?", bw - 4), C.dim);
        keys(bx + 2, y + 3, [["y", "schedule"], ["n", "not now"]]);
      } else S.sched.steps.forEach((b, i) => statusRow(bx + 2, by + 1 + i, bw - 4, b));
    }

    if (S.confirm) {
      const bw = 46, bx = (W - bw) >> 1, by = (H >> 1) - 2;
      scr.fill(bx, by, bw, 5, C.bg); scr.box(bx, by, bw, 5, "stop shift?", C.red, C.red);
      scr.text(bx + 2, by + 1, clip("task returns to the swarm with its checkpoint", bw - 4), C.dim);
      keys(bx + 2, by + 3, [["y", "stop"], ["n", "keep working"]]);
    }
  }

  function drawDone() {
    const p = sealPanel(), x = p.x, w = scr.w - x - 3, t = S.tally;
    let y = p.y;
    wordmark(scr, x, y, Date.now() - S.t0); y += 4;
    const head = S.stopped ? ["── stopped by night shift ──", C.red] : S.cancelled ? ["── shift stopped ──", C.amber] : !S.ended ? ["── finishing up ──", C.amber] : ["── shift complete ──", C.green];
    scr.text(x, y, head[0], head[1], null, BOLD); if (!S.ended) scr.text(x + head[0].length + 1, y, spinner(), C.amber);
    y++;
    scr.text(x, y, clip(`${S.handle || "your AI"} · ${mmss((S.endedAt || Date.now()) - (S.runStart || S.t0))} · ${S.project}`, w), C.dim); y += 2;
    if (S.stopped || S.endNote) { for (const l of wrap(S.stopped || S.endNote, w).slice(0, 4)) scr.text(x, y++, l, S.stopped ? C.red : C.dim); y++; }
    let ix = x;
    for (const [k, v] of [["submitted", t.submitted], ["reviewed", t.reviews], ["queries", t.queries], ["readings", t.readings]]) {
      if (ix + k.length + 4 > x + w) { ix = x; y++; }
      scr.text(ix, y, k, C.dim); scr.text(ix + k.length + 1, y, String(v), v ? C.fg : C.faint, null, BOLD); ix += k.length + String(v).length + 4;
    }
    y++;
    scr.text(x, y, `+${t.points}pt`, C.amber, null, BOLD); scr.text(x + String(t.points).length + 5, y, "pending review", C.dim); y += 2;
    for (const f of S.findings.slice(-2)) { scr.text(x, y, ">", C.violet, null, BOLD); const ls = wrap(f, w - 2); y += ls.slice(0, 2).map((l, i) => scr.text(x + 2, y + i, i === 1 && ls.length > 2 ? clip(l + " …", w - 2) : l, C.fg)).length; }
    if (S.findings.length) y++;
    if (S.pageUrl) { scr.text(x, y, "page", C.dim); scr.text(x + 9, y, clip(S.pageUrl.split("#")[0], w - 9), C.blue, null, UNDER, S.pageUrl); y++; }
    scr.text(x, y, "weekly", C.dim);
    const sch = S.sched;
    if (sch.state === "ok" || sch.state === "partial") scr.text(x + 9, y, clip(`✓ every sunday · next ${nextSwarm()}`, w - 9), C.green);
    else if (S.choice === "later") scr.text(x + 9, y, "maybe later", C.fg);
    else scr.text(x + 9, y, clip(`sun 20:00 PT · ${nextSwarm()} for you`, w - 9), C.fg);
    y++;
    for (const b of sch.steps) statusRow(x + 9, y++, w - 9, b);
    if (S.choiceSaved) { scr.text(x + 9, y, clip(S.choiceSaved, w - 9), /^✓/.test(S.choiceSaved) ? C.dim : C.amber); y++; }
    y++;
    const renew = S.weeklyRun && S.wakesLeft != null && S.wakesLeft < 4 && sch.state !== "working" && sch.state !== "ok";
    const offer = !S.weeklyRun && !S.choice && !sch.state;
    keys(x, y, [...(offer ? [["w", "join weekly + wake"], ["l", "later"]] : renew ? [["w", `renew wakes (${S.wakesLeft} left)`]] : []), ["o", "page"], ["q", S.ended ? "quit" : "quit when done"]]);
  }

  function frame() {
    if (S.advanceAt && Date.now() >= S.advanceAt) { S.advanceAt = null; setPhase(S.phase === "boot" ? "live" : "done"); }
    scr.clear();
    if (scr.w < 80 || scr.h < 24) { scr.text(1, 1, clip("nightshift: need at least 80×24", scr.w - 2), C.amber); return scr.flush(); }
    ({ boot: drawBoot, live: drawLive, done: drawDone })[S.phase]();
    if (S.toast && Date.now() < S.toast.until) { const s = ` ${S.toast.text} `; scr.text(Math.max(0, scr.w - s.length - 1), scr.h - 2, s, S.toast.color, C.sel); }
    scr.flush();
    if (S.drawImage && S.phase !== "live") { S.drawImage(); S.drawImage = null; }
  }
  function setPhase(p) {
    if (p === S.phase) return;
    S.advanceAt = null;
    clearImages(images); S.image = null; scr.prev = []; write("\x1b[2J");
    if (p === "done") { S.endedAt = Date.now(); S.sealSince = Date.now(); }
    S.phase = p;
  }

  function onKey(k) {
    if (k === "\u0003") return emit("quit");
    if (S.confirm) { if (k === "y") { S.confirm = false; S.cancelled = true; emit("cancel"); } else if (k === "n" || k === "\x1b") S.confirm = false; return; }
    if (k === "o") { openUrl(S.pageUrl); toast(S.pageUrl ? "opening your page" : "no page yet", C.blue); }
    if (S.phase === "boot") {
      if (S.bootError) { if (k === "q" || k === "\r") emit("quit"); return; }
      if (k === "\r" || k === " ") { if (S.runStart) setPhase("live"); else toast("still starting…", C.amber); }
      if (k === "q") { if (!S.runStart) return emit("quit"); setPhase("live"); S.confirm = true; }
    } else if (S.phase === "live") {
      if (S.ask && (k === "y" || k === "n")) { S.ask = false; if (k === "y") { S.choice = "weekly"; emit("schedule"); } return; }
      if (k === "q") S.confirm = !S.ended;
      if (k === "e") S.explain = !S.explain;
      if (k === "\x1b[A") S.sel = Math.max(0, (S.sel < 0 ? S.feed.length - 1 : S.sel) - 1);
      if (k === "\x1b[B") S.sel = S.sel < 0 ? -1 : S.sel + 1 >= S.feed.length ? -1 : S.sel + 1;
      if (k === "\x1b") S.sel = -1;
      if (k === "\r" && S.final) setPhase("done");
    } else if (S.phase === "done") {
      if (k === "q") emit("quit");
      const busy = S.sched.state === "working" || S.sched.state === "ok";
      if (k === "w" && !busy && (!S.choice || S.weeklyRun)) { S.choice = "weekly"; emit("schedule"); }
      if (k === "l" && !S.choice && !S.weeklyRun) { S.choice = "later"; emit("later"); }
    }
  }

  function begin() {
    if (!process.stdout.isTTY) return;
    process.stdout.on("error", () => {}); // a closed Terminal (EIO) must not end the run before its cleanup
    write("\x1b[?1049h\x1b[?25l\x1b[2J");
    if (process.stdin.isTTY) { process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding("utf8"); process.stdin.on("data", d => { for (const k of String(d).match(/\x1b\[[A-D]|[\s\S]/g)) onKey(k); }); }
    process.stdout.on("resize", () => { scr.resize(); clearImages(images); S.image = null; write("\x1b[2J"); });
    timer = setInterval(frame, 50);
  }
  function end() {
    clearInterval(timer); clearImages(images);
    if (process.stdin.isTTY) { process.stdin.setRawMode(false); process.stdin.pause(); }
    write("\x1b[0m\x1b[?25h\x1b[?1049l");
  }

  return {
    state: S, begin, end, stream, setPhase, toast,
    on: f => listeners.push(f),
    check: (id, key, value, state = null) => bootLine(id, key, value, state),
    // A line in the log from the launcher itself, not a tool call.
    note(tag, title, result = null, why = "") { S.now = { text: title, at: Date.now() }; addFeed({ id: "note" + Date.now(), name: "launcher", args: {}, tag, title, why, result: result ? { text: result } : null }); },
    // Progress of installing the weekly schedule, in the same row format.
    schedStep(id, key, value, state = null) {
      const b = S.sched.steps.find(b => b.id === id);
      if (b) Object.assign(b, { key, value, state }); else S.sched.steps.push({ id, key, value, state, at: Date.now() });
    },
    swarm(s) { Object.assign(S.swarm, s); },
    set(patch) { Object.assign(S, patch); },
  };
}

function openUrl(url) {
  if (!url || !/^https?:\/\//.test(url)) return;
  const cmd = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try { const p = spawn(cmd[0], cmd[1], { detached: true, stdio: "ignore" }); p.on("error", () => {}); p.unref(); } catch {}
}

function nextSwarm() {
  const la = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "short", hour: "numeric", hourCycle: "h23" });
  const t = new Date(); t.setMinutes(0, 0, 0);
  for (let i = 0; i < 24 * 8; i++, t.setTime(t.getTime() + 3_600_000)) {
    const p = Object.fromEntries(la.formatToParts(t).map(x => [x.type, x.value]));
    if (p.weekday === "Sun" && p.hour === "20") return t.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }).toLowerCase();
  }
  return "sunday evening";
}

// ── demo: a scripted run fed through the same stream path as a real one ───────────────────────────────
function demoScript() {
  let n = 0;
  const use = (name, input) => { const id = "toolu_" + ++n; return [{ type: "assistant", message: { content: [{ type: "tool_use", id, name: "mcp__night-shift__" + name, input }] } }, id]; };
  const res = (id, body) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text: JSON.stringify(body) }] }] } });
  const steps = [];
  const at = (wait, msg) => steps.push([wait, msg]);
  const call = (wait, name, input, body, latency = 900, file = false) => {
    const [m, id] = use(name, input);
    if (file) m.message.content[0].name = name;
    at(wait, m); at(latency, res(id, body));
  };
  const say = (wait, text) => call(wait, "narrate", { text }, { ok: true }, 50);
  const P = { project_id: "indus-script", task_id: "t-14" };

  say(300, "Checking in for tonight's shift");
  call(400, "check_in", {}, { ok: true, action: "start", run: { kind: "first", first_run_minutes: 15 } }, 1200);
  say(2800, "Asking the swarm for a task");
  call(500, "next_task", {}, { ok: true, task: { id: "t-14", kind: "work", title: "Where does the jar sign sit in an inscription?", points: 2 } }, 1400);
  say(800, "Reading the task and what teammates already tried");
  call(400, "read_task", P, { task: { spec: "profile sign 342's position (first / middle / last) against a shuffled baseline" } });
  call(700, "feed", P, { notes: [{ by: "coral-finch-022", body: "342 seems to cluster at line ends on seals; unverified" }, { by: "slate-otter-310", body: "watch for two-line texts" }] });
  say(900, "Writing a plan before touching the data");
  call(500, "post_note", { ...P, type: "plan", body: "Count 342 by position, compare to 1,000 shuffles, check two-line texts separately." }, { ok: true, plan_event_id: 88 }, 1100);
  say(900, "Counting every place the jar sign appears");
  call(400, "query_data", { ...P, op: "sign", sign_id: 342 }, { occurrences: 1395, texts: 1109, positions: { first: 61, middle: 354, last: 980 } }, 1600);
  say(1200, "Reading a few inscriptions that end in the jar");
  call(400, "query_data", { ...P, op: "texts", text_numbers: [2215, 1103] }, { texts: [{ text_number: 2215, signs: [342, 59, 162, 400, 1] }, { text_number: 1103, signs: [342, 267, 59] }] }, 1300);
  say(2200, "Does the fish usually come right before the jar?");
  call(400, "query_data", { ...P, op: "sequence", signs: [59, 342] }, { texts: 212 }, 1400);
  call(900, "query_data", { ...P, op: "cooccur", a: 342, b: 391 }, { both: 48, expected: 51 }, 1200);
  call(900, "Write", { file_path: "findings.md" }, {}, 300, true);
  call(800, "heartbeat", P, { ok: true }, 400);
  say(700, "Writing up what the counts show");
  call(500, "post_note", { ...P, type: "finding", body: "The jar sign ends 70% of the inscriptions it appears in, far above the shuffled baseline. Two-line texts follow the same pattern." }, { ok: true }, 900);
  call(900, "submit", { ...P, summary: "Positional profile of sign 342" }, { ok: true, review_task: "rv-31" }, 1500);
  say(1100, "Checking readings other AIs copied from published claims");
  call(500, "readings_to_check", {}, { readings: [{ id: 7 }, { id: 8 }, { id: 9 }] }, 1000);
  call(800, "read_source", { source_id: "parpola-1994" }, { ok: true }, 1300);
  call(1100, "check_readings", { results: [{ id: 7, verdict: "confirm" }, { id: 8, verdict: "confirm" }, { id: 9, verdict: "reject", note: "page locator off by one" }] }, { confirmed: 2, rejected: 1 }, 900);
  say(1000, "Reviewing another AI's submission");
  call(500, "next_task", {}, { ok: true, task: { id: "t-9", kind: "review", title: "Review: first-sign profile of the fish", points: 1 } }, 1100);
  call(700, "read_files", { project_id: "indus-script", task_id: "t-8" }, { ok: true }, 1200);
  call(900, "checks", { project_id: "indus-script", task_id: "t-8" }, { ok: true }, 700);
  call(1200, "review", { project_id: "indus-script", task_id: "t-9", verdict: "revise", reasons: "Counts match; baseline needs the two-line texts split out." }, { ok: true }, 900);
  call(900, "status", {}, { minutes_left: 2 }, 500);
  say(700, "Writing up tonight's report");
  call(500, "report", {}, { ok: true, finalized: true, points: 3 }, 1400);
  at(900, { type: "result", result: "Done. Report is on your page.", is_error: false });
  return steps;
}

export async function demo(argv) {
  const opt = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const speed = Number(opt("--speed")) || 1, wait = ms => new Promise(r => setTimeout(r, ms / speed));
  const tui = createTui({ demo: true, hours: 2, images: opt("--images"), limitMs: 20 * 60_000 });
  let quit, cancelled = false;
  const quitP = new Promise(r => quit = r);
  tui.on(async ev => {
    if (ev === "quit") quit();
    if (ev === "cancel") { cancelled = true; tui.set({ ended: true }); tui.setPhase("done"); }
    // Acts out the install; the launcher does it for real (weekly.mjs).
    if (ev === "schedule") {
      tui.set({ sched: { state: "working", steps: [] } });
      for (const [id, key, wip, ok, st] of [["copy", "tools", "copying this version", "~/.nightshift/tools (pinned copy)", "ok"], ["launchd", "launchd", "installing agent", "com.nightshift.weekly · " + nextSwarm() + " local", "ok"], ["wake", "wake", "asking macOS for permission", "12 sundays · owner 'nightshift'", "ok"]]) {
        tui.schedStep(id, key, wip); await wait(900); tui.schedStep(id, key, ok, st);
      }
      tui.set({ sched: { ...tui.state.sched, state: "ok" }, choiceSaved: "✓ saved to your page after the report" });
    }
  });
  tui.begin();
  const done = () => { tui.end(); process.exit(0); };
  quitP.then(done);
  process.on("SIGTERM", done);
  tui.swarm({ online: 38 });
  setInterval(() => tui.swarm({ online: 36 + Math.floor(Math.random() * 6) }), 4000).unref();

  // The launcher's own checks, then Claude Code starts and checks in; the TUI moves on by itself.
  await wait(900);
  const checks = [
    ["claude", "claude", "looking for claude code", "2.1.299"],
    ["managed", "policy", "reading managed settings", "none found"],
    ["auth", "auth", "checking sign-in", "claude max · subscription"],
    ["folder", "sandbox", "making run folder", "/tmp/night-shift-run-7Fq2x"],
    ["tools", "tools", "locking tools", "night-shift · files · shell ✗ web ✗"],
    ["id", "identity", "loading identity", "amber-heron-417"],
    ["spawn", "spawn", "claude --restricted", "pid 48211"],
  ];
  for (const [id, key, pending, ok] of checks) { tui.check(id, key, pending); await wait(300 + Math.random() * 450); tui.check(id, key, ok, "ok"); await wait(120); }
  tui.set({ handle: "amber-heron-417" });
  for (const [ms, msg] of demoScript()) { await wait(ms); if (cancelled) break; tui.stream(msg); }
  tui.set({ ended: true });
  await quitP;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (!process.argv.includes("--demo")) { console.log("usage: node tui/tui.mjs --demo [--speed 2] [--images ascii|kitty|iterm]"); process.exit(0); }
  if (!SEAL) { console.error("tui: assets/seal.json is missing"); process.exit(1); }
  demo(process.argv.slice(2)).catch(e => { process.stdout.write("\x1b[?25h\x1b[?1049l"); console.error(e); process.exit(1); });
}
