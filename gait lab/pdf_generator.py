"""
Orthopedic Eye - Clinical Report PDF Generation Engine
Filename: pdf_generator.py
"""

import io
from datetime import datetime
from reportlab.lib.pagesizes import letter
from reportlab.lib import colors
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, KeepTogether
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.pdfgen import canvas

class NumberedCanvas(canvas.Canvas):
    """
    Two-pass canvas renderer to dynamically calculate total page count
    and stamp running headers/footers accurately.
    """
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._saved_page_states = []

    def showPage(self):
        self._saved_page_states.append(dict(self.__dict__))
        self._startPage()

    def save(self):
        num_pages = len(self._saved_page_states)
        for state in self._saved_page_states:
            self.__dict__.update(state)
            self.draw_page_decorations(num_pages)
            super().showPage()
        super().save()

    def draw_page_decorations(self, page_count):
        self.saveState()
        self.setFont("Helvetica", 8)
        self.setFillColor(colors.HexColor("#64748B"))
        
        # Draw running header
        self.drawString(54, 750, "ORTHOPEDIC EYE // KINEMATIC ANALYSIS & DIAGNOSTIC REPORT")
        self.setStrokeColor(colors.HexColor("#CBD5E1"))
        self.setLineWidth(0.5)
        self.line(54, 742, letter[0] - 54, 742)
        
        # Draw running footer
        page_str = f"Page {self._pageNumber} of {page_count}"
        self.drawRightString(letter[0] - 54, 40, page_str)
        self.drawString(54, 40, f"Generated on: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')} | Confidential Medical Data")
        self.line(54, 52, letter[0] - 54, 52)
        
        self.restoreState()


