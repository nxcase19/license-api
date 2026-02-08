const express = require("express");
const cors = require("cors");
const { pool } = require("./db");

const app = express();
app.use(cors());
app.use(express.json());

// ---- API KEY (robust) ----
const API_KEY_RAW = process.env.API_KEY || "";
const API_KEY = API_KEY_RAW
  .replace(/^API_KEY\s*=\s*/i, "")
  .trim()
  .replace(/^"|"$/g, "");

function auth(req, res, next) {
  const apiKeyHeader = req.headers["x-api-key"];
  const bearerHeader = req.headers["authorization"];

  let token = null;

  if (apiKeyHeader) token = apiKeyHeader;
  if (bearerHeader && bearerHeader.startsWith("Bearer ")) {
    token = bearerHeader.replace("Bearer ", "").trim();
  }
  if (token) token = String(token).trim();

  if (!token || token !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// ---- DB INIT (idempotent) ----
async function initDb() {
  // customers
  await pool.query(`
    CREATE TABLE IF NOT EXISTS customers (
      id SERIAL PRIMARY KEY,
      customer_name TEXT NOT NULL,
      phone TEXT,
      product_id TEXT NOT NULL,
      license_key TEXT NOT NULL,
      machine_id TEXT,
      popup_message TEXT,
      agent_id INT,
      expire_at DATE,
      issued_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // agents
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agents (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      commission_percent INT DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // sales: commission ledger (earned)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sales (
      id SERIAL PRIMARY KEY,
      customer_id INT REFERENCES customers(id) ON DELETE SET NULL,
      agent_id INT REFERENCES agents(id) ON DELETE SET NULL,
      sale_price NUMERIC NOT NULL,
      commission_percent INT NOT NULL,
      commission_amount NUMERIC NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // payouts: paid ledger
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payouts (
      id SERIAL PRIMARY KEY,
      agent_id INT REFERENCES agents(id) ON DELETE CASCADE,
      amount NUMERIC NOT NULL,
      note TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // seed agent "บูม" if missing
  const check = await pool.query(`SELECT id FROM agents WHERE name=$1 LIMIT 1`, ["บูม"]);
  if (check.rowCount === 0) {
    await pool.query(
      `INSERT INTO agents(name, phone, commission_percent) VALUES($1,$2,$3)`,
      ["บูม", "0888885588", 30]
    );
  }
}

// ---- Routes ----
app.get("/", (req, res) => {
  res.send("License API is running ✅");
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// -------- Customers --------
// Create customer record (agentId, popupMessage, machineId supported)
app.post("/api/customers", auth, async (req, res) => {
  try {
    const { customerName, phone, productId, licenseKey, machineId, popupMessage, agentId, expireAt } = req.body;

    if (!customerName) return res.status(400).json({ error: "customerName required" });
    if (!productId) return res.status(400).json({ error: "productId required" });
    if (!licenseKey) return res.status(400).json({ error: "licenseKey required" });

    const result = await pool.query(
      `INSERT INTO customers(customer_name, phone, product_id, license_key, machine_id, popup_message, agent_id, expire_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id`,
      [customerName, phone || null, productId, licenseKey, machineId || null, popupMessage || null, agentId || null, expireAt || null]
    );

    res.json({ ok: true, id: result.rows[0].id });
  } catch (err) {
    console.error("POST /api/customers error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// List customers with search + sort (join agents)
app.get("/api/customers", auth, async (req, res) => {
  try {
    const search = String(req.query.search || "").trim();
    const sort = String(req.query.sort || "expire_asc");

    let orderBy = "c.expire_at ASC NULLS LAST";
    if (sort === "expire_desc") orderBy = "c.expire_at DESC NULLS LAST";
    if (sort === "issued_desc") orderBy = "c.issued_at DESC";
    if (sort === "issued_asc") orderBy = "c.issued_at ASC";

    const params = [];
    let where = "";
    if (search) {
      params.push(`%${search}%`);
      where = `
        WHERE c.customer_name ILIKE $1
           OR COALESCE(c.phone,'') ILIKE $1
           OR COALESCE(c.product_id,'') ILIKE $1
           OR COALESCE(c.license_key,'') ILIKE $1
           OR COALESCE(a.name,'') ILIKE $1
           OR COALESCE(a.phone,'') ILIKE $1
      `;
    }

    const q = `
      SELECT
        c.*,
        a.name AS agent_name,
        a.phone AS agent_phone,
        a.commission_percent AS agent_commission_percent
      FROM customers c
      LEFT JOIN agents a ON a.id = c.agent_id
      ${where}
      ORDER BY ${orderBy}
      LIMIT 200
    `;

    const result = await pool.query(q, params);
    res.json({ ok: true, rows: result.rows });
  } catch (err) {
    console.error("GET /api/customers error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// -------- Agents --------
async function agentTotals(agentId = null) {
  const where = agentId ? "WHERE a.id=$1" : "";
  const params = agentId ? [agentId] : [];
  const q = `
    SELECT
      a.id,
      a.name,
      a.phone,
      a.commission_percent,
      COALESCE(se.earned, 0) AS earned,
      COALESCE(pa.paid, 0) AS paid,
      (COALESCE(se.earned, 0) - COALESCE(pa.paid, 0)) AS balance
    FROM agents a
    LEFT JOIN (
      SELECT agent_id, COALESCE(SUM(commission_amount),0) AS earned
      FROM sales
      GROUP BY agent_id
    ) se ON se.agent_id = a.id
    LEFT JOIN (
      SELECT agent_id, COALESCE(SUM(amount),0) AS paid
      FROM payouts
      GROUP BY agent_id
    ) pa ON pa.agent_id = a.id
    ${where}
    ORDER BY a.created_at ASC, a.id ASC
  `;
  const result = await pool.query(q, params);
  return result.rows;
}

// list agents with totals
app.get("/api/agents", auth, async (req, res) => {
  try {
    const rows = await agentTotals();
    res.json({ ok: true, rows });
  } catch (err) {
    console.error("GET /api/agents error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// create agent
app.post("/api/agents", auth, async (req, res) => {
  try {
    const { name, phone, commissionPercent } = req.body;
    if (!name) return res.status(400).json({ error: "name required" });
    if (!phone) return res.status(400).json({ error: "phone required" });

    const pct = Number(commissionPercent || 0);
    if (Number.isNaN(pct) || pct < 0 || pct > 100) {
      return res.status(400).json({ error: "commissionPercent must be 0-100" });
    }

    const result = await pool.query(
      `INSERT INTO agents(name, phone, commission_percent) VALUES($1,$2,$3) RETURNING id`,
      [name, phone, pct]
    );
    res.json({ ok: true, id: result.rows[0].id });
  } catch (err) {
    console.error("POST /api/agents error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// update agent
app.put("/api/agents/:id", auth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { name, phone, commissionPercent } = req.body;
    if (!id) return res.status(400).json({ error: "invalid id" });

    const pct = commissionPercent === undefined ? null : Number(commissionPercent);
    if (pct !== null && (Number.isNaN(pct) || pct < 0 || pct > 100)) {
      return res.status(400).json({ error: "commissionPercent must be 0-100" });
    }

    const cur = await pool.query(`SELECT * FROM agents WHERE id=$1`, [id]);
    if (cur.rowCount === 0) return res.status(404).json({ error: "agent not found" });

    const nextName = name !== undefined ? name : cur.rows[0].name;
    const nextPhone = phone !== undefined ? phone : cur.rows[0].phone;
    const nextPct = pct !== null ? pct : cur.rows[0].commission_percent;

    await pool.query(
      `UPDATE agents SET name=$1, phone=$2, commission_percent=$3 WHERE id=$4`,
      [nextName, nextPhone, nextPct, id]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("PUT /api/agents/:id error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// payout (deduct balance, no link to licenses)
app.post("/api/agents/:id/payouts", auth, async (req, res) => {
  try {
    const agentId = Number(req.params.id);
    const amount = Number(req.body.amount);
    const note = String(req.body.note || "");

    if (!agentId) return res.status(400).json({ error: "invalid agentId" });
    if (!amount || amount <= 0) return res.status(400).json({ error: "amount must be > 0" });

    const totals = await agentTotals(agentId);
    if (!totals || totals.length === 0) return res.status(404).json({ error: "agent not found" });

    const balance = Number(totals[0].balance || 0);
    if (amount > balance) {
      return res.status(400).json({ error: "amount exceeds balance" });
    }

    const result = await pool.query(
      `INSERT INTO payouts(agent_id, amount, note) VALUES($1,$2,$3) RETURNING id`,
      [agentId, amount, note]
    );

    res.json({ ok: true, id: result.rows[0].id });
  } catch (err) {
    console.error("POST /api/agents/:id/payouts error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// agent history (sales + payouts)
app.get("/api/agents/:id/history", auth, async (req, res) => {
  try {
    const agentId = Number(req.params.id);
    if (!agentId) return res.status(400).json({ error: "invalid agentId" });

    const agent = await pool.query(`SELECT * FROM agents WHERE id=$1`, [agentId]);
    if (agent.rowCount === 0) return res.status(404).json({ error: "agent not found" });

    const sales = await pool.query(
      `
      SELECT s.*, c.customer_name, c.product_id
      FROM sales s
      LEFT JOIN customers c ON c.id = s.customer_id
      WHERE s.agent_id=$1
      ORDER BY s.created_at DESC
      LIMIT 500
      `,
      [agentId]
    );

    const payouts = await pool.query(
      `SELECT * FROM payouts WHERE agent_id=$1 ORDER BY created_at DESC LIMIT 500`,
      [agentId]
    );

    const totals = (await agentTotals(agentId))[0];

    res.json({
      ok: true,
      agent: agent.rows[0],
      totals,
      sales: sales.rows,
      payouts: payouts.rows,
    });
  } catch (err) {
    console.error("GET /api/agents/:id/history error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// -------- Sales --------
// create sale: compute commission from agent %
app.post("/api/sales", auth, async (req, res) => {
  try {
    const customerId = Number(req.body.customerId);
    const agentId = Number(req.body.agentId);
    const salePrice = Number(req.body.salePrice);

    if (!customerId) return res.status(400).json({ error: "customerId required" });
    if (!agentId) return res.status(400).json({ error: "agentId required" });
    if (!salePrice || salePrice <= 0) return res.status(400).json({ error: "salePrice must be > 0" });

    const agent = await pool.query(`SELECT commission_percent FROM agents WHERE id=$1`, [agentId]);
    if (agent.rowCount === 0) return res.status(404).json({ error: "agent not found" });

    const pct = Number(agent.rows[0].commission_percent || 0);
    const commissionAmount = (salePrice * pct) / 100;

    const result = await pool.query(
      `INSERT INTO sales(customer_id, agent_id, sale_price, commission_percent, commission_amount)
       VALUES($1,$2,$3,$4,$5)
       RETURNING id`,
      [customerId, agentId, salePrice, pct, commissionAmount]
    );

    res.json({
      ok: true,
      id: result.rows[0].id,
      commissionPercent: pct,
      commissionAmount,
    });
  } catch (err) {
    console.error("POST /api/sales error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ---- Start ----
const PORT = process.env.PORT || 3000;

initDb()
  .then(() => {
    console.log("DB init ✅");
    if (API_KEY) console.log("API_KEY loaded ✅ (len=" + API_KEY.length + ")");
    else console.log("API_KEY missing ❌");
    app.listen(PORT, () => console.log("API running on", PORT));
  })
  .catch((err) => {
    console.error("DB init failed:", err);
    process.exit(1);
  });
