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

[ -f "${DIST}/manifest.json" ] || fail "缺少 extension/dist/manifest.json：请先在仓库根目录运行 npm ci && npm run build"
for entry in background.js content.js popup.html prepare.html; do
  [ -f "${DIST}/${entry}" ] || fail "extension/dist 不完整（缺少 ${entry}）：请重新运行 npm run build"
done

mkdir -p "$DEST"
/usr/bin/ditto "$DIST" "$DEST"
echo "已复制扩展资源到 .appex"
