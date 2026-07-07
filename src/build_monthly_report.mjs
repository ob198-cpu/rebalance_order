// 月次レポート: 対3指数の12か月ローリング比較、保有状況、事業毀損チェック、
// リロード枠の税引後試算。出力: reports/monthly_report.html (固定名・上書き)
import fs from "node:fs";
import path from "node:path";
import {
  root, reportsDir, readPlan, readState, parseCsv, loadPrice, loadUniverse, loadMarket,
  scoreAll, onOrBefore, ret, addMonths, yen, pctf, htmlPage, stalenessWarning
} from "./lib.mjs";

// 適時開示の確認リンク(事業毀損チェックの情報源)。銘柄コードから株探の開示ページへ
const tdnetLink = (symbol) => `https://kabutan.jp/stock/news?code=${symbol.replace(".T", "")}&nmode=2`;

const plan = readPlan();
const state = readState();
const universe = loadUniverse();
const px = new Map(universe.map((u) => [u.symbol, loadPrice(u.symbol)]));
const { topix, n225, spJpy } = loadMarket();
const asOf = topix.at(-1).date;
const from12m = addMonths(asOf, -12);

// --- 3指数の12か月ローリング ---
const idx = [
  ["TOPIX配当込み(1306.T調整後)", ret(topix, from12m, asOf)],
  ["日経平均", ret(n225, from12m, asOf)],
  ["S&P500円建て", ret(spJpy, from12m, asOf)]
];

// --- 指数の12か月最大DD ---
function ddOf(rows) {
  const slice = rows.filter((r) => r.date >= from12m && r.date <= asOf);
  let peak = -Infinity, dd = 0;
  for (const r of slice) { if (r.close > peak) peak = r.close; dd = Math.min(dd, r.close / peak - 1); }
  return dd;
}

// --- 保有評価 (取得額基準の簡易評価) ---
const scored = scoreAll(universe, px, asOf, plan);
const rankOf = new Map([...scored].sort((a, b) => b.mom - a.mom).map((r, i) => [r.symbol, i + 1]));
const holdRows = state.satellite.map((h) => {
  const r1y = ret(px.get(h.symbol) ?? [], from12m, asOf);
  return `<tr><td>${h.symbol} ${h.name}<br><a href="${tdnetLink(h.symbol)}" target="_blank" class="small">適時開示を確認</a></td><td class="num">${yen(h.amount_yen)}</td><td class="num">${pctf(r1y)}</td><td class="num">${rankOf.get(h.symbol) ?? "圏外"}位</td>${plan.sell_rules.business_damage_triggers.map(() => `<td><span class="check"></span></td>`).join("")}</tr>`;
}).join("");

// --- リロード実現益 (decisions.csv の action=reload_realized 合計) と売買記録 ---
let realized = 0;
const reloadSells = [];
const decPath = path.join(root, "decisions.csv");
if (fs.existsSync(decPath)) {
  for (const d of parseCsv(fs.readFileSync(decPath, "utf8"))) {
    if (d.action === "reload_realized") realized += Number(d.amount_yen) || 0;
    if (d.action === "reload_sell") reloadSells.push(d);
  }
}
const TAX = 0.20315;
const afterTax = realized > 0 ? realized * (1 - TAX) : realized;

const investedNote = state.invested
  ? ""
  : `<div class="warn">現在は未投入(portfolio_state.json: invested=false)。本レポートの保有欄は投入後に有効になります。初回投入は rebalance_order.html を参照。</div>`;

