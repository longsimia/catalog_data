#!/bin/bash
set -e

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$APP_DIR"

echo "▶ 拉取最新版本..."
git fetch origin main
git reset --hard origin/main

echo "▶ 同步套件..."
npm install --silent

echo "▶ 重新載入服務..."
pm2 reload ecosystem.config.js --update-env

echo "✅ 更新完成"
