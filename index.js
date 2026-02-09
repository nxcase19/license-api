//license-api/index.js
const express = require("express");
const cors = require("cors");
const { pool } = require("./db");

const app = express();
app.use(cors());
app.use(express.json());

// Accept both "MY_KEY" and "API_KEY=MY_KEY" (copy/paste friendly)
const RAW_API_KEY = process.env.API_KEY || "";
const API_KEY = RAW_API_KEY.startsWith("API_KEY=")
  ? RAW_API_KEY.replace("API_KEY=", "")
  : RAW_API_KEY;

// ✅ Auth Middleware รองรับทั้ง x-api-key และ Authorization Bearer
function auth(req, res, next) {
  const apiKeyHeader = req.headers["x-api-key"];
  const bearerHeader = req.headers["authorization"];

  let token = null;

  // Case 1: x-api-key
  if (apiKeyHeader) token = apiKeyHeader;

  // Case 2: Authorization: Bearer xxx
  if (bearerHeader && bearerHeader.startsWith("Bearer ")) {
    token = bearerHeader.replace("Bearer ", "").trim();
  }

  if (!API_KEY || !token || token !== API_KEY) {
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

/**
 * =========================
 * V4.2: Agents / Broker + Popup Message
 * =========================
 * - customers: add popup_message + agent_id
 * - agents: manage brokers/agents and commission/balance
 * - sales: record sales and accrue commission to agent balance
 * - payouts: withdraw from agent balance (history)
 */

// ✅ Create agent
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

// ✅ List agents (with summary)
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

// ✅ Agent report: totals + history
app.get("/api/agents/:id/report", auth, async (req, res) => {
  const agentId = Number(req.params.id);
  if (!Number.isFinite(agentId))
    return res.status(400).json({ error: "invalid agent id" });

  try {
    const agentRes = await pool.query(
      `SELECT id, name, phone, commission_percent, balance, created_at
       FROM agents
       WHERE id = $1`,
      [agentId]
    );

    if (agentRes.rowCount === 0)
      return res.status(404).json({ error: "agent not found" });

    const totalsRes = await pool.query(
      `SELECT
         COALESCE(SUM(sale_price),0) AS sales_amount_total,
         COALESCE(SUM(commission_amount),0) AS commission_total
       FROM sales
       WHERE agent_id = $1`,
      [agentId]
    );

    const payoutTotalsRes = await pool.query(
      `SELECT COALESCE(SUM(amount),0) AS payouts_total
       FROM payouts
       WHERE agent_id = $1`,
      [agentId]
    );

    const salesRes = await pool.query(
      `SELECT s.id, s.customer_id, c.customer_name, s.sale_price, s.commission_percent, s.commission_amount, s.note, s.created_at
       FROM sales s
       LEFT JOIN customers c ON c.id = s.customer_id
       WHERE s.agent_id = $1
       ORDER BY s.created_at DESC
       LIMIT 200`,
      [agentId]
    );

    const payoutsRes = await pool.query(
      `SELECT id, amount, note, created_at
       FROM payouts
       WHERE agent_id = $1
       ORDER BY created_at DESC
       LIMIT 200`,
      [agentId]
    );

    res.json({
      ok: true,
      agent: agentRes.rows[0],
      totals: {
        salesAmountTotal: totalsRes.rows[0].sales_amount_total,
        commissionTotal: totalsRes.rows[0].commission_total,
        payoutsTotal: payoutTotalsRes.rows[0].payouts_total,
      },
      sales: salesRes.rows,
      payouts: payoutsRes.rows,
    });
  } catch (err) {
    console.error("GET /api/agents/:id/report error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ✅ Record a sale (adds commission to agent.balance)
// NOTE: DB column is sale_price (not amount)
app.post("/api/sales", auth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { agentId, customerId, amount, salePrice, sale_price, note } = req.body;

    const aId = Number(agentId);
    const cId = customerId == null ? null : Number(customerId);

    // Accept multiple input names (client-friendly)
    const rawPrice =
      salePrice ?? sale_price ?? amount; // support old "amount"
    const price = Number(rawPrice);

    if (!Number.isFinite(aId))
      return res.status(400).json({ error: "agentId is required" });
    if (!Number.isFinite(price) || price <= 0)
      return res.status(400).json({ error: "salePrice must be > 0" });

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
    const commissionAmount = (price * commissionPercent) / 100;

    const saleRes = await client.query(
      `INSERT INTO sales(agent_id, customer_id, sale_price, commission_percent, commission_amount, note)
       VALUES($1,$2,$3,$4,$5,$6)
       RETURNING id`,
      [
        aId,
        Number.isFinite(cId) ? cId : null,
        price,
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

    console.error("POST /api/sales error:", err?.message || err);
    if (err?.stack) console.error(err.stack);

    res.status(500).json({ error: "Server error" });
  } finally {
    client.release();
  }
});

// ✅ Payout (withdraw from agent.balance)
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
      `SELECT id, balance
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

    console.error("POST /api/payouts error:", err?.message || err);
    if (err?.stack) console.error(err.stack);

    res.status(500).json({ error: "Server error" });
  } finally {
    client.release();
  }
});

// ✅ Create customer record (now supports popupMessage + agentId)
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
          customer_name, phone, product_id, license_key, machine_id, expire_at, popup_message, agent_id
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
        agentId != null && agentId !== "" ? Number(agentId) : null,
      ]
    );

    res.json({ ok: true, id: result.rows[0].id });
  } catch (err) {
    console.error("POST /api/customers error:", err?.message || err);
    if (err?.stack) console.error(err.stack);

    res.status(500).json({ error: "Server error" });
  }
});

// ✅ List customers (supports search/sort + includes agent info)
app.get("/api/customers", auth, async (req, res) => {
  try {
    const q = (req.query.q || "").toString().trim();
    const sort = (req.query.sort || "expireAt").toString();
    const order =
      (req.query.order || "asc").toString().toLowerCase() === "desc"
        ? "DESC"
        : "ASC";

    const sortCol =
      sort === "issuedAt"
        ? "c.issued_at"
        : sort === "customerName"
        ? "c.customer_name"
        : "c.expire_at";

    const params = [];
    let where = "";
    if (q) {
      params.push(`%${q}%`);
      where = `WHERE (c.customer_name ILIKE $1 OR c.phone ILIKE $1 OR c.license_key ILIKE $1)`;
    }

    const sql = `
      SELECT
        c.*,
        a.name AS agent_name,
        a.phone AS agent_phone,
        a.commission_percent AS agent_commission_percent
      FROM customers c
      LEFT JOIN agents a ON a.id = c.agent_id
      ${where}
      ORDER BY ${sortCol} ${order}
    `;

    const result = await pool.query(sql, params);
    res.json({ ok: true, rows: result.rows });
  } catch (err) {
    console.error("GET /api/customers error:", err?.message || err);
    if (err?.stack) console.error(err.stack);

    res.status(500).json({ error: "Server error" });
  }
});

// ✅ Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("API running on", PORT));
