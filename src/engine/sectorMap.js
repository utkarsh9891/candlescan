/**
 * NSE sector index mapping.
 *
 * Maps NIFTY sector name → Yahoo symbol for the sector index, plus
 * a curated list of frequently-traded NIFTY SMALLCAP 100 members that
 * belong to each sector. The list is manually curated rather than
 * fetched dynamically — it's small and stable (rebalanced quarterly
 * by NSE), and avoids an API round-trip on every scan.
 *
 * Used by:
 *   - risk-scalp.js: to look up a stock's sector and gate trades by
 *     whether that sector is leading or lagging the broader market
 *     at the time of the signal
 *   - CLI sim / browser sim: to fetch sector index candles for the
 *     backtest window and compute intraday sector strength
 */

/** Yahoo symbols for NIFTY sector indices that have reliable 1m data. */
export const SECTOR_INDEX_SYMBOLS = {
  BANK: '^NSEBANK',
  FIN: 'NIFTY_FIN_SERVICE.NS',
  IT: '^CNXIT',
  AUTO: '^CNXAUTO',
  FMCG: '^CNXFMCG',
  PHARMA: '^CNXPHARMA',
  METAL: '^CNXMETAL',
  REALTY: '^CNXREALTY',
  ENERGY: '^CNXENERGY',
  MEDIA: '^CNXMEDIA',
  INFRA: '^CNXINFRA',
  PSE: '^CNXPSE',
};

/**
 * Stock → sector mapping for NIFTY SMALLCAP 100 (and a few frequently
 * traded mid-caps that appear in other indices). Kept as a static
 * lookup so the engine doesn't need to fetch sector info per-stock.
 *
 * Stocks not in this map fall through to sector = null, which means
 * the sector filter treats them as neutral (no boost, no penalty).
 */
