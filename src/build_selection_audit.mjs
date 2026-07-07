// 選定計算の完全監査レポート。入口(生データ)から出口(発注銘柄)まで、
// 全53銘柄・全ステップの数値と判定理由を1つ残らず開示する。
// 「どの銘柄が・どの段階で・どの数値により・採用/除外されたか」を第三者が追跡できる形にする。
// 出力: reports/selection_audit.html
import fs from "node:fs";
import path from "node:path";
import {
  root, reportsDir, readPlan, readState, loadPrice, loadUniverse, loadMarket,
  onOrBefore, addMonths, stdev, pctile, yen, pctf, htmlPage
} from "./lib.mjs";

const plan = readPlan();
const state = readState();
const universe = loadUniverse();
const px = new Map(universe.map((u) => [u.symbol, loadPrice(u.symbol)]));
const { topix } = loadMarket();
const asOf = topix.at(-1).date;

// === ステップ1: 計算に使う日付を確定 ===
const skipEnd = addMonths(asOf, -plan.selection.momentum.skip_months);
const lookStart = addMonths(skipEnd, -plan.selection.momentum.lookback_months);

// === ステップ2: 全銘柄のモメンタム・ボラを計算(lib.scoreAllと同一式を、途中値を保存しながら実行) ===
const detail = [];
for (const u of universe) {
  const rows = px.get(u.symbol);
  const a = onOrBefore(rows, lookStart);
  const b = onOrBefore(rows, skipEnd);
  const mom = a && b && a.close > 0 ? b.close / a.close - 1 : null;
  const slice = rows.filter((r) => r.date >= lookStart && r.date <= skipEnd);
  const drets = [];
  for (let i = 1; i < slice.length; i += 1) if (slice[i - 1].close > 0) drets.push(slice[i].close / slice[i - 1].close - 1);
  const volDaily = stdev(drets);
  const vol = Number.isFinite(volDaily) ? volDaily * Math.sqrt(252) : null;
  detail.push({
    symbol: u.symbol, name: u.name, sector: u.sector,
    startDate: a?.date, startPx: a?.close, endDate: b?.date, endPx: b?.close,
    days: slice.length, mom, vol,
    valid: Number.isFinite(mom) && Number.isFinite(vol)
  });
}
const ranked = detail.filter((d) => d.valid).sort((a, b) => b.mom - a.mom);
ranked.forEach((d, i) => { d.rank = i + 1; });
const invalid = detail.filter((d) => !d.valid);

// === ステップ3: サテライト選定の逐次トレース(1行ずつ判定ログを残す) ===
const cap = plan.satellite.max_per_sector;
const buffer = plan.satellite.rank_buffer ?? plan.satellite.holdings_max;
const held = new Set(state.satellite.map((h) => h.symbol));
const secCount = new Map();
const picked = [];
const trace = [];
// 第1パス: 保有銘柄のバッファ判定
for (const d of ranked) {
  if (!held.has(d.symbol)) continue;
  if (d.rank > buffer) { trace.push({ ...d, phase: "保有判定", result: "売却対象", why: `保有中だが順位${d.rank}位 > バッファ${buffer}位` }); continue; }
  const n = secCount.get(d.sector) ?? 0;
  if (n >= cap) { trace.push({ ...d, phase: "保有判定", result: "売却対象", why: `${d.sector}は既に${cap}銘柄確保済み` }); continue; }
  secCount.set(d.sector, n + 1); picked.push(d.symbol);
  trace.push({ ...d, phase: "保有判定", result: "保有継続", why: `保有中かつ順位${d.rank}位 ≦ バッファ${buffer}位(${d.sector} ${n + 1}/${cap}銘柄目)` });
}
// 第2パス: 上位から充足
for (const d of ranked) {
  if (picked.includes(d.symbol)) continue;
  if (picked.length >= plan.satellite.holdings_max) { trace.push({ ...d, phase: "新規選定", result: "対象外", why: `定員${plan.satellite.holdings_max}銘柄に到達済み` }); continue; }
  const n = secCount.get(d.sector) ?? 0;
  if (n >= cap) { trace.push({ ...d, phase: "新規選定", result: "除外", why: `${d.sector}は上位${cap}銘柄を採用済み(業種上限)` }); continue; }
  secCount.set(d.sector, n + 1); picked.push(d.symbol);
  trace.push({ ...d, phase: "新規選定", result: "採用", why: `モメンタム${d.rank}位・${d.sector}の${n + 1}銘柄目(上限${cap})` });
}
trace.sort((a, b) => a.rank - b.rank);

