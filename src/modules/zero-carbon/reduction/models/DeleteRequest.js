const mongoose = require("mongoose");

const DeleteRequestSchema = new mongoose.Schema({
  formulaId: { type: mongoose.Schema.Types.ObjectId, ref: "ReductionFormula", required: true },
  requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  requestedAt: { type: Date, default: Date.now },

  status: {
    type: String,
    enum: ["pending", "approved", "rejected"],
    default: "pending"
  },

  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  approvedAt: { type: Date },

  reason: { type: String }   // optional reason from consultant

}, { timestamps: true });

module.exports = mongoose.model("DeleteRequest", DeleteRequestSchema);
