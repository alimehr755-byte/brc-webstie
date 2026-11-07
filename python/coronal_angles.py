#!/usr/bin/env python3
"""coronal_angles.py — Custom joint angle computation for the coronal (frontal) plane.

Reads settings/angle_config.json and computes angles from 2D landmark coordinates.
Each angle is defined by:
  - name: angle identifier
  - proximal, joint, distal: landmark labels (or special points like "hip_mid", "shoulder_mid")
  - plane: "frontal" or "sagittal"
  - convention: sign convention for the angle
  - zero_offset: optional offset to apply

Supports both standard landmarks (ear, shoulder, elbow, wrist, hip, knee, ankle, foot, toe)
and derived points (hip_mid, shoulder_mid, ear_mid, ankle_mid).

Usage:
    from coronal_angles import compute_coronal_angles
    angles = compute_coronal_angles(pts, config_path='settings/angle_config.json')
"""

import json
import math
import os

import numpy as np


def _midpoint(p1, p2):
    """Compute midpoint of two (x, y) points."""
    if p1 is None or p2 is None:
        return None
    return ((p1[0] + p2[0]) / 2.0, (p1[1] + p2[1]) / 2.0)


def _angle_abc(a, b, c):
    """Compute angle at point b formed by points a-b-c (in degrees)."""
    if a is None or b is None or c is None:
        return None
    ba = (a[0] - b[0], a[1] - b[1])
    bc = (c[0] - b[0], c[1] - b[1])
    dot = ba[0] * bc[0] + ba[1] * bc[1]
    mag_ba = math.hypot(ba[0], ba[1])
    mag_bc = math.hypot(bc[0], bc[1])
    if mag_ba < 1e-6 or mag_bc < 1e-6:
        return None
    cos_angle = dot / (mag_ba * mag_bc)
    cos_angle = max(-1.0, min(1.0, cos_angle))
    return math.degrees(math.acos(cos_angle))


def _segment_angle_vertical(bottom, top):
    """Angle of segment bottom->top from vertical (degrees)."""
    if bottom is None or top is None:
        return None
    dx = top[0] - bottom[0]
    dy = top[1] - bottom[1]
    if abs(dy) < 1e-6:
        return None
    return math.degrees(math.atan2(dx, -dy))


def _segment_angle_horizontal(left, right):
    """Angle of segment left->right from horizontal (degrees)."""
    if left is None or right is None:
        return None
    dx = right[0] - left[0]
    dy = right[1] - left[1]
    if abs(dx) < 1e-6:
        return None
    return math.degrees(math.atan2(dy, dx))


def _resolve_point(label, pts):
    """Resolve a landmark label to (x, y) coordinates.

    Supports:
    - Standard landmarks: ear, shoulder, elbow, wrist, hip, knee, ankle, foot, toe
    - Derived points: hip_mid, shoulder_mid, ear_mid, ankle_mid
    - Side-specific: left_hip, right_hip, left_knee, right_knee, etc.
    """
    if label is None:
        return None

    label = label.lower().strip()

    # Derived midpoints
    if label == 'hip_mid':
        return _midpoint(pts.get('L', {}).get('hip'), pts.get('R', {}).get('hip'))
    if label == 'shoulder_mid':
        return _midpoint(pts.get('L', {}).get('shoulder'), pts.get('R', {}).get('shoulder'))
    if label == 'ear_mid':
        return _midpoint(pts.get('L', {}).get('ear'), pts.get('R', {}).get('ear'))
    if label == 'ankle_mid':
        return _midpoint(pts.get('L', {}).get('ankle'), pts.get('R', {}).get('ankle'))

    # Side-specific landmarks (e.g., left_hip, right_knee)
    if label.startswith('left_'):
        joint = label[5:]
        return pts.get('L', {}).get(joint)
    if label.startswith('right_'):
        joint = label[6:]
        return pts.get('R', {}).get(joint)

    # Standard landmark (use left side as default, or first available)
    for side in ('L', 'R'):
        if label in pts.get(side, {}):
            return pts[side][label]
    return None


def _apply_convention(angle, convention, zero_offset=0):
    """Apply sign convention and zero offset to an angle."""
    if angle is None:
        return None
    angle = angle + zero_offset
    if convention == 'flexion_positive':
        return angle
    elif convention == 'extension_positive':
        return -angle
    elif convention == 'abduction_positive':
        return angle
    elif convention == 'adduction_positive':
        return -angle
    elif convention == 'valgus_positive':
        return angle
    elif convention == 'varus_positive':
        return -angle
    elif convention == 'eversion_positive':
        return angle
    elif convention == 'inversion_positive':
        return -angle
    elif convention == 'dorsiflexion_positive':
        return angle
    elif convention == 'plantarflexion_positive':
        return -angle
    elif convention == 'right_drop_positive':
        return angle
    elif convention == 'right_lean_positive':
        return angle
    elif convention == 'right_tilt_positive':
        return angle
    elif convention == 'width_positive':
        return angle
    return angle


