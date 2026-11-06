"""
Orthopedic Eye — Interactive Streamlit Dashboard UI
Developed by: Muhammad Mehr Ali (Prosthetist & Orthotist)
Filename: app.py
"""

import os
import streamlit as st
import pandas as pd
import numpy as np
from gait_engine import run_gait_analysis

# j.txt — optional SMPL-X hybrid refinement availability probe (graceful). The
# production engine lives in ../python; the folder name contains a space, so we
# load it by path instead of by import name. If anything is missing the app just
# shows "off" and continues on the MediaPipe-only pipeline.
try:
    import importlib.util as _ilu
    import sys as _sys
    _smplx_abs = os.path.abspath(
        os.path.join(os.path.dirname(__file__), "..", "python", "smplx_refine.py"))
    if os.path.isfile(_smplx_abs):
        _spec = _ilu.spec_from_file_location("smplx_refine", _smplx_abs)
        _smplx_refine = _ilu.module_from_spec(_spec)
        _sys.modules.setdefault("smplx_refine", _smplx_refine)
        _spec.loader.exec_module(_smplx_refine)
        _SMPL_STATE, _SMPL_REASON = _smplx_refine.probe()
    else:
        _SMPL_STATE, _SMPL_REASON = "off", "smplx_refine.py not found"
except Exception as _smplx_exc:
    _SMPL_STATE, _SMPL_REASON = "off", "smplx_refine import failed: %s" % _smplx_exc

# --- PAGE CONFIGURATION ---
st.set_page_config(
    page_title="Orthopedic Eye - Gait & Postural Analysis",
    layout="wide",
    initial_sidebar_state="expanded"
)

# --- INLINE CUSTOM UI STYLING ---
st.markdown("""
    <style>
    .reportview-container { background: #f8fafc; }
    .main-header { font-size: 2.2rem; font-weight: 800; color: #0f172a; margin-bottom: 0.2rem; }
    .sub-header { font-size: 1.1rem; color: #64748b; margin-bottom: 2rem; }
    .developer-credit { font-size: 0.9rem; font-weight: 600; color: #0284c7; margin-bottom: 1.5rem; }
    .metric-card { 
        background: white; padding: 1.25rem; border-radius: 12px; 
        box-shadow: 0 1px 3px rgba(0,0,0,0.05); border: 1px solid #e2e8f0; 
    }
    .metric-label { font-size: 0.85rem; font-weight: 700; color: #64748b; text-transform: uppercase; }
    .metric-value { font-size: 1.6rem; font-weight: 800; color: #0f172a; margin-top: 0.25rem; }
    .diagnostic-container { 
        background: #f8fafc; border-left: 5px solid #ef4444; 
        padding: 1rem; border-radius: 4px; font-family: monospace; 
    }
    </style>
""", unsafe_allow_html=True)

# --- HEADER SECTION ---
st.markdown('<div class="main-header">Orthopedic Eye Tool</div>', unsafe_allow_html=True)
st.markdown('<div class="sub-header">Computer Vision Kinematics & Sagittal Gait Diagnostic Workspace</div>', unsafe_allow_html=True)

# --- SIDEBAR CONTROL PANEL ---
with st.sidebar:
    st.header("Control Panel")
    st.caption("SMPL-X hybrid refinement: %s" % ("on" if _SMPL_STATE == "on" else "off"))
    st.markdown("---")
    
    uploaded_file = st.file_uploader(
        "Upload Sagittal Video Video", 
        type=["mp4", "mov", "avi", "mkv"],
        help="Provide a clear, unobstructed lateral view video of the patient walking."
    )
    
    st.markdown("---")
    playback_speed = st.slider(
        "Analysis Playback Speed", 
        min_value=0.25, 
        max_value=2.0, 
        value=1.0, 
        step=0.25,
        help="Adjust to slow down or speed up frame-by-frame analysis calculations."
    )
    
    st.markdown("---")
    st.markdown("**Developer & Clinical Lead:**")
    st.markdown("Muhammad Mehr Ali<br>*Prosthetist & Orthotist*", unsafe_allow_html=True)

