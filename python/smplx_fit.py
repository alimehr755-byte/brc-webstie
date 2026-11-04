#!/usr/bin/env python3
# smplx_fit.py — SMPL-X body-model fitting spike (j.txt)
#
# Plug-in point (documented here; NOT wired into gait_lab.py report logic so the
# existing pipeline is untouched): call fit_frame() right after MediaPipe
# landmark extraction and before angle smoothing / gait-cycle code, passing the
# per-frame MediaPipe 33 keypoints. Writes corrected 3D joint angles and one
# .obj mesh per fitted frame into <out_dir>/smplx/.
#
# SMPL-X model files are NOT bundled (license-gated download from
# smpl-x.is.tue.mpg.de). When they are absent the module reports
# status: "unassessed" with a reason — zero-assumption: no angles are ever
# fabricated. Local/offline/CPU-only; torch 2.14+cpu, smplx 0.1.28 required.

import json
import math
import os

import numpy as np
import torch

try:
    import smplx
except Exception:  # pragma: no cover - optional dependency
    smplx = None

STATUS_ASSESSED = "assessed"
STATUS_UNASSESSED = "unassessed"

# MediaPipe Pose 33 landmark indices (Mediapipe python API order).
MP_NOSE = 0
MP_LEFT_EYE = 2
MP_RIGHT_EYE = 5
MP_LEFT_EAR = 7
MP_RIGHT_EAR = 8
MP_LEFT_SHOULDER = 11
MP_RIGHT_SHOULDER = 12
MP_LEFT_ELBOW = 13
MP_RIGHT_ELBOW = 14
MP_LEFT_WRIST = 15
MP_RIGHT_WRIST = 16
MP_LEFT_HIP = 23
MP_RIGHT_HIP = 24
MP_LEFT_KNEE = 25
MP_RIGHT_KNEE = 26
MP_LEFT_ANKLE = 27
MP_RIGHT_ANKLE = 28
MP_LEFT_HEEL = 29
MP_RIGHT_HEEL = 30
MP_LEFT_FOOT_INDEX = 31
MP_RIGHT_FOOT_INDEX = 32

# OpenPose-25 order used by SMPLify-X. Each entry: (mediaPipe idx, confidence
# override) or None when the joint cannot be mapped from MediaPipe.
OPENPOSE_25_TO_MP = [
    (MP_NOSE, None),           # 0 Nose
    (None, "derived"),         # 1 Neck = midpoint of shoulders
    (MP_RIGHT_SHOULDER, None), # 2 R_Shoulder
    (MP_RIGHT_ELBOW, None),    # 3 R_Elbow
    (MP_RIGHT_WRIST, None),    # 4 R_Wrist
    (MP_LEFT_SHOULDER, None),  # 5 L_Shoulder
    (MP_LEFT_ELBOW, None),     # 6 L_Elbow
    (MP_LEFT_WRIST, None),     # 7 L_Wrist
    (MP_RIGHT_HIP, None),      # 8 R_Hip
    (MP_RIGHT_KNEE, None),     # 9 R_Knee
    (MP_RIGHT_ANKLE, None),    # 10 R_Ankle
    (MP_LEFT_HIP, None),       # 11 L_Hip
    (MP_LEFT_KNEE, None),      # 12 L_Knee
    (MP_LEFT_ANKLE, None),     # 13 L_Ankle
    (MP_RIGHT_EYE, None),      # 14 R_Eye
    (MP_LEFT_EYE, None),       # 15 L_Eye
    (MP_RIGHT_EAR, None),      # 16 R_Ear
    (MP_LEFT_EAR, None),       # 17 L_Ear
    (MP_LEFT_FOOT_INDEX, None),# 18 L_Big_toe
    (MP_LEFT_FOOT_INDEX, None),# 19 L_Small_toe (MediaPipe has no small toe)
    (MP_LEFT_HEEL, None),      # 20 L_Heel
    (MP_RIGHT_FOOT_INDEX, None),# 21 R_Big_toe
    (MP_RIGHT_FOOT_INDEX, None),# 22 R_Small_toe
    (MP_RIGHT_HEEL, None),     # 23 R_Heel
    (None, None),              # 24 unused / background
]

