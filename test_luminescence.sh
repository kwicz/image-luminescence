#!/bin/bash
# End-to-end tests for luminescence_pq.py: profile embedding, white neutrality,
# and exact hue/gamut preservation via full pipeline round-trip.
set -euo pipefail
cd "$(dirname "$0")"

echo "== 1. Build fixtures =="
magick -size 64x64 xc:white fixture-white.png
magick -size 192x64 xc:'rgb(255,20,20)' \
  \( -size 64x64 xc:'rgb(0,255,128)' \) -geometry +64+0 -composite \
  \( -size 64x64 xc:'rgb(40,80,220)' \) -geometry +128+0 -composite \
  fixture-swatches.png

echo "== 2. Convert (uniform mode for round-trip math checks) =="
python3 luminescence_pq.py fixture-white.png -o fixture-white-glow.png --uniform
python3 luminescence_pq.py fixture-swatches.png -o fixture-swatches-glow.png --uniform

echo "== 3. Profile embedded (sips) =="
for f in fixture-white-glow.png fixture-swatches-glow.png; do
  desc=$(sips -g all "$f" | awk -F': ' '/^ *profile:/{print $2}')
  echo "  $f -> profile: $desc"
  [ "$desc" = "Rec2020 Gamut with PQ Transfer" ] || { echo "FAIL: wrong/missing profile"; exit 1; }
done

echo "== 4. White neutrality + expected PQ code =="
python3 - <<'EOF'
import numpy as np, subprocess, sys
sys.path.insert(0, '.')
from luminescence_pq import decode_image, pq_inverse_eotf

rgba, w, h = decode_image('fixture-white-glow.png')
r, g, b = rgba[32, 32, :3]
spread = (max(r, g, b) - min(r, g, b)) * 65535
expected = float(pq_inverse_eotf(np.array(1000.0)))
print(f"  white out R,G,B = {r:.4f},{g:.4f},{b:.4f}  spread={spread:.1f}/65535")
print(f"  expected PQ code for 1000 nits = {expected:.4f}")
assert spread <= 1, "FAIL: white is not neutral"
assert abs(r - expected) * 65535 <= 1, "FAIL: wrong PQ code for white"
print("  PASS")
EOF

echo "== 5. Round-trip: invert pipeline, compare to source =="
python3 - <<'EOF'
import numpy as np, sys
sys.path.insert(0, '.')
from luminescence_pq import decode_image, pq_eotf, srgb_oetf, M_709_TO_2020

for name in ('fixture-white', 'fixture-swatches'):
    src, w, h = decode_image(f'{name}.png')
    out, _, _ = decode_image(f'{name}-glow.png')
    # invert: PQ code -> nits -> /1000 -> 2020->709 matrix -> sRGB OETF
    linear2020 = pq_eotf(out[..., :3]) / 1000.0
    linear709 = linear2020 @ np.linalg.inv(M_709_TO_2020).T
    back = srgb_oetf(np.clip(linear709, 0, 1))
    err = np.abs(back - src[..., :3]).max() * 255
    print(f"  {name}: max round-trip error = {err:.3f}/255")
    assert err <= 1.0, f"FAIL: {name} hue/gamut not preserved"
print("  PASS: colors preserved exactly (within quantization)")
EOF

echo "== 6. Contrast: naive tagging (the old 'glow' method) shifts colors =="
python3 - <<'EOF'
import numpy as np, sys
sys.path.insert(0, '.')
from luminescence_pq import decode_image, pq_eotf, srgb_oetf, M_709_TO_2020

src, _, _ = decode_image('fixture-swatches.png')
# naive tag = pixels unchanged, display decodes them as Rec2020 PQ
naive_linear2020 = pq_eotf(src[..., :3]) / 1000.0
naive709 = np.clip(naive_linear2020 @ np.linalg.inv(M_709_TO_2020).T, 0, 1)
naive_srgb = srgb_oetf(naive709)
err = np.abs(naive_srgb - src[..., :3]).max() * 255
print(f"  naive tagging: max color error = {err:.1f}/255 (vs <=1.0 for this converter)")
EOF

echo "== 7. Highlight mode: colors stay at SDR level, whites glow =="
magick -size 64x64 xc:'#CD79A3' fixture-pink.png
python3 luminescence_pq.py fixture-pink.png -o fixture-pink-glow.png
python3 luminescence_pq.py fixture-white.png -o fixture-white-hl.png
python3 - <<'EOF'
import numpy as np, sys
sys.path.insert(0, '.')
from luminescence_pq import decode_image, pq_eotf, srgb_oetf, srgb_eotf, M_709_TO_2020

# pink (below the knee) must decode to exactly SDR-white=203 nits scaling
out, _, _ = decode_image('fixture-pink-glow.png')
nits2020 = pq_eotf(out[32, 32, :3])
linear709 = np.linalg.inv(M_709_TO_2020) @ nits2020 / 203.0
back = srgb_oetf(np.clip(linear709, 0, 1))
src = srgb_eotf(np.array([0xCD, 0x79, 0xA3]) / 255.0)
err = np.abs(back - srgb_oetf(src)).max() * 255
print(f"  pink round-trip at SDR level: max error = {err:.3f}/255")
assert err <= 1.0, "FAIL: pink not preserved at SDR level"

# white must hit the 1000-nit peak
outw, _, _ = decode_image('fixture-white-hl.png')
wn = pq_eotf(outw[32, 32, :3])
print(f"  white luminance = {wn.max():.0f} nits (expect 1000)")
assert abs(wn.max() - 1000) < 5, "FAIL: white not at peak"
print("  PASS")
EOF

echo "== 8. Reveal: SDR shows A, full-headroom decode reconstructs B =="
magick -size 64x64 gradient:'#CB7AA3'-'#27273a' fixture-a.png
magick -size 64x64 gradient:'#f5f5dc'-'#0a0a0f' -rotate 90 fixture-b.png
python3 luminescence_reveal.py fixture-a.png fixture-b.png -o fixture-reveal.jpg > /dev/null
ultrahdr_app -m 1 -P -j fixture-reveal.jpg | head -1 | grep -q "Yes" || { echo "FAIL: not valid Ultra HDR"; exit 1; }
ultrahdr_app -m 1 -j fixture-reveal.jpg -o 0 -O 4 -z fixture-reveal-dec.raw > /dev/null 2>&1
python3 - <<'EOF'
import numpy as np, sys
sys.path.insert(0, '.')
from luminescence_pq import decode_image, srgb_eotf

# base must look like A (with the 8/255 floor lift)
base, _, _ = decode_image('fixture-reveal.jpg')
a, _, _ = decode_image('fixture-a.png')
a_flat = np.maximum(a[..., :3], 8/255)
err_a = np.abs(base[..., :3] - a_flat).mean() * 255
print(f"  base vs A: mean err {err_a:.2f}/255")
assert err_a < 3, "FAIL: base does not match A"

# full decode must reconstruct B
dec = np.fromfile('fixture-reveal-dec.raw', dtype='<f2').astype(np.float32).reshape(64, 64, 4)[..., :3]
b, _, _ = decode_image('fixture-b.png')
b_lin = srgb_eotf(np.maximum(b[..., :3], 8/255))
err_b = np.abs(dec - b_lin).mean()
print(f"  decoded vs B: mean linear err {err_b:.4f}")
assert err_b < 0.02, "FAIL: reveal does not reconstruct B"
print("  PASS")
EOF
rm -f fixture-reveal-dec.raw

echo "ALL TESTS PASSED"
