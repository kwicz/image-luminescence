/* image-luminescence: client-side Ultra HDR (ISO 21496-1) gain-map encoder.
 *
 * Everything runs in the browser -- no uploads. The output byte layout
 * mirrors libultrahdr 2.0.2: primary JPEG carrying an ISO 21496-1 version
 * segment and an MPF index, followed by a gain-map JPEG carrying the ISO
 * gain-map metadata segment.
 */

"use strict";

const ISO_URN = "urn:iso:std:iso:ts:21496:-1\0";
const MAX_BOOST = 10000 / 203; // gain-map luminance ceiling over SDR white

// ---------- color math (same as luminescence.py) ----------

function srgbEotf(v) {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

// ---------- JPEG segment utilities ----------

// Index right after the leading APPn/COM segments of a JPEG (insertion
// point for our metadata segments, before DQT/SOF).
function metadataInsertionPoint(bytes) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error("not a JPEG");
  let i = 2;
  while (i + 4 <= bytes.length && bytes[i] === 0xff) {
    const m = bytes[i + 1];
    const isApp = m >= 0xe0 && m <= 0xef;
    if (!isApp && m !== 0xfe) break;
    i += 2 + ((bytes[i + 2] << 8) | bytes[i + 3]);
  }
  return i;
}

function jpegSegment(marker, payload) {
  const seg = new Uint8Array(4 + payload.length);
  seg[0] = 0xff;
  seg[1] = marker;
  seg[2] = (payload.length + 2) >> 8;
  seg[3] = (payload.length + 2) & 0xff;
  seg.set(payload, 4);
  return seg;
}

