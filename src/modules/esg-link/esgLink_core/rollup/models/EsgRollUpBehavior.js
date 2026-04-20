'use strict';

const mongoose = require('mongoose');

const rollUpBehaviorSchema = new mongoose.Schema(
  {
    code: {
      type:      String,
      required:  true,
      unique:    true,
      trim:      true,
      lowercase: true,
    },
    label: {
      type:     String,
      required: true,
      trim:     true,
    },
    description: {
      type:    String,
      default: '',
      trim:    true,
    },
    isActive: {
      type:    Boolean,
      default: true,
    },
    // Built-in behaviors cannot be deleted
    isBuiltIn: {
      type:    Boolean,
      default: false,
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

rollUpBehaviorSchema.index({ code: 1 }, { unique: true });
rollUpBehaviorSchema.index({ isActive: 1, isDeleted: 1 });

module.exports = mongoose.model('EsgRollUpBehavior', rollUpBehaviorSchema);
