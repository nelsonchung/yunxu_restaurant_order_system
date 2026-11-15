# 鋆旭食堂｜桌邊點餐

一間店、六張桌的區網點餐系統。客人掃描各桌的 QR Code 點餐，店員在後台接單、登記現場收款及查看營收。系統以 Python 3.13、Flask、SQLite 和 OpenCV 運作。

- [店家後台](http://192.168.8.235:8083/admin)
- [六桌 QR Code 產生與列印](http://192.168.8.235:8083/admin/qr)

## 文件

- [店員操作手冊](docs/operations.md)涵蓋開店、桌牌、接單與結帳。
- [部署與維護手冊](docs/deployment.md)涵蓋店家密碼、服務管理、備份還原和排查。
- [開發與測試](docs/development.md)涵蓋程式架構、菜單維護和測試方式。
