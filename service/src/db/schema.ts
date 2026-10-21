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
    kind TEXT NOT NULL CHECK (kind IN ('node')),
    state TEXT NOT NULL CHECK (state IN ('unverified','ok','missing','failed')),
    is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
    retired INTEGER NOT NULL DEFAULT 0 CHECK (retired IN (0,1)),
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
    last_verified_proxy_revision INTEGER,
    -- 预期出口不是节点参数：存放在环境上，可直接修改
    expected_exit_ip TEXT,
    binding_stage TEXT CHECK (binding_stage IS NULL OR binding_stage IN ('awaiting_profile','awaiting_extension','awaiting_association')),
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
    changed_since_page_check INTEGER NOT NULL DEFAULT 0 CHECK (changed_since_page_check IN (0,1)),
    updated_at TEXT NOT NULL
  );

  CREATE TABLE profile_bindings (
    profile_id TEXT PRIMARY KEY,
    environment_id TEXT NOT NULL UNIQUE REFERENCES environments(id),
    state TEXT NOT NULL CHECK (state IN ('bound','bound_unverified_id')),
    bound_at TEXT NOT NULL
  );

  -- 各场景最近上报的状态，只作提示，从不改变路由
  CREATE TABLE profile_reports (
    profile_id TEXT PRIMARY KEY,
    windows_open INTEGER NOT NULL,
    amazon_tabs_open INTEGER NOT NULL CHECK (amazon_tabs_open IN (0,1)),
    site_permission_granted INTEGER NOT NULL CHECK (site_permission_granted IN (0,1)),
    reported_at TEXT NOT NULL
  );

  CREATE TABLE deployments (
    generation INTEGER PRIMARY KEY,
    -- 带密钥摘要（HMAC），只在服务内部用于变化检测
    working_profile_digest TEXT,
    resource_digest TEXT NOT NULL,
    node_manifest TEXT NOT NULL,
    selection_before TEXT,
    state TEXT NOT NULL CHECK (state IN ('candidate','published','verified','failed','rolled_back')),
    readback_level TEXT CHECK (readback_level IS NULL OR readback_level IN ('full','partial')),
    unchecked_fields TEXT NOT NULL DEFAULT '[]',
    operation_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE deployment_operations (
    generation INTEGER NOT NULL REFERENCES deployments(generation),
    operation_id TEXT NOT NULL,
    environment_id TEXT,
    proxy_revision INTEGER,
    outcome TEXT,
    PRIMARY KEY (generation, operation_id)
  );

  -- 本应用拥有的对象清单；任何 Surge 或文件写入前先提交意图行，读回后确认
  CREATE TABLE managed_objects (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('group_segment','entry_segment','general_segment','resource_file','entry_ruleset_file','temp_rule')),
    identity TEXT NOT NULL,
    content_digest TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    state TEXT NOT NULL CHECK (state IN ('pending_add','present','pending_remove','removed')),
    created_by_operation TEXT,
    updated_at TEXT NOT NULL,
    UNIQUE (kind, identity)
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
    awaiting_deadline TEXT,
    warnings TEXT NOT NULL DEFAULT '[]',
    -- 激活快照：切换前状态，崩溃后用于回滚（JSON，无秘密）
    activation_snapshot TEXT,
    last_reconciled_at TEXT,
    surge_started_at TEXT,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE operations (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL UNIQUE,
    -- 对秘密值先做 HMAC 再规范化的带密钥摘要
    request_digest TEXT NOT NULL,
    kind TEXT NOT NULL,
    environment_id TEXT,
    initiator_kind TEXT NOT NULL CHECK (initiator_kind IN ('web','agent','admin','bridge','service')),
    initiator_profile_id TEXT,
    expected_revision INTEGER,
    result_revision INTEGER,
    route_epoch INTEGER,
    probe_kind TEXT CHECK (probe_kind IS NULL OR probe_kind IN ('preflight','safari')),
    phase TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued','running','waiting','succeeded','parked','failed','superseded','needs_attention')),
    superseded_by TEXT,
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
    node_name TEXT NOT NULL,
    route_epoch INTEGER,
    configuration_generation INTEGER,
    entry_mode TEXT,
    test_id TEXT,
    operation_id TEXT,
    surge_request_id TEXT,
    surge_remote_host TEXT,
    surge_rule TEXT,
    surge_policy TEXT,
    surge_started_at TEXT,
    surge_new_connection INTEGER,
    chain_evidence TEXT,
    browser_http_status INTEGER,
    browser_started_at TEXT,
    browser_finished_at TEXT,
    browser_error TEXT,
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
    purpose TEXT NOT NULL CHECK (purpose IN ('activate','apply_new_revision','reverify','probe_safari')),
    issued_at TEXT NOT NULL,
    deadline TEXT NOT NULL,
    consumed_at TEXT
  );

  CREATE TABLE capabilities (
    key TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('supported','unsupported','unverified')),
    context TEXT,
    protocol_coverage TEXT,
    proposal_id TEXT,
    verified_at TEXT,
    note TEXT
  );

  CREATE TABLE capability_proposals (
    id TEXT PRIMARY KEY,
    key TEXT NOT NULL,
    proposed_status TEXT NOT NULL CHECK (proposed_status IN ('supported','unsupported')),
    context TEXT NOT NULL,
    summary TEXT NOT NULL,
    evidence_digest TEXT NOT NULL,
    protocol_coverage TEXT,
    safari_process_paths TEXT,
    entry_strategy TEXT,
    submitted_by TEXT NOT NULL CHECK (submitted_by IN ('agent','admin')),
    submitted_at TEXT NOT NULL,
    confirmed_at TEXT,
    rejected_at TEXT
  );

  CREATE TABLE backups (
    id TEXT PRIMARY KEY,
    reason TEXT NOT NULL CHECK (reason IN ('init','remerge')),
    source_path TEXT NOT NULL,
    backup_directory TEXT NOT NULL,
    files TEXT NOT NULL,
    runtime_switches TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE secret_refs (
    ref TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('proxy','account','system')),
    owner_kind TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending','committed','orphaned')),
    created_at TEXT NOT NULL
  );

  -- 网页会话：令牌只存哈希；无 Cookie
  CREATE TABLE web_sessions (
    token_hash TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    revoked_at TEXT
  );

  CREATE TABLE login_codes (
    code_hash TEXT PRIMARY KEY,
    expires_at TEXT NOT NULL,
    used_at TEXT
  );
  `,
];
