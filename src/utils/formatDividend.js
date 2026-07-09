function toDividendResponse(item) {
  if (typeof item.toResponse === 'function') {
    return item.toResponse();
  }

  return {
    id: item.id || item.dedupKey || item._id?.toString(),
    exchange: item.exchange,
    symbol: item.symbol,
    company: item.company || '',
    dividend: item.dividend ?? 0,
    cmp: item.cmp ?? 0,
    yield: item.yield ?? 0,
    announcedAt: item.announcedAt || '',
    exDate: item.exDate || '',
    recordDate: item.recordDate || '',
    rawSubject: item.rawSubject || '',
    source: item.source || '',
  };
}

module.exports = { toDividendResponse };
