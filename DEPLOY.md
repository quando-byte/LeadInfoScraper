# Leadinfo API – Deployment Guide

## Overview

The Leadinfo API exposes a POST endpoint for n8n workflows. It scrapes stakeholder data for a specific company from Leadinfo and returns JSON.

## Deploy on DigitalOcean App Platform

### 1. Push to GitHub

```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git push -u origin main
```

### 2. Create App on DigitalOcean

1. Go to [DigitalOcean App Platform](https://cloud.digitalocean.com/apps)
2. Click **Create App** → **GitHub**
3. Select your repository and branch
4. DigitalOcean will detect Node.js and use `npm start`

### 3. Configure Environment Variables

In the App settings, add:

| Variable           | Type   | Description                          |
|--------------------|--------|--------------------------------------|
| `LEADINFO_EMAIL`   | Secret | Leadinfo portal email                |
| `LEADINFO_PASSWORD`| Secret | Leadinfo portal password             |
| `LEADINFO_UK_ONLY` | Plain  | `true` (default) or `false`          |

### 4. Deploy

Click **Deploy**. The app will be available at `https://your-app-xxxxx.ondigitalocean.app`.

---

## API Reference

### Health Check

```
GET /health
```

Returns `{ "status": "ok", "service": "leadinfo-api" }`.

### Scrape Company Stakeholders

```
POST /scrape
Content-Type: application/json

{
  "companyName": "Acme Corp Ltd"
}
```

**Alternative field names:** `company_name`, `company`

**Success (200):**

```json
{
  "success": true,
  "data": {
    "companyName": "Acme Corp Ltd",
    "companyId": "1234567",
    "stakeholders": [
      {
        "firstName": "John",
        "lastName": "Smith",
        "title": "CEO",
        "email": "john@acme.com",
        "phone": "+44 20 1234 5678"
      }
    ],
    "stakeholderCount": 1
  }
}
```

**Error responses:**

| Status | Code              | Description                          |
|--------|-------------------|--------------------------------------|
| 400    | INVALID_BODY      | Request body is not valid JSON       |
| 400    | MISSING_COMPANY_NAME | companyName missing or invalid   |
| 401    | AUTH_ERROR        | Login failed                         |
| 404    | COMPANY_NOT_FOUND | No company with that name in Inbox   |
| 500    | SCRAPE_ERROR      | Scraping failed                      |
| 503    | CONFIG_ERROR      | Credentials not configured           |
| 504    | TIMEOUT           | Request timed out                    |

---

## n8n Integration

1. Add an **HTTP Request** node
2. Method: **POST**
3. URL: `https://your-app-xxxxx.ondigitalocean.app/scrape`
4. Body Content Type: **JSON**
5. Body:
   ```json
   {
     "companyName": "{{ $json.companyName }}"
   }
   ```

---

## Local Development

```bash
npm install
# Set LEADINFO_EMAIL and LEADINFO_PASSWORD (or use .env with dotenv)
npm run dev
```

Test:

```bash
curl -X POST http://localhost:8080/scrape \
  -H "Content-Type: application/json" \
  -d '{"companyName": "Your Company Ltd"}'
```
