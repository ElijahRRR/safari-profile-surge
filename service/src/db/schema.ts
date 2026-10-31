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
  /* 2 */ `
  -- 秘密值（用户决定：不使用钥匙串）：代理凭据、账号密码与系统秘密（pepper）以明文保存在本数据库中，
  -- 只靠所有者专用的文件权限保护（数据目录 0700，数据库及其 -wal/-shm 0600）。引用见 secret_refs；
  -- 系统秘密（sfe.*）没有引用行。
  CREATE TABLE secret_values (
    ref TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('proxy','account','system')),
    value TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  -- 能力项 bridge_keychain_access（原生桥读取钥匙串）已随钥匙串一起移除：旧的能力记录与提议不再有意义
  DELETE FROM capabilities WHERE key = 'bridge_keychain_access';
  DELETE FROM capability_proposals WHERE key = 'bridge_keychain_access';
  `,
  /* 3 */ `
  -- pepper 与按它派生的 HMAC 在同一个数据库中（迁移 2）：持久保存的、由秘密值计算的带密钥摘要能让拿到数据目录副本的人离线
  -- 核对猜测的旧密码（已替换、已清扫的账号密码与代理密码）。见 docs/ARCHITECTURE.md §0「秘密的存放」。
  -- 旧格式（v1）的幂等请求摘要按秘密值的 HMAC 计算：改写为不可核对的值（之后同一 request_id 的重试按内容不同返回 409）；
  -- 新格式（v2:）不依赖秘密（engine/ledger.ts requestDigest）
  UPDATE operations SET request_digest = 'scrubbed-v1' WHERE request_digest NOT LIKE 'v2:%';
  UPDATE meta SET value = json_set(value, '$.digest', 'scrubbed-v1')
    WHERE key LIKE 'engine:req:%' AND json_valid(value) AND json_type(value, '$.digest') = 'text' AND json_extract(value, '$.digest') NOT LIKE 'v2:%';
  -- 已退役的代理版本：指纹只用于变化检测，退役之后不再需要
  UPDATE proxy_revisions SET username_fp = NULL, password_fp = NULL WHERE state = 'retired';
  -- 含已退役版本的发布记录：资源摘要覆盖当时的明文代理凭据，这些发布已无法重建
  UPDATE deployments SET resource_digest = 'scrubbed', working_profile_digest = NULL
    WHERE EXISTS (
      SELECT 1 FROM json_each(deployments.node_manifest) AS m
      JOIN proxy_revisions AS r
        ON r.environment_id = json_extract(m.value, '$.environmentId') AND r.revision = json_extract(m.value, '$.proxyRevision')
      WHERE r.state = 'retired'
    );
  `,
  /* 4 */ `
  -- 同一类（迁移 3）的其余两处：维护提交在操作中保存的预览摘要（previewDigest）按 pepper 派生的密钥对含秘密的内容计算——重新
  -- 合并覆盖当时 sfe-nodes.list 的明文买家代理凭据，初始化与重新合并覆盖工作配置中用户自己的节点凭据；与 backups/ 中的工作配置
  -- 副本一起，拿到数据目录副本的人能离线核对猜测的旧代理密码。改为只保存进程内随机密钥下的核对值（engine/maintenance.ts
  -- previewCheckOf），这里删除旧值（升级前受理、尚未执行的维护操作执行时按预览已过期处理，需要重新预览）。
  UPDATE operations SET payload = json_remove(payload, '$.previewDigest')
    WHERE kind IN ('maintenance.init', 'maintenance.remerge') AND json_valid(payload) AND json_type(payload, '$.previewDigest') IS NOT NULL;
  -- 早期版本的维护备份复制过本应用生成的文件（sfe-nodes.list 与四个 sfe-entry-*.list，含明文代理凭据），并在 backups.files 中
  -- 记下其内容的带密钥摘要：删去这些条目（用户按 INSTALL §6 删除复制的文件之后，摘要不能留下）
  UPDATE backups SET files = (
      SELECT json_group_array(json(f.value)) FROM json_each(backups.files) AS f
      WHERE NOT (ltrim(json_extract(f.value, '$.relativePath'), './') = 'sfe-nodes.list'
        OR ltrim(json_extract(f.value, '$.relativePath'), './') IN ('sfe-entry-udp.list', 'sfe-entry-verify.list', 'sfe-entry-block.list', 'sfe-entry-active.list'))
    )
    WHERE json_valid(files) AND EXISTS (
      SELECT 1 FROM json_each(backups.files) AS f
      WHERE ltrim(json_extract(f.value, '$.relativePath'), './') = 'sfe-nodes.list'
        OR ltrim(json_extract(f.value, '$.relativePath'), './') IN ('sfe-entry-udp.list', 'sfe-entry-verify.list', 'sfe-entry-block.list', 'sfe-entry-active.list')
    );
  `,
  /* 5 */ `
  -- 同一类（迁移 3）：JSON 导入的 records 用别名或驼峰写法的键（「代理密码」「登录密码」、proxy_pass、proxyPassword 等）提交时，
  -- 之前的请求摘要只认规范字段名，持久保存的 shape 按 pepper 派生的密钥覆盖了明文密码（没有 :s 标记）。现在 records 整体按秘密
  -- 处理（util/keyed-digest.ts）；这里把没有 :s 标记的导入批次摘要改写为不可核对的值（之后同一 request_id 的重试返回 409）。
  -- 带 :s 的（content_base64 或规范字段名）本来就不依赖秘密，保留。
  UPDATE operations SET request_digest = 'scrubbed-v1'
    WHERE kind = 'import.batch' AND request_digest LIKE 'v2:%' AND request_digest NOT LIKE '%:s';
  `,
  /* 6 */ `
  -- 同一类（迁移 3）：每次发布在 deployments.working_profile_digest 中保存整份工作配置按 pepper 派生密钥计算的摘要，没有期限。
  -- 工作配置含用户自己的节点凭据、http-api 密钥与 MITM 证书口令；与 backups/ 中的工作配置副本一起，拿到数据目录副本的人能离线
  -- 核对猜测的这些凭据（包括之后改过的）。改为只保存进程内随机密钥下的核对值（engine/handlers/publish.ts profileCheckOf），这里
  -- 清除旧值（它只用于「工作配置在受管理段之外有修改」的提示，清除后升级后的第一次发布不显示这条提示）。
  UPDATE deployments SET working_profile_digest = NULL WHERE working_profile_digest IS NOT NULL;
  `,
  /* 7 */ `
  -- D10（2026-10-31）：节点资源改由本机回环资源服务提供，SFE-ROUTE 的 policy-path 指向 http://127.0.0.1:<端口>/<读取令牌>/
  -- sfe-nodes.list，发布只对该资源执行一次单 key 更新并读回。设备实测证明 D7 的本地 policy-path 文件在自动重新加载关闭时不会被
  -- 重新读取（docs/verification/2026-10-24-fixed-profile-live.md），本地文件模型的两个能力项随之删除；connection_continuity
  -- 是按本地文件发布测得的，发布方式变了，记录的含义也变了，需要按回环发布重新测量。删除旧的能力记录与提议。
  DELETE FROM capabilities WHERE key IN ('targeted_resource_refresh', 'policy_path_reread', 'connection_continuity');
  DELETE FROM capability_proposals WHERE key IN ('targeted_resource_refresh', 'policy_path_reread', 'connection_continuity');
  -- 本地节点文件的写前摘要（engine/ownership.ts 的 mo_prev）与发布的写入对照（engine/handlers/publish.ts 的
  -- resource:writeBaseline）只属于本地文件模型，且按 pepper 派生的密钥覆盖含明文代理凭据的节点行（同迁移 3 的理由）：删除。
  -- GLOB 区分大小写且下划线不是通配符。managed_objects 中 resource_file 的记录不在这里改：旧的 sfe-nodes.list 可能仍在磁盘上，
  -- 由重新合并在确认改用本机资源服务之后删除文件并清除摘要。
  DELETE FROM meta WHERE key GLOB 'engine:mo_prev:resource_file:*';
  DELETE FROM meta WHERE key = 'engine:resource:writeBaseline';
  `,
];
