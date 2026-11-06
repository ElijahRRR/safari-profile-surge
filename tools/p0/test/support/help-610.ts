// Surge Mac 6.10.0（12500）内置帮助的离线样本：顶层 --help 与 inventory 读取的 `help <command>`。文字取自官方安装包
// （https://dl.nssurge.com/mac/v6/Surge-6.10.0-12500-79b87792e2bd345e064c2d473790b404.zip）中 surge-cli 的帮助字符串，
// 只保留与本项目原语有关的部分；测试 Mac 上的实际输出以 inventory 保存的原文为准（P0-RUNBOOK §4）。

export const TOP_HELP_610 = `Surge CLI
Usage: surge-cli <command> [arguments]
Command groups:
  Status       status, summary, version
  Routing      mode, global-policy, policy-group, rule match, rule explain, rule temp
  Profile      profile, module, feature, managed-profile, external-resource
  Network      dns, geoip, http probe, test, diagnostics, flush dns
  Inspection   dump, watch, log, logbook, proxy-runtime-status
  Control      reload, restart-engine, switch-profile, kill, stop, unattended-upgrade
  Environment  environment, set, set-log-level
Use \`help <command>\` for detailed usage, for example:
  help rule match
  help dump
Available parameters:
  --raw - Output raw JSON and skip client-side command validation (pass unknown commands through)
  --remote/-r <host:port> - Connect to a remote Surge instance. IPv6 uses [address]:port
  --password-stdin - Read the remote password from the first line of stdin
Utilities:
  lsp - Start the offline language server over stdin/stdout.
  --check/-c <path> - Check whether a profile is valid.
`;

export const TOPIC_HELP_610: Record<string, string> = {
  dump: `Usage: dump <type> [arguments]
Connection data: active, recent, request
Traffic data: traffic, traffic-stat [prefix], traffic-stat-host
Configuration: rule, temp-rule, policy, policy-group-sub-policies, profile [original|effective]
Runtime data: dns, auto-test-group-result, smart-group-info, event, performance, rule-usage
`,
  'rule temp': `Usage: rule temp <list | add <rule> | remove <rule> | set-policy <rule> <policy> | flush>. Quote a rule that contains commas and spaces.
  rule temp list                       Show active temporary rules
  rule temp add <rule>                 Add a temporary rule with the highest priority
  rule temp remove <rule>              Remove one temporary rule by its exact text
  rule temp set-policy <rule> <policy> Change the policy of a temporary rule
  rule temp flush                      Remove all temporary rules
Temporary rules take effect immediately, precede all profile rules, and are discarded when Surge stops.
`,
  'rule match': `Usage: rule <match|explain> <host|url> [port] [key=value ...]
Evaluate the active rule set without creating a connection, then show the matched rule and final policy.
Options:
  dest-port=<0-65535>       Destination port (alias: port)
  process-path=<path>       Source process path; affects PROCESS-NAME rules
  protocol=<name>           Protocol, such as TCP, UDP, HTTP, HTTPS, QUIC, or STUN
Examples:
  rule match example.com port=443 protocol=HTTPS process-path=/usr/bin/curl
`,
  'external-resource': `Usage:
  external-resource list
  external-resource update <key|all>
List or update external resources used by the active profile.
`,
  version: `Usage: version
Show Surge, Core, Controller protocol, system, and device versions.
`,
  status: `Usage: status
Show the current profile and path, outbound mode, feature states, uptime, and version.
`,
  'policy-group': `Usage:
  policy-group list
  policy-group get <group>
  policy-group set <group> <policy|auto>
`,
  feature: `Usage: feature <list | get <name> | set <name> <on|off>>
Features: mitm, rewrite, scripting, capture, packet-capture, cellular-mode.
macOS also supports system-proxy and enhanced-mode.
`,
  mode: `Usage: mode [get | set <rule|direct|proxy>]
Show or change the outbound mode.
`,
  kill: `Usage: kill <connection-id>
Terminate an active connection.
`,
};
