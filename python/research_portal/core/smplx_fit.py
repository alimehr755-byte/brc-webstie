#!/usr/bin/env python3
"""
smplx_fit.py - SMPL-X Body Model Fitting Module

Implements SMPLify-X body model fitting for gait analysis.
Takes MediaPipe 2D keypoints and fits a parametric SMPL-X body model
to produce corrected 3D joint angles and 3D mesh per frame.

Based on the research portal specification for transverse plane analysis.
"""

import json
import json
import math
import os
import warnings
from typing import Dict, List, Optional, Tuple

import numpy as np

try:
    import torch
    import torch.nn as nn
    HAS_TORCH = True
except ImportError:
    HAS_TORCH = False

try:
    import smplx
    HAS_SMPLX = True
except ImportError:
    smplx = None
    HAS_SMPLX = False

STATUS_ASSESSED = "assessed"
STATUS_UNASSESSED = "unassessed"


# MediaPipe Pose 33 landmark indices (Mediapipe python API order).
MP33_ORDER = [
    "nose", "left_eye_inner", "left_eye", "left_eye_outer",
    "right_eye_inner", "right_eye", "right_eye_outer",
    "left_ear", "right_ear", "mouth_left", "mouth_right",
    "left_shoulder", "right_shoulder", "left_elbow", "right_elbow",
    "left_wrist", "right_wrist", "left_pinky", "right_pinky",
    "left_index", "right_index", "left_thumb", "right_thumb",
    "left_hip", "right_hip", "left_knee", "right_knee",
    "left_ankle", "right_ankle", "left_heel", "right_heel",
    "left_foot_index", "right_foot_index"
]

# SMPL-X body joint indices (22 body joints in SMPL order):
# 0 pelvis, 1 left_hip, 2 right_hip, 3 spine1, 4 left_knee, 5 right_knee,
# 6 spine2, 7 left_ankle, 8 right_ankle, 9 spine3, 10 left_foot,
# 11 right_foot, 12 neck, 13 left_collar, 14 right_collar, 15 head,
# 16 left_shoulder, 17 right_shoulder, 18 left_elbow, 19 right_elbow,
# 20 left_wrist, 21 right_wrist

# MediaPipe -> SMPL-X joint mapping
MP_TO_SMPLX = {
    0: 15,   # nose -> head
    7: 13,   # left_ear -> left_collar
    8: 14,   # right_ear -> right_collar
    11: 16,  # left_shoulder -> left_shoulder
    12: 17,  # right_shoulder -> right_shoulder
    13: 18,  # left_elbow -> left_elbow
    14: 19,  # right_elbow -> right_elbow
    15: 20,  # left_wrist -> left_wrist
    16: 21,  # right_wrist -> right_wrist
    23: 1,   # left_hip -> left_hip
    24: 2,   # right_hip -> right_hip
    25: 4,   # left_knee -> left_knee
    26: 5,   # right_knee -> right_knee
    27: 7,   # left_ankle -> left_ankle
    28: 8,   # right_ankle -> right_ankle
}

# SMPLX joint names for reference
SMPLX_JOINT_NAMES = [
    "pelvis", "left_hip", "right_hip", "spine1", "left_knee", "right_knee",
    "spine2", "left_ankle", "right_ankle", "spine3", "left_foot",
    "right_foot", "neck", "left_collar", "right_collar", "head",
    "left_shoulder", "right_shoulder", "left_elbow", "right_elbow",
    "left_wrist", "right_wrist"
]


def _angle_abc(a: np.ndarray, b: np.ndarray, c: np.ndarray) -> float:
    """Calculate angle at vertex b formed by points a-b-c in degrees."""
    ab = a - b
    cb = c - b
    denom = float(np.linalg.norm(ab) * np.linalg.norm(cb))
    if denom < 1e-8:
        return None
    cos = float(np.dot(ab, cb) / denom)
    cos = max(-1.0, min(1.0, cos))
    return float(np.degrees(math.acos(cos)))


