const mongoose = require('mongoose');

const settingSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'global', unique: true },
    environment: { type: String, enum: ['sandbox', 'production'], default: 'sandbox' },
    midtrans_server_key: { type: String, default: '' },
    midtrans_client_key: { type: String, default: '' },
    use_midtrans: { type: String, enum: ['yes', 'no'], default: 'no' },
    manual_qris_url: { type: String, default: '' },
    manual_qris_file_id: { type: String, default: '' },

    price_strip: { type: Number, default: 15000 },
    price_news: { type: Number, default: 20000 },
    price_strip_promo: { type: Number, default: 12000 },
    timer: { type: Number, default: 6 },

    global_voucher_expiry_iso: { type: String, default: '2026-12-31T23:59' },
    global_voucher_expiry_ts: { type: Number, default: 1798736340 },
    global_voucher_expiry_label: { type: String, default: '31 Des 2026, 23:59 WIB' },
  },
  { timestamps: true }
);

settingSchema.statics.getGlobal = async function () {
  let doc = await this.findOne({ key: 'global' });
  if (!doc) {
    doc = await this.create({ key: 'global' });
  }
  return doc;
};

module.exports = mongoose.model('Setting', settingSchema);