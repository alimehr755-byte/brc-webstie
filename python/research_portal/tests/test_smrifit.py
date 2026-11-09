#!/usr/bin/env python3
"""
Unit Tests for SMPL-X Fitting Module
Tests SMPL-X body model fitting accuracy against gait lab data.
"""

import sys
sys.path.insert(0, 'E:/brc-website/python')
from smplx_fit import SmplxFitter, STATUS_ASSESSED
import numpy as np
import unittest


class TestSMPLXFitter(unittest.TestCase):
    """Test cases for SMPLXFitter class."""
    
    def setUp(self):
        """Set up test fixtures before each test method."""
        self.fitter = SmplxFitter(model_dir='E:/brc-website/gait lab/models/smplx',
                                   gender='neutral', max_iters=50, device='cpu')
    
    def test_fitter_initialization(self):
        """Test that fitter initializes correctly."""
        self.assertTrue(self.fitter.ready)
        self.assertEqual(self.fitter.gender, 'neutral')
    
    def test_fit_valid_keypoints(self):
        """Test fitting with valid 33 keypoints."""
        keypoints = self._create_test_keypoints()
        result = fitter.fit(kp_list, out_dir=None, frame_idx=0)
        self.assertEqual(result['status'], STATUS_ASSESSED)
        self.assertIn('angles_deg', result)
    
    def test_fit_invalid_keypoints(self):
        """Test fitting with invalid keypoints."""
        keypoints_list = [{"x": 0.0, "y": 0.0, "visibility": 0.0}] * 33  # All zero visibility
        kp_list = keypoints_dict_to_list(kp_dict)
        fit = fitter.fit(kp_list, out_dir=None, frame_idx=0)
        # Should return unassessed for low visibility
        self.assertEqual(fit['status'], STATUS_UNASSESSED)
    
    def test_angle_values_reasonable(self):
        """Test that fitted angles are within reasonable anatomical ranges."""
        keypoints_list = create_test_keypoints()
        kp_list = keypoints_dict_to_list(kp_dict)
        fit = fitter.fit(kp_list, out_dir=None, frame_idx=0)
        angles = fit.get('angles_deg', {})
        
        for ang_name, val in angles.items():
            if val is not None:
                self.assertGreaterEqual(val, 0)
                self.assertLessEqual(val, 180)  # Angles should be 0-180 degrees
    
    def test_fitting_consistency(self):
        """Test that fitting produces consistent results across frames."""
        keypoints_list = create_test_keypoints()
        kp_list = keypoints_dict_to_list(kp_dict)
        
        results = []
        for i in range(5):
            fit = fitter.fit(kp_list, out_dir=None, frame_idx=i)
            if fit['status'] == STATUS_ASSESSED:
                results.append(fit.get('angles_deg', {}))
        
        if len(results) > 1:
            # Check that results are similar across frames (consistency check)
            knee_vals = [r.get('knee_flexion_L', 0) for r in results]
            print(f"Knee flexion values across frames: {[round(v, 2) for v in knee_vals]}")
            self.assertTrue(len(err_vals) > 0)  # At least some valid results


if __name__ == '__main__':
    unittest.main()