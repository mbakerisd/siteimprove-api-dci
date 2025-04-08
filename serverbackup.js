require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const cron = require('node-cron');
const moment = require('moment-timezone');

const app = express();
const port = 3000;

// Retrieve Siteimprove API credentials from environment variables
const username = process.env.SITEIMPROVE_USERNAME;
const apiKey = process.env.SITEIMPROVE_API_KEY;
const authHeader = `Basic ${Buffer.from(`${username}:${apiKey}`).toString('base64')}`;

// Configure PostgreSQL connection pool
const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 30000, 
  idleTimeoutMillis: 20000,
  query_timeout: 120000,
  max: 50,
  min: 5 
});

// Connect to PostgreSQL database
pool.connect().then(() => {
  console.log('? Connected to PostgreSQL');
}).catch(err => {
  console.error('? Error connecting to PostgreSQL:', err);
});

// Function to log errors to the error_logs table
const logErrorToDatabase = async (siteId, siteName, errorMessage) => {
  try {
    await pool.query(
      'INSERT INTO error_logs (site_id, site_name, error_message, date) VALUES ($1, $2, $3, NOW())',
      [siteId || null, siteName || null, errorMessage]
    );
    console.log(`?? Error logged for site: ${siteName}`);
  } catch (error) {
    console.error('? Failed to log error:', error);
  }
};

// Function to fetch existing records
const fetchExistingRecords = async () => {
  try {
    const result = await pool.query('SELECT sid, date FROM ada_scores');
    return new Set(result.rows.map(row => `${row.sid}-${row.date}`));
  } catch (error) {
    console.error('? Error fetching existing records:', error);
    return new Set();
  }
};

// Function to insert data into the database if it doesn't exist
const insertDataIfNotExists = async (query, values, existingRecords) => {
  const [sid, , , , , , , , date] = values;
  const recordKey = `${sid}-${date}`;

  if (existingRecords.has(recordKey)) {
    console.log(`?? Skipping insert: Record already exists for sid ${sid} on ${date}`);
    return;
  }

  try {
    await pool.query(query, values);
    console.log(`? Record added successfully for sid ${sid} on ${date}`);
  } catch (error) {
    console.error(`? Database insert failed for sid ${sid}:`, error);
    await logErrorToDatabase(sid, 'Insert Error', error.message);
  }
};

// Function to fetch data with exponential backoff (handles 429 rate limits)
const fetchWithExponentialBackoff = async (url, options, retries = 5, delay = 1000) => {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await axios.get(url, options);
      return response;
    } catch (error) {
      if (error.response && error.response.status === 429) {
        const retryAfter = error.response.headers['retry-after'];
        const waitTime = retryAfter ? parseInt(retryAfter) * 1000 : delay;
        console.warn(`? Rate limit hit. Retrying after ${waitTime / 1000} seconds...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      } else {
        console.error(`? HTTP Error: ${error.response ? error.response.status : 'Unknown'} - ${error.message}`);
        throw error;
      }
    }
    delay *= 2; 
  }

  throw new Error('? Max retries reached');
};

// Fetch and Insert Records
const fetchAndInsertRecords = async () => {
  console.log('?? Fetching records from Siteimprove API...');

  try {
    const existingRecords = await fetchExistingRecords();

    const response = await axios.get('https://api.eu.siteimprove.com/v2/sites?group_id=1183842&page_size=200', {
      headers: { 'Authorization': authHeader }
    });

    const sites = response.data.items;

    const siteDetailsPromises = sites.map(async (site) => {
      if (site.product.includes('accessibility') && !site.url.includes('-qa.') && !site.url.includes('-dev.')) {
        try {
          const accessibilityResponse = await fetchWithExponentialBackoff(
            `https://api.eu.siteimprove.com/v2/sites/${site.id}/dci/overview`,
            { headers: { 'Authorization': authHeader } }
          );

          const { a, aa, aaa, aria, total: totalAccessibilityScore } = accessibilityResponse.data.a11y;
          const validatedData = {
            sid: site.id,
            name: site.site_name,
            url: site.url,
            ada_a: parseInt(a),
            ada_aa: parseInt(aa),
            ada_aaa: parseInt(aaa),
            ada_aria: parseInt(aria),
            ada_score_total: parseInt(totalAccessibilityScore),
            date: new Date().toISOString().split('T')[0]
          };

          await insertDataIfNotExists(
            `INSERT INTO ada_scores (sid, name, url, ada_a, ada_aa, ada_aaa, ada_aria, ada_score_total, date)
             VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [
              validatedData.sid,
              validatedData.name,
              validatedData.url,
              validatedData.ada_a,
              validatedData.ada_aa,
              validatedData.ada_aaa,
              validatedData.ada_aria,
              validatedData.ada_score_total,
              validatedData.date
            ],
            existingRecords
          );
        } catch (error) {
          console.error(`? Error fetching accessibility data for site ID ${site.id}:`, error);
          await logErrorToDatabase(site.id, site.site_name, error.message);
        }
      }
    });

    await Promise.allSettled(siteDetailsPromises);
    console.log('? Processing complete.');
  } catch (error) {
    console.error('? Error making API request:', error);
    await logErrorToDatabase(null, 'General API Error', error.message);
  }
};

// Cron Job: Runs Daily at 4:30 PM America/Los_Angeles Time
cron.schedule('30 16 * * *', () => {
  console.log(`?? Cron job triggered at ${moment().tz('America/Los_Angeles').format()}`);
  fetchAndInsertRecords();
}, {
  scheduled: true,
  timezone: 'America/Los_Angeles'
});

// Graceful Shutdown (Ensures DB is closed properly)
process.on('SIGINT', async () => {
  console.log('?? Shutting down gracefully...');
  await pool.end();
  console.log('? PostgreSQL connection closed.');
  process.exit(0);
});

// Start the Express server
app.listen(port, () => {
  console.log(`?? Server running at http://localhost:${port}`);
});
