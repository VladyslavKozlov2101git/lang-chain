/**
 * HEIC-фікстура: `node fixtures/make-heic.mjs`. Потрібен ffmpeg із libx265.
 *
 * Окремо від `make-scans.mjs`, бо готового енкодера HEIC тут немає ніде: ffmpeg
 * пише HEIF-контейнер лише з AV1 (тобто AVIF), у libheif-js енкодери не
 * вкомпільовані, кодек Windows не встановлений. Тому ffmpeg кодує кадр у сирий
 * HEVC, а контейнер складається тут — це кілька боксів ISOBMFF (ISO/IEC 23008-12).
 *
 * Зміст той самий, що в `r01-cina-vyshche-foto.jpg`, тому й золото те саме.
 * Бінарник у git, тож цей скрипт треба лише для перегенерації.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const INBOX = path.join(path.dirname(fileURLToPath(import.meta.url)), "inbox");
const SRC = path.join(INBOX, "r01-cina-vyshche-foto.jpg");
const OUT = path.join(INBOX, "r01-cina-vyshche-foto.heic");

const u8 = (n) => Buffer.from([n]);
const u16 = (n) => Buffer.from([n >> 8, n & 255]);
const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const box = (type, ...parts) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([u32(body.length + 8), Buffer.from(type, "ascii"), body]);
};
const fullBox = (type, version, flags, ...parts) =>
  box(type, u8(version), Buffer.from([flags >> 16, (flags >> 8) & 255, flags & 255]), ...parts);

/** Annex B (00 00 01) → масив NAL-юнітів без стартових кодів. */
function nalUnits(stream) {
  const starts = [];
  for (let i = 0; i + 2 < stream.length; i++) {
    if (stream[i] === 0 && stream[i + 1] === 0 && stream[i + 2] === 1) {
      starts.push(i + 3);
      i += 2;
    }
  }
  return starts.map((s, k) => {
    let end = k + 1 < starts.length ? starts[k + 1] - 3 : stream.length;
    while (end > s && stream[end - 1] === 0) end--; // хвостовий нуль 4-байтового коду
    return stream.subarray(s, end);
  });
}
const nalType = (nal) => (nal[0] >> 1) & 63;
const VPS = 32;
const SPS = 33;
const PPS = 34;

/** hvcC: профіль і рівень беруться з SPS, параметри — масивами VPS/SPS/PPS. */
function hvcC(params) {
  const sps = params.find((n) => nalType(n) === SPS);
  // Прибираємо emulation prevention (00 00 03), щоб читати поля RBSP як є.
  const rbsp = [];
  for (let i = 2; i < sps.length; i++) {
    if (i >= 4 && sps[i] === 3 && sps[i - 1] === 0 && sps[i - 2] === 0) continue;
    rbsp.push(sps[i]);
  }
  const ptl = Buffer.from(rbsp.slice(1, 13)); // profile byte, 4 compat, 6 constraint, level
  return box(
    "hvcC",
    u8(1),
    ptl,
    u16(0xf000), // min_spatial_segmentation 0
    u8(0xfc), // parallelismType 0
    u8(0xfd), // chroma 4:2:0
    u8(0xf8), // bit depth luma 8
    u8(0xf8), // bit depth chroma 8
    u16(0), // avgFrameRate
    u8((1 << 3) | (1 << 2) | 3), // 1 шар, nested, довжини NAL по 4 байти
    u8(params.length),
    ...params.map((nal) => Buffer.concat([u8(0x80 | nalType(nal)), u16(1), u16(nal.length), nal])),
  );
}

const dir = mkdtempSync(path.join(tmpdir(), "heic-"));
const hevc = path.join(dir, "frame.hevc");
const [width, height] = [1600, 2000];
execFileSync("ffmpeg", [
  "-hide_banner", "-loglevel", "error", "-y", "-i", SRC,
  "-pix_fmt", "yuv420p", "-c:v", "libx265", "-x265-params", "log-level=error:keyint=1",
  "-frames:v", "1", "-f", "hevc", hevc,
]);

const nals = nalUnits(readFileSync(hevc));
const params = [VPS, SPS, PPS].map((t) => nals.find((n) => nalType(n) === t));
const data = Buffer.concat(nals.filter((n) => nalType(n) < 32).flatMap((n) => [u32(n.length), n]));

const ftyp = box("ftyp", Buffer.from("heic"), u32(0), Buffer.from("mif1heic"));
const meta = (offset) =>
  fullBox(
    "meta", 0, 0,
    fullBox("hdlr", 0, 0, u32(0), Buffer.from("pict"), u32(0), u32(0), u32(0), u8(0)),
    fullBox("pitm", 0, 0, u16(1)),
    fullBox("iloc", 0, 0, u8(0x44), u8(0), u16(1), u16(1), u16(0), u16(1), u32(offset), u32(data.length)),
    fullBox("iinf", 0, 0, u16(1), fullBox("infe", 2, 0, u16(1), u16(0), Buffer.from("hvc1"), u8(0))),
    box(
      "iprp",
      box("ipco", hvcC(params), fullBox("ispe", 0, 0, u32(width), u32(height))),
      fullBox("ipma", 0, 0, u32(1), u16(1), u8(2), u8(0x81), u8(0x02)),
    ),
  );
// Зсув даних залежить від розміру meta, а розмір meta від зсуву не залежить: u32 завжди.
const offset = ftyp.length + meta(0).length + 8;
writeFileSync(OUT, Buffer.concat([ftyp, meta(offset), box("mdat", data)]));
console.log(`  ${path.basename(OUT)}: ${Math.round((offset + data.length) / 1024)} КБ`);
