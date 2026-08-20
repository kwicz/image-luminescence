#!/usr/bin/env python3
"""Make HDR "glow" images as gain-map JPEGs (Ultra HDR / ISO 21496-1).

Unlike the PQ route (hdr_glow.py), a gain-map file contains the ORIGINAL
sRGB image as its base — colors are pixel-exact on every display, with no
reference-white calibration. HDR-capable viewers additionally boost the
near-white pixels by up to --boost x over SDR white.

Requires: libultrahdr (brew install libultrahdr), ImageMagick, numpy.

Usage:
    python3 glow_gainmap.py input.png [-o out.jpg] [--boost 4] [--knee 0.85]
                            [--quality 95]
"""

import argparse
import os
import subprocess
import sys
import tempfile

import numpy as np

from luminescence_pq import decode_image, srgb_eotf

def build(input_path, out_path, boost, knee, quality):
    rgba, w, h = decode_image(input_path)
    if np.any(rgba[..., 3] < 1.0):
        print("note: JPEG has no alpha; transparency flattened onto white",
              file=sys.stderr)
        a = rgba[..., 3:4]
        rgba = rgba.copy()
        rgba[..., :3] = rgba[..., :3] * a + (1 - a)

    tmpdir = tempfile.mkdtemp()
    base_jpg = os.path.join(tmpdir, "base.jpg")
    hdr_raw = os.path.join(tmpdir, "hdr.raw")

    # Base = the SDR image everyone sees. If input is already a JPEG, keep
    # its bytes verbatim; otherwise encode once at high quality.
    if input_path.lower().endswith((".jpg", ".jpeg")):
        base_jpg = input_path
    else:
        subprocess.run(
            ["magick", input_path + "[0]", "-strip", "-background", "white",
             "-alpha", "remove", "-alpha", "off",
             "-quality", str(quality), base_jpg],
            check=True,
        )

    # HDR intent: linear light, 1.0 = SDR white. Same pixels as the base,
    # except near-white pixels ramp up to boost x (smooth knee, per-pixel
    # uniform scale so chromaticity is untouched).
    linear = srgb_eotf(rgba[..., :3])
    y = linear.max(axis=-1, keepdims=True)
    ramp = np.clip((y - knee) / (1 - knee), 0, 1) ** 2
    gain = 1 + (boost - 1) * ramp
    hdr = np.concatenate([linear * gain, np.ones_like(y)], axis=-1)
    hdr.astype(np.float16).tofile(hdr_raw)

    subprocess.run(
        ["ultrahdr_app", "-m", "0",
         "-i", base_jpg,               # compressed SDR intent (kept verbatim)
         "-p", hdr_raw,                # raw HDR intent
         "-a", "4",                    # rgbahalffloat
         "-t", "0",                    # linear transfer
         "-C", "0", "-c", "0",         # bt709 gamut both
         "-w", str(w), "-h", str(h),
         "-K", str(float(boost)),      # max content boost recommendation
         "-L", str(boost * 203.0),     # target peak nits -> hdrCapacityMax
                                       # equals boost (full glow at boost x
                                       # headroom, not at an assumed 10k nits)
         "-Q", str(quality),
         "-z", out_path],
        check=True, capture_output=True, text=True,
    )
    print(f"{out_path}: {w}x{h}, base sRGB JPEG q{quality}, "
          f"whites boost up to {boost:g}x over SDR white")


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("input")
    ap.add_argument("-o", "--output", help="output JPEG (default: <input>-glow.jpg)")
    ap.add_argument("--boost", type=float, default=4.0,
                    help="max brightness of whites, as a multiple of SDR "
                         "white (default 4; clamped by display headroom)")
    ap.add_argument("--knee", type=float, default=0.85,
                    help="brightness level (0..1) where the glow ramp starts")
    ap.add_argument("--quality", type=int, default=95,
                    help="JPEG quality for base and gain map (default 95)")
    args = ap.parse_args()

    out_path = args.output or os.path.splitext(args.input)[0] + "-luminescence.jpg"
    build(args.input, out_path, args.boost, args.knee, args.quality)


if __name__ == "__main__":
    main()
