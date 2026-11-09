#!/usr/bin/env python3
"""
Gait Event Detection Module
==========================
Detects Initial Contact (IC) and Toe-Off (TO) events from kinematic data
using kinematic marker positions and velocities relative to the pelvis.

Based on t2.txt specification:
- Initial Contact: Occurs when heel marker reaches maximum anterior position
  relative to pelvis, or at local minimum of vertical velocity before weight acceptance.
- Toe-Off: Occurs when toe marker reaches maximum posterior position relative
  to pelvis, or during peak upward vertical velocity as foot leaves floor.
"""

import numpy as np
from typing import List, Tuple, Dict, Optional
from dataclasses import dataclass
from scipy.signal import find_peaks, butter, filtfilt


@dataclass
class GaitEvent:
    """Represents a detected gait event."""
    event_type: str  # 'initial_contact' or 'toe_off'
    frame_index: int
    time_seconds: float
    confidence: float


class GaitEventDetector:
    """
    Detects gait events (Initial Contact and Toe-Off) from kinematic marker data.

    Uses relative marker positions from pelvis to detect:
    - Initial Contact: Local maximum of heel anterior position relative to pelvis
    - Toe-Off: Local minimum of toe posterior position relative to pelvis
    """

    def __init__(self, sample_rate: float = 100.0):
        """
        Initialize the gait event detector.

        Args:
            sample_rate: Sampling frequency in Hz
        """
        self.sample_rate = sample_rate
        self.min_gap_frames = int(0.6 * sample_rate)  # Minimum 600ms between events

    def detect_events(self, heel_positions: np.ndarray,
                      toe_positions: np.ndarray,
                      pelvis_positions: np.ndarray) -> dict:
        """
        Detect gait events from marker position data.

        Args:
            heel_positions: Nx3 array of heel marker coordinates [X, Y, Z]
            toe_positions: Nx3 array of toe marker coordinates [X, Y, Z]
            pelvis_positions: Nx3 array of pelvis marker coordinates [X, Y, Z]

        Returns:
            Dictionary with lists of frame indices for IC and TO
        """
        # Compute anterior-posterior position relative to pelvis
        heel_rel_x = heel_positions[:, 0] - pelvis_positions[:, 0]
        toe_rel_x = toe_positions[:, 0] - pelvis_positions[:, 0]

        # Smooth signals to remove high-frequency marker jitter
        heel_smooth = self._butterworth_lowpass(heel_rel_x, cutoff=6.0)
        toe_smooth = savgol_filter(toe_rel_x, window_length=5, polyorder=2)

        # Initial Contact: Local maxima of heel relative anterior position
        ic_indices, _ = find_peaks(heel_smooth,
                                   distance=int(0.6 * self.sample_rate),
                                   prominence=np.std(heel_smooth) * 0.4)

        # Toe-Off: Local minima of toe relative position (maximum posterior)
        # Invert signal to find minima using find_peaks
        toe_inverted = -toe_smooth
        toe_indices, _ = find_peaks(toe_inverted,
                                    distance=int(0.6 * self.sample_rate),
                                    prominence=np.std(toe_smooth) * 0.4)

        return {
            'initial_contacts': ic_indices.tolist(),
            'toe_offs': toe_indices.tolist()
        }

    def _butterworth_lowpass(self, signal: np.ndarray, cutoff: float = 6.0) -> np.ndarray:
        """Apply Butterworth lowpass filter."""
        from scipy.signal import butter, filtfilt
        nyquist = self.sample_rate / 2.0
        normalized_cutoff = cutoff / nyquist
        b, a = butter(4, normalized_cutoff, btype='low')
        return filtfilt(b, a, signal)

    def detect_events_from_timeseries(self,
                                      gait_cycle_data: np.ndarray,
                                      sample_rate: float = 100.0) -> dict:
        """
        Detect gait events from pre-computed gait cycle data.

        Args:
            gait_cycle_data: Nx3 array with heel positions
            sample_rate: Sampling frequency in Hz

        Returns:
            Dictionary with IC and TO event indices
        """
        return self.detect_events(gait_cycle_data,
                                  gait_cycle_data,  # Use same for toe
                                  np.zeros_like(gait_cycle_data))  # Pelvis at origin


