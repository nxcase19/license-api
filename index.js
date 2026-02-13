// =======================================================
// License API V4.2 (PostgreSQL - Railway)
// Customers + Agents + Sales + Payouts
// FIXED: sales table uses "amount" (NOT sale_price)
// =======================================================

const express = require("express");
const cors = require("cors");
const { pool } = require("./db");

const app = express();
app.use(cors());
app.use(express.json());

// Accept both "MY_KEY" and "API_KEY=MY_KEY"
const RAW_API_KEY = process.env.API_KEY || "";
const API_KEY = RAW_API_KEY.startsWith("API_KEY=")
  ? RAW_API_KEY.replace("API_KEY=", "")
  : RAW_API_KEY;

// ================= AUTH =================

function auth(req, res, next) {
  const apiKeyHeader = req.headers["x-api-key"];
  const bearerHeader = req.headers["authorization"];

  let token = null;

  if (apiKeyHeader) token = apiKeyHeader;

  if (bearerHeader && bearerHeader.startsWith("Bearer ")) {
    token = bearerHeader.replace("Bearer ", "").trim();
  }

  if (!API_KEY || !token || token !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
}

// ================= BASIC =================

app.get("/", (req, res) => {
  res.send("License API is running 🚀 V4.2");
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// =======================================================
// ====================== AGENTS ==========================
// =======================================================

app.post("/api/agents", auth, async (req, res) => {
  try {
    const { name, phone, commissionPercent } = req.body;

    if (!name || String(name).trim() === "") {
      return res.status(400).json({ error: "name is required" });
    }

    const result = await pool.query(
      `INSERT INTO agents(name, phone, commission_percent)
       VALUES($1,$2,COALESCE($3,0))
       RETURNING id`,
      [String(name).trim(), phone || null, commissionPercent ?? 0]
    );

    res.json({ ok: true, id: result.rows[0].id });
  } catch (err) {
    console.error("POST /api/agents error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/agents", auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, phone, commission_percent, balance, created_at
       FROM agents
       ORDER BY name ASC`
    );

    res.json({ ok: true, rows: result.rows });
  } catch (err) {
    console.error("GET /api/agents error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// =======================================================
// ======================= SALES ===========================
// =======================================================

app.post("/api/sales", auth, async (req, res) => {
  const client = await pool.connect();

  try {
    const { agentId, customerId, amount, note } = req.body;

    const aId = Number(agentId);
    const cId = customerId == null ? null : Number(customerId);
    const amt = Number(amount);

    if (!Number.isFinite(aId))
      return res.status(400).json({ error: "agentId is required" });

    if (!Number.isFinite(amt) || amt <= 0)
      return res.status(400).json({ error: "amount must be > 0" });

    await client.query("BEGIN");

    const agentRes = await client.query(
      `SELECT id, commission_percent
       FROM agents
       WHERE id = $1
       FOR UPDATE`,
      [aId]
    );

    if (agentRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "agent not found" });
    }

    const commissionPercent =
      Number(agentRes.rows[0].commission_percent) || 0;

    const commissionAmount = (amt * commissionPercent) / 100;

    const saleRes = await client.query(
      `INSERT INTO sales(
          agent_id,
          customer_id,
          amount,
          commission_percent,
          commission_amount,
          note
       )
       VALUES($1,$2,$3,$4,$5,$6)
       RETURNING id`,
      [
        aId,
        Number.isFinite(cId) ? cId : null,
        amt,
        commissionPercent,
        commissionAmount,
        note || null,
      ]
    );

    await client.query(
      `UPDATE agents
       SET balance = balance + $1
       WHERE id = $2`,
      [commissionAmount, aId]
    );

    await client.query("COMMIT");

    res.json({
      ok: true,
      id: saleRes.rows[0].id,
      commissionPercent,
      commissionAmount,
    });
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}

    console.error("POST /api/sales error:", err);
    res.status(500).json({ error: "Server error" });
  } finally {
    client.release();
  }
});

// =======================================================
// ====================== PAYOUTS ==========================
// =======================================================

app.post("/api/payouts", auth, async (req, res) => {
  const client = await pool.connect();

  try {
    const { agentId, amount, note } = req.body;

    const aId = Number(agentId);
    const amt = Number(amount);

    if (!Number.isFinite(aId))
      return res.status(400).json({ error: "agentId is required" });

    if (!Number.isFinite(amt) || amt <= 0)
      return res.status(400).json({ error: "amount must be > 0" });

    await client.query("BEGIN");

    const agentRes = await client.query(
      `SELECT balance
       FROM agents
       WHERE id = $1
       FOR UPDATE`,
      [aId]
    );

    if (agentRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "agent not found" });
    }

    const balance = Number(agentRes.rows[0].balance) || 0;

    if (balance < amt) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "insufficient balance" });
    }

    const payoutRes = await client.query(
      `INSERT INTO payouts(agent_id, amount, note)
       VALUES($1,$2,$3)
       RETURNING id`,
      [aId, amt, note || null]
    );

    await client.query(
      `UPDATE agents
       SET balance = balance - $1
       WHERE id = $2`,
      [amt, aId]
    );

    await client.query("COMMIT");

    res.json({ ok: true, id: payoutRes.rows[0].id });
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}

    console.error("POST /api/payouts error:", err);
    res.status(500).json({ error: "Server error" });
  } finally {
    client.release();
  }
});

// =======================================================
// ===================== CUSTOMERS =========================
// =======================================================

app.post("/api/customers", auth, async (req, res) => {
  try {
    const {
      customerName,
      phone,
      productId,
      licenseKey,
      machineId,
      expireAt,
      popupMessage,
      agentId,
    } = req.body;

    if (!customerName || !productId || !licenseKey || !expireAt) {
      return res.status(400).json({
        error: "customerName, productId, licenseKey, expireAt are required",
      });
    }

    const result = await pool.query(
      `INSERT INTO customers(
          customer_name,
          phone,
          product_id,
          license_key,
          machine_id,
          expire_at,
          popup_message,
          agent_id
        )
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id`,
      [
        String(customerName).trim(),
        phone || null,
        String(productId).trim(),
        String(licenseKey).trim(),
        machineId || null,
        expireAt,
        popupMessage || null,
        agentId ? Number(agentId) : null,
      ]
    );

    res.json({ ok: true, id: result.rows[0].id });
  } catch (err) {
    console.error("POST /api/customers error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/customers", auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         c.*,
         a.name AS agent_name,
         a.phone AS agent_phone,
         a.commission_percent AS agent_commission_percent
       FROM customers c
       LEFT JOIN agents a ON a.id = c.agent_id
       ORDER BY c.expire_at ASC`
    );

    res.json({ ok: true, rows: result.rows });
  } catch (err) {
    console.error("GET /api/customers error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// =======================================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log("API running on", PORT)
);
