"""Generate a 'combined dual-plane' smoke fixture from two existing clips.

Muxes the two source videos side-by-side into a single MP4 whose left/right
halves are the two planes, so the pipeline's "_split_combined" can separate
them. With the current clinics footage BOTH halves are sagittal-view recordings,
so the split portion deterministically exercises the graceful
'could not separate frontal/sagittal halves' path — while the demo/analyse
fallback still proves combined-dual-view routing.

Usage: py scripts/make-combined-fixture.py [left.mp4 right.mp4 out.mp4]
"""
import glob
import os
import sys

import cv2

BASE = os.path.normpath(os.path.join(os.path.dirname(__file__), ".."))
CLIPS = sorted(glob.glob(os.path.join(BASE, "uploads", "gait", "session-*-sagittal-*.mp4")) +
               glob.glob(os.path.join(BASE, "uploads", "gait", "session-3-*-*.mp4")))


def pick_two():
    fronts = sorted(set(CLIPS))
    # prefer the two established session-3 clips (same subject/pacing, tested)
    s3 = [p for p in fronts if "session-3-sagittal" in os.path.basename(p)]
    if len(s3) >= 2:
        return s3[0], s3[1]
    return fronts[0], fronts[1]


def main():
    if len(sys.argv) > 3:
        left, right, out = sys.argv[1], sys.argv[2], sys.argv[3]
    elif len(sys.argv) > 1:
        left, right, out = sys.argv[1], sys.argv[2], os.path.join(BASE, "uploads", "gait", "combined-smoke.mp4")
    else:
        left, right = pick_two()
        out = os.path.join(BASE, "uploads", "gait", "combined-smoke.mp4")
    la = cv2.VideoCapture(left)
    ra = cv2.VideoCapture(right)
    w = int(la.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(la.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = la.get(cv2.CAP_PROP_FPS) or 30.0
    n = int(min(la.get(cv2.CAP_PROP_FRAME_COUNT), ra.get(cv2.CAP_PROP_FRAME_COUNT)))
    if la.get(cv2.CAP_PROP_FRAME_WIDTH) != ra.get(cv2.CAP_PROP_FRAME_WIDTH) or \
       la.get(cv2.CAP_PROP_FRAME_HEIGHT) != ra.get(cv2.CAP_PROP_FRAME_HEIGHT):
        print("ERR frames differ")  # pragmatic guard for our fixtures
        return 1
    writer = cv2.VideoWriter(out, cv2.VideoWriter_fourcc(*"mp4v"), fps, (w * 2, h))
    for _ in range(n):
        ok1, f1 = la.read()
        ok2, f2 = ra.read()
        if not (ok1 and ok2):
            break
        writer.write(cv2.hconcat([f1, f2]))
    writer.release()
    la.release()
    ra.release()
    print("WROTE", out, "from", os.path.basename(left), "+", os.path.basename(right))
    return 0


if __name__ == "__main__":
    sys.exit(main())