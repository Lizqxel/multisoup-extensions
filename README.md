# multisoup 検索機能

## このリポジトリについて

このリポジトリは、`https://multisoup.co.jp/map/geospace.php` に対して、
Tampermonkeyで「住所検索バー」を後付けするユーザースクリプトを管理するためのものです。

### 目的
- 元サイトを改修せずに、住所/座標から地図中心へ移動できるようにする
- 導入手順と配布手順をあわせて管理する

### 主な同梱ファイル
- `tampermonkey-geospace-address-search.user.js`  
	実際に配布・インストールするTampermonkey用スクリプト本体
- `README.md`  
	導入手順（このファイル）

### 注意事項
- 住所検索時は外部ジオコーダーAPIへ住所文字列を送信します
- APIの仕様変更や提供状況により、検索精度や結果が変わる場合があります

---

以下、導入手順です。

【multisoup 検索機能 導入手順（Chrome）】

1. まず TampermonkeyというChrome用の拡張機能 をインストール
https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo

2. 上記拡張機能インストール完了後、スクリプトをインストールするために下記リンクを開く
https://github.com/Lizqxel/multisoup-extensions/raw/refs/heads/main/tampermonkey-geospace-address-search.user.js

3. Tampermonkey の画面が自動で開くので、 Install（インストール）をクリック

4. Chrome右上の「・・・（三点リーダー）」をクリック → 拡張機能 → 拡張機能を管理をクリック

5. 「使用している拡張機能」タブから「Tampermonkey」の詳細をクリック

6. 「ユーザー スクリプトを許可する」と「ファイルの URL へのアクセスを許可する」のチェックボックスをオンにする

7. 対象ページを開く（または再読み込み）
https://multisoup.co.jp/map/geospace.php

画面左上に「住所検索」パネルが出れば導入完了
