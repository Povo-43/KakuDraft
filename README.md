# KakuDraft

KakuDraft はブラウザで動作する日本語向け執筆アプリです。本文、メモ、AI支援、GitHubバックアップを一体で扱います。

## 主な機能
- 章（話）ごとの執筆
- 各話 / タグ / 全体メモ
- 添付ファイル（画像・音声・動画・テキスト）
- AIチャット / 校閲
- GitHub同期（差分アップロード）

## バックアップ構造

設定やメタ情報は JSON、本文系は TXT で保存します。

- `設定/settings.json`
- `設定/sync_metadata.json`
- `設定/assets_index.json`
- `キー類/keys.json`
- `話/stories.json`
- `メモ/memos.json`
- `話/ai_chat.json`
- `話/<内部ID>/body.txt`
- `話/<内部ID>/memo_<n>.txt`
- `メモ/global_<n>.txt`
- `メモ/folder_<id>_<n>.txt`
- `話/ai_chat.txt`

> タイトル変更の影響を受けにくいように、本文系 TXT は内部IDベースで保存します。

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