export const STOCK_SECTOR = {
  // BANK / FIN
  'IDFCFIRSTB': 'BANK', 'RBLBANK': 'BANK', 'CANFINHOME': 'FIN', 'CHOLAFIN': 'FIN',
  'MANAPPURAM': 'FIN', 'MFSL': 'FIN', 'LICHSGFIN': 'FIN', 'PFC': 'FIN',
  'RECLTD': 'FIN', 'CREDITACC': 'FIN', 'AAVAS': 'FIN', 'PNBHOUSING': 'FIN',
  'EQUITASBNK': 'BANK', 'UJJIVANSFB': 'BANK', 'CSBBANK': 'BANK', 'DCBBANK': 'BANK',
  'KARURVYSYA': 'BANK', 'SOUTHBANK': 'BANK',

  // IT
  'BSOFT': 'IT', 'CYIENT': 'IT', 'HAPPSTMNDS': 'IT', 'INTELLECT': 'IT',
  'KPITTECH': 'IT', 'LATENTVIEW': 'IT', 'MASTEK': 'IT', 'NETWEB': 'IT',
  'NEWGEN': 'IT', 'RATEGAIN': 'IT', 'TANLA': 'IT', 'ZENSARTECH': 'IT',
  'SAGILITY': 'IT', 'ROUTE': 'IT', 'INFOBEAN': 'IT',

  // AUTO
  'APOLLO': 'AUTO', 'APOLLOTYRE': 'AUTO', 'ASHOKLEY': 'AUTO', 'BAJAJHLDNG': 'AUTO',
  'CEAT': 'AUTO', 'CEATLTD': 'AUTO', 'CRAFTSMAN': 'AUTO', 'ENDURANCE': 'AUTO',
  'EXIDEIND': 'AUTO', 'FIEMIND': 'AUTO', 'MOTHERSON': 'AUTO', 'MRF': 'AUTO',
  'SONACOMS': 'AUTO', 'SUBROS': 'AUTO', 'SUNDARMFIN': 'FIN',
  'GABRIEL': 'AUTO', 'JAMNAAUTO': 'AUTO', 'JBMA': 'AUTO', 'LUMAXTECH': 'AUTO',

  // FMCG
  'BIKAJI': 'FMCG', 'CCL': 'FMCG', 'DABUR': 'FMCG', 'DEVYANI': 'FMCG',
  'EMAMILTD': 'FMCG', 'GODFRYPHLP': 'FMCG', 'GODREJAGRO': 'FMCG', 'JUBLFOOD': 'FMCG',
  'KRBL': 'FMCG', 'MARICO': 'FMCG', 'RADICO': 'FMCG', 'TATACONSUM': 'FMCG',
  'UBL': 'FMCG', 'VBL': 'FMCG', 'WESTLIFE': 'FMCG', 'PATANJALI': 'FMCG',
  'GODREJCP': 'FMCG', 'HONASA': 'FMCG',

  // PHARMA
  'AJANTPHARM': 'PHARMA', 'AARTIDRUGS': 'PHARMA', 'ALKEM': 'PHARMA', 'ALIVUS': 'PHARMA',
  'BIOCON': 'PHARMA', 'CAPLIPOINT': 'PHARMA', 'CONCORDBIO': 'PHARMA', 'ERIS': 'PHARMA',
  'GLENMARK': 'PHARMA', 'GRANULES': 'PHARMA', 'IPCALAB': 'PHARMA', 'JBCHEPHARM': 'PHARMA',
  'LAURUSLABS': 'PHARMA', 'MANKIND': 'PHARMA', 'NATCOPHARM': 'PHARMA', 'NEULANDLAB': 'PHARMA',
  'PPLPHARMA': 'PHARMA', 'SAILIFE': 'PHARMA', 'WOCKPHARMA': 'PHARMA', 'ZYDUSWELL': 'PHARMA',
  'ZYDUSLIFE': 'PHARMA', 'EMCURE': 'PHARMA',

  // METAL / MINING
  'GMDCLTD': 'METAL', 'GPIL': 'METAL', 'GRAVITA': 'METAL', 'HINDCOPPER': 'METAL',
  'JINDALSAW': 'METAL', 'KIRLOSBROS': 'METAL', 'MOIL': 'METAL', 'NATIONALUM': 'METAL',
  'NMDC': 'METAL', 'RATNAMANI': 'METAL', 'SAIL': 'METAL', 'WELCORP': 'METAL',
  'JINDALSTEL': 'METAL', 'HINDZINC': 'METAL', 'VEDL': 'METAL',

  // REALTY
  'ANANTRAJ': 'REALTY', 'BRIGADE': 'REALTY', 'DBREALTY': 'REALTY', 'DLF': 'REALTY',
  'GODREJPROP': 'REALTY', 'HEMIPROP': 'REALTY', 'LODHA': 'REALTY', 'MAHLIFE': 'REALTY',
  'OBEROIRLTY': 'REALTY', 'PHOENIXLTD': 'REALTY', 'PRESTIGE': 'REALTY', 'PURVA': 'REALTY',
  'SOBHA': 'REALTY', 'SUNTECK': 'REALTY',

  // ENERGY / POWER
  'ADANIGREEN': 'ENERGY', 'ADANIPOWER': 'ENERGY', 'BPCL': 'ENERGY', 'CESC': 'ENERGY',
  'GSPL': 'ENERGY', 'HINDPETRO': 'ENERGY', 'IGL': 'ENERGY', 'IOC': 'ENERGY',
  'JSWENERGY': 'ENERGY', 'NTPC': 'ENERGY', 'OIL': 'ENERGY', 'ONGC': 'ENERGY',
  'PETRONET': 'ENERGY', 'POWERGRID': 'ENERGY', 'RPOWER': 'ENERGY', 'TATAPOWER': 'ENERGY',
  'TORNTPOWER': 'ENERGY', 'NHPC': 'ENERGY', 'SJVN': 'ENERGY', 'JPPOWER': 'ENERGY',
  'NLCINDIA': 'ENERGY', 'IREDA': 'ENERGY', 'WAAREEENER': 'ENERGY', 'PREMIERENE': 'ENERGY',

  // INFRA
  'AHLUCONT': 'INFRA', 'APARINDS': 'INFRA', 'CGPOWER': 'INFRA', 'DIXON': 'INFRA',
  'GMRINFRA': 'INFRA', 'GMRAIRPORT': 'INFRA', 'HAVELLS': 'INFRA', 'IRCON': 'INFRA',
  'KALYANKJIL': 'INFRA', 'KEI': 'INFRA', 'KNRCON': 'INFRA', 'NCC': 'INFRA',
  'POLYCAB': 'INFRA', 'RVNL': 'INFRA', 'SIEMENS': 'INFRA', 'TITAGARH': 'INFRA',
  'SWSOLAR': 'INFRA', 'GRSE': 'INFRA', 'HBLENGINE': 'INFRA', 'BDL': 'INFRA',
  'INOXWIND': 'INFRA', 'SUZLON': 'ENERGY',

  // MEDIA
  'NAZARA': 'MEDIA', 'NETWORK18': 'MEDIA', 'PVRINOX': 'MEDIA', 'SAREGAMA': 'MEDIA',
  'SUNTV': 'MEDIA', 'TIPSMUSIC': 'MEDIA', 'ZEEL': 'MEDIA',

  // PSE (Public Sector Enterprises — overlap with other sectors but captured here)
  'BEL': 'PSE', 'BEML': 'PSE', 'BHEL': 'PSE', 'COCHINSHIP': 'PSE',
  'HAL': 'PSE', 'IFCI': 'PSE', 'IRFC': 'PSE', 'MAZDOCK': 'PSE',
  'MTNL': 'PSE', 'RAILTEL': 'PSE', 'SHIPCORP': 'PSE', 'HUDCO': 'FIN',
  'PNB': 'BANK', 'BANKBARODA': 'BANK', 'CANBK': 'BANK', 'UNIONBANK': 'BANK',
  'IOB': 'BANK', 'CENTRALBK': 'BANK', 'IDBI': 'BANK', 'MAHABANK': 'BANK',
};

/** @returns {string | null} sector key for a given symbol, or null. */
export function getSector(symbol) {
  if (!symbol) return null;
  const sym = String(symbol).toUpperCase().replace(/\.NS$/, '');
  return STOCK_SECTOR[sym] || null;
}

/** @returns {string | null} Yahoo sector index symbol for a sector key. */
export function getSectorIndexSymbol(sectorKey) {
  if (!sectorKey) return null;
  return SECTOR_INDEX_SYMBOLS[sectorKey] || null;
}
