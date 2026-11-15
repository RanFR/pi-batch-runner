#!/usr/bin/env bash
# pi-batch-runner offline-distribution packing script.
#
# Packs the minimal whitelist needed to run the extension on an offline machine
# into dist/pi-batch-runner-<version>.tar.gz (with a sha256 checksum). The
# bundle ships installers for both platforms:
#   - Linux/macOS: install.sh (symlink by default; --copy to copy, --force to overwrite)
#   - Windows:     install.ps1 (Junction by default; -Copy / -Force / -Target <dir>)
# CHANGELOG.md is included so pi 1.5.0+ shows an update digest on next launch.
#
# Usage: bash scripts/pack.sh   (or npm run pack; runs from any cwd)
# Zero runtime dependencies: the extension only imports node: built-ins, so the
# target machine needs no npm install.
set -euo pipefail

# ---- Locate the repo root (runs from any cwd) ----
cd "$(cd "$(dirname "$0")/.." && pwd)"

NAME="pi-batch-runner"
STAGE="dist/stage"
PKG_DIR="$STAGE/$NAME"

# ---- Dependency check ----
for cmd in tar sha256sum node; do
	command -v "$cmd" >/dev/null 2>&1 || {
		echo "错误: 打包机缺少命令 $cmd" >&2
		exit 1
	}
done

# ---- Read the version and prepare the staging area ----
VERSION="$(node -p "JSON.parse(require('fs').readFileSync('package.json','utf8')).version")"
TARBALL="dist/${NAME}-${VERSION}.tar.gz"

rm -rf "$STAGE"
mkdir -p "$PKG_DIR/lib" "$PKG_DIR/examples"

# ---- Whitelist copy + integrity checks ----
copy() {
	local src="$1" dst="$2"
	if [ ! -s "$src" ]; then
		echo "错误: 缺少文件 $src" >&2
		exit 1
	fi
	cp "$src" "$dst"
}

