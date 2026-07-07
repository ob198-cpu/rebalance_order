// リバランス指示書の生成 (NISA枠管理付き)。
// 実行前に fetch_prices.mjs で価格を最新化すること。
// 出力: reports/rebalance_order.html (固定名・上書き)
import fs from "node:fs";
import path from "node:path";
import {
  root, reportsDir, readPlan, readState, loadPrice, loadUniverse, loadMarket,
  scoreAll, selectSat, reloadCandidates, coreDecision, onOrBefore, yen, pctf, htmlPage, stalenessWarning
} from "./lib.mjs";

const plan = readPlan();
const state = readState();
const universe = loadUniverse();
const px = new Map(universe.map((u) => [u.symbol, loadPrice(u.symbol)]));
const { topix, n225, spJpy } = loadMarket();
const asOf = topix.at(-1).date;
const capital = state.capital_yen_per_account * state.accounts;

const scored = scoreAll(universe, px, asOf, plan);
const satTarget = selectSat(scored, plan, state.satellite.map((h) => h.symbol));
const reloadPool = reloadCandidates(scored);

// --- コア判定 (年1回: 保有なし=初回はいつでも / 保有ありは1月のみ) ---
const cd = coreDecision(topix, spJpy, asOf, n225);
const isJanuary = asOf.slice(5, 7) === "01";
const coreBudget = capital * plan.core.ratio;
const legLabel = { topix: "TOPIX連動ETF", nikkei: "日経225連動ETF", spjpy: "S&P500円建てETF" };
const momLine = `12-1か月モメンタム: TOPIX ${pctf(cd.momTopix)} / 日経平均 ${pctf(cd.momNikkei)} / S&P500円建て ${pctf(cd.momSpjpy)}`;
let coreAction, coreReason;
if (plan.core.ratio === 0) {
  coreAction = { type: "なし", leg: null, amount: 0 };
  coreReason = state.core.leg
    ? "G案(2026-07-06)によりコアETFは廃止。保有中のコアETFは売却し、サテライトへ再配分する(売却してもNISA枠は年内に戻らない点に注意)。"
    : "G案(2026-07-06)によりコアETFは廃止。全額を個別株サテライト+リロード枠に配分。";
} else if (!state.core.leg) {
  coreAction = { type: "買付", leg: cd.leg, amount: coreBudget };
  coreReason = `初回投入。${momLine} → ${legLabel[cd.leg]}を選択。`;
} else if (isJanuary && cd.leg !== state.core.leg) {
  coreAction = { type: "切替", leg: cd.leg, amount: state.core.amount_yen };
  coreReason = `年初判定で優位が交代。${momLine}。売却→買い直しはNISA新規枠を消費する点に注意。`;
} else {
  coreAction = { type: "維持", leg: state.core.leg, amount: state.core.amount_yen };
  coreReason = isJanuary ? "年初判定の結果、現行レッグ優位のため維持。" : "コアの切替判定は年初のみ。期中は維持。";
}
const coreInstrument = (leg) => leg === "spjpy" ? plan.core.legs.us.live_instrument
  : leg === "nikkei" ? plan.core.legs.nikkei.live_instrument
  : plan.core.legs.japan.live_instrument;

// --- サテライト差分 ---
const satBudget = capital * plan.satellite.ratio;
const perName = satBudget / plan.satellite.holdings_max;
const held = new Map(state.satellite.map((h) => [h.symbol, h]));
const targetSet = new Set(satTarget.map((r) => r.symbol));
const sells = state.satellite.filter((h) => !targetSet.has(h.symbol));
const keeps = state.satellite.filter((h) => targetSet.has(h.symbol));
const buysWanted = satTarget.filter((r) => !held.has(r.symbol)).map((r) => ({ ...r, amount: perName }));

// --- NISA枠チェック (コア買付/切替の買い直し + サテライト新規買いが対象) ---
const quotaLeft = state.nisa.quota_total_yen * state.accounts - state.nisa.quota_used_yen;
let quotaNeeded = 0;
if (coreAction.type === "買付" || coreAction.type === "切替") quotaNeeded += coreAction.amount;
quotaNeeded += buysWanted.reduce((a, b) => a + b.amount, 0);

