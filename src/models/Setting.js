const mongoose = require('mongoose');

const imagekitBackupSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, trim: true }, // contoh: 'ik_backup_1732610000'
    label: { type: String, default: 'Cadangan ImageKit', trim: true },
    public_key: { type: String, required: true, trim: true },
    private_key: { type: String, required: true, trim: true },
    url_endpoint: { type: String, required: true, trim: true },
    active: { type: Boolean, default: true },
    priority: { type: Number, default: 1 },
  },
  { _id: false }
);

const settingSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'global', unique: true },
    environment: { type: String, enum: ['sandbox', 'production'], default: 'sandbox' },
    midtrans_server_key: { type: String, default: '' },
    midtrans_client_key: { type: String, default: '' },
    use_midtrans: { type: String, enum: ['yes', 'no'], default: 'no' },
    free_mode: { type: String, enum: ['yes', 'no'], default: 'no' }, // 'yes' = Semua sesi gratis & skip payment
    manual_qris_url: { type: String, default: '' },
    manual_qris_file_id: { type: String, default: '' },

    price_strip: { type: Number, default: 15000 },
    price_news: { type: Number, default: 20000 },
    price_strip_promo: { type: Number, default: 12000 },
    timer: { type: Number, default: 6 },

    global_voucher_expiry_iso: { type: String, default: '2026-12-31T23:59' },
    global_voucher_expiry_ts: { type: Number, default: 1798736340 },
    global_voucher_expiry_label: { type: String, default: '31 Des 2026, 23:59 WIB' },

    // Multi-Account ImageKit Failover (khusus media sesi; aset frame & QRIS tetap di akun primary .env)
    imagekit_active_session_account: { type: String, default: 'auto', trim: true },
    imagekit_backups: { type: [imagekitBackupSchema], default: [] },
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