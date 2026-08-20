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

window.reveal = reveal;
window.luminesce = luminesce;
window.LUMINESCE_MAX_BOOST = MAX_BOOST;
