# KakuDraft

KakuDraft はブラウザで動作する日本語向け執筆アプリです。本文、メモ、AI支援、GitHubバックアップを一体で扱います。

## 主な機能
- 章（話）ごとの執筆
- 各話 / タグ / 全体メモ
- 添付ファイル（画像・音声・動画・テキスト）
- AIチャット / 校閲
- GitHub同期（差分アップロード）
- PWAインストール（ホーム画面追加）とオフライン起動

## PWA / オフライン対応

- Service Worker によりアプリシェル（HTML/CSS/JS/manifest/icon/help）を事前キャッシュし、オフラインでも起動できます。
- 画面遷移（ナビゲーション）は network-first / fallback to cache で処理し、通信断時はキャッシュされた `index.html` を返します。
- Google Fonts（`fonts.googleapis.com` / `fonts.gstatic.com`）はランタイムキャッシュされます。
- お気に入り機能に `PWAをインストール` / `PWA更新適用` を追加でき、更新待機中SWの適用を手動実行できます。

## バックアップ構造

設定やメタ情報は JSON、本文系は TXT で保存します。

- `設定/settings.json`
- `設定/sync_metadata.json`
- `設定/assets_index.json`
- `キー類/keys.json`
- `話/chapter_index.json`
- `メモ/memos.json`
- `話/ai_chat.json`
- `話/<内部ID>/body.txt`
- `話/<内部ID>/memo_<n>.txt`
- `メモ/global_<n>.txt`
- `メモ/folder_<id>_<n>.txt`
- `話/ai_chat.txt`

> 話の本文・メモは `stories.json` に集約せず、章ディレクトリ配下へ分割保存します。

## 添付ファイル同期

- 添付時に可能なら即時で GitHub へアップロードします。
- 添付の実体バイナリとは別に `assets_index.json`（メタデータ一覧）を保持します。
- メモ（添付欄）を開くたびに、オンラインなら `assets_index.json` を確認して一覧表示を同期します。
- 実体データの取得は **開く / ダウンロード / 削除** 操作時に必要なときだけ行います（遅延ダウンロード）。

## 旧形式からの移行

旧形式（`kakudraft_data.json`, `kakudraft_ai_chat.json`）のみがリポジトリにある場合、同期時に現行形式へ自動移行します。

## 使い方

1. `index.html` をブラウザで開く
2. バックアップタブで GitHub PAT / リポジトリ / 端末名を入力
3. `UP` で保存、`DOWN` で復元
