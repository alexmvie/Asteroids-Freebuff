#!/usr/bin/env python3
"""
v0.73.0 — SSAO A/B pixel-contrast measurer.

Compares two screenshots of the SAME frozen showcase object (SSAO off vs
on) and reports the micro-contrast + luminance deltas, so the GTAO pass
can be tuned against a numeric baseline instead of eyeballing.

Metrics (all computed on the central object crop — the object fills the
showcase frame center, the label overlay lives at the bottom):
  micro-contrast  = RMS of the luminance difference between each pixel
                    and its right/down neighbors. SSAO should RAISE this
                    in crater interiors / boulder gaps (sharp contact
                    shadows add local luminance variation).
  mean luminance  = average of the crop luminance. SSAO should LOWER it
                    slightly (occluded crevices darken).
  AO coverage     = fraction of pixels darkened by SSAO by >1.5% of full
                    range. Tells us the AO is actually biting somewhere.

Run: python3 scripts/measure-ssao-ab.py <off.png> <on.png>
"""

import sys
from PIL import Image


def luminance(px):
    # Perceptual-ish luma (Rec.709 weights).
    return 0.2126 * px[0] + 0.7152 * px[1] + 0.0722 * px[2]


def central_crop(img, frac=0.55):
    w, h = img.size
    cw, ch = int(w * frac), int(h * frac)
    x0 = (w - cw) // 2
    # Stay away from the bottom label strip: shift the crop up slightly.
    y0 = max(0, (h - ch) // 2 - int(h * 0.06))
    return img.crop((x0, y0, x0 + cw, y0 + ch))


def micro_contrast(img):
    """RMS of neighbor luminance diffs (right + down)."""
    g = img.convert("L")
    px = g.load()
    w, h = g.size
    total = 0
    count = 0
    for y in range(h - 1):
        for x in range(w - 1):
            d = px[x, y] - px[x + 1, y]
            d2 = px[x, y] - px[x, y + 1]
            total += d * d + d2 * d2
            count += 2
    return (total / count) ** 0.5


def mean_luminance(img):
    px = img.load()
    w, h = img.size
    total = 0
    for y in range(h):
        for x in range(w):
            total += luminance(px[x, y])
    return total / (w * h)


def ao_coverage(off_img, on_img):
    """Fraction of pixels where ON is darker than OFF by >1.5% of 255."""
    po = off_img.load()
    pn = on_img.load()
    w, h = off_img.size
    darkened = 0
    total = 0
    for y in range(h):
        for x in range(w):
            lo = luminance(po[x, y])
            ln = luminance(pn[x, y])
            total += 1
            if lo - ln > 255 * 0.015:
                darkened += 1
    return darkened / max(1, total)


def main():
    if len(sys.argv) != 3:
        print("usage: measure-ssao-ab.py <off.png> <on.png>")
        sys.exit(1)
    off_img = central_crop(Image.open(sys.argv[1]).convert("RGB"))
    on_img = central_crop(Image.open(sys.argv[2]).convert("RGB"))
    if off_img.size != on_img.size:
        print("ERROR: off/on crops differ in size — are they the same object/frame?")
        sys.exit(1)

    mc_off = micro_contrast(off_img)
    mc_on = micro_contrast(on_img)
    ml_off = mean_luminance(off_img)
    ml_on = mean_luminance(on_img)
    cov = ao_coverage(off_img, on_img)

    print("=" * 52)
    print(f"{'metric':<22}{'OFF':>10}{'ON':>10}{'Δ%':>8}")
    print("-" * 52)
    print(f"{'micro-contrast':<22}{mc_off:>10.2f}{mc_on:>10.2f}{100*(mc_on-mc_off)/max(mc_off,1e-9):>7.1f}%")
    print(f"{'mean luminance':<22}{ml_off:>10.2f}{ml_on:>10.2f}{100*(ml_on-ml_off)/max(ml_off,1e-9):>7.1f}%")
    print(f"{'AO coverage':<22}{'-':>10}{100*cov:>9.1f}%")
    print("=" * 52)
    print("Target: micro-contrast UP (contact shadows), mean luminance slightly DOWN,")
    print("AO coverage clearly > 0 (the pass is biting, not a no-op).")


if __name__ == "__main__":
    main()
