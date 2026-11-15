# 開發與測試

## 專案結構

| 位置 | 用途 |
| --- | --- |
| `app.py` | Flask 網頁與 API、後台登入、桌牌 QR Code 產生 |
| `orders.py` | SQLite 訂單、桌次識別碼、結帳及台灣時間營收統計 |
| `static/` | 顧客點餐、店家後台、QR Code 列印頁、商品照片 |
| `data/menu.json` | 菜單品項、分類、價格及圖片路徑 |
| `deploy/` | systemd 與 nginx 設定 |
| `tests/test_ordering.py` | 端點與資料庫整合測試 |

## 菜單維護

在 `data/menu.json` 新增或調整品項。每筆需有唯一的 `id`、`name`、`category`、以新台幣元表示的整數 `price` 和 `image`。可選填 `description`。照片放在 `static/menu/`，`image` 填 `/static/menu/檔名.webp`。既有品項保留原 `id`，已送出的訂單保留當時的品名和價格。

送單備註可供客人填寫客製需求，店員從後台訂單明細查看。修改菜單後執行下方測試，再依[部署與維護手冊](deployment.md#啟動與更新)重啟。 [原始菜單與照片專案](https://github.com/nelsonchung/yimianfangorder/tree/da483b58d20b898a0b8bc7b8c7267ff6c1052fab)

## 驗證

在樹莓派上的專案根目錄執行。整合測試使用獨立的暫存資料庫，涵蓋六桌 QR Code 解碼、桌號驗證與隔離、重送保護、加點後重新核對帳單、重啟後的資料保留及台灣時間營收統計。

```sh
python3 -m json.tool data/menu.json >/dev/null
python3 -m unittest discover -s tests -v
```

如需用瀏覽器測試點餐與結帳，可在樹莓派另外啟動一個只在本機監聽的測試服務。以下指令設置獨立密碼和資料庫，按 `Ctrl+C` 結束後會移除暫存資料。

```sh
(
    set -eu
    tmp_order_test=$(mktemp -d)
    trap 'rm -r -- "$tmp_order_test"' EXIT
    umask 077
    python3 -c 'import secrets; print(secrets.token_urlsafe(24))' > "$tmp_order_test/admin-password"
    cat "$tmp_order_test/admin-password"
    CREDENTIALS_DIRECTORY="$tmp_order_test" \
    YUNXU_DATABASE="$tmp_order_test/orders.sqlite3" \
    YUNXU_HOST=127.0.0.1 YUNXU_PORT=8184 YUNXU_PUBLIC_BASE=http://127.0.0.1:8184 \
        python3 app.py
)
```

若瀏覽器在自己的電腦上，從另一個終端機執行 `ssh -N -L 8184:127.0.0.1:8184 nelson@192.168.8.235`。開啟 `http://127.0.0.1:8184/admin`，用測試密碼登入。從 QR Code 頁面開啟任一桌的連結，在另一個分頁送單並通知結帳，再回後台驗證提醒、收款確認和營收更新。
