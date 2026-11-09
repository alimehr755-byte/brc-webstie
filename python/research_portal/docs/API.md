# Research Portal API Reference

## Overview

The BRC Gait Lab Research Portal provides a RESTful API for accessing gait analysis data, performing comparisons, and exporting research data.

**Base URL:** `http://localhost:5000/api/gait/research/`

**Authentication:** Currently uses session-based authentication via Flask sessions.

---

## Endpoints

### 1. Populations

**GET** `/research/populations`

Get population counts by diagnosis with optional filtering.

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| gender | string | Filter by gender: "male", "female", "other", "all" |
| gmfcs_level | string | Filter by GMFCS level: "I", "II", "III", "IV", "V" |
| age_min | float | Minimum age filter |
| age_max | float | Maximum age filter |

**Response:**
```json
{
  "populations": [
    {
      "diagnosis": "Cerebral palsy",
      "session_count": 2
    },
    {
      "diagnosis": "Autism",
      "session_count": 1
    }
  ],
  "total": 3
}
```

**Example Request:**
```bash
curl "http://localhost:5000/api/gait/research/populations?gender=male&gmfcs_level=III"
```

---

### 2. Coronal Plane Data

**GET** `/research/coronal`

Get coronal plane metrics aggregated by population.

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| population | string | Filter by diagnosis |
| gender | string | Filter by gender |
| gmfcs_level | string | Filter by GMFCS level |
| age_min | float | Minimum age |
| age_max | float | Maximum age |

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

---

### 3. Compare Groups

**GET** `/research/compare`

Compare two populations with statistical analysis including Welch's t-test.

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| pop1 | string | Group 1 diagnosis (required) |
| pop2 | string | Group 2 diagnosis (required) |
| metric | string | Metric to compare |
| gender | string | Filter by gender |
| gmfcs_level | string | Filter by GMFCS level |
| age_min | float | Minimum age |
| age_max | float | Maximum age |

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

---

### 4. Waveforms

**GET** `/research/waveforms`

Get multi-plane gait cycle waveforms by population.

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| joint | string | Joint target: "knee", "hip", "ankle", "pelvis", "spine" |
| plane | string | Plane of motion: "sagittal", "frontal", "transverse" |
| side | string | Side: "L", "R", "B" |
| population | string | Filter by diagnosis |
| gender | string | Filter by gender |
| gmfcs_level | string | Filter by GMFCS level |
| age_min | float | Minimum age |
| age_max | float | Maximum age |

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

---

### 5. Normative Reference Bands

**GET** `/research/normative`

Get age/sex-stratified normative bands.

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| joint | string | Joint name |
| plane | string | Plane of motion |
| side | string | Side: "L", "R" |
| age | number | Patient age |
| sex | string | Gender: "all", "male", "female" |

**Response:**
```json
{
  "bands": [
    {
      "joint": "knee",
      "plane": "sagittal",
      "side": "L",
      "age_min": 0,
      "age_max": 999,
      "sex": "all",
      "metric": "knee_flexion",
      "p5": 30,
      "p50": 60,
      "p95": 90,
      "source": "representative"
    }
  ]
}
```

---

### 6. Progression (Longitudinal Data)

**GET** `/research/progression`

Get per-patient longitudinal trends over time.

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| diagnosis | string | Filter by diagnosis |
| gender | string | Filter by gender |
| gmfcs_level | string | Filter by GMFCS level |
| age_min | float | Minimum age |
| age_max | float | Maximum age |
| metric | string | Metric to analyze |

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

---

### 7. Export CSV

**GET** `/research/export`

Export research data as CSV file.

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| population | string | Filter by diagnosis |
| gender | string | Filter by gender |
| gmfcs_level | string | Filter by GMFCS level |
| age_min | float | Minimum age |
| age_max | float | Maximum age |

**Response:** CSV file download

---

### 8. Export JSON

**GET** `/research/export.json`

Export research data as JSON file.

**Query Parameters:** Same as CSV export

**Response:** JSON file download

---

### 9. Export PDF

**GET** `/research/export.pdf`

Export research data as PDF report.

**Query Parameters:** Same as CSV export

**Response:** PDF file download

---

## Example Usage

### Example 1: Get populations by diagnosis

```bash
curl "http://localhost:5000/api/gait/research/populations?gender=female&gmfcs_level=III"
```

Response:
```json
{
  "populations": [
    {
      "diagnosis": "Cerebral palsy",
      "session_count": 3
    },
    {
      "diagnosis": "Autism",
      "session_count": 1
    }
  ],
  "total": 4
}
```

### Example 2: Compare two populations

```bash
curl "http://localhost:5000/api/gait/research/compare?pop1=Cerebral%20palsy&pop2=Healthy%20control&metric=knee_flexion_L"
```

Response:
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

### Example 3: Get waveforms for knee flexion

```bash
curl "http://localhost:5000/api/gait/research/waveforms?joint=knee&plane=sagittal&side=L"
```

Response:
```json
{
  "joint": "knee",
  "plane": "sagittal",
  "side": "L",
  "samples": 120,
  "phases": [...],
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

---

## Error Responses

All API endpoints return standard HTTP status codes:

| Status Code | Meaning |
|-------------|---------|
| 200 | Success |
| 400 | Bad Request - Missing or invalid parameters |
| 401 | Unauthorized - Authentication required |
| 404 | Not Found - Resource not found |
| 500 | Internal Server Error - Server error |

Error responses include a JSON body:
```json
{
  "error": "Error message description"
}
```

---

## Rate Limiting

Currently no rate limiting is implemented. For production use, consider implementing rate limiting using Flask-Limiter.

---

## CORS

CORS is enabled for all origins. Configure CORS settings in `routes/gait.js` if needed for production deployment.

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2026-11-09 | Initial API release |
| 1.1.0 | 2026-11-09 | Added research export endpoints |
| 1.1.1 | 2026-11-09 | Added normative data endpoint |
| 1.1.2 | 2026-11-09 | Added progression endpoint |

---

*API Documentation last updated: November 9, 2026*