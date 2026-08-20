#!/usr/bin/env python3
"""Convert sRGB artwork to HDR "glow" PNGs: correct sRGB -> Rec.2020 PQ.

Pixel math preserves hue/gamut exactly (Rec.2020 is a superset of sRGB);
the --nits parameter sets how bright sRGB white renders (default 1000).
Output embeds the standard "Rec2020 Gamut with PQ Transfer" ICC profile
(rec2020-pq-reference.icc), the exact bytes ColorSync recognizes for EDR.

Usage:
    python3 hdr_glow.py input.png [-o out.png] [--nits 1000] [--depth 16|8] [--cicp]
"""

import argparse
import os
import struct
import subprocess
import sys
import tempfile
import zlib

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
PROFILE_PATH = os.path.join(HERE, "rec2020-pq-reference.icc")

# Linear Rec.709/sRGB -> linear Rec.2020 (both D65; BT.2087 matrix)
M_709_TO_2020 = np.array([
    [0.6274, 0.3293, 0.0433],
    [0.0691, 0.9195, 0.0114],
    [0.0164, 0.0880, 0.8956],
])

# SMPTE ST 2084 constants
PQ_M1 = 2610 / 16384
PQ_M2 = 2523 / 32
PQ_C1 = 3424 / 4096
PQ_C2 = 2413 / 128
PQ_C3 = 2392 / 128


def srgb_eotf(v):
    """sRGB code (0..1) -> linear light (0..1)."""
    return np.where(v <= 0.04045, v / 12.92, ((v + 0.055) / 1.055) ** 2.4)


def srgb_oetf(l):
    """Linear light (0..1) -> sRGB code (0..1). Used by round-trip tests."""
    return np.where(l <= 0.0031308, l * 12.92, 1.055 * l ** (1 / 2.4) - 0.055)


def pq_inverse_eotf(nits):
    """Absolute luminance in nits -> PQ code (0..1)."""
    y = np.clip(nits, 0, 10000) / 10000.0
    ym = y ** PQ_M1
    return ((PQ_C1 + PQ_C2 * ym) / (1 + PQ_C3 * ym)) ** PQ_M2


def pq_eotf(code):
    """PQ code (0..1) -> absolute luminance in nits. Used by round-trip tests."""
    cm = np.clip(code, 0, 1) ** (1 / PQ_M2)
    return 10000.0 * (np.maximum(cm - PQ_C1, 0) / (PQ_C2 - PQ_C3 * cm)) ** (1 / PQ_M1)


def decode_image(path):
    """Decode any magick-readable image to float RGBA (0..1), assuming sRGB pixels."""
    out = subprocess.run(
        ["magick", "identify", "-format", "%w %h", path + "[0]"],
        capture_output=True, text=True, check=True,
    )
    w, h = map(int, out.stdout.split())
    with tempfile.NamedTemporaryFile(suffix=".raw", delete=False) as tmp:
        raw_path = tmp.name
    try:
        subprocess.run(
            ["magick", path + "[0]", "-strip", "-alpha", "on",
             "-depth", "16", "-endian", "MSB", "rgba:" + raw_path],
            check=True,
        )
        raw = np.fromfile(raw_path, dtype=">u2")
    finally:
        os.unlink(raw_path)
    if raw.size != w * h * 4:
        sys.exit(f"decode mismatch: got {raw.size} samples, expected {w * h * 4}")
    return raw.reshape(h, w, 4).astype(np.float64) / 65535.0, w, h


