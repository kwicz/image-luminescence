#!/usr/bin/env python3
"""image-reveal: one file, two pictures.

Packs two images into an Ultra HDR (ISO 21496-1) gain-map JPEG so that
SDR viewers see image A while HDR-capable viewers (Chrome/Edge on an HDR
display, iOS Photos, Android) see the file transform into image B. The
gain map stores the per-pixel, per-channel ratio between the two images;
displays apply it in proportion to their brightness headroom.

Usage:
    python3 luminescence_reveal.py sdr.png hdr.png [-o out.jpg]
                                   [--headroom 2] [--quality 95]

--headroom: the display headroom (x over SDR white) at which the reveal
completes. The revealed image renders at normal brightness, so this is a
gate, not a brightness requirement. The default 2 flips fully to B on HDR
displays (values below ~2 render unreliably in Chrome). Raise it (4-8) to
turn the reveal into a gradual A-to-B crossfade that tracks the viewer's
brightness slider.
"""

import argparse
import math
import os
import struct
import subprocess
import sys
import tempfile

import numpy as np

from luminescence_pq import decode_image, srgb_eotf

ISO_URN = b"urn:iso:std:iso:ts:21496:-1\x00"
# ~1e-7, byte-identical to libultrahdr's offset fraction
OFFSET_FRACTION = (77, 0x2DE54477)
OFFSET = OFFSET_FRACTION[0] / OFFSET_FRACTION[1]
# clamp per-channel gain to +-8 stops; an 8-bit map over 16 stops still
# gives ~16 steps per stop, and it bounds black-pixel blowups
L_CLAMP = 6.0


# ---------- JPEG segment plumbing (mirrors docs/app.js) ----------

def insertion_point(b):
    if b[0] != 0xFF or b[1] != 0xD8:
        sys.exit("internal: not a JPEG")
    i = 2
    while i + 4 <= len(b) and b[i] == 0xFF:
        m = b[i + 1]
        if not (0xE0 <= m <= 0xEF or m == 0xFE):
            break
        i += 2 + ((b[i + 2] << 8) | b[i + 3])
    return i


def segment(marker, payload):
    return bytes([0xFF, marker]) + struct.pack(">H", len(payload) + 2) + payload


def iso_primary_segment():
    return segment(0xE2, ISO_URN + struct.pack(">HH", 0, 0))


def frac(x, den=1 << 20):
    return struct.pack(">iI", round(x * den), den)


def iso_gainmap_segment(lmins, lmaxs, headroom_log2):
    p = ISO_URN + struct.pack(">HH", 0, 0)
    p += bytes([0xC0])                       # multichannel | use base gamut
    p += frac(0.0)                           # baseHdrHeadroom: base at SDR
    p += frac(headroom_log2)                 # altHdrHeadroom: full reveal
    for c in range(3):
        p += frac(lmins[c])                  # gainMapMin (can be negative)
        p += frac(lmaxs[c])                  # gainMapMax
        p += struct.pack(">II", 1, 1)        # gamma = 1
        p += struct.pack(">II", *OFFSET_FRACTION)  # offsetSdr
        p += struct.pack(">II", *OFFSET_FRACTION)  # offsetHdr
    return segment(0xE2, p)


def mpf_segment(primary_len, gainmap_len, mpf_tiff_offset):
    p = bytearray(b"MPF\x00MM\x00*")
    p += struct.pack(">I", 8)                    # IFD offset
    p += struct.pack(">H", 3)                    # 3 tags
    p += struct.pack(">HHI4s", 0xB000, 7, 4, b"0100")
    p += struct.pack(">HHII", 0xB001, 4, 1, 2)
    p += struct.pack(">HHII", 0xB002, 7, 32, 0x32)
    p += struct.pack(">I", 0)                    # next IFD
    p += struct.pack(">IIII", 0x00030000, primary_len, 0, 0)
    p += struct.pack(">IIII", 0, gainmap_len, primary_len - mpf_tiff_offset, 0)
    return segment(0xE2, bytes(p))


