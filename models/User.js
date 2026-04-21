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
  emailVerified: {
    type: Boolean,
    default: false
  },
  phone: {
    type: String,
    trim: true
  },
  gender: {
    type: String,
    enum: ['Male', 'Female'],
    trim: true
  },
  role: {
    type: String,
    required: true,
    enum: ['teacher', 'judge', 'admin', 'superadmin', 'stakeholder'],
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
  chequeNumber: {
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
  areasOfFocus: {
    type: [String],
    default: []
  },
  // Admin specific fields
  department: {
    type: String,
    trim: true
  },
  adminLevel: {
    type: String,
    enum: ['Council', 'Regional', 'National', null],
    default: null
  },
  adminRegion: {
    type: String,
    trim: true
  },
  adminCouncil: {
    type: String,
    trim: true
  },
  // Superadmin specific fields
  permissions: {
    type: [String],
    default: []
  },
  isDeleted: {
    type: Boolean,
    default: false
  },
  deletedAt: {
    type: Date,
    default: null
  },
  deletedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
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

// Enforce admin uniqueness: one admin per level+area
userSchema.pre('save', async function(next) {
  if (this.role !== 'admin' || !this.adminLevel) return next();
  if (!this.isNew && !this.isModified('adminLevel') && !this.isModified('adminRegion') && !this.isModified('adminCouncil')) return next();

  const UserModel = this.constructor;
  const query = {
    role: 'admin',
    adminLevel: this.adminLevel,
    _id: { $ne: this._id }
  };

  if (this.adminLevel === 'Council') {
    if (!this.adminRegion || !this.adminCouncil) {
      return next(new Error('Council admin must have adminRegion and adminCouncil'));
    }
    query.adminRegion = this.adminRegion;
    query.adminCouncil = this.adminCouncil;
  } else if (this.adminLevel === 'Regional') {
    if (!this.adminRegion) {
      return next(new Error('Regional admin must have adminRegion'));
    }
    query.adminRegion = this.adminRegion;
  }
  // National: no region/council filter - one slot for entire system

  const existing = await UserModel.findOne(query);
  if (existing) {
    return next(new Error('An admin already exists for this level and area'));
  }
  next();
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

// Indexes for better query performance
// Note: email index is automatically created by unique: true constraint
userSchema.index({ role: 1, status: 1 });
userSchema.index({ isDeleted: 1, deletedAt: -1 });
userSchema.index({ role: 1, assignedLevel: 1, assignedRegion: 1, assignedCouncil: 1 }); // For judge queries
// Indexes for stakeholder teacher region queries
userSchema.index({ role: 1, status: 1, region: 1 });
userSchema.index({ role: 1, status: 1, region: 1, council: 1 });
userSchema.index({ role: 1, adminLevel: 1, adminRegion: 1, adminCouncil: 1 }, { sparse: true });

module.exports = mongoose.model('User', userSchema);

