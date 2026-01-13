require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const moment = require('moment-timezone');
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');

const app = express();
const port = 3000;

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
  ssl: false,
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

const batchUpdateSiteTargetScores = async (updates) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const updatePromises = updates.map(update => {
      return client.query(
        'UPDATE ada_scores_backup SET site_target_score = $1 WHERE sid = $2 AND date = $3',
        [update.score, update.sid, update.date]
      );
    });
    await Promise.all(updatePromises);
    await client.query('COMMIT');
    console.log(`✅ Batch updated ${updates.length} site_target_scores.`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Batch update failed:', err.message);
  } finally {
    client.release();
  }
};

const fetchAndUpdateTargetScores = async () => {
  console.log('🚀 Starting site_target_score sync...');
  const approvedUrls = await loadApprovedUrls();
  const missingTargetLogs = [];

  try {
    const response = await axios.get('https://api.eu.siteimprove.com/v2/sites?group_id=1183842&page_size=200', {
      headers: { 'Authorization': authHeader },
    });

    const sites = response.data.items.filter(site => site.product.includes('accessibility'));
    console.log(`🔎 Total accessible sites pulled: ${sites.length}`);

    const startDate = new Date('2025-05-01');
    const endDate = new Date();

    for (let current = new Date(startDate); current <= endDate; current.setDate(current.getDate() + 1)) {
      const dateStr = current.toISOString().split('T')[0];
      console.log(`📅 Checking site_target_scores for: ${dateStr}`);

      const updates = [];

      for (const site of sites) {
        const normalizedSiteUrl = stripProtocol(site.url);

        if (!approvedUrls.has(normalizedSiteUrl)) {
          continue;
        }

        try {
          const targetResponse = await axios.get(`https://api.eu.siteimprove.com/v2/sites/${site.id}/a11y/overview/site_target/history`, {
            headers: { 'Authorization': authHeader },
          });

          const targetEntry = targetResponse.data.items.find(entry => {
            const entryDate = new Date(entry.timestamp.trim().replace(' ', 'T')).toISOString().split('T')[0];
            return entryDate === dateStr;
          });

          if (targetEntry) {
            const score = parseFloat(targetEntry.site_target_percentage);
            updates.push({ sid: site.id, date: dateStr, score });
          } else {
            console.log(`⚠️ No site_target_percentage for ${site.site_name} on ${dateStr}`);
            missingTargetLogs.push({ sid: site.id, name: site.site_name, date: dateStr, reason: 'No site_target_percentage' });
          }
        } catch (err) {
          console.error(`❌ Target API error for ${site.site_name}: ${err.message}`);
          await logErrorToDatabase(site.id, site.site_name, `Target score fetch error: ${err.message}`, 'INFO');
        }
      }

      if (updates.length > 0) {
        await batchUpdateSiteTargetScores(updates);
      }

      if (missingTargetLogs.length > 0) {
        const logDir = path.join(__dirname, 'logs');
        if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);

        const csvPath = path.join(logDir, `missing_site_target_${dateStr}.csv`);
        const csvContent = 'Site ID,Site Name,Date,Reason\n' + missingTargetLogs.map(log => `${log.sid},"${log.name}",${log.date},${log.reason}`).join('\n');
        fs.writeFileSync(csvPath, csvContent, 'utf8');
        console.log(`📝 Missing site_target logs saved to ${csvPath}`);
        missingTargetLogs.length = 0;
      }
    }

    console.log('✅ All done syncing target scores.');
  } catch (err) {
    console.error('❌ Error during target fetch:', err.message);
    await logErrorToDatabase(null, 'General API Error', err.message);
  }
};

app.get('/run-now', async (req, res) => {
  console.log(`📥 Manual run @ ${moment().tz('America/Los_Angeles').format()}`);
  await fetchAndUpdateTargetScores();
  res.send('✅ site_target_scores synced and updated.');
});

app.listen(port, () => {
  console.log(`🌐 Server on http://localhost:${port}`);
});
