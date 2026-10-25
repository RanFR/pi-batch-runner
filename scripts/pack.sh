#!/usr/bin/env bash
# pi-batch-runner 离线分发打包脚本。
#
# 把「保证插件在离线电脑上成功运行」的最小内容集（白名单）打成
# dist/pi-batch-runner-<version>.tar.gz（附 sha256），包内附带双平台安装脚本：
#   - Linux/macOS: install.sh（默认 symlink，--copy 复制，--force 覆盖）
#   - Windows:     install.ps1（默认 Junction，-Copy / -Force / -Target <dir>）
#
# 用法：bash scripts/pack.sh   （或 npm run pack；可从任意 cwd 运行）
# 运行时零外部依赖：本扩展只依赖 node: 内置模块，目标机无需 npm install。
set -euo pipefail

# ---- 定位仓库根（支持从任意 cwd 运行）----
cd "$(cd "$(dirname "$0")/.." && pwd)"

NAME="pi-batch-runner"
STAGE="dist/stage"
PKG_DIR="$STAGE/$NAME"

# ---- 依赖检查 ----
for cmd in tar sha256sum node; do
	command -v "$cmd" >/dev/null 2>&1 || {
		echo "错误: 打包机缺少命令 $cmd" >&2
		exit 1
	}
done

# ---- 读取版本并准备暂存区 ----
VERSION="$(node -p "JSON.parse(require('fs').readFileSync('package.json','utf8')).version")"
TARBALL="dist/${NAME}-${VERSION}.tar.gz"

rm -rf "$STAGE"
mkdir -p "$PKG_DIR/lib" "$PKG_DIR/examples"

# ---- 白名单复制 + 完整性校验 ----
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

# ---- import 纯净性检查（防止未来引入运行时外部依赖而打包遗漏）----
if grep -rn 'from "@' index.ts lib/*.ts | grep -v 'import type' >/dev/null; then
	echo "错误: 源码出现运行时外部依赖（打包策略只覆盖 node: 内置模块），请先处理：" >&2
	grep -rn 'from "@' index.ts lib/*.ts | grep -v 'import type' >&2 || true
	exit 1
fi

# ---- best-effort typecheck 门 ----
if [ -d node_modules ]; then
	echo "==> 运行 typecheck"
	npm run typecheck
else
	echo "警告: 未找到 node_modules，跳过 typecheck（质量门未执行）" >&2
fi

# ---- 生成包内 install.sh（Linux/macOS）----
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

# ---- 生成包内 install.ps1（Windows PowerShell 5.1+）----
# 注：先写入临时文件再加 UTF-8 BOM —— PS 5.1 对无 BOM 文件按 ANSI 解析，中文会乱码。
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

# ---- 打 tar 包与校验和 ----
mkdir -p dist
rm -f "$TARBALL" "${TARBALL}.sha256"
tar -czf "$TARBALL" -C "$STAGE" "$NAME"
(
	cd dist
	sha256sum "$(basename "$TARBALL")" >"$(basename "$TARBALL").sha256"
)

# ---- 摘要 ----
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
