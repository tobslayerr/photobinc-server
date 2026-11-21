const mongoose = require('mongoose');

const slotCoordSchema = new mongoose.Schema(
  {
    x: { type: Number, default: 0 },
    y: { type: Number, default: 0 },
    w: { type: Number, default: 0 },
    h: { type: Number, default: 0 },
  },
  { _id: false }
);

const frameSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ['strip', 'news'], required: true },
    original_id: { type: Number, required: true }, // 1..18 untuk strip, 1..3 untuk news
    active: { type: Boolean, default: true },
    order: { type: Number, default: 1 },
    url: { type: String, default: '' },
    url_file_id: { type: String, default: '' },
    digital_url: { type: String, default: '' },
    digital_url_file_id: { type: String, default: '' },
    w: { type: Number, default: 1200 },
    h: { type: Number, default: 1800 },
    shots: { type: Number, default: 3 },
    slots: {
      p1: { type: slotCoordSchema, default: () => ({}) },
      p2: { type: slotCoordSchema, default: () => ({}) },
      p3: { type: slotCoordSchema, default: () => ({}) },
      p4: { type: slotCoordSchema, default: () => ({}) },
      p5: { type: slotCoordSchema, default: () => ({}) },
      p6: { type: slotCoordSchema, default: () => ({}) },
    },
  },
  { timestamps: true }
);

frameSchema.index({ type: 1, original_id: 1 }, { unique: true });

module.exports = mongoose.model('Frame', frameSchema);