const mongoose = require('mongoose');

const mediaAssetItemSchema = new mongoose.Schema(
  {
    filename: { type: String, default: '' },
    url: { type: String, default: '' },
    fileId: { type: String, default: '' },
    type: { type: String, default: 'photo' },
  },
  { _id: false }
);

const transactionSchema = new mongoose.Schema(
  {
    order_id: { type: String, required: true, unique: true, index: true },
    parent_order_id: { type: String, default: null, index: true },
    package_name: { type: String, required: true },
    frame_info: { type: String, default: '' },
    amount: { type: Number, required: true, default: 0 },
    status: {
      type: String,
      enum: ['pending', 'lunas', 'cancelled'],
      default: 'pending',
      index: true,
    },
    payment_method: { type: String, default: 'qris' },
    media_link: { type: String, default: '' },
    all_files: { type: String, default: '' },
    print_url: { type: String, default: '' },
    print_file_id: { type: String, default: '' },
    print_status: { type: Number, default: 0 }, // 0 = antre, 1 = sudah dicetak
    created_at_wib: { type: String, required: true }, // Format YYYY-MM-DD HH:mm:ss (WIB)
    media_assets: { type: [mediaAssetItemSchema], default: [] },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Transaction', transactionSchema);