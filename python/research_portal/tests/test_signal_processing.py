#!/usr/bin/env python3
"""
Unit Tests for Signal Processing Module
Tests biquad notch filter and signal processing pipeline.
"""

import sys
sys.path.insert(0, 'E:/brc-website/python')
from signal_processing import BiquadNotchFilter, NotchFilterBank, SignalProcessor
import numpy as np
import unittest


class TestBiquadNotchFilter(unittest.TestCase):
    """Test cases for BiquadNotchFilter class."""
    
    def setUp(self):
        """Set up test fixtures before each test method."""
        self.sample_rate = 100.0
        self.filter = BiquadNotchFilter(notch_freq=50.0, sample_rate=self.sample_rate, q_factor=30.0)
    
    def test_initialization(self):
        """Test filter initialization."""
        self.assertIsNotNone(self.filter)
        self.assertEqual(self.filter.sample_rate, self.sample_rate)
        self.assertEqual(self.filter.notch_freq, 50.0)
    
    def test_filter_single_sample(self):
        """Test filtering a single sample."""
        result = self.filter.filter_sample(1.0)
        self.assertIsInstance(result, float)
        self.assertTrue(np.isfinite(result))
    
    def test_filter_signal(self):
        """Test filtering an entire signal."""
        signal = np.random.randn(1000)  # Random noise
        filtered = self.filter.filter_signal(signal)
        self.assertEqual(len(signal), len(filtered))
        self.assertTrue(np.all(np.isfinite(filtered)))
    
    def test_notch_attenuates_target_frequency(self):
        """Test that notch filter attenuates target frequency."""
        fs = 100.0
        f_notch = 50.0
        t = np.linspace(0, 1, fs)
        signal_noisy = np.sin(2 * np.pi * f_notch * t)  # Pure 50 Hz signal
        
        filter_obj = BiquadNotchFilter(notch_freq=f_notch, sample_rate=fs)
        filtered = filter_obj.filter_signal(signal_noisy)
        
        # The filtered signal should have much lower amplitude
        original_rms = np.sqrt(np.mean(signal_noisy**2))
        filtered_rms = np.sqrt(np.mean(filtered**2))
        
        print(f"Original RMS: {original_rms:.4f}, Filtered RMS: {filtered_rms:.4f}")
        print(f"Reduction: {(1 - filtered_rms/original_rms)*100:.1f}%")
        
        self.assertLess(filtered_rms, original_rms)  # Should reduce amplitude
    
    def test_filter_edge_cases(self):
        """Test filter with edge case inputs."""
        # All zeros
        signal_zeros = np.zeros(100)
        filtered = self.filter.filter_signal(signal_zeros)
        self.assertTrue(np.allclose(filtered, 0))
        
        # Large values
        signal_large = np.ones(100) * 1e6
        filtered = self.filter.filter_signal(signal_large)
        self.assertTrue(np.all(np.isfinite(filtered)))


class TestNotchFilterBank(unittest.TestCase):
    """Test cases for NotchFilterBank class."""
    
    def setUp(self):
        """Set up test fixtures."""
        self.sample_rate = 100.0
        self.filter_bank = NotchFilterBank(sample_rate=self.sample_rate,
                                           notch_freqs=[50.0, 100.0, 150.0])
    
    def test_filter_signal(self):
        """Test filtering through filter bank."""
        signal = np.random.randn(1000)
        filtered = self.filter_bank.filter_signal(signal)
        self.assertEqual(len(signal), len(filtered))
        self.assertTrue(np.all(np.isfinite(filtered)))


class TestSignalProcessor(unittest.TestCase):
    """Test cases for SignalProcessor class."""
    
    def setUp(self):
        """Set up test fixtures."""
        self.sample_rate = 100.0
        self.processor = SignalProcessor(sample_rate=self.sample_rate)
    
    def test_filter_signal(self):
        """Test filtering signal through pipeline."""
        signal = np.random.randn(1000)
        filtered = self.processor.filter_signal(signal)
        self.assertEqual(len(signal), len(filtered))
        self.assertTrue(np.all(np.isfinite(filtered)))
    
    def test_filter_multichannel(self):
        """Test filtering multi-channel signal."""
        signals = np.random.randn(1000, 3)  # 3 channels
        filtered = self.processor.filter_multichannel(signals)
        self.assertEqual(signals.shape, filtered.shape)
        self.assertTrue(np.all(np.isfinite(filtered)))


if __name__ == '__main__':
    unittest.main()