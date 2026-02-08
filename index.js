console.log("API_KEY loaded =", process.env.API_KEY);

const express = require("express");
const cors = require("cors");
const { pool } = require("./db");

const app = express();
app.use(cors());
app.use(express.json());

// ✅ Auth Middleware รองรับทั้ง x-api-key และ Authorization Bearer (อ่าน ENV แบบ runtime ทุกครั้ง)
function auth(req, res, next) {
  const apiKeyHeader = req.headers["x-api-key"];
  const bearerHeader = req.headers["authorization"];

  let token = null;

  // Case 1: x-api-key
  if (apiKeyHeader) token = String(apiKeyHeader).trim();

  // Case 2: Authorization: Bearer xxx
  if (bearerHeader && String(bearerHeader).startsWith("Bearer ")) {
    token = String(bearerHeader).substring(7).trim();
  }

  const realKey = process.env.API_KEY ? String(process.env.API_KEY).trim() : "";

  if (!realKey) {
    console.log("❌ API_KEY missing in ENV");
    return res.status(500).json({ error: "Server misconfigured" });
  }

  if (!token || token !== realKey) {
    console.log("❌ AUTH FAIL", {
      hasToken: Boolean(token),
      tokenPreview: token ? token.slice(0, 4) + "****" : null,
    });
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
}

// ✅ Home route
app.get("/", (req, res) => {
  res.send("License API is running ✅");
});

// ✅ Health check
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// ✅ Create customer record
app.post("/api/customers", auth, async (req, res) => {
  try {
    const { customerName, phone, productId, licenseKey, expireAt } = req.body;

    const result = await pool.query(
      `INSERT INTO customers(customer_name, phone, product_id, license_key, expire_at)
       VALUES($1,$2,$3,$4,$5)
       RETURNING id`,
      [customerName, phone, productId, licenseKey, expireAt]
    );

    res.json({ ok: true, id: result.rows[0].id });
  } catch (err) {
    console.error("POST /api/customers error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ✅ List customers (sort by expire date)
app.get("/api/customers", auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM customers ORDER BY expire_at ASC`
    );

    res.json({ ok: true, rows: result.rows });
  } catch (err) {
    console.error("GET /api/customers error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ✅ Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("API running on", PORT));

