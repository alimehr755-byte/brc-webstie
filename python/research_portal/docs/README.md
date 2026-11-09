# BRC Gait Lab - Research Portal Documentation

## Overview

The BRC Gait Lab Research Portal is a professional clinical analytics dashboard for gait analysis research. It enables clinicians and researchers to analyze gait patterns across populations, compare deformities, and export research data for further analysis.

## Table of Contents

1. [System Overview](#system-overview)
2. [Architecture](#architecture)
3. [Installation & Setup](#installation--setup)
4. [Usage Guide](#usage-guide)
5. [API Reference](#api-reference)
6. [Data Formats](#data-formats)
7. [Development](#development)
8. [Testing](#testing)
9. [Deployment](#deployment)
10. [Troubleshooting](#troubleshooting)

---

## System Overview

The Research Portal is a web-based dashboard that allows clinicians and researchers to:

- Analyze gait patterns across multiple patient populations
- Compare deformities between different patient groups
- Visualize coronal plane angles over the gait cycle
- Export research data for statistical analysis
- Generate professional research reports

### Key Features

- **Population Filtering**: Filter patients by diagnosis, gender, GMFCS level, and age range
- **Multi-Plane Waveforms**: View knee flexion, hip flexion, and ankle angle curves across the gait cycle
- **Group Comparison**: Compare two patient populations with statistical analysis (Cohen's d, p-values)
- **Export Options**: Export data as CSV, JSON, or PDF reports
- **Normative References**: View normative band comparisons for each measurement

---

## Architecture

### System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Frontend Layer                        │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │                    Research Portal UI                    │ │
│  │  (HTML/CSS/JavaScript - Responsive Design)              │ │
│  └─────────────────────────────────────────────────────────┘ │
│                           ↓ HTTP/JSON                        │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │                      Backend Layer                        │ │
│  │  ┌───────────────────────────────────────────────────┐  │ │
│  │  │              Flask Application                    │  │ │
│  │  │  - Research Portal Routes                        │  │ │
│  │  │  - Data Processing                               │  │ │
│  │  │  - File Export (CSV, JSON, PDF)                  │  │ │
│  │  └───────────────────────────────────────────────────┘  │ │
│                           ↓                                 │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │                    Data Layer                            │ │
│  │  ┌───────────────────────────────────────────────────┐  │ │
│  │  │              Gait Lab Database                    │  │ │
│  │  │  - Gait Sessions                                  │  │ │
│  │  │  - User Information                               │  │ │
│  │  │  - Research Data                                  │  │ │
│  │  └───────────────────────────────────────────────────┘  │ │
│  └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

### Technology Stack

| Component | Technology | Version |
|-----------|------------|---------|
| Frontend | HTML5, CSS3, JavaScript (ES6+) | - |
| Backend | Flask (Python) | 2.0+ |
| Data Processing | NumPy | 1.21+ |
| Data Analysis | Pandas | 1.3+ |
| Data Visualization | Plotly | 5.0+ |
| PDF Generation | ReportLab | 3.5+ |
| CORS Support | Flask-CORS | 3.0.10 |

---

## Installation & Setup

### Prerequisites

- Python 3.8 or higher
- pip (Python package installer)
- Web browser (Chrome, Firefox, Safari, or Edge)

### Installation Steps

1. **Clone the repository**
   ```bash
   git clone https://github.com/your-org/brc-gait-lab.git
   cd brc-gait-lab/python/research_portal
   ```

2. **Install dependencies**
   ```bash
   pip install -r requirements.txt
   ```

3. **Configure the application**
   - Edit `config.yaml` with your settings
   - Ensure the SMPL-X model files are in `gait_lab/models/smplx/`

4. **Run the application**
   ```bash
   python -m research_portal.app
   ```

5. **Access the portal**
   - Open your browser and navigate to `http://localhost:5000`

---

## Usage Guide

### Accessing the Research Portal

1. Navigate to the BRC Gait Lab application
2. Click on the "Research Portal" button in the sidebar
3. The research portal will open in a new browser tab

### Filtering Populations

1. Select a population (diagnosis) from the dropdown
2. Select gender (Male, Female, All)
3. Select GMFCS level (for CP patients)
4. Set age range (optional)
5. Click "Apply Filters" to update the dashboard

### Viewing Multi-Plane Waveforms

1. Select the plane of motion (Sagittal, Coronal/Frontal, Transverse)
2. Select the joint target (Knee, Hip, Ankle, Pelvis, Spine)
3. Select the side (Left, Right, Both)
4. View the waveform chart showing mean angles across the gait cycle
5. Toggle "Show normative reference range" to view normative bands

### Comparing Groups

1. Select Group 1 and Group 2 from the dropdowns
2. Select the metric to compare
3. Click "Compare" to view results
4. Review Cohen's d effect size and p-value

### Exporting Data

1. **CSV Export**: Click "Download CSV" to download raw data
2. **JSON Export**: Click "Download JSON" to export raw JSON data
3. **PDF Report**: Click "Download PDF" to generate a PDF research report

---

## API Reference

### Base URL

```
http://localhost:5000/api/gait/research/
```

### Endpoints

#### GET /research/populations

Get population counts by diagnosis.

**Parameters:**
- `gender` (optional): Filter by gender (male, female, all)
- `gmfcs_level` (optional): Filter by GMFCS level
- `age_min`: Filter by minimum age
- `age_max`: Filter by maximum age

**Response:**
```json
{
  "populations": [
    {
      "diagnosis": "Cerebral palsy",
      "session_count": 2
    }
  ],
  "total": 4
}
```

#### GET /research/coronal

Get coronal plane metrics by population.

**Parameters:**
- `population` (optional): Filter by diagnosis
- `gender`: Filter by gender
- `gmfcs_level`: Filter by GMFCS level
- `age_min`: Minimum age
- `age_max`: Maximum age

**Response:**
```json
{
  "sessions": [...],
  "summary": [
    {
      "diagnosis": "Cerebral palsy",
      "session_count": 2,
      "metrics": {
        "pelvic_obliquity_mean": {
          "mean": 5.2,
          "sd": 2.1,
          "n": 2
        }
      }
    }
  ],
  "total": 4
}
```

#### GET /research/compare

Compare two groups with statistical analysis.

**Parameters:**
- `pop1`: Group 1 diagnosis
- `pop2`: Group 2 diagnosis
- `metric`: Metric to compare
- `gender`: Filter by gender
- `gmfcs_level`: Filter by GMFCS level
- `age_min`: Minimum age
- `age_max`: Maximum age

**Response:**
```json
{
  "metric": "knee_flexion_L",
  "pop1": {
    "diagnosis": "Cerebral palsy",
    "n": 2,
    "mean": 99.1,
    "sd": 5.2,
    "values": [98.5, 100.3]
  },
  "pop2": {
    "diagnosis": "Healthy control",
    "n": 3,
    "mean": 110.5,
    "sd": 8.4,
    "values": [105.2, 112.1, 113.2]
  },
  "cohens_d": 1.45,
  "effect_size": "large",
  "welch_t": -3.45,
  "welch_df": 4.5,
  "welch_p": 0.023,
  "mean_diff_ci": [-12.5, -2.3],
  "significant": true
}
```

#### GET /research/waveforms

Get multi-plane gait cycle waveforms.

**Parameters:**
- `joint`: Joint target (knee, hip, ankle, pelvis, spine)
- `plane`: Plane of motion (sagittal, coronal/frontal, transverse)
- `side`: Side (L, R, B)
- `population`: Filter by diagnosis
- `gender`: Filter by gender
- `gmfcs_level`: Filter by GMFCS level
- `age_min`: Minimum age
- `age_max`: Maximum age

**Response:**
```json
{
  "joint": "knee",
  "plane": "sagittal",
  "side": "L",
  "samples": 120,
  "phases": [
    {
      "code": "initial_contact",
      "name": "Initial Contact / Heel Strike",
      "start_pct": 0,
      "end_pct": 2
    }
  ],
  "populations": [
    {
      "diagnosis": "Cerebral palsy",
      "n": 2,
      "samples": 120,
      "means": [10.1, 12.3, 15.2, ...],
      "sds": [2.1, 2.3, 3.1, ...]
    }
  ]
}
```

#### GET /research/normative

Get age/sex-stratified normative bands.

**Parameters:**
- `joint`: Joint name
- `plane`: Plane of motion
- `side`: Side (L, R)
- `age`: Patient age
- `sex`: Gender

**Response:**
```json
{
  "populations": [
    {
      "joint": "knee_flexion",
      "plane": "sagittal",
      "side": "L",
      "metric": "knee_flexion_mean",
      "p5": 30.0,
      "p50": 60.0,
      "p95": 90.0,
      "source": "representative"
    }
  ]
}
```

#### GET /research/progression

Get per-patient longitudinal trends.

**Parameters:**
- `diagnosis`: Filter by diagnosis
- `gender`: Filter by gender
- `gmfcs_level`: Filter by GMFCS level
- `age_min`: Minimum age
- `age_max`: Maximum age
- `metric`: Metric to analyze

**Response:**
```json
{
  "metric": "cadence",
  "populations": [
    {
      "diagnosis": "Cerebral palsy",
      "session_count": 2,
      "sessions": [
        {
          "session_id": 13,
          "created_at": "2026-09-08 10:49:15",
          "cadence": 0.886
        }
      ]
    }
  ]
}
```

#### GET /research/export

Export research data to CSV.

**Parameters:**
- `population`: Filter by diagnosis
- `gender`: Filter by gender
- `gmfcs_level`: Filter by GMFCS level
- `age_min`: Minimum age
- `age_max`: Maximum age

**Response:** CSV file download

#### GET /research/export.json

Export research data as JSON.

**Parameters:** Same as CSV export

**Response:** JSON file download

#### GET /research/export.pdf

Export research data as PDF report.

**Parameters:** Same as CSV export

**Response:** PDF file download

---

## Data Formats

### Gait Sessions

| Field | Type | Description |
|-------|------|-------------|
| id | integer | Session ID |
| user_id | integer | User ID |
| diagnosis | string | Patient diagnosis |
| gmfcs_level | string | GMFCS level (I-V) |
| age_years | float | Patient age in years |
| gender | string | Patient gender |
| body_mass_kg | float | Patient body mass in kg |
| height_cm | float | Patient height in cm |
| clinician_name | string | Assessing clinician |
| created_at | datetime | Session creation date |
| results | JSON | Gait analysis results |

### Research Data

| Field | Type | Description |
|-------|------|-------------|
| session_id | integer | Session ID |
| patient | string | Patient name |
| diagnosis | string | Patient diagnosis |
| gmfcs_level | string | GMFCS level |
| age_years | float | Patient age |
| gender | string | Patient gender |
| created_at | datetime | Session date |
| cycle | JSON | Gait cycle data |
| cv3d | JSON | Coronal plane data |
| deformities | JSON | Detected deformities |
| metrics | JSON | Coronal plane metrics |

---

## Development

### Project Structure

```
public/research_portal/
├── index.html          # Main HTML page
├── styles.css          # CSS styles
└── script.js           # JavaScript logic

public/js/research_portal.js
├── Core research portal logic

routes/gait.js
├── Backend API endpoints

python/research_portal/
├── core/
│   ├── gait_analyzer.py    # Core gait analysis
│   └── smplx_fit.py        # SMPL-X fitting
├── analysis/
│   └── anomaly_detection.py # Anomaly detection
├── requirements.txt        # Python dependencies
└── config.yaml             # Configuration
```

### Adding New Features

1. Create a new module in the appropriate directory
2. Add routes in `routes/gait.js`
3. Create UI components in `public/research_portal.html`
4. Add JavaScript logic in `public/js/research_portal.js`
5. Update `requirements.txt` if new dependencies are needed
6. Update `config.yaml` if new configuration is needed

---

## Testing

### Unit Tests

Run unit tests for individual modules:

```bash
python -m pytest tests/
```

### Integration Tests

Test end-to-end workflows:

```bash
python -m pytest tests/integration/
```

### Manual Testing

1. Start the application: `python app.py`
2. Navigate to `http://localhost:5000`
3. Click "Research Portal"
4. Test all features:
   - Population filtering
   - Waveform visualization
   - Group comparison
   - Data export

---

## Deployment

### Development

```bash
python app.py
# Access at http://localhost:5000
```

### Production

1. Use a production WSGI server (Gunicorn):
   ```bash
   gunicorn -w 4 -b 0.0.0.0:5000 app:app
   ```

2. Set up a reverse proxy (Nginx):
   ```nginx
   server {
       listen 80;
       server_name your-domain.com;
       
       location / {
           proxy_pass http://127.0.0.1:5000;
           proxy_set_header Host $host;
           proxy_set_header X-Real-IP $remote_addr;
       }
   }
   ```

3. Set up SSL (Let's Encrypt):
   ```bash
   certbot --nginx -d your-domain.com
   ```

---

## Troubleshooting

### Common Issues

**1. Application won't start**
- Check if all dependencies are installed: `pip install -r requirements.txt`
- Check if port 5000 is available
- Check error logs for details

**2. Data not loading**
- Check if gait data files exist
- Verify file paths in configuration
- Check browser console for errors

**3. Charts not rendering**
- Check if Chart.js is loaded
- Check browser console for JavaScript errors
- Verify data format matches expected schema

**4. Export not working**
- Check if ReportLab is installed: `pip install reportlab`
- Check file permissions for export directory
- Check browser download settings

### Getting Help

- Check the project documentation
- Review error logs
- Contact the development team
- Check GitHub issues for known problems

---

## License

This project is licensed under the MIT License - see the LICENSE file for details.

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2026-11-09 | Initial release with core research portal functionality |
| 1.1.0 | 2026-11-10 | Added multi-plane waveform visualization |
| 1.1.1 | 2026-11-10 | Added group comparison with statistical metrics |
| 1.1.2 | 2026-11-09 | Added CSV, JSON, and PDF export |
| 1.1.3 | 2026-11-09 | Added normative band comparison |

---

*Documentation last updated: November 9, 2026*