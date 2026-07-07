# nisa_alpha Phase 1 Universe Notes

Generated at: 2026-07-07T07:35:58.252Z UTC / 2026-07-07 Asia/Tokyo

## Method

- Primary price source: Yahoo Finance chart API.
- Price files use adjusted close from `indicators.adjclose` when available.
- Read-only seed for candidate names, market cap and snapshot fundamentals:
  `kabu_publish\199_universe100_screening.csv`.
- Market-cap gate: at least 200,000,000,000 yen.
- Liquidity gate: average daily value over the latest 60 fetched trading rows must be at least 1,000,000,000 yen.

## Counts

- Seed rows read: 0
- Rows passing market-cap gate from seed: 53
- Final universe rows after price fetch and liquidity gate: 53
- Price fetch errors: 0

## Limits

- This is not a complete live JPX Prime universe. JPX official listed-company XLS was identified as the primary listing source, but this dependency-free Phase 1 implementation does not parse legacy .xls files.
- Yahoo Finance quote and quoteSummary endpoints returned authorization errors in this environment, so current market cap, PER/PBR, ROE and profit-margin fields are not refreshed from those endpoints.
- Market-cap and financial fields are read from the frozen read-only seed snapshot, then liquidity is refreshed from Yahoo chart price and volume.
- Past delisted stocks are not included. This creates survivorship bias, especially for Phase 2 backtests.
- Snapshot fundamentals in `data/fundamentals.csv` must not be used as if they were historically available at each walk-forward selection date.
- Missing values remain blank. No estimated or filled values were created.

## User Confirmation Needed Before Phase 2

- Free stable API access for ROE, profit margin and PER/PBR was not available through Yahoo quote endpoints. Confirm whether Phase 2 may proceed with momentum plus low-volatility only, or provide an approved financial-data source.