const body = `
<h1>月次レポート (基準日: ${asOf})</h1>
${stalenessWarning(asOf)}
${investedNote}

<h2>1. 3指数の12か月ローリングリターン (${from12m} → ${asOf})</h2>
<p>運用目標は「3指数すべてに+1%」。ポートフォリオ実績との比較は、投入後に取得単価ベースで本表に追加される。</p>
<table><tr><th>指数</th><th>12か月リターン</th><th>12か月最大DD</th><th>意味と行動</th></tr>
<tr><td>${idx[0][0]}</td><td class="num">${pctf(idx[0][1])}</td><td class="num">${pctf(ddOf(topix))}</td><td rowspan="3">自ポートフォリオの12か月リターンが3指数それぞれ+1%を上回っているか毎月確認する。2四半期連続で3指数すべてに劣後した場合は、年次レビューを待たず構成の再検証を提案する。</td></tr>
<tr><td>${idx[1][0]}</td><td class="num">${pctf(idx[1][1])}</td><td class="num">${pctf(ddOf(n225))}</td></tr>
<tr><td>${idx[2][0]}</td><td class="num">${pctf(idx[2][1])}</td><td class="num">${pctf(ddOf(spJpy))}</td></tr>
</table>

${plan.core.ratio === 0 ? `<h2>2. コアの状態</h2>
<p>G案(2026-07-06)によりコアETFは廃止。構成はサテライト${plan.satellite.ratio * 100}%+リロード枠${plan.reload.ratio * 100}%(課税口座)。${state.core.leg ? `<b>注意: 保有中のコアETF(${state.core.leg} ${yen(state.core.amount_yen)})が残っている。売却・再配分を rebalance_order.html で確認。</b>` : ""}</p>` : `<h2>2. コアの状態</h2>
<table><tr><th>現在レッグ</th><th>金額</th><th>次回判定</th></tr>
<tr><td>${state.core.leg ?? "未投入"}</td><td class="num">${yen(state.core.amount_yen)}</td><td>${state.nisa.year + 1}年1月の新規枠投入時(12-1か月相対モメンタムで再判定)</td></tr></table>`}

<h2>3. サテライト保有と事業毀損チェック (毎月、各銘柄を確認)</h2>
${state.satellite.length ? `<table><tr><th>銘柄</th><th>取得額</th><th>直近1年</th><th>モメンタム順位</th>${plan.sell_rules.business_damage_triggers.map((t) => `<th>${t}</th>`).join("")}</tr>${holdRows}</table>
<p>チェックに1つでも該当したら、機械損切りではなく「事業毀損による売却候補」として翌営業日に判断・記録する。</p>` : `<p>保有なし。</p>`}

<h2>4. リロード枠 実現損益と税引後試算 (課税口座)</h2>
<table><tr><th>年初来 実現損益(decisions.csv記録分)</th><th>税率</th><th>税引後</th></tr>
<tr><td class="num">${yen(realized)}</td><td class="num">${(TAX * 100).toFixed(3)}%</td><td class="num">${yen(afterTax)}</td></tr></table>
<p class="small">record_trade.mjs reload-sell が自動記録する。損失はマイナス値で通算。</p>
${reloadSells.length ? `<h3>売却履歴とトリガー乖離(執行スリッページの実測)</h3>
<table><tr><th>日付</th><th>銘柄</th><th>売却額</th><th>記録(乖離含む)</th></tr>
${reloadSells.slice(-10).map((d) => `<tr><td>${d.date}</td><td>${d.symbol}</td><td class="num">${yen(Number(d.amount_yen) || 0)}</td><td class="small">${d.reason ?? ""}</td></tr>`).join("")}</table>
<p class="small">乖離(判定終値と翌朝寄付約定のズレ)が平均で±2ptを超えて累積する場合は年次レビューで執行方法を再検討する。</p>` : ""}

<h2>5. NISA枠の状態</h2>
<table><tr><th>年間枠</th><th>使用済み</th><th>残枠</th><th>生涯枠(成長・概算)</th></tr>
<tr><td class="num">${yen(state.nisa.quota_total_yen * state.accounts)}</td><td class="num">${yen(state.nisa.quota_used_yen)}</td><td class="num">${yen(state.nisa.quota_total_yen * state.accounts - state.nisa.quota_used_yen)}</td><td class="num">${yen(state.nisa.lifetime_used_yen ?? state.nisa.quota_used_yen)} / ${yen(state.nisa.lifetime_limit_yen ?? 12000000)}</td></tr></table>
<p class="small">生涯枠は簿価残高方式(売却分の簿価は翌年復活)。record_trade.mjsの概算値のため、毎年1月に証券会社のNISA残高画面と照合すること。</p>`;

fs.writeFileSync(path.join(reportsDir, "monthly_report.html"), htmlPage("月次レポート", body), "utf8");
console.log(`monthly_report.html written (asOf=${asOf}, invested=${state.invested})`);
