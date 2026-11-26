const mongoose = require('mongoose');

const FRAME_LIMITS = {
  strip: 18,
  news: 4, // Ditingkatkan dari 3 menjadi 4 slot Newspaper
};

/**
 * Sanitasi angka desimal (setara ef_pb_sanitize_float di WordPress)
 * Mendukung koma "," maupun titik ".", dibulatkan presisi 2 desimal (contoh: 1453.7)
 */
function sanitizeFloat(val, fallback = 0) {
  if (val === undefined) return undefined;
  if (val === '' || val === null) return fallback;
  const normalized = String(val).trim().replace(',', '.');
  const num = parseFloat(normalized);
  if (!Number.isFinite(num)) return fallback;
  return Math.round(num * 100) / 100;
}

const slotCoordSchema = new mongoose.Schema(
  {
    x: { type: Number, default: 0, set: (v) => sanitizeFloat(v, 0) },
    y: { type: Number, default: 0, set: (v) => sanitizeFloat(v, 0) },
    w: { type: Number, default: 0, set: (v) => sanitizeFloat(v, 0) },
    h: { type: Number, default: 0, set: (v) => sanitizeFloat(v, 0) },
  },
  { _id: false }
);

const frameSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ['strip', 'news'], required: true },
    original_id: {
      type: Number,
      required: true,
      min: 1,
      validate: {
        validator: function (val) {
          const max = FRAME_LIMITS[this.type] || 18;
          return Number.isInteger(val) && val >= 1 && val <= max;
        },
        message: (props) => `original_id ${props.value} melebihi batas slot untuk tipe frame ini.`,
      },
    }, // 1..18 untuk strip, 1..4 untuk news
    active: { type: Boolean, default: true },
    order: { type: Number, default: 1, set: (v) => Math.max(1, parseInt(v, 10) || 1) },
    url: { type: String, default: '' },
    url_file_id: { type: String, default: '' },
    digital_url: { type: String, default: '' },
    digital_url_file_id: { type: String, default: '' },
    w: {
      type: Number,
      default: 1200,
      set: (v) => sanitizeFloat(v, 1200),
    },
    h: {
      type: Number,
      default: function () {
        return this.type === 'news' ? 1600 : 1800;
      },
      set: function (v) {
        return sanitizeFloat(v, this.type === 'news' ? 1600 : 1800);
      },
    },
    shots: {
      type: Number,
      default: function () {
        return this.type === 'news' ? 2 : 3;
      },
    },
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
frameSchema.index({ type: 1, order: 1, original_id: 1 });

// =========================================================================
// STATIC HELPERS (PARITY PENUH DENGAN CODE SNIPPETS WORDPRESS)
// =========================================================================

frameSchema.statics.LIMITS = FRAME_LIMITS;
frameSchema.statics.sanitizeFloat = sanitizeFloat;

/**
 * 1. Pastikan seluruh slot (18 Strip & 4 News) tersedia di MongoDB.
 *    Menggunakan $setOnInsert sehingga TIDAK PERNAH menimpa data frame lama.
 */
frameSchema.statics.ensureDefaultSlots = async function () {
  const ops = [];

  for (let i = 1; i <= FRAME_LIMITS.strip; i++) {
    ops.push({
      updateOne: {
        filter: { type: 'strip', original_id: i },
        update: {
          $setOnInsert: {
            type: 'strip',
            original_id: i,
            active: true,
            order: i,
            w: 1200,
            h: 1800,
            shots: 3,
            slots: {
              p1: { x: 80, y: 120, w: 440, h: 330 },
              p2: { x: 80, y: 510, w: 440, h: 330 },
              p3: { x: 80, y: 900, w: 440, h: 330 },
              p4: { x: 680, y: 120, w: 440, h: 330 },
              p5: { x: 680, y: 510, w: 440, h: 330 },
              p6: { x: 680, y: 900, w: 440, h: 330 },
            },
          },
        },
        upsert: true,
      },
    });
  }

  for (let i = 1; i <= FRAME_LIMITS.news; i++) {
    ops.push({
      updateOne: {
        filter: { type: 'news', original_id: i },
        update: {
          $setOnInsert: {
            type: 'news',
            original_id: i,
            active: true,
            order: i,
            w: 1200,
            h: 1600,
            shots: 2,
            slots: {
              p1: { x: 100, y: 300, w: 1000, h: 800 },
              p2: { x: 100, y: 1150, w: 400, h: 300 },
            },
          },
        },
        upsert: true,
      },
    });
  }

  return this.bulkWrite(ops, { ordered: false });
};

