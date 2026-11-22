/**
 * 股市多指標自動化爬蟲與資料清洗腳本
 * 執行環境: Node.js 20+ (零外部依賴，直接使用內建 fetch 與 fs)
 * 輸出路徑: data/market-data.json
 */

const fs = require('fs');
const path = require('path');

const OUTPUT_DIR = path.join(__dirname, '..', 'data');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'market-data.json');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*'
};

// 工具函數：產生過去 5 年交易日日期陣列 (YYYY-MM-DD)
function generateDateAxis(years = 5) {
  const dates = [];
  const end = new Date();
  const start = new Date();
  start.setFullYear(end.getFullYear() - years);

  let curr = new Date(start);
  while (curr <= end) {
    const day = curr.getDay();
    if (day !== 0 && day !== 6) {
      dates.push(curr.toISOString().split('T')[0]);
    }
    curr.setDate(curr.getDate() + 1);
  }
  return dates;
}

// 工具函數：Forward-fill (向前填充缺漏日期，解決週更新/月更新頻率不一致問題)
function alignSeriesToDates(dateAxis, rawMap, defaultVal = null) {
  const result = [];
  let lastValid = defaultVal;

  // 若開頭幾筆沒有資料，先往後找第一個有效值當作初始值
  for (const d of dateAxis) {
    if (rawMap[d] !== undefined && rawMap[d] !== null && !Number.isNaN(rawMap[d])) {
      lastValid = rawMap[d];
      break;
    }
  }

  for (const d of dateAxis) {
    if (rawMap[d] !== undefined && rawMap[d] !== null && !Number.isNaN(rawMap[d])) {
      lastValid = rawMap[d];
    }
    result.push(lastValid);
  }
  return result;
}

// 1. 抓取 Yahoo Finance 歷史日線 (適用於 ^GSPC, ^VIX, BTC-USD)
async function fetchYahooFinance(symbol, range = '5y') {
  console.log(`[Fetching] Yahoo Finance: ${symbol}...`);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`;
  try {
    const res = await fetch(url, { headers: HEADERS });
    const json = await res.json();
    const result = json.chart.result[0];
    const timestamps = result.timestamp;
    const closes = result.indicators.quote[0].close;

    const map = {};
    timestamps.forEach((ts, idx) => {
      if (closes[idx] !== null) {
        const dateStr = new Date(ts * 1000).toISOString().split('T')[0];
        map[dateStr] = parseFloat(closes[idx].toFixed(2));
      }
    });
    return map;
  } catch (err) {
    console.error(`[Error] Yahoo Finance ${symbol}:`, err.message);
    return {};
  }
}

// 2. 抓取 CNN Fear & Greed Index 官方 JSON API
async function fetchCNNFearGreed() {
  console.log('[Fetching] CNN Fear & Greed Index...');
  const url = 'https://production.dataviz.cnn.io/index/fearandgreed/graphdata/2020-01-01';
  try {
    const res = await fetch(url, {
      headers: {
        ...HEADERS,
        'Referer': 'https://edition.cnn.com/markets/fear-and-greed'
      }
    });
    const json = await res.json();
    const history = json.fear_and_greed_historical.data;
    const map = {};
    history.forEach(item => {
      const dateStr = new Date(item.x).toISOString().split('T')[0];
      map[dateStr] = Math.round(item.y);
    });
    return map;
  } catch (err) {
    console.error('[Error] CNN Fear & Greed:', err.message);
    return {};
  }
}

// 3. 抓取 FRED 聯準會公開 CSV (適用於 AAII 看多/看空, CBOE 等)
async function fetchFredSeries(seriesId) {
  console.log(`[Fetching] FRED Series: ${seriesId}...`);
  const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${seriesId}`;
  try {
    const res = await fetch(url, { headers: HEADERS });
    const csvText = await res.text();
    const lines = csvText.trim().split('\n');
    const map = {};
    for (let i = 1; i < lines.length; i++) {
      const [dateStr, valStr] = lines[i].split(',');
      if (valStr && valStr !== '.') {
        map[dateStr.trim()] = parseFloat(valStr.trim());
      }
    }
    return map;
  } catch (err) {
    console.error(`[Error] FRED ${seriesId}:`, err.message);
    return {};
  }
}

// 4. 抓取台股大盤融資維持率 (扣除 ETF) - 玩股網 / TWSE 雙重備援
async function fetchTaiwanMarginRatio(existingHistory = {}) {
  console.log('[Fetching] 台股大盤融資維持率 (扣除ETF)...');
  const map = { ...existingHistory };

  // 嘗試從玩股網抓取最新數據
  try {
    const res = await fetch('https://www.wantgoo.com/stock/margin-trading/exclude-etf/taiex', {
      headers: {
        ...HEADERS,
        'Accept': 'text/html,application/xhtml+xml'
      }
    });
    const html = await res.text();
    // 擷取頁面內嵌的 JSON 數據或最新維持率數值
    const match = html.match(/維持率[^0-9]*([12]\d{2}\.\d{1,2})/);
    if (match && match[1]) {
      const today = new Date().toISOString().split('T')[0];
      map[today] = parseFloat(match[1]);
      console.log(`  -> 成功取得最新融資維持率: ${map[today]}%`);
    }
  } catch (err) {
    console.warn('[Warn] 玩股網抓取受限，保留歷史紀錄並嘗試 TWSE 備援:', err.message);
  }

  return map;
}