class SmplxFitter:
    """
    SMPL-X body model fitting class.
    
    Fits a parametric SMPL-X body model to MediaPipe 2D keypoints,
    producing corrected 3D joint angles and 3D mesh per frame.
    """

    def __init__(self, model_dir: str = "smplx_models", gender: str = "neutral",
                 max_iters: int = 100, device: str = "cpu"):
        """
        Initialize the SMPL-X fitter.

        Args:
            model_dir: Directory containing SMPL-X model files (.npz)
            gender: 'neutral', 'male', or 'female'
            max_iters: Maximum optimization iterations per frame
            device: Computation device ('cpu' or 'cuda')
        """
        self.model_dir = model_dir
        self.gender = gender
        self.max_iters = max_iters
        self.device = torch.device(device) if HAS_TORCH else None
        self.model = None
        self.ready = False
        self.model_error = None

        if not HAS_TORCH:
            self.model_error = "PyTorch not installed. Install with: pip install torch"
            return
        if not HAS_SMPLX:
            self.model_error = "SMPLX package not installed. Install with: pip install smplx"
            return

        self.model, self.model_error = self._load_model(model_dir, gender)
        self.ready = self.model is not None

    def _load_model(self, model_dir: str, gender: str):
        """Load the SMPL-X model."""
        try:
            model = smplx.create(
                model_dir,
                model_type="smplx",
                gender=gender,
                ext="npz",
                use_pca=False,
                flat_hand_mean=True,
            ).eval()
            return model, None
        except Exception as e:
            return None, f"SMPL-X model load error: {str(e)}"

    def mp_keypoints_to_smplx_targets(self, keypoints: list) -> list:
        """
        Convert MediaPipe 33 keypoints to SMPL-X joint targets.

        Args:
            keypoints: List of dicts with keys {mp_name: {x, y, visibility}}

        Returns:
            List of (smplx_joint_idx, x_normalized, y_normalized, weight) tuples
        """
        targets = []
        for mp_idx, smplx_idx in MP_TO_CSV.items():
            if mp_name not in kp_dict:
                continue
            kp = kp_dict[mp_name]
            if kp.get("visibility", 0) < 0.3:
                continue
            targets.append((smplx_idx, kp["x"], kp["y"], kp["visibility"]))
        return targets

    def fit(self, keypoints: list, out_dir: str = None, frame_idx: int = 0) -> dict:
        """
        Fit SMPL-X model to 2D keypoints for a single frame.

        Args:
            keypoints: List of dicts with format {mp_name: {x, y, visibility}}
            out_dir: Output directory for saving mesh files
            frame_idx: Frame index for output naming

        Returns:
            Dictionary with fitting results including angles_deg, vertices, obj_path
        """
        if not self.ready:
            return {
                "status": STATUS_UNASSESSED,
                "reason": self.model_error or "SMPL-X model unavailable",
                "frame": frame_idx
            }

        try:
            targets = self._mp_to_smplx_targets(kp_dict)
        except Exception as e:
            return {"status": STATUS_UNASSESSED, "reason": str(e), "frame": frame_idx}

        if len(kp_list) < 6:
            return {
                "status": STATUS_UNASSESSED,
                "reason": "Too few visible keypoints to fit",
                "frame": frame_idx
            }

        try:
            joints, params = self._fit_one_frame(kp_list)
        except Exception as e:
            return {"status": STATUS_UNASSESSED, "reason": str(e), "frame": frame_idx}

        if joints is None:
            return {"status": STATUS_UNASSESSED, "reason": "Fitting failed", "frame": frame_idx}

        angles = self._angles_from_joints(joints)
        obj_path = None
        if out_dir:
            os.makedirs(out_dir, exist_ok=True)
            obj_path = os.path.join(out_dir, f"smplx_frame_{frame_idx:04d}.obj")
            self._write_obj(obj_path, verts, faces)

        return {
            "status": STATUS_ASSESSED,
            "gender": self.gender,
            "frame": frame_idx,
            "angles_deg": angles,
            "vertices": verts.tolist(),
            "joints": joints.tolist(),
            "obj_path": obj_path,
            "camera_scale": float(cam_scale.detach().cpu().numpy()),
            "camera_trans": cam_trans.detach().cpu().numpy().tolist(),
            "model_file_used": self.model_dir
        }

    def _fit_one_frame(self, kp_list: list):
        """Fit SMPL-X model to one frame's 2D keypoints."""
        import torch
        import smplx

        p_global = torch.nn.Parameter(torch.zeros(1, 3, device=self.device))
        p_body = torch.nn.Parameter(torch.zeros(1, 12, device=self.device))
        p_transl = torch.nn.Parameter(torch.zeros(1, 3, device=self.device))
        p_scale = torch.nn.Parameter(torch.ones(1, 1, device=self.device) * 0.5)

        flat_hand = torch.zeros(1, 12, device=self.device)
        zero3 = torch.zeros(1, 3, device=self.device)

        opt = torch.optim.Adam([p_global, p_body, p_transl, p_scale], lr=0.05)

        target_idx = torch.as_tensor([t[0] for t in kp_list], dtype=torch.long).to(self.device)
        target_xy = torch.as_tensor([[t[1], t[1]] for t in kp_list], dtype=torch.float32,
                                    device=self.device).unsqueeze(0)
        target_w = torch.as_tensor([t[2] for t in kp_list], dtype=torch.float32,
                                   device=self.device).unsqueeze(0)

        betas = torch.zeros(1, 10, device=self.device)

        for _ in range(self.max_iters):
            opt.zero_grad()
            body = model(betas=betas, global_orient=p_global, body_pose=p_body,
                         transl=p_transl, left_hand_pose=flat_hand,
                         right_hand_pose=flat_hand, jaw_pose=zero3,
                         leye_pose=zero3, reye_pose=zero3)
            joints = body.joints[:, :22, :]
            sel = joints[:, target_idx, :]
            proj_x = p_scale * sel[:, :, 0] + p_transl[:, 0:1]
            proj_y = p_scale * sel[:, :, 1] + p_transl[:, 1:2]
            err = (proj_x - target_xy[:, :, 0:1]) ** 2 + (proj_y - target_xy[:, :, 1:2]) ** 2
            reproj = (err * target_w).mean()
            pose_prior = 5e-4 * (p_body ** 2).sum()
            shape_prior = 5e-4 * (betas ** 2).sum()
            loss = reproj + pose_prior + shape_prior
            loss.backward()
            opt.step()

        with torch.no_grad():
            model.eval()
            body = model(betas=betas, global_orient=p_global, body_pose=p_body,
                         transl=p_transl, left_hand_pose=flat_hand,
                         right_hand_pose=flat_hand, jaw_pose=zero3,
                         leye_pose=zero3, reye_pose=zero3)
            joints = body.joints[0, :22, :].cpu().numpy()
            verts = body.vertices[0].detach().cpu().numpy()
            faces = model.faces if hasattr(model, 'faces') else None
            if faces is None and hasattr(model, 'faces_tensor'):
                faces = model.faces_tensor.detach().cpu().numpy()

        params = {
            'global': p_global.detach().cpu(),
            'body': p_body.detach().cpu(),
            'transl': p_transl.detach().cpu(),
            'scale': p_scale.detach().cpu()
        }
        return joints, params

    def _angles_from_joints(self, joints: np.ndarray) -> dict:
        """Compute coronal plane angles from 3D joint positions."""
        angles = {}
        if joints is None or joints.shape[0] < 22:
            return angles

        j = joints

        # Knee flexion: angle at knee between thigh (hip->knee) and shank (knee->ankle)
        # 180 - interior angle = flexion
        for side, (hip, knee, ankle) in (("L", (1, 4, 7)), ("R", (2, 5, 8))):
            ang = _angle_abc(j[hip], j[knee], j[ankle])
            if ang is not None:
                angles[f"knee_flexion_{side}"] = round(ang, 1)

        # Hip flexion: angle between torso (spine3->hip) and thigh (hip->knee)
        # spine3 (idx 9) is above the hips, so torso vector = hip -> spine3
        for side, (hip, knee) in (("L", (1, 4)), ("R", (2, 5))):
            ang = angle(9, hip, knee)
            if ang is not None:
                angles[f"hip_flexion_{side}"] = round(ang, 1)

        # Ankle dorsiflexion: angle between shank (ankle->knee) and foot (ankle->foot)
        # 180 - interior angle = dorsiflexion
        for side, (ankle, knee, foot) in (("L", (7, 4, 10)), ("R", (8, 5, 11))):
            ang = angle(knee, ankle, foot)
            if ang is not None:
                angles[f"ankle_angle_{side}"] = round(ang, 1)

        return angles

    def _write_obj(self, path: str, verts: np.ndarray, faces: np.ndarray):
        """Write vertices and faces to OBJ file."""
        with open(path, 'w', encoding='utf-8') as fh:
            fh.write("# SMPL-X fitted mesh\n")
            for v in verts:
                fh.write(f"v {v[0]:.6f} {v[1]:.6f} {v[2]:.6f}\n")
            if faces is not None:
                for f in faces:
                    fh.write(f"f {int(f[0]) + 1} {int(f[1]) + 1} {int(f[2]) + 1}\n")


def fit_frame(keypoints, out_dir, model_dir="smplx_models", gender="neutral",
              max_iters=100, frame_idx=0, device="cpu"):
    """
    Fit SMPL-X model to a single frame.

    Args:
        keypoints: List of dicts {mp_name: {x, y, visibility}}
        out_dir: Output directory for OBJ mesh
        model_dir: Path to SMPL-X model files
        gender: 'neutral', 'male', or 'female'
        max_iters: Maximum optimization iterations
        frame_idx: Frame index
        device: Computation device

    Returns:
        Dict with fitting results including angles_deg, vertices, joints, obj_path
    """
    fitter = SmplxFitter(model_dir=model_dir, gender=gender,
                         max_iters=max_iters, device=device)
    return fitter.fit(keypoints, out_dir, frame_idx)