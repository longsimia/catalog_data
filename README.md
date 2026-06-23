# 素材庫部署手冊

這份文件是給「第一次部署這個專案的人」使用的。

目標：

- 從零開始
- 綁定到自己的 Oracle Cloud 主機
- 自己保管密碼、站點資料、上傳檔案
- 之後自動接收維護者更新的程式碼
- 前端介面由專案維護者統一提供與更新

## 你會得到什麼

部署完成後，你會有：

- 一個可使用的素材庫網站
- 一台自己的 Oracle Cloud 主機
- 一份獨立保存的資料目錄，不會因程式更新被覆蓋
- 一套主機自動更新機制，會定時從維護者 repo 抓最新版本

## 事前準備

你需要有：

- 一台 Oracle Cloud Ubuntu 主機
- 可 SSH 登入主機
- 這個專案的 GitHub 倉庫網址

## 第 1 步：把專案抓到 Oracle Cloud

SSH 進你的 Oracle Cloud 主機後，執行：

```bash
git clone https://github.com/longsimia/catalog_data.git ~/catalog_app
cd ~/catalog_app
```

## 第 2 步：安裝網站

執行：

```bash
bash setup.sh
```

這會自動：

- 安裝 Node.js 20
- 安裝 npm 套件
- 建立資料目錄
- 安裝 PM2
- 啟動網站

## 第 3 步：確認資料目錄

這個專案預設會把正式資料放在專案外：

```bash
$HOME/catalog_data
```

例如：

```bash
/home/ubuntu/catalog_data
```

這裡會存放：

- 站名與頁尾設定
- 管理密碼
- 素材資料
- 上傳檔案

## 第 4 步：打開網站

安裝完成後，用瀏覽器開：

```text
http://你的主機IP:3000
```

例如：

```text
http://123.123.123.123:3000
```

第一次使用時，可以進後台自行設定密碼。

## 第 5 步：設定主機自動更新

這個模式不使用 GitHub Actions，也不需要 fork。

做法是讓你的 Oracle Cloud 主機自己定時執行更新腳本。

由於某些連線環境不支援互動式編輯 `crontab -e`，建議直接在 Oracle Cloud 主機上執行：

```bash
printf '%s\n' '*/5 * * * * cd /home/ubuntu/catalog_app && bash update.sh >> /home/ubuntu/catalog_update.log 2>&1' | crontab -
```

然後執行：

```bash
crontab -l
```

你應該會看到：

```bash
*/5 * * * * cd /home/ubuntu/catalog_app && bash update.sh >> /home/ubuntu/catalog_update.log 2>&1
```

意思是：

- 每 5 分鐘
- 進入 `/home/ubuntu/catalog_app`
- 執行 `update.sh`
- 將輸出寫到 `/home/ubuntu/catalog_update.log`

如果你想降低更新頻率，也可以改成每 10 分鐘或每 30 分鐘。

## 第 6 步：確認自動更新可用

你不需要自己修改前端程式來測試部署。

請確認：

1. 主機上的網站已正常啟動
2. `crontab -l` 可以看到剛剛加入的排程
3. `bash update.sh` 手動執行一次會成功

你可以手動測試：

```bash
cd ~/catalog_app
bash update.sh
```

## 平常如何接收更新

如果你的用途只是部署與使用：

- 不需要自己修改前端程式
- 不需要自己維護 UI 程式碼
- 前端與功能更新由專案維護者統一提供

你需要做的是：

- 保持主機能正常執行 `update.sh`
- 讓 cron 定時抓最新版本

之後當維護者更新程式碼時，你的網站會在下一次排程執行時自動更新。

## `update.sh` 會做什麼

`update.sh` 目前會做：

```bash
git fetch origin main
git reset --hard origin/main
npm install --silent
pm2 reload ecosystem.config.js --update-env
```

這表示：

- 程式碼目錄會被強制同步成維護者最新版本
- 已追蹤的程式碼檔案會以遠端 `main` 為準
- npm 套件會同步更新
- PM2 會重新載入網站服務

因此仍然建議正式資料放在專案外的：

- `catalog_data`

不要把正式資料放在 repo 內的 `data/`，這樣可以避免程式碼更新與站點資料混在一起。

## 重要原則

### 會跟著維護者更新的

- 前端頁面
- 後端程式碼
- 樣式
- UI 功能

### 不會被更新覆蓋的

- 管理密碼
- 站點資料
- 素材項目
- 上傳檔案

因為這些都保存在：

- `catalog_data`

不是保存在 Git repo 裡。

## 哪些內容由使用者自己管理

使用者自己管理的是：

- 管理密碼
- 站名、副標、頁尾
- 素材內容
- 上傳檔案

這些都保存在自己的 `catalog_data`，不會因程式碼更新被覆蓋。

## 常用檢查指令

查看 PM2：

```bash
pm2 status
pm2 show catalog
pm2 env 0
```

查看 log：

```bash
pm2 logs catalog
tail -n 100 /home/ubuntu/catalog_update.log
```

手動更新：

```bash
cd ~/catalog_app
bash update.sh
```

查看排程：

```bash
crontab -l
```

## 備份建議

真正需要備份的是：

```bash
$HOME/catalog_data
```

至少要備份：

- `catalog.json`
- `config.json`
- `uploads/`