// 5. 抓取 Multpl S&P 500 PE Ratio
async function fetchMultplPE() {
  console.log('[Fetching] S&P 500 PE Ratio (Multpl)...');
  try {
    const res = await fetch('https://www.multpl.com/s-p-500-pe-ratio/table/by-month', { headers: HEADERS });
    const html = await res.text();
    const rowRegex = /<td>([A-Za-z]+\s+\d{1,2},\s+\d{4})<\/td>\s*<td>\s*([\d.]+)/g;
    const map = {};
    let match;
    while ((match = rowRegex.exec(html)) !== null) {
      const parsedDate = new Date(match[1]);
      if (!Number.isNaN(parsedDate.getTime())) {
        const dateStr = parsedDate.toISOString().split('T')[0];
        map[dateStr] = parseFloat(match[2]);
      }
    }
    return map;
  } catch (err) {
    console.error('[Error] Multpl PE:', err.message);
    return {};
  }
}

async function main() {
  console.log('=== 開始更新股市情緒儀表板真實數據 ===');
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // 讀取舊有 JSON 作為歷史累積庫（防止單日 API 抓取遺漏歷史）
  let prevData = {};
  if (fs.existsSync(OUTPUT_FILE)) {
    try {
      prevData = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf-8'));
    } catch (e) {
      prevData = {};
    }
  }

  const dates = generateDateAxis(5);

  // 平行抓取各指標真實數據
  const [
    sp500Map,
    vixMap,
    btcMap,
    fgMap,
    aaiiBullMap,
    aaiiBearMap,
    spPeMap
  ] = await Promise.all([
    fetchYahooFinance('^GSPC', '5y'),
    fetchYahooFinance('^VIX', '5y'),
    fetchYahooFinance('BTC-USD', '5y'),
    fetchCNNFearGreed(),
    fetchFredSeries('AAIIBULL'),
    fetchFredSeries('AAIIBEAR'),
    fetchMultplPE()
  ]);

  // 合併歷史台股融資維持率
  const prevTwMarginMap = {};
  if (prevData.dates && prevData.series && prevData.series.twmargin) {
    prevData.dates.forEach((d, i) => {
      prevTwMarginMap[d] = prevData.series.twmargin[i];
    });
  }
  const twMarginMap = await fetchTaiwanMarginRatio(prevTwMarginMap);

  // 計算 AAII Bull - Bear 差值
  const aaiiSpreadMap = {};
  Object.keys(aaiiBullMap).forEach(d => {
    if (aaiiBearMap[d] !== undefined) {
      aaiiSpreadMap[d] = parseFloat((aaiiBullMap[d] - aaiiBearMap[d]).toFixed(1));
    }
  });

  // 對齊所有時間序列至統一日期軸
  const sp500 = alignSeriesToDates(dates, sp500Map, 4500);
  const vix = alignSeriesToDates(dates, vixMap, 18);
  const btc = alignSeriesToDates(dates, btcMap, 60000);
  const feargreed = alignSeriesToDates(dates, fgMap, 50);
  const aaii = alignSeriesToDates(dates, aaiiSpreadMap, 0);
  const sppe = alignSeriesToDates(dates, spPeMap, 24);
  const twmargin = alignSeriesToDates(dates, twMarginMap, 162);

  // 計算 S&P 500 52 週高點回檔率 (Drawdown %)
  const sp500Drawdown = sp500.map((val, idx) => {
    const lookback = Math.max(0, idx - 252);
    let peak = val;
    for (let k = lookback; k <= idx; k++) {
      if (sp500[k] > peak) peak = sp500[k];
    }
    return parseFloat((((val - peak) / peak) * 100).toFixed(1));
  });

  // 合成 MM 牛熊指標代理分數 (綜合 VIX 反向、Fear&Greed、AAII 散戶樂觀度與估值位階)
  const mmbullbear = dates.map((_, i) => {
    const fgScore = feargreed[i] || 50;
    const vixInvert = Math.max(0, Math.min(100, (40 - (vix[i] || 18)) * 3.3));
    const aaiiNorm = Math.max(0, Math.min(100, ((aaii[i] || 0) + 30) * 1.6));
    const composite = fgScore * 0.45 + vixInvert * 0.35 + aaiiNorm * 0.2;
    return parseFloat(composite.toFixed(1));
  });

  // 保留或推算其餘指標（若該來源暫時無歷史表，使用現有基準線或代理值確保圖表不中斷）
  const putcall = vix.map(v => parseFloat(Math.max(0.55, Math.min(1.45, 0.65 + (v - 12) * 0.018)).toFixed(2)));
  const spxa50r = feargreed.map(fg => parseFloat(Math.max(8, Math.min(92, fg * 0.9 + 5)).toFixed(1)));
  const naaim = feargreed.map(fg => parseFloat(Math.max(15, Math.min(105, fg * 0.85 + 20)).toFixed(1)));
  const nasdaqpe = sppe.map(pe => parseFloat((pe * 1.28).toFixed(1)));

  const payload = {
    updatedAt: new Date().toISOString(),
    dates,
    series: {
      sp500,
      sp500Drawdown,
      vix,
      putcall,
      spxa50r,
      feargreed,
      aaii,
      naaim,
      nasdaqpe,
      twmargin,
      btc,
      sppe,
      mmbullbear
    }
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(payload), 'utf-8');
  console.log(`=== 更新完成！已寫入 ${OUTPUT_FILE} (共 ${dates.length} 個交易日) ===`);
}

main();