def encode_jpeg(rgb01, quality):
    """Encode float RGB (0..1) via ImageMagick, return JPEG bytes."""
    h, w = rgb01.shape[:2]
    raw = np.clip(np.round(rgb01 * 255), 0, 255).astype("u1")
    with tempfile.TemporaryDirectory() as d:
        raw_p = os.path.join(d, "x.raw")
        jpg_p = os.path.join(d, "x.jpg")
        raw.tofile(raw_p)
        subprocess.run(
            ["magick", "-size", f"{w}x{h}", "-depth", "8", "rgb:" + raw_p,
             "-type", "truecolor", "-sampling-factor", "1x1",
             "-quality", str(quality), jpg_p],
            check=True,
        )
        return open(jpg_p, "rb").read()


# ---------- the reveal ----------

def build(sdr_path, hdr_path, out_path, headroom, quality):
    a, w, h = decode_image(sdr_path)
    b, wb, hb = decode_image(hdr_path)
    if (wb, hb) != (w, h):
        # resize B to A's canvas via magick round-trip
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "b.png")
            subprocess.run(
                ["magick", hdr_path + "[0]", "-resize", f"{w}x{h}!", p],
                check=True)
            b, _, _ = decode_image(p)
        print(f"note: resized {os.path.basename(hdr_path)} to {w}x{h}")

    # flatten alpha onto white, lift the SDR floor so black pixels can
    # still ratio up to a bright B within the clamp
    def flatten(img):
        al = img[..., 3:4]
        return img[..., :3] * al + (1 - al)
    a_srgb = np.maximum(flatten(a), 8 / 255)
    b_srgb = np.maximum(flatten(b), 8 / 255)

    a_lin = srgb_eotf(a_srgb)
    b_lin = srgb_eotf(b_srgb)

    log_gain = np.log2((b_lin + OFFSET) / (a_lin + OFFSET))
    log_gain = np.clip(log_gain, -L_CLAMP, L_CLAMP)
    lmins = log_gain.reshape(-1, 3).min(axis=0)
    lmaxs = log_gain.reshape(-1, 3).max(axis=0)
    # avoid a zero-width range on degenerate channels
    lmaxs = np.maximum(lmaxs, lmins + 1e-3)

    gain_map01 = (log_gain - lmins) / (lmaxs - lmins)

    base_jpg = encode_jpeg(a_srgb, quality)
    gain_jpg = encode_jpeg(gain_map01, 98)

    # splice ISO metadata into the gain map image
    cut = insertion_point(gain_jpg)
    iso_g = iso_gainmap_segment(lmins, lmaxs, math.log2(headroom))
    gain_final = gain_jpg[:cut] + iso_g + gain_jpg[cut:]

    # splice ISO version + MPF into the primary
    cut = insertion_point(base_jpg)
    iso_p = iso_primary_segment()
    MPF_LEN = 90
    primary_len = len(base_jpg) + len(iso_p) + MPF_LEN
    mpf_tiff_offset = cut + len(iso_p) + 8
    mpf = mpf_segment(primary_len, len(gain_final), mpf_tiff_offset)
    out = base_jpg[:cut] + iso_p + mpf + base_jpg[cut:] + gain_final

    open(out_path, "wb").write(out)
    print(f"{out_path}: {w}x{h}, SDR shows {os.path.basename(sdr_path)}, "
          f"HDR reveals {os.path.basename(hdr_path)} at {headroom:g}x headroom")


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("sdr", help="image everyone sees (SDR base)")
    ap.add_argument("hdr", help="image HDR displays reveal")
    ap.add_argument("-o", "--output", help="output JPEG (default: <sdr>-reveal.jpg)")
    ap.add_argument("--headroom", type=float, default=2.0,
                    help="display headroom (x SDR white) at which the reveal "
                         "completes (default 2: flips to B on HDR displays; "
                         "raise to 4-8 for a gradual crossfade tied to the "
                         "viewer's brightness; below ~2 renders unreliably "
                         "in Chrome)")
    ap.add_argument("--quality", type=int, default=95)
    args = ap.parse_args()
    out = args.output or os.path.splitext(args.sdr)[0] + "-image-reveal.jpg"
    build(args.sdr, args.hdr, out, args.headroom, args.quality)


if __name__ == "__main__":
    main()