# --- WORKSPACE EXECUTION ---
if uploaded_file is not None:
    # Save uploaded file safely to local buffer
    temp_video_path = f"temp_{uploaded_file.name}"
    with open(temp_video_path, "wb") as f:
        f.write(uploaded_file.getbuffer())
        
    st.info("🔄 Processing clinical landmarks and compiling kinematic cycles. Please wait...")
    
    try:
        # Run the full processing engine
        results = run_gait_analysis(temp_video_path, playback_speed, generate_overlay_video=True)
        
        st.success("✅ Kinematic processing complete! Generating clinical layout.")
        
        # --- TAB LAYOUTS ---
        tab1, tab2, tab3 = st.tabs(["📊 Metric Dashboard", "📈 Cycle Distribution Charts", "🎞️ Overlay Video Workspace"])
        
        with tab1:
            st.subheader("Spatio-Temporal & Structural Symmetry Matrix")
            
            # Row 1: Spatio-temporal params
            col1, col2, col3, col4 = st.columns(4)
            with col1:
                st.markdown(f'<div class="metric-card"><div class="metric-label">Calculated Cadence</div><div class="metric-value">{results["cadence"]}</div></div>', unsafe_allow_html=True)
            with col2:
                st.markdown(f'<div class="metric-card"><div class="metric-label">Left Stride Duration</div><div class="metric-value">{results["left_stride"]}</div></div>', unsafe_allow_html=True)
            with col3:
                st.markdown(f'<div class="metric-card"><div class="metric-label">Right Stride Duration</div><div class="metric-value">{results["right_stride"]}</div></div>', unsafe_allow_html=True)
            with col4:
                st.markdown(f'<div class="metric-card"><div class="metric-label">Stride Time Symmetry</div><div class="metric-value">{results["stride_si"]}</div></div>', unsafe_allow_html=True)
            
            st.markdown("<br>", unsafe_allow_html=True)
            
            # Row 2: Range Peak Extremities
            col5, col6, col7, col8 = st.columns(4)
            with col5:
                st.markdown(f'<div class="metric-card"><div class="metric-label">Peak Knee Flexion Symmetry</div><div class="metric-value">{results["knee_flexion_si"]}</div></div>', unsafe_allow_html=True)
            with col6:
                st.markdown(f'<div class="metric-card"><div class="metric-label">Peak Hip Flexion Symmetry</div><div class="metric-value">{results["hip_flexion_si"]}</div></div>', unsafe_allow_html=True)
            with col7:
                st.markdown(f'<div class="metric-card"><div class="metric-label">Dynamic Trunk Lean Range</div><div class="metric-value">{results["trunk_lean_range"]}</div></div>', unsafe_allow_html=True)
            with col8:
                st.markdown(f'<div class="metric-card"><div class="metric-label">Dynamic Head Tilt Range</div><div class="metric-value">{results["head_tilt_range"]}</div></div>', unsafe_allow_html=True)

            st.markdown("<br><hr>", unsafe_allow_html=True)
            
            # Row 3: Comprehensive Joint Extreme Breakdowns
            st.subheader("Joint Angle Extremes Breakdown")
            col_l, col_r = st.columns(2)
            with col_l:
                st.markdown("### 🔵 Left Side Extremes")
                st.write(f"**Hip Joint:** Flexion: {results['rom_extremes']['L']['hip_max']:.1f}° | Extension: {results['rom_extremes']['L']['hip_min']:.1f}°")
                st.write(f"**Knee Joint:** Flexion: {results['rom_extremes']['L']['knee_max']:.1f}° | Extension: {results['rom_extremes']['L']['knee_min']:.1f}°")
                st.write(f"**Ankle Joint:** Dorsiflexion: {max(0, results['rom_extremes']['L']['ankle_max_df']):.1f}° | Plantarflexion: {abs(min(0, results['rom_extremes']['L']['ankle_max_pf'])):.1f}°")
            with col_r:
                st.markdown("### 🟠 Right Side Extremes")
                st.write(f"**Hip Joint:** Flexion: {results['rom_extremes']['R']['hip_max']:.1f}° | Extension: {results['rom_extremes']['R']['hip_min']:.1f}°")
                st.write(f"**Knee Joint:** Flexion: {results['rom_extremes']['R']['knee_max']:.1f}° | Extension: {results['rom_extremes']['R']['knee_min']:.1f}°")
                st.write(f"**Ankle Joint:** Dorsiflexion: {max(0, results['rom_extremes']['R']['ankle_max_df']):.1f}° | Plantarflexion: {abs(min(0, results['rom_extremes']['R']['ankle_max_pf'])):.1f}°")
            
            st.markdown("<br><hr>", unsafe_allow_html=True)
            
            # Diagnostics Log Box
            st.subheader("Automated Clinical Interpretation & Kinematic Deviations")
            if results["diagnostic_text"].strip():
                st.markdown(f'<div class="diagnostic-container">{results["diagnostic_text"].replace("\n", "<br>")}</div>', unsafe_allow_html=True)
            else:
                st.info("No major pathological joint deviations identified during this specific recording sequence.")
                
            # Download full textual analysis summary report file
            if os.path.exists("gait_report.txt"):
                with open("gait_report.txt", "r") as f:
                    report_data = f.read()
                st.download_button(
                    label="📥 Download Clinical Diagnostic Report (.TXT)",
                    data=report_data,
                    file_name="gait_analysis_report.txt",
                    mime="text/plain"
                )

        with tab2:
            st.subheader("Normalized 0–100% Gait Cycle Distributions")
            c1, c2 = st.columns(2)
            with c1:
                if os.path.exists("full_rom_plot.png"):
                    st.image("full_rom_plot.png", caption="Bilateral Sagittal ROM Cycles (Normalized)", use_container_width=True)
            with c2:
                if os.path.exists("gait_cycle_plot.png"):
                    st.image("gait_cycle_plot.png", caption="Postural Lean & Head Axis Drift Tracking", use_container_width=True)
            
            # Export Raw Normalized Curve Values
            st.markdown("### Export Raw Kinematic Data Curve Metrics")
            st.dataframe(results["cycle_df"], use_container_width=True)

        with tab3:
            st.subheader("Diagnostic Visual Overlay Studio")
            col_vid, col_info = st.columns([2, 1])
            with col_vid:
                if os.path.exists(results["overlay_video_path"]):
                    st.video(results["overlay_video_path"])
                else:
                    st.error("Error loading computed overlay presentation file.")
            with col_info:
                st.markdown("""
                **Overlay Guide Indicators:**
                * **Red Circles:** Tracked Link Chain Segment Axes Centers (Shoulder, Neck, Hip, Knee, Ankle Joints).
                * **Cyan Lines:** Continuous Biomechanical Skeletal Link Chain.
                * **Dynamic Labels:** Real-time angular calculations running frame-by-frame adjacent to each joint marker.
                * **Heel Strike Popup:** Red overlay alerts firing automatically when foot-to-hip spatial vector offsets peak.
                """)
                
    except Exception as e:
        st.error(f"An unexpected runtime validation exception surfaced: {e}")
        st.info("Verify your video matches normal visibility benchmarks and contains full-body profiles.")
        
    finally:
        # Safe clean-up unlinking bypass for Windows OS file locks
        if os.path.exists(temp_video_path):
            try:
                os.remove(temp_video_path)
            except PermissionError:
                pass

else:
    # Default Empty Welcome Screen state
    st.info("👋 Welcome to the Orthopedic Eye workspace. To initiate full joint kinematics parsing, select a lateral gait recording file inside the sidebar menu.")