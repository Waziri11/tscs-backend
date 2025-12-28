const express = require('express');
const Submission = require('../models/Submission');
const { protect, authorize } = require('../middleware/auth');

const router = express.Router();

// All routes require authentication
router.use(protect);

// @route   GET /api/submissions
// @desc    Get all submissions (with filters)
// @access  Private
router.get('/', async (req, res) => {
  try {
    const { 
      level, 
      status, 
      year, 
      category, 
      class: classLevel, 
      subject, 
      region, 
      council,
      search 
    } = req.query;
    
    let query = {};
    
    // Role-based filtering
    if (req.user.role === 'judge') {
      // Judges only see submissions at their assigned level and location
      query.level = req.user.assignedLevel;
      
      if (req.user.assignedLevel === 'Council') {
        query.region = req.user.assignedRegion;
        query.council = req.user.assignedCouncil;
      } else if (req.user.assignedLevel === 'Regional') {
        query.region = req.user.assignedRegion;
      }
      // National level judges see all national submissions (no additional filter)
    } else if (req.user.role === 'teacher') {
      // Teachers only see their own submissions
      query.teacherId = req.user._id;
    }
    
    // Apply filters
    if (level) query.level = level;
    if (status) query.status = status;
    if (year) query.year = parseInt(year);
    if (category) query.category = category;
    if (classLevel) query.class = classLevel;
    if (subject) query.subject = subject;
    if (region) query.region = region;
    if (council) query.council = council;
    
    if (search) {
      query.$or = [
        { teacherName: { $regex: search, $options: 'i' } },
        { school: { $regex: search, $options: 'i' } },
        { category: { $regex: search, $options: 'i' } },
        { subject: { $regex: search, $options: 'i' } }
      ];
    }

    const submissions = await Submission.find(query)
      .populate('teacherId', 'name email username')
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      count: submissions.length,
      submissions
    });
  } catch (error) {
    console.error('Get submissions error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   GET /api/submissions/:id
// @desc    Get single submission
// @access  Private
router.get('/:id', async (req, res) => {
  try {
    const submission = await Submission.findById(req.params.id)
      .populate('teacherId', 'name email username school');

    if (!submission) {
      return res.status(404).json({
        success: false,
        message: 'Submission not found'
      });
    }

    // Check authorization
    if (req.user.role === 'teacher' && submission.teacherId._id.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to access this submission'
      });
    }

    res.json({
      success: true,
      submission
    });
  } catch (error) {
    console.error('Get submission error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   POST /api/submissions
// @desc    Create new submission
// @access  Private (Teacher, Admin, Superadmin)
router.post('/', authorize('teacher', 'admin', 'superadmin'), async (req, res) => {
  try {
    const submissionData = {
      ...req.body,
      teacherId: req.user.role === 'teacher' ? req.user._id : req.body.teacherId || req.user._id
    };

    const submission = await Submission.create(submissionData);

    res.status(201).json({
      success: true,
      submission
    });
  } catch (error) {
    console.error('Create submission error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// @route   PUT /api/submissions/:id
// @desc    Update submission
// @access  Private (Teacher owns it, or Admin/Superadmin)
router.put('/:id', async (req, res) => {
  try {
    const submission = await Submission.findById(req.params.id);

    if (!submission) {
      return res.status(404).json({
        success: false,
        message: 'Submission not found'
      });
    }

    // Check authorization
    if (req.user.role === 'teacher' && submission.teacherId.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to update this submission'
      });
    }

    const updatedSubmission = await Submission.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    ).populate('teacherId', 'name email username');

    res.json({
      success: true,
      submission: updatedSubmission
    });
  } catch (error) {
    console.error('Update submission error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// @route   DELETE /api/submissions/:id
// @desc    Delete submission
// @access  Private (Admin/Superadmin only)
router.delete('/:id', authorize('admin', 'superadmin'), async (req, res) => {
  try {
    const submission = await Submission.findById(req.params.id);

    if (!submission) {
      return res.status(404).json({
        success: false,
        message: 'Submission not found'
      });
    }

    await submission.deleteOne();

    res.json({
      success: true,
      message: 'Submission deleted successfully'
    });
  } catch (error) {
    console.error('Delete submission error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

module.exports = router;

