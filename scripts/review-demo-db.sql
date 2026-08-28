-- Demo database for Apple App Review.
--
-- Postgly shows an empty connection list until it reaches a Postgres server,
-- so a reviewer needs one to evaluate the app at all. This provisions a
-- throwaway store schema plus a login role to hand them in the App Review
-- Information notes.
--
-- Run against a fresh managed Postgres (Neon, Supabase, Aiven):
--
--   psql "$REVIEW_DB_URL" -v reviewer_password="'<pick-one>'" \
--        -f scripts/review-demo-db.sql
--
-- The role gets read and write on this schema only. The data is disposable —
-- letting the reviewer insert and edit rows means the record editor can be
-- exercised without an error that reads like a bug.

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------- schema ----

DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;

CREATE TABLE customers (
  id         serial PRIMARY KEY,
  name       text NOT NULL,
  email      text UNIQUE NOT NULL,
  country    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE products (
  id          serial PRIMARY KEY,
  sku         text UNIQUE NOT NULL,
  name        text NOT NULL,
  price_cents integer NOT NULL CHECK (price_cents >= 0),
  in_stock    integer NOT NULL DEFAULT 0
);

CREATE TABLE orders (
  id          serial PRIMARY KEY,
  customer_id integer NOT NULL REFERENCES customers(id),
  status      text NOT NULL DEFAULT 'pending',
  total_cents integer NOT NULL,
  placed_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE order_items (
  id         serial PRIMARY KEY,
  order_id   integer NOT NULL REFERENCES orders(id),
  product_id integer NOT NULL REFERENCES products(id),
  quantity   integer NOT NULL CHECK (quantity > 0),
  unit_cents integer NOT NULL
);

CREATE INDEX idx_orders_customer ON orders(customer_id);
CREATE INDEX idx_orders_status   ON orders(status);

-- ------------------------------------------------------------------ data ----

INSERT INTO customers (name, email, country) VALUES
  ('Ana Ribeiro',     'ana.ribeiro@example.com',     'BR'),
  ('Lucas Moreira',   'lucas.moreira@example.com',   'BR'),
  ('Sofia Almeida',   'sofia.almeida@example.com',   'PT'),
  ('James Carter',    'james.carter@example.com',    'US'),
  ('Yuki Tanaka',     'yuki.tanaka@example.com',     'JP'),
  ('Marta Silva',     'marta.silva@example.com',     'BR'),
  ('Diego Fernandez', 'diego.fernandez@example.com', 'AR'),
  ('Chloe Dubois',    'chloe.dubois@example.com',    'FR'),
  ('Omar Haddad',     'omar.haddad@example.com',     'AE'),
  ('Nina Kowalski',   'nina.kowalski@example.com',   'PL');

INSERT INTO products (sku, name, price_cents, in_stock) VALUES
  ('KB-001', 'Mechanical Keyboard',         18900,  42),
  ('MS-002', 'Wireless Mouse',               7450, 130),
  ('MN-003', '27" 4K Monitor',             129900,  17),
  ('DK-004', 'USB-C Dock',                  24900,  64),
  ('HP-005', 'Noise Cancelling Headphones', 34900,  28),
  ('CH-006', 'Ergonomic Chair',             89900,   9),
  ('WC-007', '1080p Webcam',                12900,  75),
  ('SD-008', '1TB NVMe SSD',                15900,  88);

INSERT INTO orders (customer_id, status, total_cents, placed_at)
SELECT (random() * 9)::int + 1,
       (ARRAY['pending','paid','shipped','delivered','refunded'])[(random() * 4)::int + 1],
       (random() * 250000)::int + 5000,
       now() - (random() * 120)::int * interval '1 day'
FROM generate_series(1, 240);

INSERT INTO order_items (order_id, product_id, quantity, unit_cents)
SELECT (random() * 239)::int + 1,
       (random() * 7)::int + 1,
       (random() * 3)::int + 1,
       (random() * 100000)::int + 5000
FROM generate_series(1, 600);

ANALYZE;

-- ------------------------------------------------------------------ role ----
-- Read and write on this schema, nothing else. No superuser, no CREATEDB,
-- no CREATEROLE, so the credentials in the review notes can't reach past
-- the demo data.

-- The attributes go on CREATE, not a later ALTER: on managed Postgres the
-- admin role is not a superuser, and altering the SUPERUSER attribute at all
-- — even to turn it off — is superuser-only. They are the defaults anyway;
-- naming them keeps the intent readable.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'appreview') THEN
    CREATE ROLE appreview LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END
$$;

ALTER ROLE appreview WITH PASSWORD :reviewer_password;

-- CONNECT usually comes from PUBLIC, but some managed providers revoke it.
-- GRANT ... ON DATABASE needs a literal name, hence the dynamic statement.
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO appreview', current_database());
END
$$;

GRANT USAGE ON SCHEMA public TO appreview;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO appreview;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO appreview;

-- Keep the grants working for anything added to the schema later.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO appreview;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO appreview;

SELECT 'appreview ready — ' || count(*) || ' tables granted'
FROM information_schema.tables WHERE table_schema = 'public';