def convert(rgba, nits, sdr_nits=None, knee=0.85):
    """sRGB RGBA (0..1) -> Rec.2020 PQ RGBA (0..1). Alpha passes through.

    Default (highlight mode, sdr_nits set): pixels render at normal SDR
    brightness (sdr_nits for white-level), and only near-white pixels ramp
    up toward `nits` — colors keep their on-screen appearance, whites glow.
    Uniform mode (sdr_nits=None): whole image scales to `nits`; saturated
    colors then exceed SDR range and appear washed out on screen.
    """
    linear = srgb_eotf(rgba[..., :3])
    if sdr_nits is None:
        pixel_nits = nits
    else:
        # per-pixel gain by max channel keeps chromaticity exactly:
        # 1.0 up to the knee, smooth quadratic ramp to peak at pure white
        y = linear.max(axis=-1, keepdims=True)
        ramp = np.clip((y - knee) / (1 - knee), 0, 1) ** 2
        pixel_nits = sdr_nits + (nits - sdr_nits) * ramp
    absolute = (linear * pixel_nits) @ M_709_TO_2020.T
    pq = pq_inverse_eotf(absolute)
    return np.dstack([pq, rgba[..., 3]])


def png_chunk(typ, data):
    return (struct.pack(">I", len(data)) + typ + data
            + struct.pack(">I", zlib.crc32(typ + data)))


def write_png(path, rgba, depth, icc, cicp):
    h, w = rgba.shape[:2]
    has_alpha = np.any(rgba[..., 3] < 1.0)
    channels = 4 if has_alpha else 3
    color_type = 6 if has_alpha else 2
    maxval = (1 << depth) - 1
    px = np.round(rgba[..., :channels] * maxval).astype(">u2" if depth == 16 else "u1")

    scanlines = bytearray()
    row_bytes = px.tobytes()
    stride = w * channels * (depth // 8)
    for y in range(h):
        scanlines.append(0)  # filter: none
        scanlines += row_bytes[y * stride:(y + 1) * stride]

    out = bytearray(b"\x89PNG\r\n\x1a\n")
    out += png_chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, depth, color_type, 0, 0, 0))
    if cicp:
        # primaries=9 (BT.2020), transfer=16 (PQ), matrix=0 (RGB), full range=1
        out += png_chunk(b"cICP", bytes([9, 16, 0, 1]))
    out += png_chunk(b"iCCP", b"Rec2020 PQ\x00\x00" + zlib.compress(icc, 9))
    out += png_chunk(b"IDAT", zlib.compress(bytes(scanlines), 9))
    out += png_chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(out)


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("input")
    ap.add_argument("-o", "--output", help="output PNG (default: <input>-glow.png)")
    ap.add_argument("--nits", type=float, default=1000.0,
                    help="peak luminance for whites in nits (default 1000)")
    ap.add_argument("--sdr-nits", type=float, default=203.0,
                    help="luminance of normal (non-glowing) content; "
                         "203 = HDR reference white (BT.2408)")
    ap.add_argument("--knee", type=float, default=0.85,
                    help="brightness level (0..1) where the glow ramp starts "
                         "(default 0.85; only near-white pixels glow)")
    ap.add_argument("--uniform", action="store_true",
                    help="scale the whole image to --nits (colors above SDR "
                         "range will look washed out on screen)")
    ap.add_argument("--depth", type=int, choices=(8, 16), default=16,
                    help="output bit depth (default 16; 8 may band in gradients)")
    ap.add_argument("--cicp", action="store_true",
                    help="also write a cICP chunk (BT.2020 + PQ) for browsers")
    args = ap.parse_args()

    out_path = args.output or os.path.splitext(args.input)[0] + "-luminescence-pq.png"
    if os.path.exists(PROFILE_PATH):
        icc = open(PROFILE_PATH, "rb").read()
    else:  # pip-installed: no data file next to the module
        from luminescence_icc import DATA as icc

    rgba, w, h = decode_image(args.input)
    sdr = None if args.uniform else args.sdr_nits
    result = convert(rgba, args.nits, sdr, args.knee)
    write_png(out_path, result, args.depth, icc, args.cicp)

    white_code = float(pq_inverse_eotf(np.array(args.nits)))
    mode = (f"uniform x{args.nits:g} nits" if args.uniform else
            f"colors at {args.sdr_nits:g} nits, whites glow to {args.nits:g}")
    print(f"{out_path}: {w}x{h}, {args.depth}-bit, {mode} "
          f"(white PQ code {white_code:.4f})")


if __name__ == "__main__":
    main()
