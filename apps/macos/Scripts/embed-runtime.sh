#!/bin/sh
# SafariProfileSurge.app 的 Run Script：把固定版本的 Node 复制到 Contents/Helpers/node，
# 把 service/dist 复制到 Contents/Resources/service/（service.mjs、sfe.mjs、web/）。
# Node 是 Mach-O 可执行文件（代码），按 Apple「Placing content in a bundle」放在 Helpers：
#   “help app, helper tool | macOS | Contents/MacOS/, Contents/Helpers/”；“Resources are everything that’s not code.”；
#   “If you put content in the wrong location, you may encounter hard-to-debug code signing and distribution problems.”
#   （https://developer.apple.com/documentation/bundleresources/placing-content-in-a-bundle）
# service.mjs 与 web/ 是脚本与静态文件（资源），留在 Resources。
# 只复制本机已有的文件，从不下载；缺少任何一项都让构建失败并说明原因。
# 由 Xcode 在签名 App 之前运行；Node 用与 App 相同的签名身份重新签名（嵌套代码先于外层 App 签名）。
set -eu

fail() {
  # Xcode 把以 error: 开头的输出显示为构建错误
  echo "error: $*" >&2
  exit 1
}

: "${SRCROOT:?}" "${TARGET_BUILD_DIR:?}" "${UNLOCALIZED_RESOURCES_FOLDER_PATH:?}" "${CONTENTS_FOLDER_PATH:?}"
REPO_ROOT="$(cd "${SRCROOT}/../.." && pwd)"
SERVICE_DIST="${REPO_ROOT}/service/dist"
RESOURCES_DEST="${TARGET_BUILD_DIR}/${UNLOCALIZED_RESOURCES_FOLDER_PATH}"
# 与 project.yml 中 sfe-service-launcher 的 copy 目标（wrapper 下的 Contents/Helpers）相同
HELPERS_DEST="${TARGET_BUILD_DIR}/${CONTENTS_FOLDER_PATH}/Helpers"
NODE_DEST="${HELPERS_DEST}/node"

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

mkdir -p "$RESOURCES_DEST" "$HELPERS_DEST"
# 旧构建把 node 放在 Resources：增量构建时一并删除，Resources 中不留任何 Mach-O。
# 旧构建还会在 Helpers 中留下已删除的钥匙串工具 sfe-keychain（本项目不再使用钥匙串）：一并删除。
# 只删除本脚本负责的路径；Helpers 中的 sfe-service-launcher 由 Xcode 复制，不动。
rm -rf "${RESOURCES_DEST}/service" "${RESOURCES_DEST}/node" "$NODE_DEST" "${HELPERS_DEST}/sfe-keychain"
/usr/bin/ditto "$SERVICE_DIST" "${RESOURCES_DEST}/service"
/usr/bin/ditto "$node_bin" "$NODE_DEST"
chmod 0755 "$NODE_DEST"

# App 包签名把 Helpers 中的 Mach-O 当作嵌套代码封装，嵌套代码必须先签名：用与 App 相同的身份签名 Node（同团队签名）
if [ "${CODE_SIGNING_ALLOWED:-NO}" = "YES" ] && [ -n "${EXPANDED_CODE_SIGN_IDENTITY:-}" ]; then
  if [ "${ENABLE_HARDENED_RUNTIME:-NO}" = "YES" ]; then
    /usr/bin/codesign --force --sign "$EXPANDED_CODE_SIGN_IDENTITY" --identifier com.sfe.node --timestamp=none \
      --options runtime --entitlements "${SRCROOT}/Config/node.entitlements" "$NODE_DEST" || fail "Node 签名失败"
  else
    /usr/bin/codesign --force --sign "$EXPANDED_CODE_SIGN_IDENTITY" --identifier com.sfe.node --timestamp=none \
      "$NODE_DEST" || fail "Node 签名失败"
  fi
fi

echo "已嵌入 Node v${node_pin} 与 service/dist"
