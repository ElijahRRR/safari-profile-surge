#!/bin/sh
# SafariProfileSurge.app 的 Run Script：把固定版本的 Node 与 service/dist 复制进
# Contents/Resources（node、service/service.mjs、service/sfe.mjs、service/web/）。
# 只复制本机已有的文件，从不下载；缺少任何一项都让构建失败并说明原因。
# 由 Xcode 在签名 App 之前运行；Node 用与 App 相同的签名身份重新签名。
set -eu

fail() {
  # Xcode 把以 error: 开头的输出显示为构建错误
  echo "error: $*" >&2
  exit 1
}

: "${SRCROOT:?}" "${TARGET_BUILD_DIR:?}" "${UNLOCALIZED_RESOURCES_FOLDER_PATH:?}"
REPO_ROOT="$(cd "${SRCROOT}/../.." && pwd)"
SERVICE_DIST="${REPO_ROOT}/service/dist"
DEST="${TARGET_BUILD_DIR}/${UNLOCALIZED_RESOURCES_FOLDER_PATH}"

node_bin="${SFE_NODE_BINARY:-}"
node_pin="${SFE_NODE_VERSION:-}"
node_pin="${node_pin#v}"

[ -n "$node_bin" ] || fail "未设置 SFE_NODE_BINARY：请在 apps/macos/Local.xcconfig 中填写固定版本 Node 的绝对路径（见 Local.xcconfig.example）"
[ -n "$node_pin" ] || fail "未设置 SFE_NODE_VERSION：请在 apps/macos/Local.xcconfig 中填写 Node 版本号，例如 22.13.1"
case "$node_bin" in
  /*) ;;
  *) fail "SFE_NODE_BINARY 必须是绝对路径" ;;
esac
printf '%s\n' "$node_pin" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || fail "SFE_NODE_VERSION 格式不正确：应为 x.y.z，例如 22.13.1"
[ -f "$node_bin" ] && [ -x "$node_bin" ] || fail "找不到 Node：${node_bin} 不存在或不可执行"

major="${node_pin%%.*}"
rest="${node_pin#*.}"
minor="${rest%%.*}"
if [ "$major" -lt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -lt 13 ]; }; then
  fail "Node 版本过低：服务需要 22.13 或更高（node:sqlite），Local.xcconfig 固定为 ${node_pin}"
fi

actual="$("$node_bin" --version 2>/dev/null || true)"
[ "$actual" = "v${node_pin}" ] || fail "Node 版本不符：${node_bin} 报告 ${actual:-未知}，Local.xcconfig 固定为 v${node_pin}"

for entry in service.mjs sfe.mjs; do
  [ -f "${SERVICE_DIST}/${entry}" ] || fail "缺少 service/dist/${entry}：请先在仓库根目录运行 npm ci && npm run build"
done
[ -d "${SERVICE_DIST}/web" ] || fail "缺少 service/dist/web/：请先在仓库根目录运行 npm ci && npm run build"

mkdir -p "$DEST"
rm -rf "${DEST}/service" "${DEST}/node"
/usr/bin/ditto "$SERVICE_DIST" "${DEST}/service"
/usr/bin/ditto "$node_bin" "${DEST}/node"
chmod 0755 "${DEST}/node"

# App 包签名会封装 Resources 中的 Mach-O；先用与 App 相同的身份签名 Node（同团队签名）
if [ "${CODE_SIGNING_ALLOWED:-NO}" = "YES" ] && [ -n "${EXPANDED_CODE_SIGN_IDENTITY:-}" ]; then
  if [ "${ENABLE_HARDENED_RUNTIME:-NO}" = "YES" ]; then
    /usr/bin/codesign --force --sign "$EXPANDED_CODE_SIGN_IDENTITY" --identifier com.sfe.node --timestamp=none \
      --options runtime --entitlements "${SRCROOT}/Config/node.entitlements" "${DEST}/node" || fail "Node 签名失败"
  else
    /usr/bin/codesign --force --sign "$EXPANDED_CODE_SIGN_IDENTITY" --identifier com.sfe.node --timestamp=none \
      "${DEST}/node" || fail "Node 签名失败"
  fi
fi

echo "已嵌入 Node v${node_pin} 与 service/dist"
