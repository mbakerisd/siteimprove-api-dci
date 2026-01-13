require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const moment = require('moment-timezone');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');

const app = express();
const port = process.env.PORT || 3000;

// Serve static assets from ./public (resolve from this file, not CWD)
app.use(express.static(path.join(__dirname, 'public')));

/** ====== AUTH ====== **/
const username = process.env.SITEIMPROVE_USERNAME;
const apiKey   = process.env.SITEIMPROVE_API_KEY;
const authHeader = `Basic ${Buffer.from(`${username}:${apiKey}`).toString('base64')}`;

let jobRunning = false;

/** ====== DB POOL ====== **/
const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: Number(process.env.DB_PORT) || 5432,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 30000,
  idleTimeoutMillis: 20000,
  query_timeout: 120000,
  max: 50,
  min: 5
});

pool.connect()
  .then(() => console.log('? Connected to PostgreSQL'))
  .catch(err => console.error('? Connection error:', err));

/** ====== URL NORMALIZATION ====== **/
const normalizeUrlKey = (raw) => {
  if (!raw) return '';
  try {
    const parsed = new URL(raw.startsWith('http') ? raw : `http://${raw}`);
    let host = (parsed.hostname || '').toLowerCase().replace(/^www\./, '');
    const port = parsed.port && !['80','443'].includes(parsed.port) ? `:${parsed.port}` : '';
    let p = (parsed.pathname || '/')
      .replace(/\/{2,}/g, '/')
      .replace(/\/+$/g, '/')
      .toLowerCase();
    if (p !== '/' && p.endsWith('/')) p = p.slice(0, -1);
    return `${host}${port}${p}`;
  } catch {
    return raw
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .replace(/\/{2,}/g, '/')
      .replace(/\/+$/g, '/');
  }
};

/** ====== APPROVED LIST (DISABLED) ====== **/
// Approved list checking has been disabled - all sites will be processed

/** ====== LOGGING HELPERS ====== **/
const logErrorToDatabase = async (siteId, siteName, errorMessage, level = 'ERROR') => {
  try {
    await pool.query(
      'INSERT INTO error_logs (site_id, site_name, message, level, timestamp) VALUES ($1, $2, $3, $4, NOW())',
      [siteId || null, siteName || null, errorMessage, level]
    );
    console.log(`?? Logged ${level} for site ${siteName}`);
  } catch (error) {
    console.error('? Failed to log error:', error);
  }
};

const fetchExistingRecords = async () => {
  const result = await pool.query('SELECT sid, date FROM ada_scores');
  return new Set(result.rows.map(row => `${row.sid}-${row.date}`));
};

/** ====== INSERTOR ====== **/
const insertScore = async (record, existingRecords, counters) => {
  const key = `${record.sid}-${record.date}`;
  if (existingRecords.has(key)) {
    counters.skippedExisting++;
    return false;
  }

  const query = `
    INSERT INTO ada_scores (sid, name, url, ada_a, ada_aa, ada_aaa, ada_aria, ada_score_total, site_target_score, date)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
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
    record.site_target_score,
    record.date,
  ];

  try {
    const result = await pool.query(query, values);
    if (result.rowCount > 0) {
      counters.inserted++;
      existingRecords.add(key);
      return true;
    } else {
      counters.skippedExisting++;
      return false;
    }
  } catch (err) {
    counters.insertErrors++;
    console.error(`? Insert failed for ${record.name}: ${err.message}`);
    await logErrorToDatabase(record.sid, record.name, err.message);
    return false;
  }
};

/** ====== UTIL ====== **/
const logMemoryUsage = () => {
  const used = process.memoryUsage();
  console.log(
    `?? Memory - RSS: ${(used.rss / 1024 / 1024).toFixed(2)}MB, Heap: ${(used.heapUsed / 1024 / 1024).toFixed(2)}MB`
  );
};

/** ====== MAIN FETCH/PROCESS ====== **/
const fetchAndInsertRecords = async () => {
  console.log('?? Starting Siteimprove pull...');
  const stats = {
    sitesPulled: 0,
    processed: 0,
    inserted: 0,
    skippedExisting: 0,
    targetInfoNotes: 0,
    targetErrors: 0,
    insertErrors: 0
  };

  const existingRecords = await fetchExistingRecords();

  try {
    const response = await axios.get(
      'https://api.eu.siteimprove.com/v2/sites?group_id=1183842&page_size=250',
      { headers: { 'Authorization': authHeader } }
    );

    const sites = (response.data.items || []).filter(site => site.product.includes('accessibility'));
    stats.sitesPulled = sites.length;
    console.log(`?? Total accessible sites pulled: ${sites.length}`);

    for (let i = 0; i < sites.length; i += 20) {
      const batch = sites.slice(i, i + 20);
      for (const site of batch) {
        const today = new Date().toISOString().split('T')[0];

        try {
          stats.processed++;
          console.log(`?? Processing site: ${site.site_name} (${site.id})`);

          const scoreResponse = await axios.get(
            `https://api.eu.siteimprove.com/v2/sites/${site.id}/dci/overview`,
            { headers: { 'Authorization': authHeader } }
          );

          let siteTarget = null;
          try {
            const targetResponse = await axios.get(
              `https://api.eu.siteimprove.com/v2/sites/${site.id}/a11y/overview/site_target/history`,
              { headers: { 'Authorization': authHeader } }
            );

            const todayStr = new Date().toISOString().split('T')[0];
            const todayTarget = (targetResponse.data.items || []).find(
              entry => typeof entry.timestamp === 'string' && entry.timestamp.startsWith(todayStr)
            );
            if (todayTarget) {
              siteTarget = parseFloat(todayTarget.site_target_percentage);
            } else {
              stats.targetInfoNotes++;
              await logErrorToDatabase(site.id, site.site_name, 'No site_target_percentage entry for today', 'INFO');
            }
          } catch (targetErr) {
            stats.targetErrors++;
            await logErrorToDatabase(site.id, site.site_name, `Target score fetch error: ${targetErr.message}`, 'INFO');
          }

          const { a, aa, aaa, aria, total } = scoreResponse.data.a11y;
          const record = {
            sid: site.id,
            name: site.site_name,
            url: site.url,
            ada_a: parseInt(a),
            ada_aa: parseInt(aa),
            ada_aaa: parseInt(aaa),
            ada_aria: parseInt(aria),
            ada_score_total: parseInt(total),
            site_target_score: siteTarget,
            date: today,
          };

          await insertScore(record, existingRecords, stats);
        } catch (err) {
          console.error(`? Error for ${site.site_name}: ${err.message}`);
          await logErrorToDatabase(site.id, site.site_name, `Approved site failed during processing: ${err.message}`, 'WARNING');
        }
      }

      logMemoryUsage();
    }

    console.log('? All done.');
    return stats;
  } catch (err) {
    console.error('? Error during main fetch:', err.message);
    await logErrorToDatabase(null, 'General API Error', err.message);
    throw err;
  }
};

