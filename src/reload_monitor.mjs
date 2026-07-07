// リロード枠の日次監視 (課税口座)。+20%利確 / -8%損切りのトリガー判定と入替指示。
// 実行前に fetch_prices.mjs で価格を最新化すること。
// 出力: reports/reload_monitor.html (固定名・上書き)
import fs from "node:fs";
import path from "node:path";
import {
  reportsDir, readPlan, readState, loadPrice, loadUniverse, loadMarket,
  scoreAll, reloadCandidates, onOrBefore, yen, pctf, htmlPage, stalenessWarning, splitSuspects
} from "./lib.mjs";

const plan = readPlan();
const state = readState();
const universe = loadUniverse();
const px = new Map(universe.map((u) => [u.symbol, loadPrice(u.symbol)]));
const { topix } = loadMarket();
const asOf = topix.at(-1).date;

const TP = plan.reload.take_profit_pct / 100;
const SL = plan.reload.stop_loss_pct / 100;
const scored = scoreAll(universe, px, asOf, plan);
const pool = reloadCandidates(scored);
const heldSet = new Set(state.reload.map((r) => r.symbol));

const positions = state.reload.map((r) => {
  const last = onOrBefore(px.get(r.symbol) ?? [], asOf);
  const cur = last?.close ?? null;
  const gain = cur && r.entry_price > 0 ? cur / r.entry_price - 1 : null;
  let judge = "継続", cls = "hold", action = "保有継続。翌営業日も本モニタで確認。";
  if (gain !== null && gain >= TP) { judge = "利確"; cls = "buy"; action = `全量売却(+${(gain * 100).toFixed(1)}%)。売却代金で下表の次候補1位を買付(リロード)。実現益は課税対象(約20%)。`; }
  else if (gain !== null && gain <= SL) { judge = "損切り"; cls = "sell"; action = `全量売却(${(gain * 100).toFixed(1)}%)。売却代金で下表の次候補1位を買付(リロード)。損失は課税口座内で損益通算可。`; }
  return { ...r, cur, gain, judge, cls, action, tpLine: r.entry_price * (1 + TP), slLine: r.entry_price * (1 + SL) };
});
const suspects = splitSuspects(px, state.reload.map((r) => r.symbol).concat(state.satellite.map((h) => h.symbol)), asOf);

const body = `
<h1>リロード枠 日次モニタ (基準日: ${asOf})</h1>
${stalenessWarning(asOf)}
${suspects.length ? `<div class="danger"><b>株式分割の疑い</b>: ${suspects.map((s) => `${s.symbol} (${s.date} 生値${(s.jump * 100).toFixed(0)}%変動)`).join("、")}。分割なら <code>node src/record_trade.mjs split 銘柄 分割比</code> で取得単価を調整すること(±判定が壊れたままになる)。</div>` : ""}
<p>ルール: 取得価格から <b>+${plan.reload.take_profit_pct}%で利確</b> / <b>${plan.reload.stop_loss_pct}%で損切り</b>。トリガー時は全量売却し、次候補の最上位未保有銘柄へ<b>翌営業日寄付・成行</b>で入替(窓開けで±ラインを飛び越えても寄付で機械的に執行)。口座: 課税口座(NISA枠は使わない)。</p>

<h2>1. 保有ポジション判定</h2>
${positions.length ? `<table><tr><th>銘柄</th><th>取得日</th><th>取得単価</th><th>利確ライン</th><th>損切ライン</th><th>直近終値(調整後)</th><th>損益率</th><th>判定</th><th>行動</th></tr>
${positions.map((p) => `<tr class="${p.cls}"><td>${p.symbol} ${p.name}</td><td>${p.entry_date ?? "—"}</td><td class="num">${p.entry_price?.toLocaleString("ja-JP") ?? "—"}</td><td class="num">${p.tpLine?.toFixed(0) ?? "—"}</td><td class="num">${p.slLine?.toFixed(0) ?? "—"}</td><td class="num">${p.cur?.toFixed(0) ?? "—"}</td><td class="num">${p.gain === null ? "—" : (p.gain * 100).toFixed(1) + "%"}</td><td><b>${p.judge}</b></td><td>${p.action}</td></tr>`).join("")}</table>
<p class="small">データ更新不能時は、上表の利確/損切ラインと証券アプリの現在値で手動判定してよい。</p>`
  : `<div class="warn">リロード枠の保有がありません。初回買付は rebalance_order.html の第4節を参照してください。</div>`}

<h2>2. 入替候補プール 全${pool.length}銘柄 (高ボラ上位30% × 12-1か月モメンタム正、モメンタム順)</h2>
<p>トリガー発生時は、このリストの<b>未保有の最上位</b>を翌営業日寄付で買う。リストは毎日再計算される。</p>
<table><tr><th>順位</th><th>銘柄</th><th>業種</th><th>直近終値</th><th>12-1か月モメンタム</th><th>年率ボラ</th><th>状態</th></tr>
${pool.map((r, i) => `<tr class="${heldSet.has(r.symbol) ? "buy" : ""}"><td class="num">${i + 1}</td><td>${r.symbol} ${r.name}</td><td>${r.sector}</td><td class="num">${onOrBefore(px.get(r.symbol), asOf)?.close.toFixed(0) ?? "—"}</td><td class="num">${pctf(r.mom)}</td><td class="num">${pctf(r.vol)}</td><td>${heldSet.has(r.symbol) ? "<b>保有中</b>" : "控え"}</td></tr>`).join("")}
</table>
<p class="small">候補が空の場合(全銘柄モメンタム負など)は入替を行わず現金で待機する。プールが痩せてきたら(数銘柄以下)相場全体の悪化サイン。</p>

<h2>3. 売買後にやること(record_trade.mjs で記録。JSONの手編集は禁止)</h2>
<ol>
<li>売却: <code>node src/record_trade.mjs reload-sell 銘柄 約定単価</code>(実現損益とトリガー乖離を自動記録)</li>
<li>買付: <code>node src/record_trade.mjs reload-buy 銘柄 約定単価 株数</code>(利確/損切ラインを自動表示)</li>
</ol>`;

fs.writeFileSync(path.join(reportsDir, "reload_monitor.html"), htmlPage("リロード枠 日次モニタ", body), "utf8");

// 自動実行(GitHub Actions)の通知判定用に、トリガー状態を機械可読で出力する。
// HTMLと同一の positions / suspects から生成するため判定のズレは起きない。
const status = {
  as_of: asOf,
  generated_at: new Date().toISOString(),
  positions: positions.map((p) => ({
    symbol: p.symbol, name: p.name, judge: p.judge,
    gain_pct: p.gain === null ? null : Number((p.gain * 100).toFixed(2))
  })),
  triggers: positions.filter((p) => p.judge !== "継続")
    .map((p) => `${p.symbol} ${p.name}: ${p.judge} (${(p.gain * 100).toFixed(1)}%)`),
  split_suspects: suspects.map((s) => `${s.symbol} (${s.date} 生値${(s.jump * 100).toFixed(0)}%変動)`),
  data_stale: stalenessWarning(asOf) !== ""
};
fs.writeFileSync(path.join(reportsDir, "reload_status.json"), JSON.stringify(status, null, 2) + "\n", "utf8");
console.log(`reload_monitor.html written (asOf=${asOf}, positions=${positions.length}, triggers=${status.triggers.length})`);
