const mongoose = require('mongoose');
const { Schema } = mongoose;

const DataEntrySchema = new Schema({
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  nodeId: {
    type: String,
    required: true
  },
  date: {
    type: Date,
    required: true
  },
  time: {
    type: String,
    required: true
  },
  quantity: {
    type: Number,
    required: true
  },
  assessmentType: {
    type: String,
    default: ''
  },
  uncertaintyLevelConsumedData: {
    type: Number,
    default: 0
  },
  uncertaintyLevelEmissionFactor: {
    type: Number,
    default: 0
  },
  comments: {
    type: String,
    default: ''
  },
  fuelSupplier: {
    type: String,
    default: ''
  }
}, {
  timestamps: true // adds createdAt / updatedAt
});

module.exports = mongoose.model('DataEntry', DataEntrySchema);