copy index.ts "$PKG_DIR/index.ts"
copy package.json "$PKG_DIR/package.json"
copy CHANGELOG.md "$PKG_DIR/CHANGELOG.md"
copy README.md "$PKG_DIR/README.md"
copy examples/tasks.example.md "$PKG_DIR/examples/tasks.example.md"
for f in lib/*.ts; do
	copy "$f" "$PKG_DIR/$f"
done

LIB_COUNT="$(find "$PKG_DIR/lib" -maxdepth 1 -name '*.ts' -type f | wc -l)"
if [ "$LIB_COUNT" -ne 5 ]; then
	echo "错误: lib/*.ts 应为 5 个文件，实际暂存 $LIB_COUNT 个: $(ls -1 "$PKG_DIR/lib" | tr '\n' ' ')" >&2
	exit 1
fi

# ---- Import purity check (guards against future runtime deps missing from the bundle) ----
if grep -rn 'from "@' index.ts lib/*.ts | grep -v 'import type' >/dev/null; then
	echo "错误: 源码出现运行时外部依赖（打包策略只覆盖 node: 内置模块），请先处理：" >&2
	grep -rn 'from "@' index.ts lib/*.ts | grep -v 'import type' >&2 || true
	exit 1
fi

# ---- Best-effort typecheck gate ----
if [ -d node_modules ]; then
	echo "==> 运行 typecheck"
	npm run typecheck
else
	echo "警告: 未找到 node_modules，跳过 typecheck（质量门未执行）" >&2
fi

# ---- Generate the bundled install.sh (Linux/macOS) ----
cat >"$PKG_DIR/install.sh" <<'INSTALL_SH_EOF'
#!/usr/bin/env bash
# pi-batch-runner 安装脚本（Linux/macOS）
# 用法: bash install.sh [--copy] [--force]
#   --copy   复制安装（默认 symlink 安装）
#   --force  覆盖已存在的安装目标
set -euo pipefail

COPY=0
FORCE=0
for arg in "$@"; do
	case "$arg" in
	--copy) COPY=1 ;;
	--force) FORCE=1 ;;
	*)
		echo "未知参数: $arg" >&2
		echo "用法: bash install.sh [--copy] [--force]" >&2
		exit 1
		;;
	esac
done

SRC="$(cd "$(dirname "$0")" && pwd)"
TARGET="$HOME/.pi/agent/extensions/batch-runner"

if [ -e "$TARGET" ] || [ -L "$TARGET" ]; then
	if [ "$FORCE" -ne 1 ]; then
		echo "错误: 安装目标已存在: $TARGET（如需覆盖请加 --force）" >&2
		exit 1
	fi
	rm -rf "$TARGET"
fi

mkdir -p "$(dirname "$TARGET")"

if [ "$COPY" -eq 1 ]; then
	cp -r "$SRC" "$TARGET"
	echo "已复制安装到: $TARGET"
else
	ln -s "$SRC" "$TARGET"
	echo "已 symlink 安装: $TARGET -> $SRC"
fi
echo "重启 pi 后 /batch 命令可用。"
INSTALL_SH_EOF
chmod +x "$PKG_DIR/install.sh"

# ---- Generate the bundled install.ps1 (Windows PowerShell 5.1+) ----
# Note: write a temp file first, then prepend a UTF-8 BOM — PS 5.1 parses BOM-less
# files as ANSI, which would garble the Chinese text.
PS1_TMP="$PKG_DIR/.install.ps1.tmp"
cat >"$PS1_TMP" <<'INSTALL_PS1_EOF'
# pi-batch-runner 安装脚本（Windows PowerShell 5.1+）
# 用法: powershell -ExecutionPolicy Bypass -File install.ps1 [-Copy] [-Force] [-Target <dir>]
#   -Copy           复制安装（默认 Junction 安装，无需管理员/开发者模式）
#   -Force          覆盖已存在的安装目标
#   -Target <dir>   覆盖安装目标（默认 %USERPROFILE%\.pi\agent\extensions\batch-runner）
param(
    [switch]$Copy,
    [switch]$Force,
    [string]$Target
)

$ErrorActionPreference = 'Stop'

$Src = (Resolve-Path -LiteralPath $PSScriptRoot).Path
if (-not $Target) {
    $Target = Join-Path $env:USERPROFILE '.pi\agent\extensions\batch-runner'
}

if (Test-Path -LiteralPath $Target) {
    if (-not $Force) {
        Write-Error "安装目标已存在: $Target（如需覆盖请加 -Force）"
        exit 1
    }
    Remove-Item -LiteralPath $Target -Recurse -Force
}

$Parent = Split-Path -Parent $Target
if (-not (Test-Path -LiteralPath $Parent)) {
    New-Item -ItemType Directory -Path $Parent -Force | Out-Null
}

if ($Copy) {
    Copy-Item -LiteralPath $Src -Destination $Target -Recurse
    Write-Host "已复制安装到: $Target"
} else {
    New-Item -ItemType Junction -Path $Target -Value $Src | Out-Null
    Write-Host "已 Junction 安装: $Target -> $Src"
}
Write-Host "重启 pi 后 /batch 命令可用。"
INSTALL_PS1_EOF
printf '\xEF\xBB\xBF' | cat - "$PS1_TMP" > "$PKG_DIR/install.ps1"
rm -f "$PS1_TMP"

# ---- Build the tarball and checksum ----
mkdir -p dist
rm -f "$TARBALL" "${TARBALL}.sha256"
tar -czf "$TARBALL" -C "$STAGE" "$NAME"
(
	cd dist
	sha256sum "$(basename "$TARBALL")" >"$(basename "$TARBALL").sha256"
)

# ---- Summary ----
FILE_COUNT="$(tar -tzf "$TARBALL" | grep -vc '/$')"
echo ""
echo "==> 打包完成"
echo "产物: $TARBALL ($(du -h "$TARBALL" | cut -f1))"
echo "校验: $(cat "${TARBALL}.sha256")"
echo "包内文件数: $FILE_COUNT"
tar -tzf "$TARBALL"
echo ""
echo "目标机安装："
echo "  Linux/macOS: tar -xzf ${NAME}-${VERSION}.tar.gz && cd $NAME && bash install.sh"
echo "  Windows:     tar -xzf ${NAME}-${VERSION}.tar.gz && cd $NAME && powershell -ExecutionPolicy Bypass -File install.ps1"