def compute_coronal_angles(pts, config_path=None):
    """Compute custom coronal plane angles from landmark points.

    Args:
        pts: dict with 'L' and 'R' keys, each containing joint_label -> (x, y) tuples
        config_path: path to angle_config.json (default: settings/angle_config.json)

    Returns:
        dict: {angle_name: angle_value or None}
    """
    if config_path is None:
        config_path = os.path.join('settings', 'angle_config.json')

    if not os.path.exists(config_path):
        return {}

    with open(config_path, 'r', encoding='utf-8') as f:
        config = json.load(f)

    frontal_angles = config.get('frontal', [])
    results = {}

    for angle_def in frontal_angles:
        name = angle_def.get('name')
        proximal = angle_def.get('proximal')
        joint = angle_def.get('joint')
        distal = angle_def.get('distal')
        convention = angle_def.get('convention', 'flexion_positive')
        zero_offset = angle_def.get('zero_offset', 0)

        # Special cases for derived measurements
        if name == 'step_width':
            left = _resolve_point('left_ankle', pts)
            right = _resolve_point('right_ankle', pts)
            if left and right:
                results[name] = _apply_convention(
                    abs(right[0] - left[0]), convention, zero_offset)
            else:
                results[name] = None
            continue

        if name == 'pelvic_obliquity':
            left_hip = _resolve_point('left_hip', pts)
            right_hip = _resolve_point('right_hip', pts)
            if left_hip and right_hip:
                angle = _segment_angle_horizontal(left_hip, right_hip)
                results[name] = _apply_convention(angle, convention, zero_offset)
            else:
                results[name] = None
            continue

        if name == 'trunk_lean':
            hip_mid = _resolve_point('hip_mid', pts)
            shoulder_mid = _resolve_point('shoulder_mid', pts)
            if hip_mid and shoulder_mid:
                angle = _segment_angle_vertical(hip_mid, shoulder_mid)
                results[name] = _apply_convention(angle, convention, zero_offset)
            else:
                results[name] = None
            continue

        if name == 'head_lateral_tilt':
            shoulder_mid = _resolve_point('shoulder_mid', pts)
            ear_mid = _resolve_point('ear_mid', pts)
            if shoulder_mid and ear_mid:
                angle = _segment_angle_vertical(shoulder_mid, ear_mid)
                results[name] = _apply_convention(angle, convention, zero_offset)
            else:
                results[name] = None
            continue

        # General 3-point angle computation
        p_prox = _resolve_point(proximal, pts)
        p_joint = _resolve_point(joint, pts)
        p_dist = _resolve_point(distal, pts)

        if p_prox and p_joint and p_dist:
            angle = _angle_abc(p_prox, p_joint, p_dist)
            results[name] = _apply_convention(angle, convention, zero_offset)
        else:
            results[name] = None

    return results


def compute_all_custom_angles(pts, config_path=None):
    """Compute both sagittal and frontal custom angles from landmark points.

    Args:
        pts: dict with 'L' and 'R' keys, each containing joint_label -> (x, y) tuples
        config_path: path to angle_config.json

    Returns:
        dict: {'sagittal': {...}, 'frontal': {...}}
    """
    if config_path is None:
        config_path = os.path.join('settings', 'angle_config.json')

    if not os.path.exists(config_path):
        return {'sagittal': {}, 'frontal': {}}

    with open(config_path, 'r', encoding='utf-8') as f:
        config = json.load(f)

    # For now, compute frontal angles using compute_coronal_angles
    # Sagittal angles would use a similar approach
    frontal = compute_coronal_angles(pts, config_path)

    return {'sagittal': {}, 'frontal': frontal}


if __name__ == '__main__':
    # Quick test
    test_pts = {
        'L': {'ear': (100, 50), 'shoulder': (100, 100), 'elbow': (120, 130),
              'wrist': (130, 160), 'hip': (100, 200), 'knee': (100, 300),
              'ankle': (100, 400), 'foot': (110, 410), 'toe': (90, 405)},
        'R': {'ear': (200, 50), 'shoulder': (200, 100), 'elbow': (180, 130),
              'wrist': (170, 160), 'hip': (200, 200), 'knee': (200, 300),
              'ankle': (200, 400), 'foot': (190, 410), 'toe': (210, 405)},
    }
    angles = compute_coronal_angles(test_pts)
    print('Computed coronal angles:')
    for name, val in angles.items():
        print(f'  {name}: {val}')
