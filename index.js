// const { Pool } = require('pg');
// require('dotenv').config();

// const pool = new Pool({
//   host: process.env.DB_HOST,
//   user: process.env.DB_USER,
//   password: process.env.DB_PASSWORD,
//   database: process.env.DB_NAME,
//   port: process.env.DB_PORT,
// });

// const insertData = async () => {
//   const query = `
//     INSERT INTO site_history (site_id, site_name, url, dci_score, date, time)
//     VALUES ($1, $2, $3, $4, $5, $6)
//     RETURNING *;
//   `;
//   const values = [
//     12345, // site_id
//     'Test Site', // site_name
//     'https://example.com', // url
//     80.14, // dci_score
//     '2025-01-15', // date
//     '08:00:00', // time
//   ];

//   try {
//     const result = await pool.query(query, values);
//     console.log('Inserted:', result.rows[0]);
//   } catch (error) {
//     console.error('Error inserting data:', error);
//   } finally {
//     pool.end();
//   }
// };

// insertData();