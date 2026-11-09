#!/usr/bin/env python3
"""
Signal Processing Module - Biquad Notch Filter
Implements real-time biquad notch filter for removing power-line interference
and movement artifacts from gait analysis data.
"""

import numpy as np
from typing import List, Tuple, Optional
from dataclasses import dataclass


@dataclass
class FilterCoefficients:
    """Biquad filter coefficients."""
    b0: float
    b1: float
    b2: float
    a1: float
    a2: float


class BiquadNotchFilter:
    """
    Biquad Notch Filter for removing narrowband noise (e.g., power line interference).

    Transfer function:
    H(z) = (b0 + b1*z^-1 + b2*z^-2) / (1 + a1*z^-1 + a2*z^-2)

    Coefficients:
    b0 = 1 / (1 + alpha)
    b1 = -2 * cos(w0) / (1 + alpha)
    b2 = 1 / (1 + alpha)
    a1 = -2 * cos(w0) / (1 + alpha)
    a2 = (1 - alpha) / (1 + alpha)

    where:
    w0 = 2 * pi * f_notch / f_s  (normalized frequency)
    alpha = sin(w0) / (2 * Q)    (bandwidth parameter)
    """

    def __init__(self, notch_freq: float = 50.0, sample_rate: float = 100.0,
                 q_factor: float = 30.0):
        """
        Initialize biquad notch filter.

        Args:
            notch_freq: Notch frequency in Hz (default 50 Hz for power line)
            sample_rate: Sampling frequency in Hz
            q_factor: Quality factor (higher = narrower notch)
        """
        self.notch_freq = notch_freq
        self.sample_rate = sample_rate
        self.q_factor = q_factor
        self.b0, self.b1, self.b2, self.a1, self.a2 = self._compute_coefficients()

        # Filter state (direct form II transposed)
        self.w1 = 0.0
        self.w2 = 0.0

    def _compute_coefficients(self) -> tuple:
        """Compute biquad filter coefficients."""
        w0 = 2.0 * math.pi * self.notch_freq / self.sample_rate
        alpha = math.sin(w0) / (2.0 * self.q_factor)

        cos_w0 = math.cos(w0)

        b0 = 1.0 / (1.0 + alpha)
        b1 = -2.0 * cos_w0 / (1.0 + alpha)
        b2 = 1.0 / (1.0 + alpha)
        a1 = -2.0 * cos_w0 / (1.0 + alpha)
        a2 = (1.0 - alpha) / (1.0 + alpha)

        return b0, b1, b2, a1, a2

    def filter_sample(self, sample: float) -> float:
        """Filter a single sample through the biquad notch filter."""
        w = sample - self.a1 * self.w1 - self.a2 * self.w2
        out = self.b0 * w + self.b1 * self.w1 + self.b2 * self.w2
        self.w2 = self.w1
        self.w1 = w
        return out

    def filter_signal(self, signal: np.ndarray) -> np.ndarray:
        """Filter an entire signal array."""
        output = np.zeros_like(signal)
        for i in range(len(signal)):
            output[i] = self.filter_sample(signal[i])
        return output

    def reset(self):
        """Reset filter state."""
        self.w1 = 0.0
        self.w2 = 0.0


class NotchFilterBank:
    """
    Multiple notch filters for removing multiple frequency bands
    (e.g., 50 Hz and its harmonics).
    """

    def __init__(self, sample_rate: float = 100.0,
                 notch_freqs: List[float] = None):
        """
        Initialize filter bank.

        Args:
            sample_rate: Sampling frequency in Hz
            notch_freqs: List of frequencies to notch (default: [50, 100, 150])
        """
        if notch_freqs is None:
            notch_freqs = [50.0, 100.0, 150.0]

        self.filters = [
            BiquadNotchFilter(freq, sample_rate) for freq in notch_freqs
        ]

    def filter_signal(self, signal: np.ndarray) -> np.ndarray:
        """Filter signal through all notch filters sequentially."""
        signal_filtered = signal.copy()
        for f in self.filters:
            signal_filtered = f.filter_signal(signal_filtered)
        return signal_filtered


class ButterworthLowpass:
    """
    Butterworth lowpass filter for smoothing gait data.
    """

    def __init__(self, cutoff_freq: float = 6.0, sample_rate: float = 100.0,
                 order: int = 4):
        """
        Initialize Butterworth lowpass filter.

        Args:
            cutoff_freq: Cutoff frequency in Hz
            sample_rate: Sampling frequency in Hz
            order: Filter order
        """
        from scipy.signal import butter, filtfilt
        self.cutoff_freq = cutoff_freq
        self.sample_rate = sample_rate
        self.order = order
        self.b, self.a = butter(order, cutoff_freq / (sample_rate / 2), btype='low')

    def filter_signal(self, signal: np.ndarray) -> np.ndarray:
        """Apply zero-phase Butterworth lowpass filter."""
        from scipy.signal import filtfilt
        return filtfilt(self.b, self.a, signal)


class SignalProcessor:
    """
    Main signal processing pipeline for gait analysis.
    Combines notch filtering and lowpass filtering.
    """

    def __init__(self, sample_rate: float = 100.0,
                 notch_freqs: List[float] = None,
                 lowpass_cutoff: float = 6.0,
                 enable_notch: bool = True,
                 enable_lowpass: bool = True):
        """
        Initialize signal processing pipeline.

        Args:
            sample_rate: Sampling frequency in Hz
            notch_freqs: List of notch frequencies (default: [50, 100, 150])
            lowpass_cutoff: Lowpass cutoff frequency in Hz
            enable_notch: Enable notch filtering
            enable_lowpass: Enable lowpass filtering
        """
        self.sample_rate = sample_rate
        self.notch_filter = NotchFilterBank(sample_rate, notch_freqs) if enable_notch else None
        self.lowpass_filter = ButterworthLowpass(cutoff_freq, sample_rate) if enable_lowpass else None

    def filter_signal(self, signal: np.ndarray) -> np.ndarray:
        """Apply all enabled filters to signal."""
        signal_filtered = signal.copy()

        if self.notch_filter is not None:
            signal_filtered = self.notch_filter.filter_signal(signal_filtered)

        if self.lowpass_filter is not None:
            signal_filtered = self.lowpass_filter.filter_signal(signal_filtered)

        return signal_filtered

    def filter_multichannel(self, signals: np.ndarray) -> np.ndarray:
        """Filter multiple signal channels (e.g., x, y, z coordinates).
        
        Args:
            signals: Array of shape (n_samples, n_channels)

        Returns:
            Filtered signals array
        """
        filtered = np.zeros_like(signals)
        for i in range(signals.shape[1]):
            filtered[:, i] = self.filter_signal(signals[:, i])
        return filtered


if __name__ == "__main__":
    # Example usage
    import numpy as np

    # Create test signal with 50 Hz noise
    fs = 100.0
    t = np.linspace(0, 1, fs)
    signal_clean = np.sin(2 * np.pi * 5 * t)  # 5 Hz gait signal
    noise = 0.5 * np.sin(2 * np.pi * 50 * t)  # 50 Hz noise
    signal_noisy = signal_clean + noise

    # Filter
    processor = SignalProcessor(sample_rate=fs)
    filtered = processor.filter_signal(signal_noisy)

    print(f"Original signal RMS: {np.std(signal_noisy):.4f}")
    print(f"Filtered signal RMS: {np.std(filtered):.4f}")
    print(f"Noise reduction: {100 * (1 - np.std(filtered) / np.std(signal_noisy)):.1f}%")