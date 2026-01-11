const mongoose = require('mongoose');

const evaluationCriterionSchema = new mongoose.Schema({
  key: {
    type: String,
    required: true,
    trim: true
  },
  label: {
    type: String,
    required: true,
    trim: true
  },
  order: {
    type: Number,
    default: 0
  }
}, { _id: true });

const areaOfFocusSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  evaluationCriteria: {
    type: [evaluationCriterionSchema],
    default: []
  }
}, { _id: true });

const subjectSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  areasOfFocus: {
    type: [areaOfFocusSchema],
    default: []
  }
}, { _id: true });

const classSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  subjects: {
    type: [subjectSchema],
    default: []
  }
}, { _id: true });

const categorySchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  classes: {
    type: [classSchema],
    default: []
  }
}, { _id: true });

const competitionYearSchema = new mongoose.Schema({
  year: {
    type: Number,
    required: true,
    unique: true
  },
  categories: {
    type: [categorySchema],
    default: []
  },
  isActive: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('Competition', competitionYearSchema);

