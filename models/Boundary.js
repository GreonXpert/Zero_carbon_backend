

const mongoose = require('mongoose');

const BoundarySchema = new mongoose.Schema({
  name: { type: String, required: true },
  type: { type: String, required: true },
  controlApproach: { type: String, required: true },
  location: { type: String },
  comments: { type: String },
});

module.exports = mongoose.model('Boundary', BoundarySchema);