const buys = [];
const postponed = [];
let running = coreAction.type === "維持" ? 0 : coreAction.amount;
for (const b of buysWanted) { // モメンタム上位優先 (selectSatの並び順)
  if (running + b.amount <= quotaLeft) { buys.push(b); running += b.amount; }
  else postponed.push(b);
}
const quotaAfter = quotaLeft - running;

// --- リロード枠 (課税口座: NISA枠計算の対象外) ---
const reloadBudget = capital * plan.reload.ratio;
const heldReload = new Set(state.reload.map((r) => r.symbol));
const reloadTargets = state.reload.length >= plan.reload.positions
  ? []
  : reloadPool.filter((r) => !heldReload.has(r.symbol)).slice(0, plan.reload.positions - state.reload.length);

// --- HTML ---
const rankOf = new Map(scored.sort((a, b) => b.mom - a.mom).map((r, i) => [r.symbol, i + 1]));
const lastClose = (s) => onOrBefore(px.get(s), asOf)?.close;
// 発注株数は生値(実際の取引価格)基準。株数 = round(予算/株価)。NISA残枠超過時はfloorへ(運用方針書§4-11)
const lastRaw = (s) => { const r = onOrBefore(px.get(s), asOf); return r?.raw || r?.close; };
const sharesFor = (s, amt) => { const p = lastRaw(s); return p > 0 ? `${Math.round(amt / p).toLocaleString("ja-JP")}株` : "—"; };
const coreShares = coreAction.leg === "topix"
  ? `${Math.round(coreAction.amount / (onOrBefore(topix, asOf)?.raw || onOrBefore(topix, asOf)?.close)).toLocaleString("ja-JP")}口`
  : coreAction.leg ? "発注時の実勢価格で計算(口数 = round(金額÷価格))" : "—";

const preflight = state.invested ? "" : `
<div class="warn"><b>初回発注前チェックリスト(1つでも未了なら発注しない)</b><br>
□ 証券口座の配当受取方式が<b>「株式数比例配分方式」</b>になっている(未設定だとNISA配当にも20.315%課税される)<br>
□ 課税口座は<b>特定口座(源泉徴収あり)</b>になっている(リロード枠の確定申告を不要にするため)<br>
□ 単元未満株サービス(SBI「S株」等)が利用可能になっている<br>
□ シナリオ・リハーサル資料の事前コミットメント5項目を読み、<code>decisions.csv</code> に action=commitment を記録した</div>`;