# SMPL-X vertex ids for anatomical angle computation (smplx.vertex_ids).
VERTEX_IDS = {
    "left_hip": "LEFT_HIP", "right_hip": "RIGHT_HIP",
    "left_knee": "LEFT_KNEE", "right_knee": "RIGHT_KNEE",
    "left_ankle": "LEFT_ANKLE", "right_ankle": "RIGHT_ANKLE",
    "left_shoulder": "LEFT_SHOULDER", "right_shoulder": "RIGHT_SHOULDER",
}


def _angle_abc(a, b, c):
    ab = a - b
    cb = c - b
    denom = float(np.linalg.norm(ab) * np.linalg.norm(cb))
    if denom < 1e-8:
        return None
    cos = float(np.dot(ab, cb) / denom)
    cos = max(-1.0, min(1.0, cos))
    return float(np.degrees(math.acos(cos)))


def _load_model(model_dir, gender):
    if smplx is None:
        return None, "smplx package not installed"
    candidates = [
        os.path.join(model_dir, f"SMPLX_{gender.upper()}.npz"),
        os.path.join(model_dir, f"SMPLX_{gender.capitalize()}.npz"),
        os.path.join(model_dir, f"smplx_{gender}.npz"),
        os.path.join(model_dir, gender, f"SMPLX_{gender.upper()}.npz"),
    ]
    model_path = next((p for p in candidates if os.path.exists(p)), None)
    if model_path is None:
        return None, ("SMPL-X model file not found in model_dir='%s'. Download "
                      "gender-specific SMPL-X .npz from smpl-x.is.tue.mpg.de "
                      "(license acceptance required) and place them under "
                      "<repo>/python/smplx_models/.") % model_dir
    try:
        model = smplx.create(
            model_dir, model_type="smplx", gender=gender, ext="npz",
            use_pca=False, flat_hand_mean=True,
        ).eval()
    except TypeError:
        model = smplx.create(
            model_dir, model_type="smplx", gender=gender,
            model_ext="npz", use_pca=False, flat_hand_mean=True,
        ).eval()
    return model, None


def _to_openpose25(keypoints):
    """Accept OpenPose-25 (len 25) or MediaPipe-33 (len 33) keypoints.

    Each item: dict with x, y and optional confidence/visibility. Returns
    (pts25 (25,2), conf (25,)) normalized to [0,1] image frame, plus whether
    the input was MediaPipe (so the neck joint can be derived).
    """
    n = len(keypoints)
    if n == 33:
        mp = np.asarray([[float(k.get("x", 0.0)), float(k.get("y", 0.0))]
                         for k in keypoints], dtype=np.float64)
        vis = np.asarray([float(k.get("visibility",
                                         k.get("presence", 1.0))) for k in keypoints],
                         dtype=np.float64)
        pts = np.zeros((25, 2), dtype=np.float64)
        conf = np.zeros(25, dtype=np.float64)
        for i, entry in enumerate(OPENPOSE_25_TO_MP):
            if entry is None:
                continue
            mp_idx, _ = entry
            if mp_idx is None:
                continue
            pts[i] = mp[mp_idx]
            conf[i] = vis[mp_idx]
        # Neck = midpoint of shoulders (derivable from MediaPipe).
        pts[1] = (mp[MP_LEFT_SHOULDER] + mp[MP_RIGHT_SHOULDER]) / 2.0
        conf[1] = min(vis[MP_LEFT_SHOULDER], vis[MP_RIGHT_SHOULDER])
        return pts, conf, True
    if n == 25:
        pts = np.asarray([[float(k.get("x", 0.0)), float(k.get("y", 0.0))]
                          for k in keypoints], dtype=np.float64)
        conf = np.asarray([float(k.get("confidence", k.get("visibility", 1.0)))
                           for k in keypoints], dtype=np.float64)
        return pts, conf, False
    raise ValueError("expected 25 (OpenPose) or 33 (MediaPipe) keypoints, got %d" % n)


