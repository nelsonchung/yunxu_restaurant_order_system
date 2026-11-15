# 部署與維護手冊

## 目前部署

| 項目 | 設定 |
| --- | --- |
| 樹莓派登入 | `ssh nelson@192.168.8.235` |
| 專案目錄 | `/media/nelson/work-disk/web-site/yunxu_restaurant_order_system` |
| 店內網站 | `http://192.168.8.235:8083` |
| 網路範圍 | nginx 在 `8083` 提供 HTTP，允許 `192.168.8.0/24` 和本機連入 |
| Python 應用 | `127.0.0.1:8183`，由 `yunxu-restaurant-order` systemd 服務啟動 |
| 資料庫 | `instance/orders.sqlite3`，保存訂單、結帳狀態和六桌 QR Code 識別碼 |

維護指令在樹莓派上的專案根目錄執行。系統依賴 Python 3.13、Flask、OpenCV、nginx 和 systemd。現行部署以 nginx 轉接只在本機監聽的 Flask 內建伺服器，提供店內區網服務。

## 店家密碼

首次安裝產生店家密碼。登入樹莓派後，在專案根目錄執行 `cat instance/admin-password` 取得。此檔案及 `instance/` 內的其他檔案都應保留在樹莓派和受控備份中。

更換密碼時，在樹莓派的 Bash 執行以下指令。重啟後，店員需重新登入。

```sh
python3 - <<'PYCODE' && sudo systemctl restart yunxu-restaurant-order
from getpass import getpass
from pathlib import Path

password = getpass('輸入新店家密碼（至少 12 字元）：').strip()
if len(password) < 12:
    raise SystemExit('密碼至少需要 12 個有效字元。')
Path('instance/admin-password').write_text(password + '\n', encoding='utf-8')
PYCODE
```

## 啟動與更新

服務已設定開機啟動，並等待專案所在的磁碟掛載。修改菜單或 Python 程式後，先跑[開發測試](development.md#驗證)，再重啟服務及檢查健康端點。

```sh
sudo systemctl restart yunxu-restaurant-order
systemctl is-active yunxu-restaurant-order
curl -fsS http://127.0.0.1:8083/healthz
```

若重建現有部署，先放回專案、建立 `instance/` 並準備店家密碼。只在新店尚無密碼檔時，才執行以下初始化。已有資料庫或桌牌時，請還原原本的資料庫。

```sh
(
    umask 077
    mkdir -p instance
    if [ ! -e instance/admin-password ]; then
        python3 -c 'import secrets; print(secrets.token_urlsafe(24))' > instance/admin-password
    fi
)
```

將專案中的 systemd 和 nginx 設定安裝到系統。搬移專案、變更帳號或更換網路時，先修改 `deploy/` 內對應設定。更新既有 systemd 設定時，在 `daemon-reload` 後需要另執行 `sudo systemctl restart yunxu-restaurant-order`。

```sh
sudo install -m 0644 deploy/yunxu-restaurant-order.service /etc/systemd/system/yunxu-restaurant-order.service
sudo systemd-analyze verify /etc/systemd/system/yunxu-restaurant-order.service
sudo systemctl daemon-reload
sudo systemctl enable --now yunxu-restaurant-order
sudo install -m 0644 deploy/yunxu-restaurant-order.nginx.conf /etc/nginx/conf.d/yunxu-restaurant-order.conf
sudo nginx -t && sudo systemctl reload nginx
```

若樹莓派的店內 IP 或對外通訊埠變更，更新 systemd 設定內的 `YUNXU_PUBLIC_BASE` 和 nginx 設定內相應的 `listen`、`allow` 值。套用後，從店內 Wi-Fi 驗證網址，再重新產生和列印桌牌。

## 備份與還原

以下指令在服務運作中用 SQLite 的備份介面複製訂單，並將店家密碼一併備份。請把備份留在權限受控的位置。

```sh
(
set -eu
umask 077
order_backup_root="$HOME/yunxu-order-backups"
mkdir -p "$order_backup_root"
order_backup_dir=$(mktemp -d "$order_backup_root/$(date +%Y%m%d-%H%M%S)-XXXXXX")
python3 - "$order_backup_dir/orders.sqlite3" <<'PY'
import sqlite3
import sys
from contextlib import closing
from pathlib import Path

source_uri = Path('instance/orders.sqlite3').resolve().as_uri() + '?mode=ro'
with closing(sqlite3.connect(source_uri, uri=True)) as source:
    with closing(sqlite3.connect(sys.argv[1])) as backup:
        source.backup(backup)
        if backup.execute('PRAGMA integrity_check').fetchone() != ('ok',):
            raise RuntimeError('備份資料庫未通過完整性檢查')
PY
install -m 0600 instance/admin-password "$order_backup_dir/admin-password"
printf '%s\n' "$order_backup_dir"
)
```

還原會回到所選備份的訂單與桌牌狀態，請安排在停止接單時操作。

1. 確認備份內有 `orders.sqlite3` 和 `admin-password`，執行 `sudo systemctl stop yunxu-restaurant-order`。
2. 將目前的 `instance/` 整個移到另一個目錄留存，建立權限為 `700`、由 `nelson` 持有的新 `instance/`。
3. 將備份的兩個檔案放進新的 `instance/`，權限設為 `600`，檔案也由 `nelson` 持有。
4. 執行 `sudo systemctl start yunxu-restaurant-order`，確認健康端點及後台可開啟，並用客人手機抽查桌牌和訂單狀態。

## 故障排查

```sh
systemctl status yunxu-restaurant-order
sudo journalctl -u yunxu-restaurant-order -n 60 --no-pager
findmnt /media/nelson/work-disk
curl -fsS http://127.0.0.1:8183/healthz
curl -fsS http://127.0.0.1:8083/healthz
```

- `8183` 失敗時，先查服務紀錄與磁碟掛載狀態。若剛更換密碼，確認檔案存在且至少有 12 個字元。
- `8183` 成功、`8083` 失敗時，檢查 `systemctl status nginx` 和 `sudo nginx -t`。`502` 也可能出現在 Python 應用剛重啟的幾秒內。
- 兩個本機端點都通，但手機連不上時，確認手機 Wi-Fi 可連到 `192.168.8.235:8083`，且客用網路的隔離設定允許這段連線。