const body = `
<h1>リバランス指示書 (基準日: ${asOf})</h1>
${stalenessWarning(asOf)}
${preflight}
<p>資金モデル: ${state.accounts}口座 × ${yen(state.capital_yen_per_account)} = ${yen(capital)}。構成: コア${plan.core.ratio * 100}% / サテライト${plan.satellite.ratio * 100}% / リロード枠${plan.reload.ratio * 100}%(課税口座)。</p>
<div class="ok"><b>執行ルール(この指示書だけで発注完結すること)</b><br>
・<b>鮮度</b>: 発注当日の朝に fetch_prices.mjs → build_rebalance_order.mjs を実行して本書を再生成してから発注する(古い指示書は使わない)<br>
・<b>いつ</b>: 本指示書の生成日から<b>3営業日以内</b>。過ぎたら執行せず次回四半期まで持ち越す(運用方針書§8-2)<br>
・<b>注文条件</b>: 単元未満株(S株)は<b>当日朝の成行注文→前場始値で約定</b>(S株に指値は存在しない。SBIは7:00頃までの注文で前場寄付扱い)。単元株(100株)で買える場合のみ、寄付成行または前日終値±1%指値を使用可<br>
・<b>発注経路</b>: NISA口座=成長投資枠。個別株は1株単位。予算内で単元が買える場合のみ単元で<br>
・<b>株数</b>: ①株数 = round(金額 ÷ 実勢価格) ②その銘柄でNISA残枠を超えるならfloor ③合計が残枠超ならモメンタム順位の低い銘柄からfloor→見送り<br>
・<b>記録</b>: 約定ごとに <code>node src/record_trade.mjs sat-buy 銘柄 約定単価 株数</code>(リロードは reload-buy)。JSONの手編集は禁止</div>

<h2>1. NISA枠の状態</h2>
<table><tr><th>年間枠(合計)</th><th>使用済み</th><th>残枠</th><th>今回指示の消費</th><th>指示実行後の残枠</th></tr>
<tr><td class="num">${yen(state.nisa.quota_total_yen * state.accounts)}</td><td class="num">${yen(state.nisa.quota_used_yen)}</td><td class="num">${yen(quotaLeft)}</td><td class="num">${yen(running)}</td><td class="num">${yen(quotaAfter)}</td></tr></table>
${postponed.length ? `<div class="warn">残枠不足のため、以下の買付は見送り(モメンタム順位の低い順に除外): ${postponed.map((b) => `${b.symbol} ${b.name}`).join("、")}。来年の新規枠で再検討する。</div>` : `<div class="ok">今回の指示はすべて残枠内に収まっています。</div>`}

${plan.core.ratio === 0 ? `<h2>2. コア (廃止)</h2>
<p>${coreReason}(参考: ${momLine})</p>` : `<h2>2. コア (NISA口座 / 目標 ${yen(coreBudget)})</h2>
<table><tr><th>操作</th><th>対象</th><th>金額</th><th>株数(口数)目安</th><th>理由</th></tr>
<tr class="${coreAction.type === "維持" ? "hold" : "buy"}"><td>${coreAction.type}</td><td>${coreInstrument(coreAction.leg)}</td><td class="num">${yen(coreAction.amount)}</td><td class="num">${coreAction.type === "維持" ? "—" : coreShares}</td><td>${coreReason}</td></tr></table>`}

<h2>3. サテライト (NISA口座 / 目標 ${yen(satBudget)}、1銘柄 ${yen(perName)})</h2>
<table><tr><th>操作</th><th>銘柄</th><th>直近終値(生値)</th><th>金額目安</th><th>株数目安</th><th>根拠 (12-1か月モメンタム / 母集団内順位)</th></tr>
${sells.map((h) => `<tr class="sell"><td>売却</td><td>${h.symbol} ${h.name}</td><td class="num">${lastRaw(h.symbol)?.toFixed(0) ?? "—"}</td><td class="num">${yen(h.amount_yen)}</td><td class="num">全株</td><td>選定基準外(順位 ${rankOf.get(h.symbol) ?? "圏外"}位。バッファ${plan.satellite.rank_buffer ?? plan.satellite.holdings_max}位以内なら保持するルール適用後も残らず)。売却してもNISA枠は年内に戻らない。</td></tr>`).join("")}
${keeps.map((h) => `<tr class="hold"><td>維持</td><td>${h.symbol} ${h.name}</td><td class="num">${lastRaw(h.symbol)?.toFixed(0) ?? "—"}</td><td class="num">${yen(h.amount_yen)}</td><td class="num">—</td><td>選定基準内(順位 ${rankOf.get(h.symbol)}位)。</td></tr>`).join("")}
${buys.map((b) => `<tr class="buy"><td>買付</td><td>${b.symbol} ${b.name}</td><td class="num">${lastRaw(b.symbol)?.toFixed(0) ?? "—"}</td><td class="num">${yen(b.amount)}</td><td class="num">${sharesFor(b.symbol, b.amount)}</td><td>モメンタム ${pctf(b.mom)}(順位 ${rankOf.get(b.symbol)}位)、年率ボラ ${pctf(b.vol)}、セクター: ${b.sector}(1業種${plan.satellite.max_per_sector}銘柄まで)。</td></tr>`).join("")}
${postponed.map((b) => `<tr class="hold"><td>見送り</td><td>${b.symbol} ${b.name}</td><td class="num">${lastRaw(b.symbol)?.toFixed(0) ?? "—"}</td><td class="num">${yen(b.amount)}</td><td class="num">—</td><td>残枠不足。</td></tr>`).join("")}
</table>

<h2>4. リロード枠 (課税口座 / 目標 ${yen(reloadBudget)}、${plan.reload.positions}銘柄)</h2>
${state.reload.length ? `<p>保有中: ${state.reload.map((r) => `${r.symbol} ${r.name}`).join("、")}。日々の利確/損切り判定は reload_monitor.html を参照。</p>` : ""}
${reloadTargets.length ? `<table><tr><th>操作</th><th>銘柄</th><th>直近終値(生値)</th><th>金額目安</th><th>株数目安</th><th>根拠</th></tr>
${reloadTargets.map((r) => `<tr class="buy"><td>買付</td><td>${r.symbol} ${r.name}</td><td class="num">${lastRaw(r.symbol)?.toFixed(0) ?? "—"}</td><td class="num">${yen(reloadBudget / plan.reload.positions)}</td><td class="num">${sharesFor(r.symbol, reloadBudget / plan.reload.positions)}</td><td>高ボラ(年率 ${pctf(r.vol)})×モメンタム ${pctf(r.mom)}。+20%で利確 / -8%で損切りし、次候補へ入替。約定単価を必ず記録(±判定の基準)。</td></tr>`).join("")}</table>` : `<p>追加購入なし(定員${plan.reload.positions}銘柄まで保有済み)。</p>`}

<h2>5. 発注前の確認 (事業毀損チェック)</h2>
<p>買付対象の各銘柄について、以下に1つでも該当すればその銘柄は買わない(configのsell_rules準拠)。確認して□を埋めること。</p>
<table><tr><th>銘柄</th>${plan.sell_rules.business_damage_triggers.map((t) => `<th>${t}</th>`).join("")}</tr>
${[...buys, ...reloadTargets].map((b) => `<tr><td>${b.symbol} ${b.name}</td>${plan.sell_rules.business_damage_triggers.map(() => `<td><span class="check"></span>なし</td>`).join("")}</tr>`).join("")}
</table>

<h2>6. 約定後にやること — この通りにコマンドを打つ(価格は実際の約定単価に置換)</h2>
<p class="small">下のコマンドは本指示書の操作をそのまま写したものです。<b>末尾の株価は基準日の目安値</b>なので、実際に約定した単価・株数に打ち替えてから実行してください(枠超過は自動でエラーになります)。</p>
<pre style="background:#0b1f2e;color:#d7e6f0;padding:12px;border-radius:8px;overflow-x:auto;font-size:13px;line-height:1.7">${[
  ...sells.map((h) => `node src/record_trade.mjs sat-sell ${h.symbol} ${lastRaw(h.symbol)?.toFixed(0) ?? "約定単価"}`),
  ...buys.map((b) => `node src/record_trade.mjs sat-buy ${b.symbol} ${lastRaw(b.symbol)?.toFixed(0) ?? "約定単価"} ${sharesFor(b.symbol, b.amount)?.replace("株", "") ?? "株数"}`),
  ...reloadTargets.map((r) => `node src/record_trade.mjs reload-buy ${r.symbol} ${lastRaw(r.symbol)?.toFixed(0) ?? "約定単価"} ${sharesFor(r.symbol, reloadBudget / plan.reload.positions)?.replace("株", "") ?? "株数"}`),
  "node src/record_trade.mjs status   # 最後に残枠・保有を確認",
].join("\n") || "(今回は売買なし)"}</pre>
<p class="small">裁量で変えた場合は行末に <code>-- override "理由"</code> を付ける。全件入力後、上の status で保有8・残枠が想定通りかを必ず確認。</p>`;

fs.writeFileSync(path.join(reportsDir, "rebalance_order.html"), htmlPage("リバランス指示書", body), "utf8");
console.log(`rebalance_order.html written (asOf=${asOf}, core=${coreAction.type}:${coreAction.leg}, satBuys=${buys.length}, satSells=${sells.length}, postponed=${postponed.length}, quotaLeft after=${Math.round(quotaAfter)})`);