/** ====== ROUTES ====== **/
app.get('/run-now', async (req, res) => {
  const ts = moment().tz('America/Los_Angeles').format('YYYY-MM-DD HH:mm:ss z');
  console.log(`?? Manual run @ ${ts}`);
  try {
    const before = Number((await pool.query('SELECT COUNT(*) FROM ada_scores')).rows[0].count);
    const stats  = await fetchAndInsertRecords();
    const after  = Number((await pool.query('SELECT COUNT(*) FROM ada_scores')).rows[0].count);

    res
      .status(200)
      .send(
        [
          '? Run complete.',
          `Sites pulled: ${stats.sitesPulled}`,
          `Processed: ${stats.processed}`,
          `Inserted: ${stats.inserted}`,
          `Skipped existing: ${stats.skippedExisting}`,
          `Target info notes: ${stats.targetInfoNotes}, target errors: ${stats.targetErrors}`,
          `Rows before: ${before}, after: ${after}`,
        ].join(' | ')
      );
  } catch (e) {
    res.status(500).send(`? Run failed: ${e.message}`);
  }
});

app.get('/run-batch', async (req, res) => {
  const { start, end } = req.query;
  if (!start || !end) return res.status(400).send('?? Start and end dates are required. Example: /run-batch?start=2025-06-01&end=2025-06-30');

  const batchScript = path.resolve(__dirname, 'historical-data-batch-v2.js');
  const command = `node "${batchScript}" ${start} ${end}`;
  console.log(`?? Running batch update: ${command}`);

  exec(command, (error, stdout, stderr) => {
    if (error) {
      console.error(`? Exec error: ${error.message}`);
      return res.status(500).send('? Batch run failed.');
    }
    if (stderr) console.error(`?? STDERR:\n${stderr}`);
    console.log(`?? STDOUT:\n${stdout}`);
    res.send('? Batch run completed. Check logs for details.');
  });
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
    console.error('? Error fetching status summary:', err);
    res.status(500).json({ error: 'Failed to fetch status summary' });
  }
});

app.get('/api/today-records', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const result = await pool.query(
      `SELECT name, url, date, site_target_score FROM ada_scores WHERE date = $1`,
      [today]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('? Error fetching today records:', err);
    res.status(500).json({ error: 'Failed to fetch today records' });
  }
});

app.listen(port, () => {
  console.log(`?? Server on http://localhost:${port}`);
});

/** ====== CRON SCHEDULER ====== **/
// TEST TIME (6:10 PM LA): '10 18 * * *'
// PROD TIME (4:30 PM LA): '30 16 * * *'
const SCHEDULE = process.env.CRON_EXPR || '35 18 * * *';


cron.schedule(SCHEDULE, async () => {
  const now = moment().tz('America/Los_Angeles').format('YYYY-MM-DD HH:mm:ss z');
  if (jobRunning) {
    console.log(`? Skipping scheduled run at ${now} (previous run still running)`);
    return;
  }
  jobRunning = true;
  console.log(`??? Scheduled run started @ ${now}`);
  try {
    const before = Number((await pool.query('SELECT COUNT(*) FROM ada_scores')).rows[0].count);
    const stats  = await fetchAndInsertRecords();
    const after  = Number((await pool.query('SELECT COUNT(*) FROM ada_scores')).rows[0].count);
    console.log(
      [
        '? Scheduled run complete.',
        `Sites pulled: ${stats.sitesPulled}`,
        `Processed: ${stats.processed}`,
        `Inserted: ${stats.inserted}`,
        `Skipped existing: ${stats.skippedExisting}`,
        `Rows before: ${before}, after: ${after}`,
      ].join(' | ')
    );
  } catch (e) {
    console.error(`? Scheduled run failed: ${e.message}`);
  } finally {
    jobRunning = false;
  }
}, { timezone: 'America/Los_Angeles' });