function ascii(s) {
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

// ---------- ISO 21496-1 metadata ----------

// Primary image: urn + minimum_version(0) + writer_version(0)
function isoPrimarySegment() {
  const p = new Uint8Array(ISO_URN.length + 4);
  p.set(ascii(ISO_URN), 0);
  return jpegSegment(0xe2, p);
}

// Gain-map image: urn + versions + flags + headrooms + 3 channels of
// (gainMapMin, gainMapMax, gamma, offsetSdr, offsetHdr) as fractions.
// lmins/lmaxs are per-channel log2 gains (may be negative); altHr is the
// log2 display headroom at which the map is fully applied.
function isoGainmapMeta(lmins, lmaxs, altHr) {
  const p = new Uint8Array(ISO_URN.length + 4 + 1 + 16 + 3 * 40);
  const dv = new DataView(p.buffer);
  let o = 0;
  p.set(ascii(ISO_URN), o);
  o += ISO_URN.length;
  dv.setUint16(o, 0); o += 2;          // minimum_version
  dv.setUint16(o, 0); o += 2;          // writer_version
  p[o++] = 0xc0;                        // multichannel | use_base_colour_space
  dv.setUint32(o, 0); o += 4;           // baseHdrHeadroom = 0/1
  dv.setUint32(o, 1); o += 4;
  dv.setInt32(o, Math.round(altHr * (1 << 20))); o += 4;
  dv.setUint32(o, 1 << 20); o += 4;
  for (let c = 0; c < 3; c++) {
    dv.setInt32(o, Math.round(lmins[c] * (1 << 20))); o += 4;
    dv.setUint32(o, 1 << 20); o += 4;
    dv.setInt32(o, Math.round(lmaxs[c] * (1 << 20))); o += 4;
    dv.setUint32(o, 1 << 20); o += 4;
    dv.setUint32(o, 1); o += 4;         // gamma = 1/1
    dv.setUint32(o, 1); o += 4;
    dv.setUint32(o, 77); o += 4;        // offsetSdr ~= 1e-7 (matches libuhdr)
    dv.setUint32(o, 0x2de54477); o += 4;
    dv.setUint32(o, 77); o += 4;        // offsetHdr
    dv.setUint32(o, 0x2de54477); o += 4;
  }
  return jpegSegment(0xe2, p);
}

function isoGainmapSegment(boost) {
  const l = Math.log2(boost);
  return isoGainmapMeta([0, 0, 0], [l, l, l], l);
}

// ---------- MPF (CIPA DC-007) index for two images ----------

function mpfSegment(primaryLen, gainmapLen, mpfEndianOffsetInPrimary) {
  const p = new Uint8Array(86);
  const dv = new DataView(p.buffer);
  p.set(ascii("MPF\0"), 0);
  p.set(ascii("MM\0*"), 4);            // big-endian TIFF header
  dv.setUint32(8, 8);                   // IFD offset
  dv.setUint16(12, 3);                  // 3 tags
  // B000: MP format version
  dv.setUint16(14, 0xb000); dv.setUint16(16, 7); dv.setUint32(18, 4);
  p.set(ascii("0100"), 22);
  // B001: number of images
  dv.setUint16(26, 0xb001); dv.setUint16(28, 4); dv.setUint32(30, 1);
  dv.setUint32(34, 2);
  // B002: MP entries (2 x 16 bytes) at offset 0x32 from TIFF header
  dv.setUint16(38, 0xb002); dv.setUint16(40, 7); dv.setUint32(42, 32);
  dv.setUint32(46, 0x32);
  dv.setUint32(50, 0);                  // next IFD
  // entry 1: primary
  dv.setUint32(54, 0x00030000);         // baseline MP primary image
  dv.setUint32(58, primaryLen);
  dv.setUint32(62, 0);                  // offset 0 by convention
  // entry 2: gain map, offset relative to the TIFF endianness header
  dv.setUint32(70, 0);
  dv.setUint32(74, gainmapLen);
  dv.setUint32(78, primaryLen - mpfEndianOffsetInPrimary);
  return jpegSegment(0xe2, p);
}

// ---------- encoding pipeline ----------

async function canvasToJpegBytes(source, quality) {
  const canvas = document.createElement("canvas");
  canvas.width = source.width;
  canvas.height = source.height;
  const ctx = canvas.getContext("2d");
  if (source instanceof ImageData) ctx.putImageData(source, 0, 0);
  else ctx.drawImage(source, 0, 0);
  const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", quality));
  return new Uint8Array(await blob.arrayBuffer());
}

function computeGainMap(imageData, boost, knee) {
  const { width, height, data } = imageData;
  const out = new ImageData(width, height);
  const log2boost = Math.log2(boost);
  for (let i = 0; i < data.length; i += 4) {
    const r = srgbEotf(data[i] / 255);
    const g = srgbEotf(data[i + 1] / 255);
    const b = srgbEotf(data[i + 2] / 255);
    const y = Math.max(r, g, b);
    let ramp = (y - knee) / (1 - knee);
    ramp = Math.min(Math.max(ramp, 0), 1);
    const gain = 1 + (boost - 1) * ramp * ramp;
    const v = Math.round((Math.log2(gain) / log2boost) * 255);
    out.data[i] = out.data[i + 1] = out.data[i + 2] = v;
    out.data[i + 3] = 255;
  }
  return out;
}

// Main entry: file/blob in, Ultra HDR JPEG bytes out.
async function luminesce(fileOrBlob, { boost = MAX_BOOST, knee = 0.85, quality = 0.95 } = {}) {
  boost = Math.min(boost, MAX_BOOST);
  const bitmap = await createImageBitmap(fileOrBlob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  // flatten any transparency onto white, like the CLI
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

  // base: keep original bytes verbatim when input is already a JPEG
  let base;
  if (fileOrBlob.type === "image/jpeg") {
    base = new Uint8Array(await fileOrBlob.arrayBuffer());
  } else {
    base = await canvasToJpegBytes(canvas, quality);
  }

  // gain map JPEG with its ISO metadata segment spliced in
  const gainJpeg = await canvasToJpegBytes(computeGainMap(imageData, boost, knee), quality);
  const gainCut = metadataInsertionPoint(gainJpeg);
  const isoGain = isoGainmapSegment(boost);
  const gainFinal = new Uint8Array(gainJpeg.length + isoGain.length);
  gainFinal.set(gainJpeg.subarray(0, gainCut), 0);
  gainFinal.set(isoGain, gainCut);
  gainFinal.set(gainJpeg.subarray(gainCut), gainCut + isoGain.length);

  // primary with ISO version segment + MPF index spliced in
  const cut = metadataInsertionPoint(base);
  const isoPrim = isoPrimarySegment();
  const MPF_LEN = 90; // 4 header + 86 payload
  const primaryLen = base.length + isoPrim.length + MPF_LEN;
  // TIFF endianness header sits after: cut + isoPrim + FFE2 + len + "MPF\0"
  const mpfEndianOffset = cut + isoPrim.length + 8;
  const mpf = mpfSegment(primaryLen, gainFinal.length, mpfEndianOffset);

  const out = new Uint8Array(primaryLen + gainFinal.length);
  let w = 0;
  out.set(base.subarray(0, cut), w); w += cut;
  out.set(isoPrim, w); w += isoPrim.length;
  out.set(mpf, w); w += mpf.length;
  out.set(base.subarray(cut), w); w += base.length - cut;
  out.set(gainFinal, w);
  return out;
}

// Shared container assembly: base JPEG + gain-map JPEG + ISO metadata.
function assembleUltraHdr(base, gainJpeg, isoGain) {
  const gainCut = metadataInsertionPoint(gainJpeg);
  const gainFinal = new Uint8Array(gainJpeg.length + isoGain.length);
  gainFinal.set(gainJpeg.subarray(0, gainCut), 0);
  gainFinal.set(isoGain, gainCut);
  gainFinal.set(gainJpeg.subarray(gainCut), gainCut + isoGain.length);

  const cut = metadataInsertionPoint(base);
  const isoPrim = isoPrimarySegment();
  const MPF_LEN = 90;
  const primaryLen = base.length + isoPrim.length + MPF_LEN;
  const mpfEndianOffset = cut + isoPrim.length + 8;
  const mpf = mpfSegment(primaryLen, gainFinal.length, mpfEndianOffset);

  const out = new Uint8Array(primaryLen + gainFinal.length);
  let w = 0;
  out.set(base.subarray(0, cut), w); w += cut;
  out.set(isoPrim, w); w += isoPrim.length;
  out.set(mpf, w); w += mpf.length;
  out.set(base.subarray(cut), w); w += base.length - cut;
  out.set(gainFinal, w);
  return out;
}

// HDR reveal: SDR viewers see imageA, HDR viewers see imageB.
async function reveal(fileA, fileB, { headroom = 2, quality = 0.95 } = {}) {
  const FLOOR = 8 / 255, CLAMP = 6;
  const bmpA = await createImageBitmap(fileA);
  const bmpB = await createImageBitmap(fileB);
  const w = bmpA.width, h = bmpA.height;

  const draw = (bmp) => {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bmp, 0, 0, w, h);
    return { canvas: c, data: ctx.getImageData(0, 0, w, h) };
  };
  const A = draw(bmpA), B = draw(bmpB);

  // per-pixel per-channel log2 gain, clamped
  const n = w * h;
  const logGain = new Float32Array(n * 3);
  const OFF = 77 / 0x2de54477;
  const lmins = [Infinity, Infinity, Infinity];
  const lmaxs = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) {
      const av = srgbEotf(Math.max(A.data.data[i * 4 + c] / 255, FLOOR));
      const bv = srgbEotf(Math.max(B.data.data[i * 4 + c] / 255, FLOOR));
      let L = Math.log2((bv + OFF) / (av + OFF));
      L = Math.min(Math.max(L, -CLAMP), CLAMP);
      logGain[i * 3 + c] = L;
      if (L < lmins[c]) lmins[c] = L;
      if (L > lmaxs[c]) lmaxs[c] = L;
    }
  }
  for (let c = 0; c < 3; c++) {
    if (lmaxs[c] - lmins[c] < 1e-3) lmaxs[c] = lmins[c] + 1e-3;
  }

  // normalized multichannel gain map; also lift A's floor in the base
  const mapData = new ImageData(w, h);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) {
      const g = (logGain[i * 3 + c] - lmins[c]) / (lmaxs[c] - lmins[c]);
      mapData.data[i * 4 + c] = Math.round(g * 255);
      A.data.data[i * 4 + c] = Math.max(A.data.data[i * 4 + c], 8);
    }
    mapData.data[i * 4 + 3] = 255;
    A.data.data[i * 4 + 3] = 255;
  }
  A.canvas.getContext("2d").putImageData(A.data, 0, 0);

  const base = await canvasToJpegBytes(A.canvas, quality);
  const gainJpeg = await canvasToJpegBytes(mapData, 1.0);
  const iso = isoGainmapMeta(lmins, lmaxs, Math.log2(headroom));
  return assembleUltraHdr(base, gainJpeg, iso);
}


