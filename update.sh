#!/bin/bash
set -e

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR="${DATA_DIR:-$HOME/catalog_data}"
STATE_DIR="$DATA_DIR/.update_state"
LAST_UPDATE_FILE="$STATE_DIR/last_update_date"
LAST_NO_UPDATE_LOG_FILE="$STATE_DIR/last_no_update_log_date"

mkdir -p "$STATE_DIR"

today="$(date +%F)"
yesterday="$(date -d 'yesterday' +%F)"

read_state_file() {
  local file="$1"
  if [ -f "$file" ]; then
    tr -d '\r\n' < "$file"
  fi
}

write_state_file() {
  local file="$1"
  local value="$2"
  printf '%s' "$value" > "$file"
}

last_update_date="$(read_state_file "$LAST_UPDATE_FILE")"
last_no_update_log_date="$(read_state_file "$LAST_NO_UPDATE_LOG_FILE")"

# 每天只補一筆「昨日無更新」摘要，避免每 5 分鐘都寫 log
if [ "$last_no_update_log_date" != "$yesterday" ] && [ "$last_update_date" != "$yesterday" ]; then
  printf '[%s] ℹ️  %s 沒有版本更新\n' "$(date '+%F %T')" "$yesterday"
  write_state_file "$LAST_NO_UPDATE_LOG_FILE" "$yesterday"
fi

cd "$APP_DIR"

fetch_output="$(git fetch origin main 2>&1)" || {
  printf '[%s] ❌ 拉取最新版本失敗\n' "$(date '+%F %T')" >&2
  printf '%s\n' "$fetch_output" >&2
  exit 1
}

LOCAL_SHA="$(git rev-parse HEAD)"
REMOTE_SHA="$(git rev-parse origin/main)"

if [ "$LOCAL_SHA" = "$REMOTE_SHA" ]; then
  exit 0
fi

printf '[%s] ▶ 偵測到新版本，開始更新\n' "$(date '+%F %T')"
printf '    目前版本：%s\n' "$LOCAL_SHA"
printf '    遠端版本：%s\n' "$REMOTE_SHA"
if [ -n "$fetch_output" ]; then
  printf '%s\n' "$fetch_output"
fi

git reset --hard origin/main

printf '[%s] ▶ 同步套件...\n' "$(date '+%F %T')"
install_output="$(npm install --silent 2>&1)" || {
  printf '[%s] ❌ npm install 失敗\n' "$(date '+%F %T')" >&2
  printf '%s\n' "$install_output" >&2
  exit 1
}
if [ -n "$install_output" ]; then
  printf '%s\n' "$install_output"
fi

printf '[%s] ▶ 重新載入服務...\n' "$(date '+%F %T')"
reload_output="$(pm2 reload ecosystem.config.js --update-env 2>&1)" || {
  printf '[%s] ❌ PM2 reload 失敗\n' "$(date '+%F %T')" >&2
  printf '%s\n' "$reload_output" >&2
  exit 1
}
if [ -n "$reload_output" ]; then
  printf '%s\n' "$reload_output"
fi

write_state_file "$LAST_UPDATE_FILE" "$today"
printf '[%s] ✅ 更新完成\n' "$(date '+%F %T')"
