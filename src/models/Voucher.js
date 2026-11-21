const mongoose = require('mongoose');

const voucherSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, uppercase: true, trim: true },
    type: { type: String, enum: ['discount', 'free'], default: 'discount' },
    amount_strip: { type: Number, default: 0 },
    amount_news: { type: Number, default: 0 },
    usage_limit: { type: Number, default: 1 },
    usage_count: { type: Number, default: 0 },
    expiry_ts: { type: Number, default: 0 },
    used_package: { type: String, default: '' },
    used_at: { type: String, default: '' },
    notes: { type: String, default: '' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Voucher', voucherSchema);