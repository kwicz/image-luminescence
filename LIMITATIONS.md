# Limitations and Notes

## What was actually going on with the example images

- The "glowing" images (`watercolor-disco-ball-hdr.png`, etc.) were sRGB pixels
  **tagged** with the "Rec2020 Gamut with PQ Transfer" ICC profile — no pixel
  conversion. Glow comes from code 255 being read as PQ max (~10,000 nits),
  but colors are distorted (max error measured at 128/255 on saturated colors).
- The "converted but colors wrong" images had **broken conversion math**:
  white (255,255,255) mapped to the non-neutral (123,127,105). A correct
  conversion keeps white on equal channels.
- `luminescence_pq.py` does the conversion correctly: round-trip error <= 0.006/255,
  white stays perfectly neutral, and `--nits` controls the glow strength.

## Where the glow works

- macOS: Preview, Finder/Quick Look, Safari, Chrome — on EDR-capable displays
  (any Apple Silicon MacBook, Pro Display XDR, recent iMacs). Whites render
  above SDR reference white and stay bright when the screen dims -- best
  viewed with screen brightness at about 50%.
- iOS/iPadOS: Photos, Safari.
- Chrome (all platforms with an HDR display): honors the PNG `cICP` chunk —
  always pass `--cicp`. On this machine, ColorSync maps cICP files to the
  system "Rec. ITU-R BT.2100 PQ" profile, the strongest recognition path.

## Where it won't

- SDR-only displays: the OS tone-maps everything back into SDR range. Images
  look normal (correct colors), just no glow. This is graceful degradation.
- Uploads that re-encode: Slack, most social platforms, and many CMSes strip
  ICC profiles/cICP or transcode to sRGB. Test each destination; if the
  pipeline strips metadata, the image will look **dark** (raw PQ codes shown
  as sRGB), which is worse than the naive-tag method's failure mode. Keep the
  sRGB original for those destinations.
- Windows: only HDR-aware apps on HDR-enabled displays (Chrome/Edge with cICP
  work; most native apps don't).
- Low-power/battery dimming on iPhones can cap EDR headroom; glow strength
  varies with ambient conditions by OS design.

## Brightness reality

- `--nits 1000` means "sRGB white requests 1000 nits". The OS clamps to the
  display's current EDR headroom (typically 2-8x SDR white on Apple displays).
  Values above ~1000 rarely add anything and increase clipping on lesser
  displays. 400-600 is a subtler, tasteful glow.
- All colors scale together, so relative appearance (hue, saturation,
  contrast) is preserved — the whole image glows, not just whites.

## Why the original custom-ICC idea was dropped

The initial plan was a custom ICC v4 profile with sRGB primaries + PQ TRC.
Technically valid, but OS HDR/EDR treatment is special-cased to *recognized*
HDR signals: the standard Rec.2020/BT.2100 PQ profiles, cICP metadata, and
gain maps. A nonstandard primaries+PQ combo would be rendered colorimetrically
and tone-mapped into SDR — dark, not glowing. The standards-correct expression
of that exact idea is cICP with primaries=1 (BT.709) + transfer=16 (PQ), but
converting to Rec.2020 (this tool) is a superset of that and better supported.

## Format notes

- Output is always PNG. 16-bit by default; `--depth 8` is fine for flat logo
  art but can band in gradients (PQ spends few codes on bright regions).
- JPEG output is unsupported by design — 8-bit only, and JPEG color-metadata
  handling is what produced the broken disco-ball example.
- Grayscale/palette sources are promoted to RGB(A); one example file
  (`the-good-17-anniversary-hdr.png`) was invalid because an RGB profile sat
  on a grayscale PNG — this tool avoids that class of bug.
