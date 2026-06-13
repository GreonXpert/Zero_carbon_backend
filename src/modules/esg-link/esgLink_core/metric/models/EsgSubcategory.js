'use strict';
/**
 * EsgSubcategory.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Mongoose model for custom (user-added) Metric Library subcategories.
 *
 * The static subcategory register lives in EsgMetric.SUBCATEGORY_CODES. When a
 * user picks "Other" while creating a metric and types a new subcategory name,
 * a document is created here with an auto-generated code. The code is then used
 * the same way a static subcategory code is — e.g. ESG-{esgCategory}-{code}-{NNN}.
 */

const mongoose = require('mongoose');

const ESG_CATEGORY_ENUM = ['E', 'S', 'G'];

const esgSubcategorySchema = new mongoose.Schema(
  {
    esgCategory: {
      type: String,
      enum: ESG_CATEGORY_ENUM,
      required: [true, 'esgCategory is required (E | S | G)'],
    },
    code: {
      type: String,
      required: [true, 'code is required'],
      trim: true,
      uppercase: true,
    },
    label: {
      type: String,
      required: [true, 'label is required'],
      trim: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'createdBy is required'],
    },
    isDeleted: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
    versionKey: false,
    collection: 'esg_subcategories',
  }
);

// One code per ESG category
esgSubcategorySchema.index({ esgCategory: 1, code: 1 }, { unique: true });

module.exports = mongoose.model('EsgSubcategory', esgSubcategorySchema);