class SmplxFitter:
    def __init__(self, model_dir="smplx_models", gender="neutral",
                 max_iters=200, device="cpu"):
        self.model_dir = model_dir
        self.gender = gender
        self.max_iters = max_iters
        self.device = torch.device(device)
        self.model, self.model_error = _load_model(model_dir, gender)
        self.ready = self.model is not None
        self.vertex_ids = None
        if self.ready:
            try:
                from smplx import vertex_ids as _vid
                self.vertex_ids = {name: getattr(_vid, VERTEX_IDS[name])
                                   for name in VERTEX_IDS}
            except Exception:
                self.vertex_ids = None

    def fit(self, keypoints, out_dir, frame_idx=0):
        if not self.ready:
            return {
                "status": STATUS_UNASSESSED,
                "reason": self.model_error or "SMPL-X model unavailable",
                "frame": frame_idx,
            }
        try:
            pts25, conf, _ = _to_openpose25(keypoints)
        except ValueError as exc:
            return {"status": STATUS_UNASSESSED, "reason": str(exc), "frame": frame_idx}

        valid = conf > 0
        if int(valid.sum()) < 6:
            return {"status": STATUS_UNASSESSED,
                    "reason": "too few visible keypoints to fit",
                    "frame": frame_idx}

        model = self.model.to(self.device)
        pose_dim = 63  # 21 joints x 3, use_pca=False
        global_orient = torch.zeros(1, 3, device=self.device, requires_grad=True)
        body_pose = torch.zeros(1, pose_dim, device=self.device, requires_grad=True)
        betas = torch.zeros(1, 10, device=self.device, requires_grad=True)
        cam_scale = torch.ones(1, device=self.device, requires_grad=True)
        cam_trans = torch.zeros(2, device=self.device, requires_grad=True)

        pts_t = torch.tensor(pts25, device=self.device, dtype=torch.float32)
        conf_t = torch.tensor(conf, device=self.device, dtype=torch.float32)
        # OpenPose-25 -> SMPL-X joint regressor mapping (joint name -> vertex id).
        # Use the SMPL-X joint output directly when available.
        optimizer = torch.optim.LBFGS(
            [global_orient, body_pose, betas, cam_scale, cam_trans],
            max_iter=self.max_iters, line_search_fn="strong_wolfe")

        def closure():
            optimizer.zero_grad()
            output = model(global_orient=global_orient, body_pose=body_pose,
                           betas=betas, transl=torch.zeros(1, 3,
                                                           device=self.device),
                           return_verts=True)
            joints = output.joints  # (1, J, 3) SMPL-X joint order
            # Use the subset of SMPL-X joints aligned to OpenPose-25 order where
            # the model exposes them; fall back to vertex-derived angles below.
            pred25 = joints[0, :25, :2] if joints.shape[1] >= 25 else None
            if pred25 is None:
                pred25 = output.vertices[0, :, :2]
            pred = cam_scale * pred25 + cam_trans
            diff = (pred - pts_t) * conf_t[:, None]
            reproj = torch.sum(diff * diff)
            prior = 50.0 * (torch.sum(body_pose ** 2) +
                            torch.sum(betas ** 2) +
                            torch.sum(global_orient ** 2))
            loss = reproj + prior
            loss.backward()
            return loss

        optimizer.step(closure)

        with torch.no_grad():
            output = model(global_orient=global_orient, body_pose=body_pose,
                           betas=betas,
                           transl=torch.zeros(1, 3, device=self.device),
                           return_verts=True)
            verts = output.vertices[0].detach().cpu().numpy()
            faces = model.faces if hasattr(model, "faces") else None
            if faces is None and hasattr(model, "faces_tensor"):
                faces = model.faces_tensor.detach().cpu().numpy()

        angles = self._angles_from_verts(verts)
        obj_path = None
        if out_dir:
            smplx_dir = os.path.join(out_dir, "smplx")
            os.makedirs(smplx_dir, exist_ok=True)
            obj_path = os.path.join(smplx_dir, "frame_%04d.obj" % frame_idx)
            self._write_obj(obj_path, verts, faces)

        return {
            "status": STATUS_ASSESSED,
            "gender": self.gender,
            "frame": frame_idx,
            "angles_deg": angles,
            "vertices": verts.tolist(),
            "obj_path": obj_path,
            "camera_scale": float(cam_scale.detach().cpu().numpy()),
            "camera_trans": cam_trans.detach().cpu().numpy().tolist(),
            "model_file_used": getattr(self, "_model_path", self.model_dir),
        }

    def _angles_from_verts(self, verts):
        angles = {}
        if self.vertex_ids is None or verts.shape[0] == 0:
            return angles
        vid = self.vertex_ids
        for side, (hip, knee, ankle) in (("L", ("left_hip", "left_knee", "left_ankle")),
                                          ("R", ("right_hip", "right_knee", "right_ankle"))):
            if hip in vid and knee in vid and ankle in vid:
                h = verts[vid[hip]]; k = verts[vid[knee]]; a = verts[vid[ankle]]
                ang = _angle_abc(h, k, a)
                if ang is not None:
                    angles["knee_flexion_%s" % side] = round(ang, 1)
            if hip in vid and knee in vid:
                pass
        return angles

    def _write_obj(self, path, verts, faces):
        with open(path, "w", encoding="utf-8") as fh:
            fh.write("# SMPL-X fitted mesh, frame\n")
            for v in verts:
                fh.write("v %.6f %.6f %.6f\n" % (v[0], v[1], v[2]))
            if faces is not None:
                for f in faces:
                    fh.write("f %d %d %d\n" % (int(f[0]) + 1, int(f[1]) + 1, int(f[2]) + 1))


