#!/bin/sh
# SafariProfileSurgeExtension.appex 的 Run Script：把 extension/dist（vite 构建结果）平铺复制进
# .appex 的 Contents/Resources。Safari 按扩展包的资源目录读取 manifest.json，因此不能多一层目录。
# 只复制本机已有的文件，从不下载；缺少构建结果时让构建失败。
set -eu

fail() {
  echo "error: $*" >&2
  exit 1
}

: "${SRCROOT:?}" "${TARGET_BUILD_DIR:?}" "${UNLOCALIZED_RESOURCES_FOLDER_PATH:?}"
REPO_ROOT="$(cd "${SRCROOT}/../.." && pwd)"
DIST="${REPO_ROOT}/extension/dist"
DEST="${TARGET_BUILD_DIR}/${UNLOCALIZED_RESOURCES_FOLDER_PATH}"

# 备选钥匙串方案的编译标志与 keychain-access-groups 权限必须同时打开或同时关闭：默认 entitlements 不声明这项
# 受限权限（否则扩展依赖会过期的描述文件），打开 SFE_DATA_PROTECTION_KEYCHAIN 时必须换成 Extension-DataProtection。
case " ${SWIFT_ACTIVE_COMPILATION_CONDITIONS:-} " in
  *" SFE_DATA_PROTECTION_KEYCHAIN "*) WANT_ENTITLEMENTS="Config/Extension-DataProtection.entitlements" ;;
  *) WANT_ENTITLEMENTS="Config/Extension.entitlements" ;;
esac
[ "${CODE_SIGN_ENTITLEMENTS:-}" = "$WANT_ENTITLEMENTS" ] || fail "扩展的 CODE_SIGN_ENTITLEMENTS 应为 ${WANT_ENTITLEMENTS}（与 SWIFT_ACTIVE_COMPILATION_CONDITIONS 中的 SFE_DATA_PROTECTION_KEYCHAIN 一致，见 apps/macos/README.md「钥匙串方案」）"

[ -f "${DIST}/manifest.json" ] || fail "缺少 extension/dist/manifest.json：请先在仓库根目录运行 npm ci && npm run build"
for entry in background.js content.js popup.html prepare.html; do
  [ -f "${DIST}/${entry}" ] || fail "extension/dist 不完整（缺少 ${entry}）：请重新运行 npm run build"
done

mkdir -p "$DEST"
/usr/bin/ditto "$DIST" "$DEST"
echo "已复制扩展资源到 .appex"