def create_clinical_pdf_report(patient_data: dict, diagnostic_results: dict) -> io.BytesIO:
    """
    Generates a production-quality clinical PDF report.
    
    Parameters:
        patient_data (dict): Demographics and basic clinical metrics.
        diagnostic_results (dict): Output dictionary compiled directly from engine.py.
        
    Returns:
        io.BytesIO: In-memory byte buffer containing the generated PDF.
    """
    buffer = io.BytesIO()
    
    # Page setup: Letter size with 0.75 inch (54 points) side margins, customized top/bottom for header/footer clearance
    doc = SimpleDocTemplate(
        buffer,
        pagesize=letter,
        leftMargin=54,
        rightMargin=54,
        topMargin=72,
        bottomMargin=72
    )
    
    styles = getSampleStyleSheet()
    
    # Custom Color Palettes (Clinical Deep Slate Theme)
    primary_color = colors.HexColor("#1E293B")
    secondary_color = colors.HexColor("#0F766E")
    text_color = colors.HexColor("#334155")
    
    # Modified Typographic Hierarchy Styles
    title_style = ParagraphStyle(
        'DocTitle',
        parent=styles['Normal'],
        fontName='Helvetica-Bold',
        fontSize=24,
        leading=28,
        textColor=primary_color,
        spaceAfter=15
    )
    
    h1_style = ParagraphStyle(
        'Heading1_Custom',
        parent=styles['Normal'],
        fontName='Helvetica-Bold',
        fontSize=14,
        leading=18,
        textColor=secondary_color,
        spaceBefore=12,
        spaceAfter=6,
        keepWithNext=True
    )
    
    body_style = ParagraphStyle(
        'BodyText_Custom',
        parent=styles['Normal'],
        fontName='Helvetica',
        fontSize=10,
        leading=14,
        textColor=text_color,
        spaceAfter=6
    )
    
    table_text_style = ParagraphStyle(
        'TableText',
        parent=styles['Normal'],
        fontName='Helvetica',
        fontSize=9,
        leading=12,
        textColor=text_color
    )
    
    table_header_style = ParagraphStyle(
        'TableHeader',
        parent=styles['Normal'],
        fontName='Helvetica-Bold',
        fontSize=9,
        leading=12,
        textColor=colors.white
    )

    story = []
    
    # 1. Document Header
    story.append(Paragraph("Clinical Gait Assessment Summary", title_style))
    story.append(Paragraph("Automated Quantified Motion Analysis and Biomechanical Prescription Record.", body_style))
    story.append(Spacer(1, 15))
    
    # 2. Patient Profile & Metrics Matrix
    story.append(Paragraph("Patient Profile & Intake Parameters", h1_style))
    
    profile_data = [
        [Paragraph("Parameter", table_header_style), Paragraph("Value / Assessment Reference", table_header_style),
         Paragraph("Parameter", table_header_style), Paragraph("Value / Assessment Reference", table_header_style)],
        [Paragraph("Patient Name:", table_text_style), Paragraph(str(patient_data.get('name', 'N/A')), table_text_style),
         Paragraph("Scoliometer ATR:", table_text_style), Paragraph(f"{patient_data.get('scoliometer_angle', 0.0)}°", table_text_style)],
        [Paragraph("Medical ID:", table_text_style), Paragraph(str(patient_data.get('patient_id', 'N/A')), table_text_style),
         Paragraph("Staheli Arch Index:", table_text_style), Paragraph(str(patient_data.get('arch_index', 0.25)), table_text_style)],
        [Paragraph("Age / Gender:", table_text_style), Paragraph(f"{patient_data.get('age', 'N/A')} / {patient_data.get('gender', 'N/A')}", table_text_style),
         Paragraph("Leg Length Disc.:", table_text_style), Paragraph(f"{patient_data.get('leg_length_discrepancy_cm', 0.0)} cm", table_text_style)]
    ]
    
    # Total printable width is 8.5 inches - (2 * 0.75 margin) = 7.0 inches (504 points)
    profile_table = Table(profile_data, colWidths=[114, 138, 114, 138])
    profile_table.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (3, 0), secondary_color),
        ('ALIGN', (0, 0), (-1, -1), 'LEFT'),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('GRID', (0, 0), (-1, -1), 0.5, colors.HexColor("#E2E8F0")),
        ('TOPPADDING', (0, 0), (-1, -1), 6),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
        ('LEFTPADDING', (0, 0), (-1, -1), 8),
        ('RIGHTPADDING', (0, 0), (-1, -1), 8),
    ]))
    story.append(profile_table)
    story.append(Spacer(1, 15))
    
    # 3. Kinematic Feature Extractions
    story.append(Paragraph("Computer-Vision Extracted Kinematic Features", h1_style))
    features = diagnostic_results.get("extracted_features", {})
    
    features_data = [
        [Paragraph("Biomechanical Metric Evaluated", table_header_style), Paragraph("Calculated Frame Value", table_header_style)],
        [Paragraph("Measured Sagittal Knee Range of Motion (ROM)", table_text_style), Paragraph(f"{features.get('measured_knee_rom', 0.0)}°", table_text_style)],
        [Paragraph("Measured Sagittal Ankle Range of Motion (ROM)", table_text_style), Paragraph(f"{features.get('measured_ankle_rom', 0.0)}°", table_text_style)],
        [Paragraph("Average Stance Phase Knee Flexion Angle", table_text_style), Paragraph(f"{features.get('average_stance_knee_flexion', 0.0)}°", table_text_style)],
        [Paragraph("Peak Measured Extension Alignment (Minimum Flexion)", table_text_style), Paragraph(f"{features.get('peak_extension_angle', 0.0)}°", table_text_style)]
    ]
    
    features_table = Table(features_data, colWidths=[334, 170])
    features_table.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (1, 0), primary_color),
        ('GRID', (0, 0), (-1, -1), 0.5, colors.HexColor("#E2E8F0")),
        ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, colors.HexColor("#F8FAFC")]),
        ('TOPPADDING', (0, 0), (-1, -1), 5),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 5),
        ('LEFTPADDING', (0, 0), (-1, -1), 8),
    ]))
    story.append(features_table)
    story.append(Spacer(1, 15))
    
    # 4. Diagnostics & Prescription Action Plan
    summary = diagnostic_results.get("diagnostic_summary", {})
    severity = summary.get("primary_severity", "Normal")
    
    # Dynamic severity coloring
    severity_colors = {"Normal": "#10B981", "Mild": "#F59E0B", "Moderate": "#F97316", "Severe": "#EF4444"}
    sev_color = severity_colors.get(severity, "#334155")
    
    severity_style = ParagraphStyle(
        'SevStyle',
        parent=body_style,
        fontName='Helvetica-Bold',
        textColor=colors.HexColor(sev_color)
    )
    
    diag_elements = [
        Paragraph("Diagnostic Assessment & Action Plan", h1_style),
        Paragraph(f"Overall Triaged Severity Classification: Dynamic Framework Trigger -> <b>{severity}</b>", severity_style),
        Spacer(1, 6),
        Paragraph("Identified Biomechanical Pathologies / Structural Abnormalities:", ParagraphStyle('Sub', parent=body_style, fontName='Helvetica-Bold')),
    ]
    
    for pathology in summary.get("detected_pathologies", []):
        diag_elements.append(Paragraph(f"• {pathology}", body_style))
        
    diag_elements.append(Spacer(1, 6))
    diag_elements.append(Paragraph("Targeted Orthotic Intervention & Clinical Pathway Plan:", ParagraphStyle('Sub2', parent=body_style, fontName='Helvetica-Bold')))
    
    for recommendation in summary.get("clinical_action_plan", []):
        diag_elements.append(Paragraph(f"• {recommendation}", body_style))
        
    story.append(KeepTogether(diag_elements))
    
    # Build document via custom pass canvas pattern
    doc.build(story, canvasmaker=NumberedCanvas)
    buffer.seek(0)
    return buffer