// ---------- PQ PNG (the LinkedIn-surviving format) ----------

const REC2020_PQ_ICC_B64 = "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czMFUwukczMFUxM5czMFUxxwczMFUye+czMFUzWyczMFU0bZczMFU1t9czMFU3MzZz4EcIAAczMLpAAAczMLpAVTczMLpAukczMLpBM5czMLpBxwczMLpCe+czMLpDWyczMLpEbZczMLpFt9czMLpHMzZz4JwIAAczMTOQAAczMTOQVTczMTOQukczMTORM5czMTORxwczMTOSe+czMTOTWyczMTOUbZczMTOVt9czMTOXMzZz4QL4AAczMccAAAczMccAVTczMccAukczMccBM5czMccBxwczMccCe+czMccDWyczMccEbZczMccFt9czMccHMzZz4YF4AAczMnvgAAczMnvgVTczMnvgukczMnvhM5czMnvhxwczMnvie+czMnvjWyczMnvkbZczMnvlt9czMnvnMzZz4h7YAAczM1sgAAczM1sgVTczM1sgukczM1shM5czM1shxwczM1sie+czM1sjWyczM1skbZczM1slt9czM1snMzZz4uRIAAczNG2QAAczNG2QVTczNG2QukczNG2RM5czNG2RxwczNG2Se+czNG2TWyczNG2UbZczNG2Vt9czNG2XMzZz49vYAAczNbfQAAczNbfQVTczNbfQukczNbfRM5czNbfRxwczNbfSe+czNbfTWyczNbfUbZczNbfVt9czNbfXMzZz5QyoAAczNzMwAAczNzMwVTczNzMwukczNzMxM5czNzMxxwczNzMye+czNzMzWyczNzM0bZczNzM1t9czNzM3MzZz5nPoAAZz6AAAAAZz6AAARwZz6AAAnAZz6AABAvZz6AABgXZz6AACHtZz6AAC5EZz6AAD29Zz6AAFDKZz6AAGc+Zz6AAIAAgAAAAAAAgAAAAARwgAAAAAnAgAAAABAvgAAAABgXgAAAACHtgAAAAC5EgAAAAD29gAAAAFDKgAAAAGc+gAAAAIAAgAAEcAAAgAAEcARwgAAEcAnAgAAEcBAvgAAEcBgXgAAEcCHtgAAEcC5EgAAEcD29gAAEcFDKgAAEcGc+gAAEcIAAgAAJwAAAgAAJwARwgAAJwAnAgAAJwBAvgAAJwBgXgAAJwCHtgAAJwC5EgAAJwD29gAAJwFDKgAAJwGc+gAAJwIAAgAAQLwAAgAAQLwRwgAAQLwnAgAAQLxAvgAAQLxgXgAAQLyHtgAAQLy5EgAAQLz29gAAQL1DKgAAQL2c+gAAQL4AAgAAYFwAAgAAYFwRwgAAYFwnAgAAYFxAvgAAYFxgXgAAYFyHtgAAYFy5EgAAYFz29gAAYF1DKgAAYF2c+gAAYF4AAgAAh7QAAgAAh7QRwgAAh7QnAgAAh7RAvgAAh7RgXgAAh7SHtgAAh7S5EgAAh7T29gAAh7VDKgAAh7Wc+gAAh7YAAgAAuRAAAgAAuRARwgAAuRAnAgAAuRBAvgAAuRBgXgAAuRCHtgAAuRC5EgAAuRD29gAAuRFDKgAAuRGc+gAAuRIAAgAA9vQAAgAA9vQRwgAA9vQnAgAA9vRAvgAA9vRgXgAA9vSHtgAA9vS5EgAA9vT29gAA9vVDKgAA9vWc+gAA9vYAAgABQygAAgABQygRwgABQygnAgABQyhAvgABQyhgXgABQyiHtgABQyi5EgABQyj29gABQylDKgABQymc+gABQyoAAgABnPgAAgABnPgRwgABnPgnAgABnPhAvgABnPhgXgABnPiHtgABnPi5EgABnPj29gABnPlDKgABnPmc+gABnPoAAgACAAAAAgACAAARwgACAAAnAgACAABAvgACAABgXgACAACHtgACAAC5EgACAAD29gACAAFDKgACAAGc+gACAAIAAAABjdXJ2AAAAAAAAAEEAAAACAAcAEQAgADgAWACEAL8BCgFpAeECdgMtBAoFFQZUB88JjwucDgMQxBP6F58bxSBlJZ4rdzHkONBAhEi2UX5at2R8bnp424OKjlSZQ6RIrzK6Q8VU0Gfbsecc8r3+3v//////////////////////////////////////////AABjdXJ2AAAAAAAAAEEAAAACAAcAEQAgADgAWACEAL8BCgFpAeECdgMtBAoFFQZUB88JjwucDgMQxBP6F58bxSBlJZ4rdzHkONBAhEi2UX5at2R8bnp424OKjlSZQ6RIrzK6Q8VU0Gfbsecc8r3+3v//////////////////////////////////////////AABjdXJ2AAAAAAAAAEEAAAACAAcAEQAgADgAWACEAL8BCgFpAeECdgMtBAoFFQZUB88JjwucDgMQxBP6F58bxSBlJZ4rdzHkONBAhEi2UX5at2R8bnp424OKjlSZQ6RIrzK6Q8VU0Gfbsecc8r3+3v//////////////////////////////////////////AAAAAKxoAAAqaQAAIAcAAEdvAACs4wAAC67///+BAAAHrQAAzBMAAAAAAAAAAAAAAABwYXJhAAAAAAAAAAAAAQAAcGFyYQAAAAAAAAAAAAEAAHBhcmEAAAAAAAAAAAABAABtQkEgAAAAAAMDAAAAAAAgAAAAAAAAAAAAAAAAAAAAAHBhcmEAAAAAAAAAAAABAABwYXJhAAAAAAAAAAAAAQAAcGFyYQAAAAAAAAAAAAEAAGNpY3AAAAAACRAAAQ==";

