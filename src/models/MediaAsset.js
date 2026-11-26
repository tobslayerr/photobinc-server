const mongoose = require('mongoose');

const mediaAssetSchema = new mongoose.Schema(
  {
    filename: { type: String, required: true, unique: true, index: true },
    url: { type: String, required: true },
    fileId: { type: String, default: '' },
    storage_account_id: { type: String, default: 'primary', index: true },
    type: { type: String, enum: ['photo', 'video', 'gif', 'raw', 'print'], default: 'photo' },
    order_id: { type: String, default: '' },
    deleted_from_storage: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = mongoose.model('MediaAsset', mediaAssetSchema);