/**
 * 2. Ambil daftar frame terurut persis seperti aplikasi & Quick-Sort Board
 *    Tie-breaker: order ASC, lalu original_id ASC
 */
frameSchema.statics.getSortedFrames = async function ({ onlyActive = false } = {}) {
  const filter = onlyActive ? { active: true, url: { $ne: '' } } : {};
  const all = await this.find(filter)
    .sort({ order: 1, original_id: 1 })
    .lean();

  const strip = all.filter((f) => f.type === 'strip' && f.original_id <= FRAME_LIMITS.strip);
  const news = all
    .filter((f) => f.type === 'news' && f.original_id <= FRAME_LIMITS.news)
    .map((f) => ({
      ...f,
      digital_url: f.digital_url || f.url,
    }));

  return { strip, news };
};

/**
 * 3. Simpan hasil Drag & Drop urutan frame dalam 1 query (bulkWrite)
 *    @param {'strip'|'news'} type
 *    @param {number[]} orderedOriginalIds - Contoh: [4, 1, 2, 3]
 */
frameSchema.statics.reorderGroup = async function (type, orderedOriginalIds) {
  if (!['strip', 'news'].includes(type)) {
    throw new Error('Tipe frame tidak valid (harus strip atau news).');
  }
  const max = FRAME_LIMITS[type];
  const cleanIds = [...new Set((orderedOriginalIds || []).map((id) => parseInt(id, 10)))]
    .filter((id) => Number.isInteger(id) && id >= 1 && id <= max);

  if (cleanIds.length === 0) return { modifiedCount: 0 };

  const ops = cleanIds.map((origId, index) => ({
    updateOne: {
      filter: { type, original_id: origId },
      update: { $set: { order: index + 1 } },
    },
  }));

  return this.bulkWrite(ops, { ordered: false });
};

/**
 * 4. Import JSON format WordPress (pb_strip_f1_..., pb_news_f4_...) ke MongoDB
 *    Mendukung koordinat desimal & 4 slot Newspaper
 */
