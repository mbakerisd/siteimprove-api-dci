# Siteimprove API - ADA Compliance Tracker

## Overview

This Node.js application automatically fetches accessibility (ADA) compliance data from the Siteimprove API and stores it in a PostgreSQL database. It tracks compliance scores over time for all websites with accessibility monitoring enabled in your Siteimprove account.

## Features

- ✅ **Automated Data Collection**: Scheduled daily pulls via cron jobs
- 📊 **ADA Compliance Tracking**: Monitors A, AA, AAA, and ARIA compliance levels
- 🎯 **Target Score Tracking**: Records site-specific accessibility targets
- 🔄 **Duplicate Prevention**: Avoids re-inserting existing records
- 📝 **Error Logging**: Comprehensive error tracking in database
- 🌐 **REST API**: Query collected data via HTTP endpoints
- ⏱️ **Manual Triggers**: Run data collection on-demand
- 🔄 **Batch Processing**: Historical data backfill support

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Installation](#installation)
3. [Project Structure](#project-structure)
4. [Database Setup](#database-setup)
5. [Environment Configuration](#environment-configuration)
6. [Running the Application](#running-the-application)
7. [PM2 Process Management](#pm2-process-management)
8. [API Endpoints](#api-endpoints)
9. [Cron Scheduling](#cron-scheduling)
10. [Troubleshooting](#troubleshooting)

---

## Prerequisites

- **Node.js**: v14.x or higher
- **PostgreSQL**: v12.x or higher
- **npm**: v6.x or higher
- **PM2**: v5.x or higher (for production deployment)
- **Siteimprove Account**: With API access credentials

---

## Installation

### 1. Clone the Repository

```bash
git clone https://github.com/mbakerisd/siteimprove-api-dci.git
cd siteimprove-api-dci
```

### 2. Install Dependencies

```bash
npm install
```

**Required npm packages:**
- `express` - Web server framework
- `axios` - HTTP client for API requests
- `pg` - PostgreSQL client
- `dotenv` - Environment variable management
- `moment-timezone` - Date/time handling
- `node-cron` - Job scheduling

---

## Project Structure

```
siteimprove-api-dci/
├── app.js                          # Main application (API server + cron scheduler)
├── historical-data-fetch.js        # Legacy batch historical data fetcher (v1)
├── historical-data-batch-v2.js     # Improved batch historical data fetcher (v2)
├── site-target-history-fetch.js    # Fetches site target history data
├── site-target-updater.js          # Updates site target scores
├── package.json                    # Node.js dependencies
├── .env                            # Environment variables (not in git)
├── .gitignore                      # Git ignore rules
├── README.md                       # This documentation
├── public/                         # Static web assets
│   ├── index.html                  # Dashboard homepage
│   ├── run-now.html               # Manual trigger interface
│   ├── status.html                # Status monitoring page
│   └── deletion-report.html       # Data deletion reports
└── views/                         # EJS templates (if used)
    ├── index.ejs
    ├── runnow.ejs
    ├── status.ejs
    └── remove-now.ejs
```

### File Descriptions

#### Core Application Files

**`app.js`** - Main application server
- Express.js REST API server
- Automated cron scheduling (daily data collection)
- Database connection pooling
- Fetches accessibility scores from Siteimprove API
- Stores data in PostgreSQL
- Serves static web dashboard

**`historical-data-batch-v2.js`** - Historical data backfill (Recommended)
- Fetches ADA scores for a specific date range
- Called via `/run-batch` endpoint
- Usage: `node historical-data-batch-v2.js 2025-01-01 2025-12-31`
- Improved version with better error handling

**`historical-data-fetch.js`** - Legacy historical fetcher (v1)
- Original batch script (use v2 instead)
- Kept for backward compatibility

**`site-target-history-fetch.js`** - Site target data collector
- Fetches site target percentage history
- Independent script for target tracking
- Usage: `node site-target-history-fetch.js`

**`site-target-updater.js`** - Target score updater
- Updates site target scores in database
- Synchronizes target data
- Usage: `node site-target-updater.js`

---

## Database Setup

### 1. Create PostgreSQL Database

```sql
CREATE DATABASE adabackupdb;
```

### 2. Create Tables

**Main Data Table:**
```sql
CREATE TABLE ada_scores (
    id SERIAL PRIMARY KEY,
    sid INTEGER NOT NULL,
    name VARCHAR(255) NOT NULL,
    url TEXT NOT NULL,
    ada_a INTEGER,
    ada_aa INTEGER,
    ada_aaa INTEGER,
    ada_aria INTEGER,
    ada_score_total INTEGER,
    site_target_score DECIMAL(5,2),
    date DATE NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_site_date UNIQUE (sid, date)
);
```

**Error Logging Table:**
```sql
CREATE TABLE error_logs (
    id SERIAL PRIMARY KEY,
    site_id INTEGER,
    site_name VARCHAR(255),
    message TEXT,
    level VARCHAR(50) DEFAULT 'ERROR',
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### 3. Create Indexes (Optional but Recommended)

```sql
CREATE INDEX idx_ada_scores_date ON ada_scores(date);
CREATE INDEX idx_ada_scores_sid ON ada_scores(sid);
CREATE INDEX idx_error_logs_timestamp ON error_logs(timestamp);
CREATE INDEX idx_error_logs_level ON error_logs(level);
```

---

## Environment Configuration

Create a `.env` file in the project root:

```env
# Siteimprove API Credentials
SITEIMPROVE_USERNAME=your_username_here
SITEIMPROVE_API_KEY=your_api_key_here

# PostgreSQL Database Configuration
DB_USER=postgres
DB_HOST=your-database-host.com
DB_NAME=adabackupdb
DB_PASSWORD=your_secure_password
DB_PORT=5432

# Application Configuration
PORT=3000
NODE_ENV=production

# Cron Schedule (optional - defaults to 6:35 PM Pacific)
# Format: minute hour day month dayOfWeek
CRON_EXPR=35 18 * * *
```

### Database Connection Details

The application uses the `pg` (node-postgres) library with connection pooling:

```javascript
const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: Number(process.env.DB_PORT) || 5432,
  ssl: { rejectUnauthorized: false },  // Required for cloud databases
  connectionTimeoutMillis: 30000,
  idleTimeoutMillis: 20000,
  query_timeout: 120000,
  max: 50,  // Maximum pool size
  min: 5    // Minimum pool size
});
```

**Connection Pool Benefits:**
- Reuses database connections for better performance
- Handles connection failures gracefully
- Automatically reconnects on connection loss
- Manages concurrent requests efficiently

---

## Running the Application

### Development Mode

```bash
# Run directly with Node
node app.js

# Or with nodemon for auto-restart on file changes
npx nodemon app.js
```

### Production Mode (Recommended)

Use PM2 for process management in production environments.

---

## PM2 Process Management

PM2 is a production process manager for Node.js applications with built-in load balancing, monitoring, and auto-restart capabilities.

### Installation

```bash
# Install PM2 globally
npm install -g pm2
```

### Basic PM2 Commands

#### Start the Application

```bash
# Start with PM2
pm2 start app.js --name "siteimprove-api"

# Start with environment variables
pm2 start app.js --name "siteimprove-api" --env production
```

#### Restart the Application

```bash
# Restart after code changes
pm2 restart siteimprove-api

# Graceful reload (zero-downtime)
pm2 reload siteimprove-api
```

#### Monitor & Logs

```bash
# View real-time logs
pm2 logs siteimprove-api

# View last 100 lines
pm2 logs siteimprove-api --lines 100

# Monitor CPU and memory
pm2 monit

# Check application status
pm2 status

# View detailed info
pm2 show siteimprove-api
```

#### Stop & Delete

```bash
# Stop the application
pm2 stop siteimprove-api

# Delete from PM2 process list
pm2 delete siteimprove-api
```

### Advanced PM2 Configuration

Create `ecosystem.config.js` in project root:

```javascript
module.exports = {
  apps: [{
    name: 'siteimprove-api',
    script: './app.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    },
    error_file: './logs/pm2-error.log',
    out_file: './logs/pm2-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    time: true,
    // Restart on cron schedule (optional)
    cron_restart: '0 3 * * *'  // Restart at 3 AM daily
  }]
};
```

**Using ecosystem file:**

```bash
# Start
pm2 start ecosystem.config.js

# Restart
pm2 restart ecosystem.config.js

# Reload
pm2 reload ecosystem.config.js
```

### PM2 Startup Script (Auto-start on System Boot)

```bash
# Generate startup script
pm2 startup

# Save current process list
pm2 save

# The app will now auto-start on system reboot
```

### PM2 Process Persistence

```bash
# Save current running processes
pm2 save

# Restore saved processes
pm2 resurrect

# Clear saved process list
pm2 cleardump
```

---

## API Endpoints

### 1. Manual Data Collection

**Endpoint:** `GET /run-now`

Triggers immediate data collection from Siteimprove API.

```bash
curl http://localhost:3000/run-now
```

**Response:**
```
✅ Run complete. | Sites pulled: 150 | Processed: 150 | Inserted: 45 | Skipped existing: 105 | Target info notes: 5, target errors: 2 | Rows before: 2500, after: 2545
```

### 2. Batch Historical Update

**Endpoint:** `GET /run-batch?start=YYYY-MM-DD&end=YYYY-MM-DD`

Runs batch update for historical date range using `historical-data-batch-v2.js`.

```bash
curl "http://localhost:3000/run-batch?start=2025-06-01&end=2025-06-30"
```

**What it does:**
- Executes `historical-data-batch-v2.js` script with date range
- Fetches historical ADA scores for all sites
- Useful for backfilling missing data or initial database population

### 3. Database Status Summary

**Endpoint:** `GET /api/status`

Returns count of records grouped by date.

```bash
curl http://localhost:3000/api/status
```

**Response:**
```json
[
  { "date": "2026-01-13", "count": "150" },
  { "date": "2026-01-12", "count": "148" },
  { "date": "2026-01-11", "count": "147" }
]
```

### 4. Today's Records

**Endpoint:** `GET /api/today-records`

Returns all records collected today.

```bash
curl http://localhost:3000/api/today-records
```

**Response:**
```json
[
  {
    "name": "Example Website",
    "url": "https://example.lacounty.gov",
    "date": "2026-01-13",
    "site_target_score": "95.50"
  }
]
```

---

## Utility Scripts

In addition to the main application, several utility scripts are available for specific tasks:

### Historical Data Backfill

**Script:** `historical-data-batch-v2.js`

Fetches historical ADA compliance scores for a date range.

```bash
# Run directly
node historical-data-batch-v2.js 2025-01-01 2025-12-31

# Or via API endpoint
curl "http://localhost:3000/run-batch?start=2025-01-01&end=2025-12-31"
```

**Use cases:**
- Initial database population
- Backfilling missing dates
- Data recovery after errors

### Site Target History Fetcher

**Script:** `site-target-history-fetch.js`

Collects historical site target percentage data.

```bash
node site-target-history-fetch.js
```

**Use cases:**
- Analyzing target score trends over time
- Separate target tracking
- Historical compliance goal analysis

### Site Target Updater

**Script:** `site-target-updater.js`

Updates or synchronizes site target scores in the database.

```bash
node site-target-updater.js
```

**Use cases:**
- Bulk update target scores
- Sync targets from Siteimprove
- Fix missing target data

---

## Cron Scheduling

The application includes built-in cron scheduling using `node-cron`.

### Default Schedule

- **Time:** 6:35 PM Pacific Time (America/Los_Angeles)
- **Frequency:** Daily
- **Cron Expression:** `35 18 * * *`

### Customizing Schedule

Set `CRON_EXPR` in `.env`:

```env
# Run at 4:30 PM Pacific (production)
CRON_EXPR=30 16 * * *

# Run at 12:00 PM Pacific
CRON_EXPR=0 12 * * *

# Run every 6 hours
CRON_EXPR=0 */6 * * *

# Run at midnight
CRON_EXPR=0 0 * * *
```

### Cron Expression Format

```
* * * * *
│ │ │ │ │
│ │ │ │ └─── Day of Week (0-7, Sunday = 0 or 7)
│ │ │ └───── Month (1-12)
│ │ └─────── Day of Month (1-31)
│ └───────── Hour (0-23)
└─────────── Minute (0-59)
```

### Monitoring Cron Jobs

```bash
# View PM2 logs to see scheduled runs
pm2 logs siteimprove-api --lines 50
```

Look for log entries like:
```
⏰📅 Scheduled run started @ 2026-01-13 18:35:00 PST
✅ Scheduled run complete. | Sites pulled: 150 | ...
```

---

## How It Works

### Data Collection Flow

1. **Scheduled Trigger**: Cron job runs daily at configured time
2. **API Authentication**: Uses Basic Auth with Siteimprove credentials
3. **Site Discovery**: Fetches all sites with accessibility product from group ID 1183842
4. **Data Collection**: For each site:
   - Fetches DCI overview (A, AA, AAA, ARIA scores)
   - Fetches site target history (today's target percentage)
   - Handles errors gracefully with retry logic
5. **Database Storage**: 
   - Checks for duplicate records (sid + date)
   - Inserts new records
   - Logs any errors to error_logs table
6. **Memory Management**: Processes sites in batches of 20

### Database Schema

**ada_scores table:**
- `sid` - Siteimprove Site ID (integer)
- `name` - Website name (string)
- `url` - Website URL (string)
- `ada_a` - Level A compliance score (integer)
- `ada_aa` - Level AA compliance score (integer)
- `ada_aaa` - Level AAA compliance score (integer)
- `ada_aria` - ARIA compliance score (integer)
- `ada_score_total` - Total accessibility score (integer)
- `site_target_score` - Target percentage goal (decimal)
- `date` - Collection date (date)

**error_logs table:**
- `site_id` - Siteimprove Site ID (integer, nullable)
- `site_name` - Website name (string, nullable)
- `message` - Error description (text)
- `level` - Error severity: ERROR, WARNING, INFO (string)
- `timestamp` - When error occurred (timestamp)

---

## Troubleshooting

### Common Issues

#### 1. Database Connection Fails

**Error:** `❌ PostgreSQL connection error`

**Solutions:**
- Verify database credentials in `.env`
- Check if PostgreSQL is running
- Verify SSL settings (cloud databases require `ssl: { rejectUnauthorized: false }`)
- Check firewall rules for database port (default: 5432)

```bash
# Test connection manually
psql -h your-host -U your-user -d adabackupdb
```

#### 2. API Authentication Fails

**Error:** `401 Unauthorized` or `403 Forbidden`

**Solutions:**
- Verify `SITEIMPROVE_USERNAME` and `SITEIMPROVE_API_KEY` in `.env`
- Check API key hasn't expired
- Ensure account has API access enabled

#### 3. Duplicate Key Errors

**Error:** `duplicate key value violates unique constraint`

**Solution:**
- The app handles this automatically with `ON CONFLICT DO NOTHING`
- Records are skipped if `(sid, date)` already exists
- Check `skippedExisting` count in response

#### 4. Memory Issues

**Error:** `JavaScript heap out of memory`

**Solutions:**
- Reduce batch size (currently 20) in `app.js`
- Increase Node memory limit:
  ```bash
  node --max-old-space-size=4096 app.js
  ```
- With PM2:
  ```bash
  pm2 start app.js --max-memory-restart 1G
  ```

#### 5. Cron Job Not Running

**Check:**
- Verify timezone setting: `{ timezone: 'America/Los_Angeles' }`
- Check PM2 logs for scheduled run messages
- Ensure `jobRunning` flag isn't stuck (restart app)

```bash
pm2 logs siteimprove-api --lines 100 | grep "Scheduled"
```

### Logs Location

**Console logs:**
```bash
pm2 logs siteimprove-api
```

**Database error logs:**
```sql
SELECT * FROM error_logs 
ORDER BY timestamp DESC 
LIMIT 50;
```

---

## Maintenance

### Regular Tasks

1. **Monitor Database Size**
   ```sql
   SELECT pg_size_pretty(pg_database_size('adabackupdb'));
   ```

2. **Archive Old Records** (optional)
   ```sql
   -- Archive records older than 1 year
   DELETE FROM ada_scores WHERE date < CURRENT_DATE - INTERVAL '1 year';
   ```

3. **Review Error Logs**
   ```sql
   SELECT level, COUNT(*) 
   FROM error_logs 
   WHERE timestamp > CURRENT_DATE - INTERVAL '7 days'
   GROUP BY level;
   ```

4. **Vacuum Database** (improve performance)
   ```sql
   VACUUM ANALYZE ada_scores;
   VACUUM ANALYZE error_logs;
   ```

---

## Performance Optimization

### Database Indexes

Already created in setup, but verify:

```sql
SELECT indexname, indexdef 
FROM pg_indexes 
WHERE tablename IN ('ada_scores', 'error_logs');
```

### Connection Pool Tuning

Adjust in `app.js` based on your workload:

```javascript
max: 50,  // Increase for high concurrency
min: 5,   // Minimum idle connections
query_timeout: 120000  // 2 minutes timeout
```

---

## Security Best Practices

1. **Never commit `.env` file** - Already in `.gitignore`
2. **Use strong database passwords**
3. **Enable SSL for database connections** - Already configured
4. **Restrict database access by IP** - Configure in PostgreSQL
5. **Regular dependency updates**:
   ```bash
   npm audit
   npm update
   ```

---

## Support & Contact

- **Repository**: https://github.com/mbakerisd/siteimprove-api-dci
- **Issues**: Report bugs via GitHub Issues
- **Documentation**: This README

---

## License

County of Los Angeles - Internal Use Only

---

## Changelog

### Version 2.0 (2026-01-13)
- Removed approved sites whitelist checking
- Simplified processing logic
- All sites with accessibility product are now tracked
- Improved error handling and statistics
- Renamed scripts for better clarity:
  - `batch.js` → `historical-data-fetch.js`
  - `batchv2.js` → `historical-data-batch-v2.js`
  - `dci_site_target_history.js` → `site-target-history-fetch.js`
  - `app_site_target_new.js` → `site-target-updater.js`

### Version 1.0
- Initial release
- Basic data collection and storage
- Cron scheduling
- Error logging

---

## Quick Reference

### Common Commands

```bash
# Start application
pm2 start app.js --name "siteimprove-api"

# Restart after changes
pm2 restart siteimprove-api

# View logs
pm2 logs siteimprove-api

# Check status
pm2 status

# Manual data collection
curl http://localhost:3000/run-now

# Historical backfill
curl "http://localhost:3000/run-batch?start=2025-01-01&end=2025-12-31"
```

### File Quick Reference

| File | Purpose |
|------|---------|
| `app.js` | Main application server + scheduler |
| `historical-data-batch-v2.js` | Historical data backfill (recommended) |
| `historical-data-fetch.js` | Legacy batch script (v1) |
| `site-target-history-fetch.js` | Fetch site target history |
| `site-target-updater.js` | Update site targets |
| `.env` | Environment configuration (not in git) |
| `README.md` | This documentation |

### Database Quick Reference

| Table | Purpose |
|-------|---------|
| `ada_scores` | Main ADA compliance data |
| `error_logs` | Application error tracking |

### API Quick Reference

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/run-now` | GET | Trigger manual data collection |
| `/run-batch?start=YYYY-MM-DD&end=YYYY-MM-DD` | GET | Historical backfill |
| `/api/status` | GET | Database status summary |
| `/api/today-records` | GET | Today's collected records |
