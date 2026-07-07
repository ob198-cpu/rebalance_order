// Phase 4 運用ツール共通ライブラリ。
// 選定・判定ロジックはバックテスト(run_backtest_design_e.mjs)と同一式を使う。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const pricesDir = path.join(root, "data", "prices");
export const reportsDir = path.join(root, "reports");

export function readPlan() {
  return JSON.parse(fs.readFileSync(path.join(root, "config", "plan.json"), "utf8"));
}
export function readState() {
  return JSON.parse(fs.readFileSync(path.join(root, "data", "portfolio_state.json"), "utf8"));
}

export function parseCsv(text) {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = src.split(/\r?\n/).filter((l) => l.length);
  const headers = lines[0].split(",");
  return lines.slice(1).map((l) => {
    const cells = l.split(",");
    return Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? ""]));
  });
}

export function loadPrice(symbol, excl1306 = false) {
  const rows = parseCsv(fs.readFileSync(path.join(pricesDir, `${symbol}.csv`), "utf8"))
    .map((r) => ({ date: r.date, close: Number(r.close_adj), raw: Number(r.close_raw) }))
    .filter((r) => r.date && Number.isFinite(r.close));
  if (excl1306) return rows.filter((r) => r.date !== "2026-03-30" && r.date !== "2026-03-31");
  return rows;
}

export function onOrBefore(rows, d) {
  let lo = 0, hi = rows.length - 1, best = null;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (rows[m].date <= d) { best = rows[m]; lo = m + 1; } else hi = m - 1; }
  return best;
}
export function ret(rows, s, e) {
  const a = onOrBefore(rows, s), b = onOrBefore(rows, e);
  if (!a || !b || a.close <= 0) return null;
  return b.close / a.close - 1;
}
export function addMonths(d, m) { const x = new Date(`${d}T00:00:00Z`); x.setUTCMonth(x.getUTCMonth() + m); return x.toISOString().slice(0, 10); }
export function stdev(xs) { if (xs.length < 2) return null; const m = xs.reduce((a, b) => a + b, 0) / xs.length; return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1)); }
export function pctile(values, p) { const xs = values.filter(Number.isFinite).sort((a, b) => a - b); if (!xs.length) return null; const pos = (xs.length - 1) * p, lo = Math.floor(pos), hi = Math.ceil(pos); return lo === hi ? xs[lo] : xs[lo] + (xs[hi] - xs[lo]) * (pos - lo); }

export function loadUniverse() {
  return parseCsv(fs.readFileSync(path.join(root, "data", "universe.csv"), "utf8"))
    .map((r) => ({ symbol: r.symbol, name: r.name, sector: r.sector || "その他" }));
}

export function loadMarket() {
  const topix = loadPrice("1306.T", true);
  const gspc = loadPrice("^GSPC");
  const jpy = loadPrice("JPY=X");
  const n225 = loadPrice("^N225");
  const spJpy = gspc.map((r) => { const fx = onOrBefore(jpy, r.date); return fx ? { date: r.date, close: r.close * fx.close } : null; }).filter(Boolean);
  return { topix, n225, spJpy };
}

export function scoreAll(universe, px, asOf, plan) {
  const skipEnd = addMonths(asOf, -plan.selection.momentum.skip_months);
  const lookStart = addMonths(skipEnd, -plan.selection.momentum.lookback_months);
  const scored = [];
  for (const u of universe) {
    const rows = px.get(u.symbol);
    if (!rows) continue;
    const mom = ret(rows, lookStart, skipEnd);
    const slice = rows.filter((r) => r.date >= lookStart && r.date <= skipEnd);
    const drets = [];
    for (let i = 1; i < slice.length; i += 1) if (slice[i - 1].close > 0) drets.push(slice[i].close / slice[i - 1].close - 1);
    const vol = stdev(drets);
    if (!Number.isFinite(mom) || !Number.isFinite(vol)) continue;
    scored.push({ symbol: u.symbol, name: u.name, sector: u.sector, mom, vol: vol * Math.sqrt(252) });
  }
  return scored;
}
export function selectSat(scored, plan, held = []) {
  let pool = scored;
  if (plan.selection.exclude_volatility_top_decile) {
    const cut = pctile(scored.map((r) => r.vol), 0.9);
    pool = scored.filter((r) => r.vol <= cut);
  }
  // H案(2026-07-06): ランクバッファ。保有銘柄はモメンタム順位がrank_buffer以内なら優先保持し、
  // 回転とNISA枠消費を抑える(売却しても枠は戻らないため)。残り枠は上位銘柄で充足。
  // セクター上限: 同一セクターはmax_per_sector銘柄まで(保持・新規共通)。
  const cap = plan.satellite.max_per_sector ?? Infinity;
  const buffer = plan.satellite.rank_buffer ?? plan.satellite.holdings_max;
  const sorted = [...pool].sort((a, b) => b.mom - a.mom);
  const rank = new Map(sorted.map((r, i) => [r.symbol, i + 1]));
  const heldSet = new Set(held);
  const bySector = new Map();
  const picked = [];
  const take = (r) => { bySector.set(r.sector, (bySector.get(r.sector) ?? 0) + 1); picked.push(r); };
  for (const r of sorted) {
    if (picked.length >= plan.satellite.holdings_max) break;
    if (!heldSet.has(r.symbol) || rank.get(r.symbol) > buffer) continue;
    if ((bySector.get(r.sector) ?? 0) >= cap) continue;
    take(r);
  }
  for (const r of sorted) {
    if (picked.length >= plan.satellite.holdings_max) break;
    if (picked.some((p) => p.symbol === r.symbol)) continue;
    if ((bySector.get(r.sector) ?? 0) >= cap) continue;
    take(r);
  }
  return picked;
}
export function reloadCandidates(scored) {
  const cut = pctile(scored.map((r) => r.vol), 0.7);
  return scored.filter((r) => r.vol >= cut && r.mom > 0).sort((a, b) => b.mom - a.mom);
}
export function coreDecision(topix, spJpy, asOf, n225 = null) {
  const skipEnd = addMonths(asOf, -1), lookStart = addMonths(skipEnd, -12);
  const mT = ret(topix, lookStart, skipEnd), mS = ret(spJpy, lookStart, skipEnd);
  const mN = n225 ? ret(n225, lookStart, skipEnd) : null;
  // 3市場(TOPIX/日経/S&P500円建て)からモメンタム最大を選択。同値・欠損時はTOPIX優先
  let leg = "topix", best = Number.isFinite(mT) ? mT : -Infinity;
  if (Number.isFinite(mN) && mN > best) { leg = "nikkei"; best = mN; }
  if (Number.isFinite(mS) && mS > best) { leg = "spjpy"; best = mS; }
  return { leg, momTopix: mT, momNikkei: mN, momSpjpy: mS };
}

