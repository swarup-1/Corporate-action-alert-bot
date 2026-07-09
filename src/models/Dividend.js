const mongoose = require('mongoose');

const dividendSchema = new mongoose.Schema(
  {
    dedupKey: { type: String, required: true, unique: true },
    exchange: { type: String, enum: ['NSE', 'BSE'], required: true },
    symbol: { type: String, required: true },
    company: { type: String, default: '' },
    dividend: { type: Number, default: 0 },
    cmp: { type: Number, default: 0 },
    yield: { type: Number, default: 0 },
    announcedAt: { type: String, default: '' },
    exDate: { type: String, default: '' },
    recordDate: { type: String, default: '' },
    rawSubject: { type: String, default: '' },
    source: { type: String, default: '' },
    actionType: { type: String, default: 'dividend' },
  },
  { timestamps: true },
);

dividendSchema.methods.toResponse = function toResponse() {
  return {
    id: this._id.toString(),
    exchange: this.exchange,
    symbol: this.symbol,
    company: this.company,
    dividend: this.dividend,
    cmp: this.cmp,
    yield: this.yield,
    announcedAt: this.announcedAt,
    exDate: this.exDate,
    recordDate: this.recordDate,
    rawSubject: this.rawSubject,
    source: this.source,
  };
};

module.exports = mongoose.model('Dividend', dividendSchema);
