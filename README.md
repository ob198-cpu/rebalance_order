# rebalance_order

NISA Alpha 運用レポートの公開用リポジトリです。GitHub Actionsが毎営業日に価格を取得して
全帳票を再生成し、GitHub Pagesへ自動公開します（方向1: 運用自動化 2026-07-07導入）。

公開URL: https://ob198-cpu.github.io/rebalance_order/

## 自動実行（.github/workflows/daily.yml）

- 毎営業日 16:35 JST 頃（Actionsのcronは遅延あり）に実行:
  1. `src/fetch_prices.mjs` — Yahoo Financeから全銘柄の価格を取得
  2. `src/build_rebalance_order.mjs` / `src/reload_monitor.mjs` / `src/build_monthly_report.mjs` / `src/build_selection_audit.mjs` — 帳票を再生成
  3. リロード枠の利確/損切りトリガー・株式分割疑い・データ鮮度異常を検知した日だけ
     **Issueを自動作成**（例:「【要対応】日次モニタ検知 2026-07-07」）
  4. Pagesへデプロイ（コミットはしない。リポジトリの中身は手動push時点のスナップショット）
- 手動実行: Actionsタブ → Daily market update and deploy → Run workflow

## 通知の受け取り方

トリガー発生日はIssueが作成され、リポジトリをWatchしていればGitHubからメールが届きます。
（Settings → Notifications でメール通知が有効なことを確認。既に同日Issueがある場合は重複作成しません）

## 売買した日にやること（状態の同期）

保有状態の正本はローカルの `nisa_alpha` です。約定を記録したら公開側へ同期してpushします:

```powershell
cd "C:\AI関連ファイル\株\nisa_alpha"
node src/record_trade.mjs ...   # 約定記録(正本を更新)
Copy-Item data\portfolio_state.json ..\rebalance_order\data\ -Force
Copy-Item decisions.csv ..\rebalance_order\ -Force
cd ..\rebalance_order
git add data/portfolio_state.json decisions.csv; git commit -m "Update portfolio state"; git push
```

翌営業日の自動実行から、新しい保有内容で帳票が生成されます（すぐ反映したい場合はActionsから手動実行）。

## 構成

- `index.html` — 入口ページ
- `reports/` — 帳票（自動生成。手動編集しない）
- `src/` `config/` `data/` — 生成スクリプト・設定・データ（正本は `nisa_alpha`。変更はローカルで行い、コピーで同期）

## 注意

- 本サイトは運用補助資料であり、投資助言や自動売買システムではありません。発注前に価格、株数、口座区分、NISA残枠を必ず確認してください。
- 公開リポジトリのため、`data/portfolio_state.json`（保有銘柄・金額）も公開されます。
