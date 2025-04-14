const mongoose = require('mongoose');

const GWPSchema = new mongoose.Schema({
  chemicalName: {
    type: String,
    required: true,
  },
  chemicalFormula: {
    type: String, // New field for storing the chemical formula
    required: true,
  },
  assessments: {
    type: Map,
    of: Number, // Each key-value pair represents an assessment and its value
    required: true,
  },
});

module.exports = mongoose.model('GWP', GWPSchema);
