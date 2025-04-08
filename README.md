# Siteimprove API - DCI Score Tracker

This Node.js application pulls accessibility data from the Siteimprove API and inserts DCI scores into a PostgreSQL database for reporting and analysis.

## Features

- Connects to the Siteimprove API
- Retrieves accessibility scores (DCI, A, AA, AAA, ARIA)
- Inserts daily records into a PostgreSQL database
- Designed for automation (cron jobs or manual run)
- Logging and error handling included
- PM2 support for background running
- Modular and easy to extend

## 🛠️ Tech Stack

- Node.js
- Express
- PostgreSQL
- Axios
- dotenv
- PM2 (for process management)

## Setup Instructions

1. **Clone the repo**
   ```bash
   git clone https://github.com/your-username/siteimprove-api-dci.git
   cd siteimprove-api-dci
