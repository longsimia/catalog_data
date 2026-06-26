#!/bin/bash
set -e

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR="${DATA_DIR:-$HOME/catalog_data}"
LOG_FILE="${UPDATE_LOG_FILE:-$HOME/catalog_update.log}"
STATE_DIR="$DATA_DIR/.update_state"
LAST_UPDATE_FILE="$STATE_DIR/last_update_date"
LAST_NO_UPDATE_LOG_FILE="$STATE_DIR/last_no_update_log_date"
RUN_LOG_FILE="$(mktemp)"
LOG_FILE_TMP=""

mkdir -p "$STATE_DIR"
mkdir -p "$(dirname "$LOG_FILE")"

flush_run_log() {
  if [ ! -f "$RUN_LOG_FILE" ] || [ ! -s "$RUN_LOG_FILE" ]; then
    return
  fi

  if [ -f "$LOG_FILE" ] && [ -s "$LOG_FILE" ]; then
    LOG_FILE_TMP="$(mktemp)"
    cat "$RUN_LOG_FILE" "$LOG_FILE" > "$LOG_FILE_TMP"
    mv "$LOG_FILE_TMP" "$LOG_FILE"
    LOG_FILE_TMP=""
  else
    cp "$RUN_LOG_FILE" "$LOG_FILE"
  fi
}

cleanup_run_log() {
  flush_run_log
  rm -f "$RUN_LOG_FILE"
  if [ -n "$LOG_FILE_TMP" ]; then
    rm -f "$LOG_FILE_TMP"
  fi
}

log_line() {
  local line="$1"
  printf '%s\n' "$line" >> "$RUN_LOG_FILE"
  if [ -t 1 ]; then
    printf '%s\n' "$line"
  fi
}

log_block() {
  local block="$1"
  [ -n "$block" ] || return
  while IFS= read -r line || [ -n "$line" ]; do
    log_line "$line"
  done <<< "$block"
}

trap cleanup_run_log EXIT

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
  log_line "$(printf '[%s] ℹ️  %s 沒有版本更新' "$(date '+%F %T')" "$yesterday")"
  write_state_file "$LAST_NO_UPDATE_LOG_FILE" "$yesterday"
fi

cd "$APP_DIR"

fetch_output="$(git fetch origin main 2>&1)" || {
  log_line "$(printf '[%s] ❌ 拉取最新版本失敗' "$(date '+%F %T')")"
  log_block "$fetch_output"
  exit 1
}

LOCAL_SHA="$(git rev-parse HEAD)"
REMOTE_SHA="$(git rev-parse origin/main)"

if [ "$LOCAL_SHA" = "$REMOTE_SHA" ]; then
  exit 0
fi

log_line "$(printf '[%s] ▶ 偵測到新版本，開始更新' "$(date '+%F %T')")"
log_line "$(printf '    目前版本：%s' "$LOCAL_SHA")"
log_line "$(printf '    遠端版本：%s' "$REMOTE_SHA")"
if [ -n "$fetch_output" ]; then
  log_block "$fetch_output"
fi

git reset --hard origin/main

log_line "$(printf '[%s] ▶ 同步套件...' "$(date '+%F %T')")"
install_output="$(npm install --silent 2>&1)" || {
  log_line "$(printf '[%s] ❌ npm install 失敗' "$(date '+%F %T')")"
  log_block "$install_output"
  exit 1
}
if [ -n "$install_output" ]; then
  log_block "$install_output"
fi

log_line "$(printf '[%s] ▶ 重新載入服務...' "$(date '+%F %T')")"
reload_output="$(pm2 reload ecosystem.config.js --update-env 2>&1)" || {
  log_line "$(printf '[%s] ❌ PM2 reload 失敗' "$(date '+%F %T')")"
  log_block "$reload_output"
  exit 1
}
if [ -n "$reload_output" ]; then
  log_block "$reload_output"
fi

write_state_file "$LAST_UPDATE_FILE" "$today"
log_line "$(printf '[%s] ✅ 更新完成' "$(date '+%F %T')")"