// === ステップ4: リロード候補の導出(ボラ閾値も開示) ===
const volCut = pctile(ranked.map((d) => d.vol), 0.7);
const reloadTrace = ranked.map((d) => {
  const volOk = d.vol >= volCut;
  const momOk = d.mom > 0;
  return { ...d, volOk, momOk, inPool: volOk && momOk,
    why: volOk && momOk ? "候補入り" : !volOk ? `ボラ${pctf(d.vol)} < 閾値${pctf(volCut)}` : `モメンタム${pctf(d.mom)} ≦ 0` };
});
const pool = reloadTrace.filter((d) => d.inPool).sort((a, b) => b.mom - a.mom);

const fetchedAt = (() => {
  const line = fs.readFileSync(path.join(root, "data", "prices", "5801.T.csv"), "utf8").split(/\r?\n/)[1] ?? "";
  return line.split(",").at(-1) ?? "不明";
})();

const rowCls = (r) => r === "採用" || r === "保有継続" || r === "候補入り" ? "buy" : r === "除外" || r === "売却対象" ? "sell" : "hold";

const body = `
<h1>銘柄選定の計算過程 — 完全監査レポート (基準日: ${asOf})</h1>
<p>本書は「どの銘柄が・どの段階で・どの数値により・採用/除外されたか」を<b>全${universe.length}銘柄について1行ずつ</b>開示するものです。使っている式は割り算と標準偏差のみで、AI・乱数・裁量は一切入りません。同じデータで再実行すれば必ず同じ結果になります。</p>

<h2>ステップ0: 入力データ</h2>
<table>
<tr><th>項目</th><th>内容</th></tr>
<tr><td>データソース</td><td>Yahoo Finance chart API(日次終値・調整後終値)。各CSVに出所URLと取得時刻を記録</td></tr>
<tr><td>取得時刻</td><td>${fetchedAt}</td></tr>
<tr><td>対象</td><td>母集団${universe.length}銘柄 + 指数(TOPIX ETF・日経平均・S&P500・ドル円)</td></tr>
<tr><td>保存場所</td><td>data/prices/(銘柄コード).csv — 誰でも開いて検算可能</td></tr>
</table>

<h2>ステップ1: 計算期間の確定</h2>
<table>
<tr><th>変数</th><th>値</th><th>決め方</th></tr>
<tr><td>基準日</td><td>${asOf}</td><td>価格データの最終営業日</td></tr>
<tr><td>測定終了日(skipEnd)</td><td>${skipEnd}</td><td>基準日の${plan.selection.momentum.skip_months}か月前(直近1か月は短期反動を避けるため除外)</td></tr>
<tr><td>測定開始日(lookStart)</td><td>${lookStart}</td><td>測定終了日の${plan.selection.momentum.lookback_months}か月前</td></tr>
<tr><td>モメンタムの式</td><td colspan="2">終了日の調整後終値 ÷ 開始日の調整後終値 − 1</td></tr>
<tr><td>ボラティリティの式</td><td colspan="2">同期間の日次リターンの標準偏差 × √252(年率換算)</td></tr>
</table>

<h2>ステップ2: 全${universe.length}銘柄の計算結果(省略なし)</h2>
<p>開始価格・終了価格は実際に使われた営業日の調整後終値。この2つの数字を電卓で割ればモメンタム列が再現できます。</p>
<table><tr><th>順位</th><th>銘柄</th><th>業種</th><th>開始日</th><th>開始値</th><th>終了日</th><th>終了値</th><th>モメンタム</th><th>年率ボラ</th></tr>
${ranked.map((d) => `<tr><td class="num">${d.rank}</td><td>${d.symbol} ${d.name}</td><td>${d.sector}</td><td>${d.startDate}</td><td class="num">${d.startPx?.toFixed(1)}</td><td>${d.endDate}</td><td class="num">${d.endPx?.toFixed(1)}</td><td class="num">${pctf(d.mom)}</td><td class="num">${pctf(d.vol)}</td></tr>`).join("")}
</table>
${invalid.length ? `<p class="small">計算不能(データ13か月未満): ${invalid.map((d) => d.symbol).join(", ")} — 自動的に選定対象外。</p>` : ""}

<h2>ステップ3: サテライト8銘柄の逐次判定ログ(全銘柄の採否理由)</h2>
<p>順位1位から順に走査し、「業種上限${cap}銘柄」「保有銘柄はバッファ${buffer}位まで維持」のルールを機械的に適用した記録です。${held.size ? "" : "(現在未投入のため保有判定の対象なし。全銘柄が新規選定パス)"}</p>
<table><tr><th>順位</th><th>銘柄</th><th>業種</th><th>モメンタム</th><th>判定</th><th>理由(そのときの業種カウンタ込み)</th></tr>
${trace.map((t) => `<tr class="${rowCls(t.result)}"><td class="num">${t.rank}</td><td>${t.symbol} ${t.name}</td><td>${t.sector}</td><td class="num">${pctf(t.mom)}</td><td><b>${t.result}</b></td><td>${t.why}</td></tr>`).join("")}
</table>
<p><b>結果: ${picked.map((s, i) => `${i + 1}.${s}`).join(" ")}</b>(各${yen(state.capital_yen_per_account * state.accounts * plan.satellite.ratio / plan.satellite.holdings_max)})</p>

<h2>ステップ4: リロード枠(回転売買)候補の導出</h2>
<p>条件は2つ: <b>①年率ボラが全体の上位30%</b>(今回の閾値 = ${pctf(volCut)}。${ranked.length}銘柄のボラの70パーセンタイル)、<b>②モメンタムがプラス</b>。両方満たす銘柄をモメンタム順に並べ、上位${plan.reload.positions}銘柄を保有します。</p>
<table><tr><th>順位</th><th>銘柄</th><th>モメンタム</th><th>年率ボラ</th><th>①ボラ≧${pctf(volCut)}</th><th>②モメンタム>0</th><th>判定</th></tr>
${reloadTrace.map((d) => `<tr class="${d.inPool ? "buy" : "hold"}"><td class="num">${d.rank}</td><td>${d.symbol} ${d.name}</td><td class="num">${pctf(d.mom)}</td><td class="num">${pctf(d.vol)}</td><td>${d.volOk ? "○" : "×"}</td><td>${d.momOk ? "○" : "×"}</td><td>${d.inPool ? `<b>候補${pool.indexOf(d) + 1}位</b>` : d.why}</td></tr>`).join("")}
</table>

<h2>ステップ5: 検算の方法(第三者向け)</h2>
<ol>
<li>data/prices/5801.T.csv を表計算ソフトで開く</li>
<li>${lookStart}以前の直近営業日の調整後終値(3列目)と、${skipEnd}以前の直近営業日の同値を探す</li>
<li>後者÷前者−1 を計算 → ステップ2の表のモメンタム列と一致するはず</li>
<li>選定ロジック本体は src/lib.mjs の scoreAll / selectSat / reloadCandidates(計約60行)。読めば本書の判定と1対1に対応</li>
</ol>
<p class="small">本書は reports/selection_audit.html として毎回の価格更新で自動再生成される。数値の手入力・編集は一切ない。</p>
`;

fs.writeFileSync(path.join(reportsDir, "selection_audit.html"), htmlPage("銘柄選定の計算過程(完全監査)", body), "utf8");
console.log(`selection_audit.html written (asOf=${asOf}, ranked=${ranked.length}, picked=${picked.length}, reload_pool=${pool.length}, vol_cut=${(volCut * 100).toFixed(1)}%)`);
