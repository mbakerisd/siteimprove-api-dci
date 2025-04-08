require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const moment = require('moment-timezone');


const app = express();
const port = 3000;

// Siteimprove credentials and authorization
const username = process.env.SITEIMPROVE_USERNAME;
const apiKey = process.env.SITEIMPROVE_API_KEY;
const authHeader = `Basic ${Buffer.from(`${username}:${apiKey}`).toString('base64')}`;

// PostgreSQL pool setup
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

pool.connect().then(() => {
  console.log('✅ Connected to PostgreSQL');
}).catch(err => {
  console.error('❌ PostgreSQL connection error:', err);
});

// Log errors to database
const logErrorToDatabase = async (siteId, siteName, errorMessage) => {
  try {
    await pool.query(
      'INSERT INTO error_logs (site_id, site_name, error_message, date) VALUES ($1, $2, $3, NOW())',
      [siteId || null, siteName || null, errorMessage]
    );
    console.log(`📦 Logged error for site: ${siteName}`);
  } catch (error) {
    console.error('❌ Failed to log error:', error);
  }
};

// Fetch existing records from DB
const fetchExistingRecords = async () => {
  try {
    const result = await pool.query('SELECT sid, date FROM ada_scores');
    return new Set(result.rows.map(row => `${row.sid}-${row.date}`));
  } catch (error) {
    console.error('❌ Failed fetching existing records:', error);
    return new Set();
  }
};

// Bulk insert helper
const bulkInsertData = async (records) => {
  if (records.length === 0) return;

  const values = [];
  const placeholders = records.map((record, index) => {
    const baseIndex = index * 9;
    values.push(
      record.sid,
      record.name,
      record.url,
      record.ada_a,
      record.ada_aa,
      record.ada_aaa,
      record.ada_aria,
      record.ada_score_total,
      record.date
    );
    return `($${baseIndex + 1}, $${baseIndex + 2}, $${baseIndex + 3}, $${baseIndex + 4}, $${baseIndex + 5}, $${baseIndex + 6}, $${baseIndex + 7}, $${baseIndex + 8}, $${baseIndex + 9})`;
  }).join(',');

  const query = `
    INSERT INTO ada_scores (sid, name, url, ada_a, ada_aa, ada_aaa, ada_aria, ada_score_total, date)
    VALUES ${placeholders}
  `;

  try {
    await pool.query(query, values);
    console.log(`✅ Bulk inserted ${records.length} records.`);
  } catch (error) {
    console.error('❌ Bulk insert error:', error.message);
  }
};

// Exponential backoff fetch helper
const fetchWithExponentialBackoff = async (url, options, retries = 5, delay = 1000) => {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await axios.get(url, options);
      return response;
    } catch (error) {
      if (error.response && error.response.status === 429) {
        const retryAfter = error.response.headers['retry-after'];
        const waitTime = retryAfter ? parseInt(retryAfter) * 1000 : delay;
        console.warn(`⏳ Rate limited. Retrying in ${waitTime / 1000}s...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      } else {
        throw error;
      }
    }
    delay *= 2;
  }
  throw new Error('❌ Max retries exceeded');
};

// Fetch and store records
const fetchAndInsertRecords = async () => {
  console.log('🚀 Fetching records from Siteimprove...');

  try {
    const existingRecords = await fetchExistingRecords();
    const response = await axios.get('https://api.eu.siteimprove.com/v2/sites?group_id=1183842&page_size=200', {
      headers: { 'Authorization': authHeader }
    });

    const sites = response.data?.items || [];

    if (sites.length === 0) {
      console.warn('⚠️ No sites returned. Check your group_id or API credentials.');
    }
    
    const bulkInsertBuffer = [];

    const siteDetailsPromises = sites.map(async (site) => {
      if (site.product.includes('accessibility')) {
        try {
          console.log(`🔍 Fetching accessibility data for site: ${site.id} (${site.site_name})`);

          const accessibilityResponse = await fetchWithExponentialBackoff(
            `https://api.eu.siteimprove.com/v2/sites/${site.id}/dci/overview`,
            { headers: { 'Authorization': authHeader } }
          );

          const { a, aa, aaa, aria, total: totalAccessibilityScore } = accessibilityResponse.data.a11y;
          const date = new Date().toISOString().split('T')[0];
          const recordKey = `${site.id}-${date}`;

          if (!existingRecords.has(recordKey)) {
            bulkInsertBuffer.push({
              sid: site.id,
              name: site.site_name,
              url: site.url,
              ada_a: parseInt(a),
              ada_aa: parseInt(aa),
              ada_aaa: parseInt(aaa),
              ada_aria: parseInt(aria),
              ada_score_total: parseInt(totalAccessibilityScore),
              date
            });
          } else {
            console.log(`⏩ Skipping: Record already exists for sid ${site.id} on ${date}`);
          }
        } catch (error) {
          let errorMessage = '';
          const siteInfo = `site ${site.id} (${site.site_name})`;

          if (error.response) {
            if (
              error.response.data?.message?.includes('No site found with id') &&
              error.response.data?.type === 'RequestError'
            ) {
              errorMessage = `🚫 Skipping ${siteInfo}: Not found or no access`;
              console.warn(errorMessage);
              return;
            }

            errorMessage = `API Error for ${siteInfo}: Status ${error.response.status} - ${JSON.stringify(error.response.data)}`;
          } else {
            errorMessage = `Unexpected error for ${siteInfo}: ${error.message}`;
          }

          console.error(`❌ ${errorMessage}`);
          await logErrorToDatabase(site.id, site.site_name, 'Not found or no access to dci/overview');

        }
      }
    });

    await Promise.allSettled(siteDetailsPromises);
    await bulkInsertData(bulkInsertBuffer);

    console.log('✅ Finished processing all sites.');
  } catch (error) {
    const errorMsg = `General fetch error: ${error.message}`;
    console.error(`❌ ${errorMsg}`);
    await logErrorToDatabase(null, 'General API Error', errorMsg);
  }
};

// Route to trigger job manually
app.get('/run-now', async (req, res) => {
  console.log(`📥 Manual trigger @ ${moment().tz('America/Los_Angeles').format()}`);
  await fetchAndInsertRecords();
  res.send('✅ Fetch and insert completed.');
});

// Graceful shutdown
// Graceful shutdown with guard
let isShuttingDown = false;

process.on('SIGINT', async () => {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log('👋 Gracefully shutting down...');
  try {
    await pool.end();
    console.log('✅ PostgreSQL connection closed.');
  } catch (err) {
    console.error('❌ Error during shutdown:', err);
  } finally {
    process.exit(0);
  }
});


// Start Express server
app.listen(port, () => {
  console.log(`🌍 Server running at http://localhost:${port}`);
});