frameSchema.statics.importFromWpJson = async function (data) {
  if (!data || typeof data !== 'object') {
    throw new Error('Format JSON tidak valid.');
  }

  const ops = [];

  for (let i = 1; i <= FRAME_LIMITS.strip; i++) {
    if (data[`pb_strip_f${i}_url`] === undefined && data[`pb_strip_f${i}_w`] === undefined) continue;
    const slots = {};
    for (let j = 1; j <= 6; j++) {
      slots[`p${j}`] = {
        x: sanitizeFloat(data[`pb_strip_f${i}_p${j}_x`], 0),
        y: sanitizeFloat(data[`pb_strip_f${i}_p${j}_y`], 0),
        w: sanitizeFloat(data[`pb_strip_f${i}_p${j}_w`], 0),
        h: sanitizeFloat(data[`pb_strip_f${i}_p${j}_h`], 0),
      };
    }
    ops.push({
      updateOne: {
        filter: { type: 'strip', original_id: i },
        update: {
          $set: {
            active: Number(data[`pb_strip_f${i}_active`] ?? 1) === 1,
            order: parseInt(data[`pb_strip_f${i}_order`], 10) || i,
            url: String(data[`pb_strip_f${i}_url`] || ''),
            w: sanitizeFloat(data[`pb_strip_f${i}_w`], 1200),
            h: sanitizeFloat(data[`pb_strip_f${i}_h`], 1800),
            shots: 3,
            slots,
          },
        },
        upsert: true,
      },
    });
  }

  for (let i = 1; i <= FRAME_LIMITS.news; i++) {
    if (data[`pb_news_f${i}_url`] === undefined && data[`pb_news_f${i}_w`] === undefined) continue;
    const slots = {};
    for (let j = 1; j <= 2; j++) {
      slots[`p${j}`] = {
        x: sanitizeFloat(data[`pb_news_f${i}_p${j}_x`], 0),
        y: sanitizeFloat(data[`pb_news_f${i}_p${j}_y`], 0),
        w: sanitizeFloat(data[`pb_news_f${i}_p${j}_w`], 0),
        h: sanitizeFloat(data[`pb_news_f${i}_p${j}_h`], 0),
      };
    }
    ops.push({
      updateOne: {
        filter: { type: 'news', original_id: i },
        update: {
          $set: {
            active: Number(data[`pb_news_f${i}_active`] ?? 1) === 1,
            order: parseInt(data[`pb_news_f${i}_order`], 10) || i,
            url: String(data[`pb_news_f${i}_url`] || ''),
            digital_url: String(data[`pb_news_f${i}_digital_url`] || ''),
            w: sanitizeFloat(data[`pb_news_f${i}_w`], 1200),
            h: sanitizeFloat(data[`pb_news_f${i}_h`], 1600),
            shots: 2,
            slots,
          },
        },
        upsert: true,
      },
    });
  }

  if (ops.length === 0) return { modifiedCount: 0 };
  return this.bulkWrite(ops, { ordered: false });
};

/**
 * 5. Export seluruh frame dari MongoDB ke format JSON identik WordPress
 */
frameSchema.statics.exportToWpJson = async function () {
  const { strip, news } = await this.getSortedFrames({ onlyActive: false });
  const out = {};

  strip.forEach((f) => {
    const i = f.original_id;
    out[`pb_strip_f${i}_active`] = f.active ? 1 : 0;
    out[`pb_strip_f${i}_order`] = f.order;
    out[`pb_strip_f${i}_url`] = f.url || '';
    out[`pb_strip_f${i}_w`] = f.w;
    out[`pb_strip_f${i}_h`] = f.h;
    for (let j = 1; j <= 6; j++) {
      const s = (f.slots && f.slots[`p${j}`]) || {};
      out[`pb_strip_f${i}_p${j}_x`] = s.x ?? 0;
      out[`pb_strip_f${i}_p${j}_y`] = s.y ?? 0;
      out[`pb_strip_f${i}_p${j}_w`] = s.w ?? 0;
      out[`pb_strip_f${i}_p${j}_h`] = s.h ?? 0;
    }
  });

  news.forEach((f) => {
    const i = f.original_id;
    out[`pb_news_f${i}_active`] = f.active ? 1 : 0;
    out[`pb_news_f${i}_order`] = f.order;
    out[`pb_news_f${i}_url`] = f.url || '';
    out[`pb_news_f${i}_digital_url`] = f.digital_url || '';
    out[`pb_news_f${i}_w`] = f.w;
    out[`pb_news_f${i}_h`] = f.h;
    for (let j = 1; j <= 2; j++) {
      const s = (f.slots && f.slots[`p${j}`]) || {};
      out[`pb_news_f${i}_p${j}_x`] = s.x ?? 0;
      out[`pb_news_f${i}_p${j}_y`] = s.y ?? 0;
      out[`pb_news_f${i}_p${j}_w`] = s.w ?? 0;
      out[`pb_news_f${i}_p${j}_h`] = s.h ?? 0;
    }
  });

  return out;
};

module.exports = mongoose.model('Frame', frameSchema);