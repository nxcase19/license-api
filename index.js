const express = require("express");
const cors = require("cors");
const { pool } = require("./db");

const app = express();
app.use(cors());
app.use(express.json());

const API_KEY = process.env.API_KEY;

function auth(req, res, next) {
  if (req.headers["x-api-key"] !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/api/customers", auth, async (req, res) => {
  const { customerName, phone, productId, licenseKey, expireAt } = req.body;

  const result = await pool.query(
    `INSERT INTO customers(customer_name, phone, product_id, license_key, expire_at)
     VALUES($1,$2,$3,$4,$5) RETURNING id`,
    [customerName, phone, productId, licenseKey, expireAt]
  );

  res.json({ ok: true, id: result.rows[0].id });
});

app.get("/api/customers", auth, async (req, res) => {
  const result = await pool.query(
    `SELECT * FROM customers ORDER BY expire_at ASC`
  );
  res.json({ ok: true, rows: result.rows });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("API running on", PORT));
