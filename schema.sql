-- License API schema (V4.2)
-- Customers + Agents (brokers) + Sales (commission accrual) + Payouts (withdraw)

CREATE TABLE IF NOT EXISTS agents (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT,
  commission_percent NUMERIC DEFAULT 0,
  balance NUMERIC DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS customers (
  id SERIAL PRIMARY KEY,
  customer_name TEXT NOT NULL,
  phone TEXT,
  product_id TEXT NOT NULL,
  license_key TEXT NOT NULL,
  machine_id TEXT,
  expire_at DATE,
  issued_at TIMESTAMP DEFAULT NOW(),
  popup_message TEXT,
  agent_id INT REFERENCES agents(id)
);

CREATE INDEX IF NOT EXISTS idx_customer_name ON customers(customer_name);
CREATE INDEX IF NOT EXISTS idx_expire_at ON customers(expire_at);
CREATE INDEX IF NOT EXISTS idx_customers_agent_id ON customers(agent_id);

CREATE TABLE IF NOT EXISTS sales (
  id SERIAL PRIMARY KEY,
  agent_id INT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  customer_id INT REFERENCES customers(id) ON DELETE SET NULL,
  sale_price NUMERIC NOT NULL,
  commission_percent NUMERIC NOT NULL,
  commission_amount NUMERIC NOT NULL,
  note TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sales_agent_id_created_at ON sales(agent_id, created_at);

CREATE TABLE IF NOT EXISTS payouts (
  id SERIAL PRIMARY KEY,
  agent_id INT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  amount NUMERIC NOT NULL,
  note TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payouts_agent_id_created_at ON payouts(agent_id, created_at);

-- Optional: seed initial agent "บูม"
-- INSERT INTO agents(name, phone, commission_percent) VALUES('บูม', '0888885588', 0);