// データ鮮度チェック(⑪ API障害時手順)。基準日が4暦日より古ければ警告HTMLを返す。
export function stalenessWarning(asOf) {
  const ageDays = Math.floor((Date.now() - new Date(`${asOf}T00:00:00Z`)) / 86400000);
  if (ageDays <= 4) return "";
  return `<div class="danger"><b>データ鮮度警告</b>: 価格データの基準日(${asOf})が${ageDays}日前です。fetch_prices.mjs を再実行してください。
Yahoo API障害で更新できない場合: 判定は前営業日データで続行可。リロードの利確/損切ラインは <code>node src/record_trade.mjs status</code> が表示するので、証券アプリの株価で手動判定できます。3営業日以上更新不能なら判定持ち越し。</div>`;
}

// 株式分割の疑い検出(⑥)。直近lookback営業日に生値が±25%超ジャンプしていれば通知を返す。
export function splitSuspects(pxMap, symbols, asOf, lookback = 7) {
  const out = [];
  for (const s of symbols) {
    const rows = (pxMap.get(s) ?? []).filter((r) => r.date <= asOf).slice(-lookback - 1);
    for (let i = 1; i < rows.length; i += 1) {
      const raw0 = rows[i - 1].raw ?? rows[i - 1].close, raw1 = rows[i].raw ?? rows[i].close;
      if (raw0 > 0 && Math.abs(raw1 / raw0 - 1) > 0.25) out.push({ symbol: s, date: rows[i].date, jump: raw1 / raw0 - 1 });
    }
  }
  return out;
}

export const yen = (v) => `${Math.round(v).toLocaleString("ja-JP")}円`;
export const pctf = (v, d = 1) => Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : "—";

export function htmlPage(title, rawBody) {
  // 先頭のヘッダ行(<th>のみの<tr>)を<thead>に包み、改ページ時に各ページでヘッダを再表示させる
  const body = rawBody.replaceAll(/<table>(\s*<tr>\s*<th>[\s\S]*?<\/tr>)/g, "<table><thead>$1</thead>");
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${title}</title>
<style>
body{font-family:Meiryo,"Noto Sans JP",sans-serif;color:#102333;line-height:1.75;margin:28px;max-width:1080px}
h1{color:#0b4f79;font-size:22px}h2{color:#0b4f79;font-size:18px;margin-top:28px;border-bottom:2px solid #d5e5f0;padding-bottom:4px}
table{border-collapse:collapse;width:100%;margin:12px 0}th,td{border:1px solid #bfd6e6;padding:7px 9px;vertical-align:top;font-size:13.5px}
th{background:#e8f3fa;text-align:left}td.num{text-align:right}
.buy{background:#eefaf4}.sell{background:#fdecec}.hold{background:#fafafa}
.warn{background:#fff4e5;border:1px solid #e6a23c;padding:12px;border-radius:8px;margin:12px 0}
.ok{background:#eefaf4;border:1px solid #41a36f;padding:12px;border-radius:8px;margin:12px 0}
.danger{background:#fdecec;border:1px solid #c0392b;padding:12px;border-radius:8px;margin:12px 0}
.small{font-size:12px;color:#5a6b78}
.check{width:22px;height:22px;display:inline-block;border:2px solid #7a8b98;border-radius:4px;vertical-align:middle;margin-right:8px}
/* PDF印刷時の改ページ制御 */
thead { display: table-header-group; } /* 表が改ページをまたぐ時、次ページ先頭にヘッダ行を再表示 */
@media print {
  /* 見出しは次の要素と切り離さない。さらに「見出し→説明文→表/ボックス」を数珠つなぎで
     一体化し、見出しだけがページ末尾に取り残される事故を防ぐ(:has で直後が表/divの段落も固定) */
  h1, h2, h3 { break-after: avoid; page-break-after: avoid; break-inside: avoid; }
  p:has(+ table), p:has(+ div), p:has(+ ol), p:has(+ ul), h3:has(+ p) { break-after: avoid; page-break-after: avoid; }
  /* 行・箇条書き項目・注意ボックスは途中で切らない */
  tr, li, .ok, .warn, .danger { break-inside: avoid; page-break-inside: avoid; }
  p { orphans: 3; widows: 3; }
}
</style></head><body>${body}
<p class="small">生成: ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC / nisa_alpha Phase 4 ツール。本資料は判断補助であり、投資助言・自動売買ではありません。</p>
</body></html>`;
}