class GaitEventAnalyzer:
    """
    Higher-level gait event analysis with temporal-spatial metrics computation.
    """

    def __init__(self, sample_rate: float = 100.0):
        self.detector = GaitEventDetector(sample_rate)

    def detect_events(self, heel_positions: np.ndarray,
                      toe_positions: np.ndarray,
                      pelvis_positions: np.ndarray) -> dict:
        """Detect gait events."""
        return self.detector.detect_events(heel_positions, toe_positions, pelvis_positions)

    def compute_temporal_spatial_metrics(self,
                                         ic_frames: List[int],
                                         toe_frames: List[int],
                                         sampling_rate: float) -> dict:
        """
        Compute temporal-spatial gait metrics from IC and TO events.

        Args:
            ic_frames: List of Initial Contact frame indices
            toe_frames: List of Toe-Off frame indices
            sampling_rate: Sampling rate in Hz

        Returns:
            Dictionary with gait cycle metrics per stride
        """
        results = []

        for i in range(len(ic_frames) - 1):
            ic1 = ic_frames[i]
            ic2 = ic_frames[i + 1]

            # Find corresponding toe-off between IC1 and IC2
            valid_to = [t for t in toe_frames if ic1 < t < ic_frames[i + 1]]
            if not valid_to:
                continue

            to = valid_to[0]

            # Temporal calculations
            cycle_time = (ic2 - ic1) / sampling_rate
            stance_time = (to - ic1) / sampling_rate
            swing_time = (ic2 - to) / sampling_rate

            stance_pct = (t_stance / t_cycle) * 100
            swing_pct = (t_swing / t_cycle) * 100

            results.append({
                'cycle_time_s': t_cycle,
                'stance_time_s': t_stance,
                'swing_time_s': t_swing,
                'stance_pct': stance_pct,
                'swing_pct': swing_pct,
                'cadence': 60 / t_cycle if t_cycle > 0 else 0
            })

        return results

    def compute_stride_parameters(self,
                                  heel_coords: np.ndarray,
                                  ic_frames: List[int],
                                  toe_frames: List[int],
                                  sample_rate: float) -> dict:
        """
        Compute spatial parameters (stride and step length).

        Args:
            heel_coords: Nx3 array of heel marker coordinates
            ic_frames: List of Initial Contact frame indices
            toe_frames: List of Toe-Off frame indices
            sample_rate: Sampling frequency in Hz

        Returns:
            Dictionary with stride and step length metrics
        """
        metrics = []

        for i in range(len(ic_frames) - 1):
            ic1 = ic_frames[i]
            ic2 = ic_frames[i + 1]

            # Find corresponding toe-off
            valid_to = [t for t in toe_frames if ic1 < t < ic_frames[i + 1]]
            if not valid_to:
                continue

            to = valid_to[0]

            # Temporal calculations
            t_cycle = (ic2 - ic1) / sampling_rate
            t_stance = (to - ic1) / sampling_rate
            t_swing = (ic2 - to) / sampling_rate

            # Spatial calculation - stride length along forward progression axis (X)
            stride_length = abs(heel_coords[ic2, 0] - heel_coords[ic1, 0])

            results.append({
                'cycle_time_s': t_cycle,
                'stance_time_s': t_stance,
                'swing_time_s': t_swing,
                'stance_pct': (t_stance / t_cycle) * 100,
                'swing_pct': (t_swing / t_cycle) * 100,
                'stride_length': stride_length,
                'cadence': 60 / t_cycle if t_cycle > 0 else 0
            })

        return results


if __name__ == "__main__":
    # Example usage
    import numpy as np

    # Simulate gait data
    n_frames = 300
    sampling_rate = 100.0
    t = np.arange(n_frames) / sampling_rate

    # Simulate heel position with periodic pattern
    heel_x = 0.5 * np.sin(2 * np.pi * 1.0 * t) + np.random.normal(0, 0.01, n_frames)
    heel_y = np.zeros(n_frames)
    heel_z = np.zeros(n_frames)
    heel_positions = np.column_stack([heel_x, heel_y, heel_z])

    # Toe position (slightly different phase)
    toe_x = 0.5 * np.sin(2 * np.pi * 1.0 * t + 0.5) + np.random.normal(0, 0.01, n_frames)
    toe_y = np.zeros(n_frames)
    toe_z = np.zeros(n_frames)
    toe_positions = np.column_stack([toe_x, toe_y, toe_z])

    # Pelvis position (relatively stable)
    pelvis_x = np.zeros(n_frames)
    pelvis_y = np.zeros(n_frames)
    pelvis_z = np.zeros(n_frames)
    pelvis_positions = np.column_stack([pelvis_x, pelvis_y, pelvis_z])

    detector = GaitEventDetector(sample_rate=sampling_rate)
    events = detector.detect_events(heel_positions, toe_positions, pelvis_positions)

    print(f"Detected {len(events['initial_contacts'])} Initial Contacts")
    print(f"Detected {len(events['toe_offs'])} Toe-Offs")

    # Compute spatio-temporal metrics
    analyzer = GaitEventAnalyzer(sample_rate=sampling_rate)
    metrics = analyzer.compute_temporal_spatial_metrics(
        events['initial_contacts'], events['toe_offs'], sampling_rate)

    print(f"\nTemporal-Spatial Metrics:")
    for i, m in enumerate(metrics[:5]):  # Show first 5 cycles
        print(f"  Cycle {i+1}: N={m['cadence']:.1f} c/s, Stance={m['stance_pct']:.1f}%, "
              f"Swing={m['swing_pct']:.1f}%")