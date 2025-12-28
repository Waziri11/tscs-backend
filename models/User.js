const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  username: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    lowercase: true
  },
  password: {
    type: String,
    required: true,
    minlength: 6
  },
  name: {
    type: String,
    required: true,
    trim: true
  },
  email: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    lowercase: true
  },
  phone: {
    type: String,
    trim: true
  },
  role: {
    type: String,
    required: true,
    enum: ['teacher', 'judge', 'admin', 'superadmin'],
    default: 'teacher'
  },
  status: {
    type: String,
    enum: ['active', 'inactive', 'suspended'],
    default: 'active'
  },
  // Teacher specific fields
  school: {
    type: String,
    trim: true
  },
  subject: {
    type: String,
    trim: true
  },
  region: {
    type: String,
    trim: true
  },
  council: {
    type: String,
    trim: true
  },
  // Judge specific fields
  assignedLevel: {
    type: String,
    enum: ['Council', 'Regional', 'National', null],
    default: null
  },
  assignedRegion: {
    type: String,
    trim: true
  },
  assignedCouncil: {
    type: String,
    trim: true
  },
  specialization: {
    type: String,
    trim: true
  },
  experience: {
    type: String,
    trim: true
  },
  // Admin specific fields
  department: {
    type: String,
    trim: true
  },
  // Superadmin specific fields
  permissions: {
    type: [String],
    default: []
  }
}, {
  timestamps: true
});

// Hash password before saving
userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) {
    return next();
  }
  
  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

// Method to compare password
userSchema.methods.comparePassword = async function(candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

// Remove password from JSON output
userSchema.methods.toJSON = function() {
  const obj = this.toObject();
  delete obj.password;
  return obj;
};

module.exports = mongoose.model('User', userSchema);

