import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const alphaRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = path.resolve(alphaRoot, "..");
const configDir = path.join(alphaRoot, "config");
const dataDir = path.join(alphaRoot, "data");
const pricesDir = path.join(dataDir, "prices");
const reportsDir = path.join(alphaRoot, "reports");
const readonlySeedPath = path.join(workspaceRoot, "kabu_publish", "199_universe100_screening.csv");

const priceHeaders = ["date", "close_raw", "close_adj", "volume", "source_url", "fetched_at"];
const universeHeaders = ["symbol", "name", "sector", "market_cap", "avg_value", "source", "as_of"];

// セクター正規化(add_sector と同一規則)。シード列が空なら既存 universe.csv の値を引き継ぐ。
// これを欠くと universe.csv 再生成でセクター列が消え、セクター上限判定が全銘柄「その他」
// (=上限2でサテライトが2銘柄になる)というサイレント故障を起こす。
function normalizeSector(raw) {
  let x = (raw || "").split("/")[0].trim();
  if (x === "半導体装置") x = "半導体";
  return x;
}
const fundamentalsHeaders = [
  "symbol",
  "name",
  "per",
  "pbr",
  "roe_pct",
  "profit_metric",
  "profit_yoy_pct",
  "profit_cagr_3period_pct",
  "revenue_yoy_pct",
  "revenue_cagr_3period_pct",
  "source",
  "as_of",
  "limitations"
];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function ensureDirs() {
  for (const dir of [configDir, dataDir, pricesDir, reportsDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function csvCell(value) {
  const s = value == null ? "" : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function writeCsv(file, headers, rows) {
  const body = [
    headers.map(csvCell).join(","),
    ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(","))
  ].join("\r\n");
  fs.writeFileSync(file, `\uFEFF${body}\r\n`, "utf8");
}

function parseCsv(text) {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell.replace(/\r$/, ""));
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }
  if (cell || row.length) {
    row.push(cell.replace(/\r$/, ""));
    if (row.some((value) => value !== "")) rows.push(row);
  }
  return rows;
}

function readCsvRecords(file) {
  const rows = parseCsv(fs.readFileSync(file, "utf8"));
  const headers = rows.shift() ?? [];
  return rows.map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ""])));
}

function finiteNumber(value) {
  if (value == null || value === "") return null;
  const n = Number(String(value).replaceAll(",", ""));
  return Number.isFinite(n) ? n : null;
}

function addYears(date, years) {
  const next = new Date(date.getTime());
  next.setUTCFullYear(next.getUTCFullYear() + years);
  return next;
}

