#!/bin/bash
# ═══════════════════════════════════════════════════
#  素材庫 一鍵安裝腳本（Ubuntu + Oracle Cloud VM）
#  執行方式：bash setup.sh
# ═══════════════════════════════════════════════════
set -e

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR="${DATA_DIR:-$HOME/catalog_data}"
PORT=3000

echo ""
echo "════════════════════════════════════════"
echo "  素材庫安裝腳本"
echo "════════════════════════════════════════"
echo ""

# 1. 安裝 Node.js 20
echo "▶ [1/5] 安裝 Node.js 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - > /dev/null 2>&1
sudo apt-get install -y nodejs > /dev/null 2>&1
echo "    Node.js $(node -v) 安裝完成"

# 2. 建立目錄
echo "▶ [2/5] 建立目錄結構..."
mkdir -p "$APP_DIR/public"
mkdir -p "$DATA_DIR/uploads"
echo "    程式碼目錄：$APP_DIR"
echo "    資料目錄：$DATA_DIR"

# 3. 安裝 Node 套件
echo "▶ [3/5] 安裝 npm 套件..."
cd "$APP_DIR"
npm install --silent
echo "    套件安裝完成"

# 4. 設定防火牆
echo "▶ [4/5] 開放防火牆 port $PORT..."
# Ubuntu ufw
if command -v ufw &> /dev/null; then
  sudo ufw allow $PORT/tcp > /dev/null 2>&1 || true
fi
# Oracle Cloud iptables（重要！ufw 在 OCI 上可能不夠）
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport $PORT -j ACCEPT 2>/dev/null || true
sudo apt-get install -y iptables-persistent > /dev/null 2>&1 || true
sudo netfilter-persistent save > /dev/null 2>&1 || true
echo "    防火牆設定完成"

# 5. 安裝 PM2 並設定開機自啟
echo "▶ [5/5] 設定 PM2 背景執行..."
sudo npm install -g pm2 --silent > /dev/null 2>&1
pm2 delete catalog 2>/dev/null || true
PORT="$PORT" DATA_DIR="$DATA_DIR" pm2 start ecosystem.config.js --update-env
STARTUP_CMD=$(pm2 startup systemd -u "$(whoami)" --hp "$HOME" 2>&1 | grep "sudo")
if [ -n "$STARTUP_CMD" ]; then
  eval "$STARTUP_CMD" > /dev/null 2>&1 || true
fi
pm2 save > /dev/null 2>&1

echo ""
echo "════════════════════════════════════════"
echo "  ✅ 安裝完成！"
echo ""

# 取得公開 IP
PUBLIC_IP=$(curl -s --max-time 5 ifconfig.me 2>/dev/null || echo "無法取得")
echo "  本機訪問：http://localhost:$PORT"
echo "  外部訪問：http://$PUBLIC_IP:$PORT"
echo ""
echo "  ⚠️  重要：請記得在 Oracle Cloud Console 中"
echo "     開放 Security List 的 port $PORT（TCP Ingress）"
echo ""
echo "  常用指令："
echo "    pm2 status          → 查看運行狀態"
echo "    pm2 logs catalog    → 查看 log"
echo "    pm2 restart catalog → 重新啟動"
echo "════════════════════════════════════════"
echo ""
