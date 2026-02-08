const { Pool } = require("pg");

// Railway แนะนำให้ใช้ DATABASE_URL
// ตัวอย่าง: postgresql://user:pass@host:port/db
const connectionString = process.env.DATABASE_URL;

const pool = new Pool({
  connectionString,
  // Railway บางโปรเจกต์ต้องใช้ SSL; ถ้าเจอปัญหาให้เปิดด้านล่าง
  // ssl: { rejectUnauthorized: false },
});

module.exports = { pool };