const M709_TO_2020 = [
  [0.6274, 0.3293, 0.0433],
  [0.0691, 0.9195, 0.0114],
  [0.0164, 0.0880, 0.8956],
];
const PQ = { m1: 2610 / 16384, m2: 2523 / 32, c1: 3424 / 4096, c2: 2413 / 128, c3: 2392 / 128 };

function pqInverseEotf(nits) {
  const y = Math.min(Math.max(nits, 0), 10000) / 10000;
  const ym = Math.pow(y, PQ.m1);
  return Math.pow((PQ.c1 + PQ.c2 * ym) / (1 + PQ.c3 * ym), PQ.m2);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function deflate(bytes) {
  const cs = new CompressionStream("deflate");
  const w = cs.writable.getWriter();
  w.write(bytes);
  w.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

function pngChunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(ascii(type), 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

// sRGB image -> Rec.2020 PQ PNG (8-bit) with BT.2100 profile + cICP.
// Highlight mode: colors render at sdrNits, near-whites ramp to nits.
async function luminescePq(fileOrBlob, { nits = 1000, sdrNits = 203, knee = 0.85 } = {}) {
  const bitmap = await createImageBitmap(fileOrBlob);
  const w = bitmap.width, h = bitmap.height;
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0);
  const src = ctx.getImageData(0, 0, w, h).data;

  const raw = new Uint8Array(h * (1 + w * 3)); // filter byte + RGB rows
  let o = 0;
  for (let y = 0; y < h; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const lin = [0, 1, 2].map(c => srgbEotf(src[i + c] / 255));
      const yMax = Math.max(lin[0], lin[1], lin[2]);
      let ramp = (yMax - knee) / (1 - knee);
      ramp = Math.min(Math.max(ramp, 0), 1);
      const pixNits = sdrNits + (nits - sdrNits) * ramp * ramp;
      for (let c = 0; c < 3; c++) {
        const abs = (M709_TO_2020[c][0] * lin[0] + M709_TO_2020[c][1] * lin[1] +
                     M709_TO_2020[c][2] * lin[2]) * pixNits;
        raw[o++] = Math.round(pqInverseEotf(abs) * 255);
      }
    }
  }

  const icc = Uint8Array.from(atob(REC2020_PQ_ICC_B64), ch => ch.charCodeAt(0));
  const iccDeflated = await deflate(icc);
  const iccp = new Uint8Array(12 + iccDeflated.length);
  iccp.set(ascii("Rec2020 PQ\0\0"), 0);
  iccp.set(iccDeflated, 12);

  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, w);
  new DataView(ihdr.buffer).setUint32(4, h);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type: RGB
  const idat = await deflate(raw);

  const parts = [
    ascii("\x89PNG\r\n\x1a\n"),
    pngChunk("IHDR", ihdr),
    pngChunk("cICP", new Uint8Array([9, 16, 0, 1])),
    pngChunk("iCCP", iccp),
    pngChunk("IDAT", idat),
    pngChunk("IEND", new Uint8Array(0)),
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const part of parts) { out.set(part, p); p += part.length; }
  return out;
}

window.luminescePq = luminescePq;

window.reveal = reveal;
window.luminesce = luminesce;
window.LUMINESCE_MAX_BOOST = MAX_BOOST;
