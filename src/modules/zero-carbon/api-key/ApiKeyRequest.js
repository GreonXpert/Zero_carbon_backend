// models/ApiKeyRequest.js
const mongoose = require("mongoose");

const ApiKeyRequestSchema = new mongoose.Schema(
  {
    clientId: { type: String, required: true },

    keyType: {
      type: String,
      enum: ["DC_API", "DC_IOT", "NET_API", "NET_IOT"],
      required: true
    },

    // DC scope
    nodeId: { type: String },
    scopeIdentifier: { type: String },

    // Net Reduction project
    projectId: { type: String },
    calculationMethodology: { type: String },

    // ✅ NEW: what the client wanted to switch to (so approval can switch correctly)
    intendedInputType: {
      type: String,
      enum: ["API", "IOT"],
      required: false
    },

    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },

    // ✅ NEW: better timestamps (your controllers already write requestedAt in NET) :contentReference[oaicite:6]{index=6}
    requestedAt: { type: Date, default: Date.now },

    status: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
      index: true
    },

    // ✅ NEW: who processed it
    processedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    processedAt: { type: Date },
    rejectionReason: { type: String }
  },
  { timestamps: true }
);

module.exports = mongoose.model("ApiKeyRequest", ApiKeyRequestSchema);
