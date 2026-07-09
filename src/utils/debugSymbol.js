const DEBUG_SYMBOLS = (process.env.DEBUG_SYMBOLS || '')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

function matchesDebugSymbol(symbol, company = '') {
  if (DEBUG_SYMBOLS.length === 0) return false;
  const sym = String(symbol || '').toUpperCase();
  const name = String(company || '').toUpperCase();
  return DEBUG_SYMBOLS.some((d) => sym.includes(d) || name.includes(d));
}


module.exports = { DEBUG_SYMBOLS, matchesDebugSymbol };
