CREATE TABLE IF NOT EXISTS services (
  id text PRIMARY KEY,
  name text NOT NULL,
  duration_minutes integer NOT NULL CHECK (duration_minutes > 0),
  active boolean NOT NULL DEFAULT true
);
INSERT INTO services (id, name, duration_minutes) VALUES
  ('consultation', 'Consultation', 30),
  ('extended-care', 'Extended care', 60)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY,
  version integer NOT NULL DEFAULT 0,
  state jsonb NOT NULL DEFAULT '{}',
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS appointments (
  reference text PRIMARY KEY,
  service_id text NOT NULL REFERENCES services(id),
  visitor_name text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  timezone text NOT NULL,
  status text NOT NULL DEFAULT 'confirmed' CHECK (status = 'confirmed'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  CONSTRAINT appointments_no_overlap EXCLUDE USING gist
    (tstzrange(starts_at, ends_at, '[)') WITH &&)
);
CREATE TABLE IF NOT EXISTS operations (
  operation_id text PRIMARY KEY,
  session_hash text NOT NULL REFERENCES sessions(token_hash),
  action text NOT NULL,
  fingerprint text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS performance_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_hash text NOT NULL REFERENCES sessions(token_hash),
  stage text NOT NULL,
  duration_ms double precision NOT NULL CHECK (duration_ms >= 0),
  result text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS voice_handoffs (
  ticket_hash text PRIMARY KEY,
  session_hash text NOT NULL REFERENCES sessions(token_hash),
  sealed_token text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS voice_requests (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_hash text NOT NULL REFERENCES sessions(token_hash),
  created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS voice_requests_created_at ON voice_requests(created_at);
