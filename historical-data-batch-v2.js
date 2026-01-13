require('dotenv').config();
const axios = require('axios');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

// ===== DB =====
const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
  ssl: {
    rejectUnauthorized: false
  },
  connectionTimeoutMillis: 30000,
  idleTimeoutMillis: 20000,
  query_timeout: 120000,
  max: 50,
  min: 5
});

// ===== AUTH =====
const authHeader = `Basic ${Buffer.from(
  `${process.env.SITEIMPROVE_USERNAME}:${process.env.SITEIMPROVE_API_KEY}`
).toString('base64')}`;

// ===== URL NORMALIZATION (scheme-agnostic; drop www; normalize path; ignore default ports) =====
const normalizeUrlKey = (raw) => {
  if (!raw) return '';
  try {
    const parsed = new URL(raw.startsWith('http') ? raw : `http://${raw}`);
    let host = (parsed.hostname || '').toLowerCase().replace(/^www\./, '');
    const port =
      parsed.port && !['80', '443'].includes(parsed.port) ? `:${parsed.port}` : '';
    let p = (parsed.pathname || '/')
      .replace(/\/{2,}/g, '/')
      .replace(/\/+$/g, '/')
      .toLowerCase();
    if (p !== '/' && p.endsWith('/')) p = p.slice(0, -1);
    return `${host}${port}${p}`;
  } catch {
    // Fallback best-effort
    return raw
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .replace(/\/{2,}/g, '/')
      .replace(/\/+$/g, '/');
  }
};

// ===== APPROVED LIST (JSON) =====
const APPROVED_JSON_PATH = './checklist/approved_sites_clean.json';

const loadApprovedUrls = async () => {
  const rawData = fs.readFileSync(APPROVED_JSON_PATH, 'utf-8');
  const approvedList = JSON.parse(rawData); // [{ Title, URL }, ...]
  const rawCount = approvedList.length;

  const normalized = approvedList
    .filter(x => x && x.URL)
    .map(x => normalizeUrlKey(x.URL));
  const approvedSet = new Set(normalized);

  console.log(
    `Total Approved (raw): ${rawCount} | Approved (unique by key): ${approvedSet.size}`
  );
  return approvedSet;
};

(async () => {
  try {
    const args = process.argv.slice(2);
    const startDate = args[0] ? new Date(args[0]) : new Date('2025-05-01');
    const endDate = args[1] ? new Date(args[1]) : new Date();

    const approvedUrls = await loadApprovedUrls();

    const response = await axios.get(
      'https://api.eu.siteimprove.com/v2/sites?group_id=1183842&page_size=250',
      { headers: { Authorization: authHeader } }
    );

    const sites = (response.data.items || []).filter(site =>
      site.product && site.product.includes('accessibility')
    );

    console.log(`Accessible sites pulled: ${sites.length}`);

    const missingTargetLogs = [];

    for (
      let current = new Date(startDate);
      current <= endDate;
      current.setDate(current.getDate() + 1)
    ) {
      const dateStr = new Date(current).toISOString().split('T')[0];
      console.log(`Processing: ${dateStr}`);

      // Batch in chunks to avoid hammering the API
      for (let i = 0; i < sites.length; i += 20) {
        const batch = sites.slice(i, i + 20);
        const updates = [];

        for (const site of batch) {
          const normalizedSiteUrl = normalizeUrlKey(site.url);
          if (!approvedUrls.has(normalizedSiteUrl)) continue;

          try {
            const targetRes = await axios.get(
              `https://api.eu.siteimprove.com/v2/sites/${site.id}/a11y/overview/site_target/history`,
              { headers: { Authorization: authHeader } }
            );

            const targetEntry = (targetRes.data.items || []).find(entry => {
              // Siteimprove timestamps often look like "2025-06-15 00:00:00"
              const iso = new Date(
                entry.timestamp.trim().replace(' ', 'T')
              )
                .toISOString()
                .split('T')[0];
              return iso === dateStr;
            });

            if (targetEntry) {
              const score = parseFloat(targetEntry.site_target_percentage);
              if (!Number.isNaN(score)) {
                updates.push({ sid: site.id, date: dateStr, score });
              } else {
                missingTargetLogs.push({
                  sid: site.id,
                  name: site.site_name,
                  date: dateStr,
                  reason: 'site_target_percentage not a number'
                });
              }
            } else {
              console.log(
                `Missing site_target_percentage for ${site.site_name} on ${dateStr}`
              );
              missingTargetLogs.push({
                sid: site.id,
                name: site.site_name,
                date: dateStr,
                reason: 'No site_target_percentage'
              });
            }
          } catch (err) {
            console.error(`Error fetching for ${site.site_name}:`, err.message);
            missingTargetLogs.push({
              sid: site.id,
              name: site.site_name,
              date: dateStr,
              reason: `Fetch error: ${err.message}`
            });
          }
        }

        if (updates.length > 0) {
          const client = await pool.connect();
          try {
            const queries = updates.map(u =>
              client.query(
                `UPDATE ada_scores
                 SET site_target_score = $1
                 WHERE sid = $2 AND date = $3 AND site_target_score IS NULL`,
                [u.score, u.sid, u.date]
              )
            );
            await Promise.all(queries);
            console.log(
              `Batch updated ${updates.length} site_target_scores for ${dateStr}`
            );
          } catch (err) {
            console.error('Batch update error:', err.message);
          } finally {
            client.release();
          }
        }
      }

      if (missingTargetLogs.length > 0) {
        const logDir = path.join(__dirname, 'logs');
        if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

        const csvPath = path.join(logDir, `missing_site_target_${dateStr}.csv`);
        const csvContent =
          'Site ID,Site Name,Date,Reason\n' +
          missingTargetLogs
            .map(
              log =>
                `${log.sid},"${(log.name || '').replace(/"/g, '""')}",${log.date},${log.reason}`
            )
            .join('\n');
        fs.writeFileSync(csvPath, csvContent, 'utf8');
        console.log(`Log saved: ${csvPath}`);
        missingTargetLogs.length = 0; // reset for next day
      }
    }

    console.log('Done');
    process.exit(0);
  } catch (e) {
    console.error('Fatal error:', e);
    process.exit(1);
  }
})();