function tokyoDate(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function unixSeconds(date) {
  return Math.floor(date.getTime() / 1000);
}

function sourceUrl(symbol, start, end) {
  const period1 = unixSeconds(start);
  const period2 = unixSeconds(end);
  return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${period1}&period2=${period2}&interval=1d&events=history`;
}

async function fetchChart(symbol, start, end, fetchedAt) {
  const url = sourceUrl(symbol, start, end);
  const response = await fetch(url, {
    headers: { "user-agent": "nisa-alpha-builder/1.0" }
  });
  if (!response.ok) throw new Error(`${symbol}: HTTP ${response.status}`);
  const json = await response.json();
  const result = json.chart?.result?.[0];
  if (!result?.timestamp?.length) throw new Error(`${symbol}: chart result is empty`);
  const quote = result.indicators?.quote?.[0] ?? {};
  const adj = result.indicators?.adjclose?.[0]?.adjclose ?? [];
  const rows = result.timestamp.map((timestamp, index) => ({
    date: new Date(timestamp * 1000).toISOString().slice(0, 10),
    close_raw: quote.close?.[index] ?? "",
    close_adj: adj[index] ?? quote.close?.[index] ?? "",
    volume: quote.volume?.[index] ?? "",
    source_url: url,
    fetched_at: fetchedAt
  })).filter((row) => row.close_raw !== "" || row.close_adj !== "");
  return { rows, meta: result.meta ?? {}, url };
}

function loadReadonlySeed(plan) {
  if (!fs.existsSync(readonlySeedPath)) {
    throw new Error(`Readonly seed not found: ${readonlySeedPath}`);
  }
  const sourceRows = readCsvRecords(readonlySeedPath);
  const candidates = [];
  for (const row of sourceRows) {
    const marketCapMillion = finiteNumber(row.market_cap_million_jpy);
    if (!row.ticker || !marketCapMillion) continue;
    const marketCapYen = marketCapMillion * 1_000_000;
    if (marketCapYen < plan.universe.min_market_cap_yen) continue;
    candidates.push({
      symbol: row.ticker,
      name: row.company,
      market_cap: Math.round(marketCapYen),
      source_row: row,
      source: `local_readonly:${path.relative(workspaceRoot, readonlySeedPath)}; original_metric_source=Yahoo Japan snapshot in seed`
    });
  }
  return { sourceRows, candidates };
}

function averageDailyValue(rows, tradingDays) {
  const usable = rows
    .map((row) => ({
      close: finiteNumber(row.close_adj),
      volume: finiteNumber(row.volume)
    }))
    .filter((row) => Number.isFinite(row.close) && Number.isFinite(row.volume))
    .slice(-tradingDays);
  if (!usable.length) return null;
  return usable.reduce((sum, row) => sum + row.close * row.volume, 0) / usable.length;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function priceFile(symbol) {
  return path.join(pricesDir, `${symbol}.csv`);
}

function writeUniverseNotes({ plan, rules, sourceRows, marketCapCandidates, finalUniverse, errors, fetchedAt, asOfDate }) {
  const notes = `# nisa_alpha Phase 1 Universe Notes

Generated at: ${fetchedAt} UTC / ${asOfDate} Asia/Tokyo

## Method

- Primary price source: Yahoo Finance chart API.
- Price files use adjusted close from \`indicators.adjclose\` when available.
- Read-only seed for candidate names, market cap and snapshot fundamentals:
  \`${path.relative(workspaceRoot, readonlySeedPath)}\`.
- Market-cap gate: at least ${plan.universe.min_market_cap_yen.toLocaleString("ja-JP")} yen.
- Liquidity gate: average daily value over the latest ${rules.liquidity_avg_trading_days} fetched trading rows must be at least ${plan.universe.min_avg_daily_value_yen.toLocaleString("ja-JP")} yen.

## Counts

- Seed rows read: ${sourceRows.length}
- Rows passing market-cap gate from seed: ${marketCapCandidates.length}
- Final universe rows after price fetch and liquidity gate: ${finalUniverse.length}
- Price fetch errors: ${errors.length}

## Limits

- This is not a complete live JPX Prime universe. JPX official listed-company XLS was identified as the primary listing source, but this dependency-free Phase 1 implementation does not parse legacy .xls files.
- Yahoo Finance quote and quoteSummary endpoints returned authorization errors in this environment, so current market cap, PER/PBR, ROE and profit-margin fields are not refreshed from those endpoints.
- Market-cap and financial fields are read from the frozen read-only seed snapshot, then liquidity is refreshed from Yahoo chart price and volume.
- Past delisted stocks are not included. This creates survivorship bias, especially for Phase 2 backtests.
- Snapshot fundamentals in \`data/fundamentals.csv\` must not be used as if they were historically available at each walk-forward selection date.
- Missing values remain blank. No estimated or filled values were created.

## User Confirmation Needed Before Phase 2

- Free stable API access for ROE, profit margin and PER/PBR was not available through Yahoo quote endpoints. Confirm whether Phase 2 may proceed with momentum plus low-volatility only, or provide an approved financial-data source.
`;
  fs.writeFileSync(path.join(dataDir, "universe_notes.md"), notes, "utf8");
}

async function main() {
  ensureDirs();
  const plan = readJson(path.join(configDir, "plan.json"));
  const rules = readJson(path.join(configDir, "data_rules.json"));
  const fetchedAt = new Date().toISOString();
  const asOfDate = tokyoDate(new Date(fetchedAt));
  const end = new Date();
  end.setUTCDate(end.getUTCDate() + 1);
  const start = addYears(end, -rules.price_history_years);

  // 母集団の正本は universe.csv。存在する場合はそのメンバーを維持して価格・流動性のみ更新する
  // (静的シード199から再導出すると、年次の母集団更新が四半期の価格更新で巻き戻されるため)。
  // universe.csv が無い初期構築時のみシードから導出する。
  const universePath0 = path.join(dataDir, "universe.csv");
  let sourceRows = [];
  let marketCapCandidates;
  if (fs.existsSync(universePath0)) {
    const rows = readCsvRecords(universePath0);
    marketCapCandidates = rows.map((row) => ({
      symbol: row.symbol,
      name: row.name,
      market_cap: finiteNumber(row.market_cap) ?? 0,
      source_row: { sector: row.sector },
      source: row.source || "existing_universe"
    }));
    console.log(`universe.csv を正本として ${marketCapCandidates.length} 銘柄の価格を更新(メンバー変更は refresh_universe.mjs で行う)`);
  } else {
    ({ sourceRows, candidates: marketCapCandidates } = loadReadonlySeed(plan));
  }
  const benchmarks = rules.benchmarks.map((item) => ({ ...item, benchmark: true }));
  const targets = [
    ...marketCapCandidates.map((item) => ({ symbol: item.symbol, name: item.name, candidate: item })),
    ...benchmarks
  ];
  const uniqueTargets = [...new Map(targets.map((item) => [item.symbol, item])).values()];
  const fetched = new Map();
  const errors = [];

  for (const target of uniqueTargets) {
    try {
      const result = await fetchChart(target.symbol, start, end, fetchedAt);
      writeCsv(priceFile(target.symbol), priceHeaders, result.rows);
      fetched.set(target.symbol, result);
      console.log(`fetched ${target.symbol}: ${result.rows.length} rows`);
    } catch (error) {
      errors.push({ symbol: target.symbol, name: target.name, error: error.message, fetched_at: fetchedAt });
      console.error(`fetch failed ${target.symbol}: ${error.message}`);
    }
    await sleep(rules.network_delay_ms);
  }

  const existingSector = new Map();
  const universePath = path.join(dataDir, "universe.csv");
  if (fs.existsSync(universePath)) {
    for (const row of readCsvRecords(universePath)) {
      if (row.symbol && row.sector) existingSector.set(row.symbol, row.sector);
    }
  }
  const fromExisting = fs.existsSync(universePath0);
  const finalUniverse = [];
  for (const candidate of marketCapCandidates) {
    const result = fetched.get(candidate.symbol);
    if (!result) {
      // 既存母集団の銘柄は取得失敗でも脱落させない(前回価格ファイルで運用継続)
      if (fromExisting) finalUniverse.push({
        symbol: candidate.symbol, name: candidate.name,
        sector: normalizeSector(candidate.source_row?.sector) || existingSector.get(candidate.symbol) || "その他",
        market_cap: candidate.market_cap, avg_value: "",
        source: `${candidate.source}; price_fetch_failed=${asOfDate}`, as_of: asOfDate
      });
      continue;
    }
    const avgValue = averageDailyValue(result.rows, rules.liquidity_avg_trading_days);
    if (!Number.isFinite(avgValue) || avgValue < plan.universe.min_avg_daily_value_yen) {
      // 既存母集団は四半期更新では除外しない(除外判定は年次の refresh_universe.mjs のみ)
      if (fromExisting) {
        console.warn(`流動性警告: ${candidate.symbol} avg_value=${Math.round(avgValue ?? 0).toLocaleString("ja-JP")} < 基準。年次見直しで除外候補`);
      } else {
        continue;
      }
    }
    finalUniverse.push({
      symbol: candidate.symbol,
      name: candidate.name || result.meta.longName || result.meta.shortName || candidate.symbol,
      sector: normalizeSector(candidate.source_row?.sector) || existingSector.get(candidate.symbol) || "その他",
      market_cap: candidate.market_cap,
      avg_value: Number.isFinite(avgValue) ? Math.round(avgValue) : "",
      source: `${String(candidate.source).split("; liquidity_source=")[0].split("; price_fetch_failed=")[0]}; liquidity_source=Yahoo chart API`,
      as_of: asOfDate
    });
  }

  writeCsv(path.join(dataDir, "universe.csv"), universeHeaders, finalUniverse);
  writeCsv(path.join(dataDir, "fundamentals.csv"), fundamentalsHeaders, finalUniverse.map((item) => {
    const seed = marketCapCandidates.find((candidate) => candidate.symbol === item.symbol)?.source_row ?? {};
    return {
      symbol: item.symbol,
      name: item.name,
      per: seed.per_forecast,
      pbr: seed.pbr_actual,
      roe_pct: seed.roe_actual_pct,
      profit_metric: seed.profit_metric_used,
      profit_yoy_pct: seed.profit_yoy_pct,
      profit_cagr_3period_pct: seed.profit_cagr_3period_pct,
      revenue_yoy_pct: seed.revenue_yoy_pct,
      revenue_cagr_3period_pct: seed.revenue_cagr_3period_pct,
      source: `local_readonly:${path.relative(workspaceRoot, readonlySeedPath)}`,
      as_of: seed.updated_at || asOfDate,
      limitations: "snapshot only; not usable as historical point-in-time data"
    };
  }));
  writeCsv(path.join(reportsDir, "data_fetch_errors.csv"), ["symbol", "name", "error", "fetched_at"], errors);
  writeUniverseNotes({
    plan,
    rules,
    sourceRows,
    marketCapCandidates,
    finalUniverse,
    errors,
    fetchedAt,
    asOfDate
  });

  console.log(`universe rows: ${finalUniverse.length}`);
  console.log(`fetch errors: ${errors.length}`);
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exit(1);
});
