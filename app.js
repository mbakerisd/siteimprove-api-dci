require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const moment = require('moment-timezone');
const ExcelJS = require('exceljs');

const app = express();
const port = 3004;

app.use(express.static('public'));

const username = process.env.SITEIMPROVE_USERNAME;
const apiKey = process.env.SITEIMPROVE_API_KEY;
const authHeader = `Basic ${Buffer.from(`${username}:${apiKey}`).toString('base64')}`;

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
  console.error('❌ Connection error:', err);
});

const stripProtocol = (url) => {
  try {
    const parsed = new URL(url);
    return parsed.hostname + parsed.pathname;
  } catch (e) {
    return url.replace(/^https?:\/\//i, '').toLowerCase();
  }
};

const loadApprovedUrls = async () => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile('./checklist/approved_sites.xlsx');
  const worksheet = workbook.getWorksheet(1);

  const approvedUrls = new Set();
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const raw = row.getCell('B').text.trim();
    const normalized = stripProtocol(raw.toLowerCase());
    if (raw) approvedUrls.add(normalized);
  });

  console.log(`🔗 Total Approved URLs: ${approvedUrls.size}`);
  return approvedUrls;
};

const logErrorToDatabase = async (siteId, siteName, errorMessage, level = 'ERROR') => {
  try {
    await pool.query(
      'INSERT INTO error_log (site_id, site_name, message, level, timestamp) VALUES ($1, $2, $3, $4, NOW())',
      [siteId || null, siteName || null, errorMessage, level]
    );
    console.log(`📦 Logged ${level} for site ${siteName}`);
  } catch (error) {
    console.error('❌ Failed to log error:', error);
  }
};

const fetchExistingRecords = async () => {
  const result = await pool.query('SELECT sid, date FROM ada_scores');
  return new Set(result.rows.map(row => `${row.sid}-${row.date}`));
};

const insertScore = async (record, existingRecords) => {
  const key = `${record.sid}-${record.date}`;
  if (existingRecords.has(key)) {
    console.log(`⏩ Skipping existing record: ${key}`);
    return;
  }

  const query = `
    INSERT INTO ada_scores (sid, name, url, ada_a, ada_aa, ada_aaa, ada_aria, ada_score_total, date)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    ON CONFLICT (sid, date) DO NOTHING
  `;

  const values = [
    record.sid,
    record.name,
    record.url,
    record.ada_a,
    record.ada_aa,
    record.ada_aaa,
    record.ada_aria,
    record.ada_score_total,
    record.date,
  ];

  try {
    await pool.query(query, values);
  } catch (err) {
    console.error(`❌ Insert failed for ${record.name}: ${err.message}`);
    await logErrorToDatabase(record.sid, record.name, err.message);
  }
};

const fetchAndInsertRecords = async () => {
  console.log('🚀 Starting Siteimprove pull...');
  const existingRecords = await fetchExistingRecords();
  const approvedUrls = await loadApprovedUrls();

  try {
    const response = await axios.get('https://api.eu.siteimprove.com/v2/sites?group_id=1183842&page_size=200', {
      headers: { 'Authorization': authHeader },
    });

    const sites = response.data.items.filter(site => site.product.includes('accessibility'));
    console.log(`🔎 Total accessible sites pulled: ${sites.length}`);

    for (let i = 0; i < sites.length; i += 20) {
      const batch = sites.slice(i, i + 20);

      for (const site of batch) {
        const normalizedSiteUrl = stripProtocol(site.url);
        const today = new Date().toISOString().split('T')[0];

        if (!approvedUrls.has(normalizedSiteUrl)) {
          console.log(`🚫 Skipping unmatched site: ${site.url}`);
          continue;
        }

        try {
          console.log(`➡️ Processing site: ${site.site_name} (${site.id})`);

          const scoreResponse = await axios.get(`https://api.eu.siteimprove.com/v2/sites/${site.id}/dci/overview`, {
            headers: { 'Authorization': authHeader },
          });

          const { a, aa, aaa, aria, total } = scoreResponse.data.a11y;
          let record = {
            sid: site.id,
            name: site.site_name,
            url: site.url,
            ada_a: parseInt(a),
            ada_aa: parseInt(aa),
            ada_aaa: parseInt(aaa),
            ada_aria: parseInt(aria),
            ada_score_total: parseInt(total),
            date: today,
          };

          const key = `${record.sid}-${record.date}`;

          if (!existingRecords.has(key)) {
            await insertScore(record, existingRecords);
          } else {
            console.log(`⏩ Already exists: ${key}`);
          }

          record = null;
        } catch (err) {
          console.error(`❌ Error for ${site.site_name}: ${err.message}`);
          await logErrorToDatabase(site.id, site.site_name, `Approved site failed during processing: ${err.message}`, 'WARNING');
        }
      }

      logMemoryUsage();
    }

    console.log('✅ All done.');
  } catch (err) {
    console.error('❌ Error during main fetch:', err.message);
    await logErrorToDatabase(null, 'General API Error', err.message);
  }
};

const logMemoryUsage = () => {
  const used = process.memoryUsage();
  console.log(`📊 Memory - RSS: ${(used.rss / 1024 / 1024).toFixed(2)}MB, Heap: ${(used.heapUsed / 1024 / 1024).toFixed(2)}MB`);
};

app.get('/run-now', async (req, res) => {
  console.log(`📥 Manual run @ ${moment().tz('America/Los_Angeles').format()}`);
  await fetchAndInsertRecords();
  res.send('✅ ADA scores fetched and inserted.');
});

app.get('/api/status', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT date, COUNT(*) AS count
      FROM ada_scores
      GROUP BY date
      ORDER BY date DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Error fetching status summary:', err);
    res.status(500).json({ error: 'Failed to fetch status summary' });
  }
});

app.get('/api/today-records', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const result = await pool.query(
      `SELECT name, url, date FROM ada_scores WHERE date = $1`,
      [today]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Error fetching today records:', err);
    res.status(500).json({ error: 'Failed to fetch today records' });
  }
});

app.listen(port, () => {
  console.log(`🌐 Server on http://localhost:${port}`);
});
