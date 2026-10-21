// SQLite 结构的唯一定义。迁移按顺序执行，只追加不修改已发布的迁移。见 docs/ARCHITECTURE.md §4。

export const MIGRATIONS: readonly string[] = [
  /* 1 */ `
  CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE front_proxies (
    id TEXT PRIMARY KEY,
    surge_name TEXT NOT NULL UNIQUE,
    ownership TEXT NOT NULL CHECK (ownership IN ('user_existing','sfe_managed')),
    state TEXT NOT NULL CHECK (state IN ('unverified','ok','missing','failed')),
    is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
    last_checked_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX front_proxies_one_default ON front_proxies(is_default) WHERE is_default = 1;

  CREATE TABLE environments (
    id TEXT PRIMARY KEY,
    seq INTEGER NOT NULL UNIQUE,
    code TEXT NOT NULL UNIQUE,
    node_tag TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    site TEXT NOT NULL,
    auto_open_orders INTEGER NOT NULL CHECK (auto_open_orders IN (0,1)),
    auto_fill_login INTEGER NOT NULL CHECK (auto_fill_login IN (0,1)),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    desired_proxy_revision INTEGER,
    deployed_proxy_revision INTEGER,
    deleted_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX environments_display_name ON environments(display_name) WHERE deleted_at IS NULL;

  CREATE TABLE proxy_revisions (
    environment_id TEXT NOT NULL REFERENCES environments(id),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    protocol TEXT NOT NULL CHECK (protocol IN ('socks5')),
    host TEXT NOT NULL,
    port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
    username_ref TEXT,
    username_fp TEXT,
    password_ref TEXT,
    password_fp TEXT,
    front_proxy_id TEXT NOT NULL REFERENCES front_proxies(id),
    expected_exit_ip TEXT,
    node_name TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL CHECK (state IN ('desired','deployed','superseded','retired')),
    created_at TEXT NOT NULL,
    retired_at TEXT,
    PRIMARY KEY (environment_id, revision)
  );

  CREATE TABLE accounts (
    environment_id TEXT PRIMARY KEY REFERENCES environments(id),
    label TEXT,
    login_identifier TEXT,
    password_ref TEXT,
    password_fp TEXT,
    page_identity TEXT NOT NULL DEFAULT 'unverified' CHECK (page_identity IN ('unverified','recognized','mismatch')),
    changed_since_page_check INTEGER NOT NULL DEFAULT 0 CHECK (changed_since_page_check IN (0,1)),
    updated_at TEXT NOT NULL
  );

  CREATE TABLE profile_bindings (
    profile_id TEXT PRIMARY KEY,
    environment_id TEXT NOT NULL UNIQUE REFERENCES environments(id),
    bound_at TEXT NOT NULL
  );

  CREATE TABLE deployments (
    generation INTEGER PRIMARY KEY,
    working_profile_digest TEXT,
    resource_digest TEXT NOT NULL,
    node_manifest TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('candidate','published','verified','failed')),
    operation_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE route_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    route_epoch INTEGER NOT NULL,
    entry_mode TEXT NOT NULL CHECK (entry_mode IN ('NORMAL','BLOCKED','VERIFY_ONLY','ACTIVE','UNKNOWN')),
    entry_mode_verified_at TEXT,
    phase TEXT NOT NULL,
    active_environment_id TEXT REFERENCES environments(id),
    active_proxy_revision INTEGER,
    selected_node TEXT,
    old_session_policy TEXT CHECK (old_session_policy IS NULL OR old_session_policy IN ('closed_confirmed','keep_open_acknowledged')),
    operation_id TEXT,
    warnings TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL
  );

  CREATE TABLE operations (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL UNIQUE,
    request_digest TEXT NOT NULL,
    kind TEXT NOT NULL,
    environment_id TEXT,
    expected_revision INTEGER,
    result_revision INTEGER,
    route_epoch INTEGER,
    phase TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','parked','failed','needs_attention')),
    payload TEXT NOT NULL,
    result TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX operations_environment ON operations(environment_id, created_at);
  CREATE INDEX operations_status ON operations(status);

  CREATE TABLE operation_steps (
    operation_id TEXT NOT NULL REFERENCES operations(id),
    seq INTEGER NOT NULL,
    at TEXT NOT NULL,
    phase TEXT NOT NULL,
    message TEXT NOT NULL,
    PRIMARY KEY (operation_id, seq)
  );

  CREATE TABLE outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_id TEXT NOT NULL REFERENCES operations(id),
    resume_reason TEXT,
    available_at TEXT NOT NULL,
    claimed_at TEXT,
    done_at TEXT
  );
  CREATE INDEX outbox_pending ON outbox(done_at, available_at);

  CREATE TABLE probes (
    id TEXT PRIMARY KEY,
    environment_id TEXT NOT NULL REFERENCES environments(id),
    kind TEXT NOT NULL CHECK (kind IN ('preflight','safari')),
    outcome TEXT NOT NULL CHECK (outcome IN ('ok','failed','mismatch','inconclusive')),
    exit_ip TEXT,
    proxy_revision INTEGER NOT NULL,
    route_epoch INTEGER,
    surge_policy TEXT,
    surge_process_matched INTEGER,
    test_id TEXT,
    operation_id TEXT,
    message TEXT,
    observed_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE INDEX probes_env_kind ON probes(environment_id, kind, observed_at);

  CREATE TABLE verification_tests (
    test_id TEXT PRIMARY KEY,
    operation_id TEXT NOT NULL REFERENCES operations(id),
    environment_id TEXT NOT NULL REFERENCES environments(id),
    profile_id TEXT NOT NULL,
    route_epoch INTEGER NOT NULL,
    issued_at TEXT NOT NULL,
    deadline TEXT NOT NULL,
    consumed_at TEXT
  );

  CREATE TABLE capabilities (
    key TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('supported','unsupported','unverified')),
    surge_version TEXT,
    verified_at TEXT,
    evidence_ref TEXT,
    note TEXT
  );

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE secret_refs (
    ref TEXT PRIMARY KEY,
    state TEXT NOT NULL CHECK (state IN ('pending','committed','orphaned')),
    created_at TEXT NOT NULL
  );

  CREATE TABLE web_sessions (
    id_hash TEXT PRIMARY KEY,
    csrf_token TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  CREATE TABLE login_codes (
    code_hash TEXT PRIMARY KEY,
    expires_at TEXT NOT NULL,
    used_at TEXT
  );
  `,
];
