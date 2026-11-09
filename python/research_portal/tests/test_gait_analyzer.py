#!/usr/bin/env python3
"""
Unit Tests for Gait Analyzer Module
Tests core gait analysis functions: joint angles, coronal plane analysis, temporal-spatial metrics.
"""

import sys
import os
sys.path.insert(0, 'E:/brc-website/python')
from core.gait_analyzer import GaitAnalyzer
import numpy as np
import unittest


class TestGaitAnalyzer(unittest.TestCase):
    """Test cases for GaitAnalyzer class."""
    
    def setUp(self):
        """Set up test fixtures before each test method."""
        self.analyzer = GaitAnalyzer()
    
    def test_calculate_3d_angle_right_angle(self):
        """Test angle calculation for 90-degree angle."""
        a = np.array([1.0, 0.0, 0.0])  # Point A
        b = np.array([0.0, 0.0, 0.0])  # Vertex B
        c = np.array([0.0, 1.0, 0.0])  # Point C
        angle = self.analyzer.calculate_3d_angle(a, b, c)
        self.assertAlmostEqual(angle, 90.0, places=5)
    
    def test_calculate_3d_angle_straight_line(self):
        """Test angle calculation for straight line (180 degrees)."""
        a = np.array([1.0, 0.0, 0.0])
        b = np.array([0.0, 0.0, 0.0])
        c = np.array([-1.0, 0.0, 0.0])
        angle = self.analyzer.calculate_3d_angle(a, b, c)
        self.assertAlmostEqual(angle, 180.0, places=5)
    
    def test_calculate_3d_angle_opposite(self):
        """Test angle calculation for 0-degree angle (same direction)."""
        a = np.array([1.0, 0.0, 0.0])
        b = np.array([0.0, 0.0, 0.0])
        c = np.array([1.0, 0.0, 0.0])
        angle = self.analyzer.calculate_3d_angle(a, b, c)
        self.assertAlmostEqual(angle, 0.0, places=5)
    
    def test_calculate_3d_angle_invalid_input(self):
        """Test angle calculation with invalid input (zero vector)."""
        a = np.array([0.0, 0.0, 0.0])
        b = np.array([0.0, 0.0, 0.0])
        c = np.array([1.0, 0.0, 0.0])
        result = self.analyzer.calculate_3d_angle(a, b, c)
        self.assertIsNone(result)
    
    def test_calculate_pelvic_obliquity(self):
        """Test pelvic obliquity calculation."""
        left_hip = np.array([-0.1, 0.0, 0.0])
        right_hip = np.array([0.1, 0.0, 0.0])
        obliquity = self.analyzer.calculate_pelvic_obliquity(left_hip, right_hip)
        self.assertAlmostEqual(obliquity, 90.0, places=5)  # Horizontal line = 90 deg from horizontal axis
    
    def test_calculate_trunk_rotation(self):
        """Test trunk rotation calculation."""
        left_shoulder = np.array([-0.5, 0.0, 0.0])
        right_shoulder = np.array([0.5, 0.0, 0.0])
        left_hip = np.array([-0.3, -0.5, 0.0])
        right_hip = np.array([0.3, -0.5, 0.0])
        rotation = self.analyzer.calculate_trunk_rotation(left_shoulder, right_shoulder, left_hip, right_hip)
        self.assertIsInstance(rotation, float)
        self.assertTrue(-180 <= rotation <= 180)
    
    def test_normalize_gait_cycle(self):
        """Test gait cycle normalization to 0-100%."""
        # Create synthetic gait cycle data
        cycle_data = np.sin(np.linspace(0, 2*np.pi, 50))  # 50 samples
        cycle_start = 0
        cycle_end = len(cycle_data) - 1
        normalized = self.analyzer.normalize_gait_cycle(cycle_data, cycle_start, cycle_end)
        self.assertEqual(len(normalized), 101)  # Should return 101 points (0-100%)
        self.assertTrue(len(normalized) == 101)
    
    def test_detect_gait_events(self):
        """Test gait event detection."""
        # Create synthetic heel position data with clear peaks
        t = np.linspace(0, 2, 200)  # 2 seconds at 100 Hz
        heel_x = np.sin(2 * np.pi * 1.0 * t)  # 1 Hz gait cycle
        pelvis_x = np.zeros_like(heel_x)
        heel_positions = np.column_stack([heel_x, np.zeros_like(heel_x), np.zeros_like(heel_x)])
        pelvis_positions = np.column_stack([pelvis_x, np.zeros_like(pelvis_x), np.zeros_like(pelvis_x)])
        
        events = self.analyzer.detect_gait_events(heel_positions, pelvis_positions, sampling_rate=100.0)
        self.assertIn('initial_contacts', events)
        print(f"Detected {len(events['initial_contacts'])} initial contacts")
    
    def test_calculate_spatio_temporal_metrics(self):
        """Test spatio-temporal metrics calculation."""
        ic_frames = [0, 100, 200]  # 3 gait cycles
        toe_frames = [50, 150]  # Toe-offs between ICs
        sampling_rate = 100.0
        
        metrics = self.analyzer.calculate_spatio_temporal_metrics(ic_frames, toe_frames, sampling_rate)
        self.assertIsInstance(metrics, list)
        self.assertGreater(len(metrics), 0)
        for metric in metrics:
            self.assertIn('cadence', metric)
            print(f"  Cadence: {m.get('cadence', 'N/A')} c/s")


if __name__ == '__main__':
    unittest.main()