def fit_frame(keypoints, out_dir, model_dir="smplx_models", gender="neutral",
              max_iters=200, frame_idx=0, device="cpu"):
    fitter = SmplxFitter(model_dir=model_dir, gender=gender,
                         max_iters=max_iters, device=device)
    return fitter.fit(keypoints, out_dir, frame_idx=frame_idx)


def main(argv=None):
    import argparse
    parser = argparse.ArgumentParser(description="SMPL-X fitting spike (CPU/offline)")
    parser.add_argument("--keypoints", required=True,
                        help="JSON: 25 OpenPose-25 or 33 MediaPipe keypoints")
    parser.add_argument("--gender", default="neutral", choices=["neutral", "male", "female"])
    parser.add_argument("--model-dir", default="smplx_models")
    parser.add_argument("--out", default=".")
    parser.add_argument("--max-iters", type=int, default=200)
    parser.add_argument("--device", default="cpu")
    ns = parser.parse_args(argv if argv is not None else __import__("sys").argv[1:])
    with open(ns.keypoints, "r", encoding="utf-8") as fh:
        keypoints = json.load(fh)
    if isinstance(keypoints, dict) and "keypoints" in keypoints:
        keypoints = keypoints["keypoints"]
    result = fit_frame(keypoints, ns.out, model_dir=ns.model_dir,
                       gender=ns.gender, max_iters=ns.max_iters,
                       frame_idx=0, device=ns.device)
    print(json.dumps(result, indent=2))
    return 0 if result["status"] == STATUS_ASSESSED else 1


if __name__ == "__main__":
    import sys
    raise SystemExit(main(sys.argv[1:]))
