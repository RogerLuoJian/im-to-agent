#!/bin/bash
#
# im-to-agent 系统服务管理脚本（macOS launchd）
# 用法: bash scripts/service.sh [install|uninstall|status|logs]
#

set -euo pipefail

SERVICE_NAME="com.im-to-agent"
PLIST_PATH="$HOME/Library/LaunchAgents/${SERVICE_NAME}.plist"

# 项目根目录（脚本所在的上一级）
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="${PROJECT_DIR}/logs"

NODE_PATH="$(which node)"
ENTRY_POINT="${PROJECT_DIR}/dist/index.js"

generate_env_vars() {
  # 注入 PATH，确保 launchd 环境能找到 node、claude 和 codex
  local node_bin_dir
  node_bin_dir="$(dirname "$NODE_PATH")"
  echo "      <key>PATH</key>"
  echo "      <string>${node_bin_dir}:/usr/local/bin:/usr/bin:/bin</string>"
}

do_install() {
  echo "==> 编译项目..."
  (cd "$PROJECT_DIR" && npm run build)

  if [[ ! -f "${PROJECT_DIR}/config.json" ]]; then
    echo "错误: 未找到 config.json，请先复制 config.json.example 并填入配置" >&2
    exit 1
  fi

  if [[ ! -f "$ENTRY_POINT" ]]; then
    echo "错误: 编译产物 dist/index.js 不存在" >&2
    exit 1
  fi

  echo "==> 创建日志目录..."
  mkdir -p "$LOG_DIR"

  # 如果服务已存在，先停止进程并卸载
  if launchctl list 2>/dev/null | grep -q "$SERVICE_NAME"; then
    echo "==> 检测到已有服务，先卸载..."
    # 杀掉残留的 node 进程
    pkill -f "$ENTRY_POINT" 2>/dev/null || true
    sleep 1
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
  fi

  echo "==> 生成 plist 配置..."
  local env_vars
  env_vars="$(generate_env_vars)"

  cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${SERVICE_NAME}</string>

    <key>ProgramArguments</key>
    <array>
        <string>${NODE_PATH}</string>
        <string>${ENTRY_POINT}</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${PROJECT_DIR}</string>

    <key>EnvironmentVariables</key>
    <dict>
${env_vars}
    </dict>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>${LOG_DIR}/stdout.log</string>

    <key>StandardErrorPath</key>
    <string>${LOG_DIR}/stderr.log</string>
</dict>
</plist>
PLIST

  echo "==> 加载服务..."
  launchctl load "$PLIST_PATH"

  echo ""
  echo "安装完成！服务已启动。"
  echo "  查看状态: bash scripts/service.sh status"
  echo "  查看日志: bash scripts/service.sh logs"
  echo "  卸载服务: bash scripts/service.sh uninstall"
}

do_uninstall() {
  if [[ ! -f "$PLIST_PATH" ]]; then
    echo "服务未安装"
    return
  fi

  echo "==> 停止残留进程..."
  pkill -f "$ENTRY_POINT" 2>/dev/null || true
  sleep 1

  echo "==> 卸载服务..."
  launchctl unload "$PLIST_PATH" 2>/dev/null || true
  rm -f "$PLIST_PATH"
  echo "服务已卸载"
}

do_status() {
  if ! launchctl list 2>/dev/null | grep -q "$SERVICE_NAME"; then
    echo "服务未运行"
    return 1
  fi

  echo "服务运行中:"
  launchctl list | grep "$SERVICE_NAME"
}

do_logs() {
  local stdout="${LOG_DIR}/stdout.log"
  local stderr="${LOG_DIR}/stderr.log"

  if [[ ! -f "$stdout" && ! -f "$stderr" ]]; then
    echo "暂无日志文件，服务可能尚未启动过"
    return 1
  fi

  echo "==> 日志输出 (Ctrl+C 退出)"
  tail -f "$LOG_DIR"/*.log
}

case "${1:-}" in
  install)   do_install ;;
  uninstall) do_uninstall ;;
  status)    do_status ;;
  logs)      do_logs ;;
  *)
    echo "用法: bash scripts/service.sh <command>"
    echo ""
    echo "命令:"
    echo "  install    编译项目并注册为系统服务（开机自启）"
    echo "  uninstall  卸载系统服务"
    echo "  status     查看服务运行状态"
    echo "  logs       实时查看服务日志"
    exit 1
    ;;
esac
