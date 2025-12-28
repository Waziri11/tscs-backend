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
    
    // Role-based filtering (applied first, cannot be overridden)
    if (req.user.role === 'judge') {
      // Check if judge has assignment data
      if (!req.user.assignedLevel) {
        console.log('Judge has no assignedLevel:', req.user._id, req.user.username);
        return res.json({
          success: true,
          count: 0,
          submissions: [],
          message: 'Judge assignment not configured. Please contact administrator.'
        });
      }

      // Strict level matching: judges only see submissions at their exact assigned level
      query.level = req.user.assignedLevel;
      
      if (req.user.assignedLevel === 'Council') {
        // Council level: must match both region and council exactly
        if (!req.user.assignedRegion || !req.user.assignedCouncil) {
          console.log('Council judge missing region/council:', req.user._id, req.user.username);
          return res.json({
            success: true,
            count: 0,
            submissions: [],
            message: 'Judge assignment incomplete. Please contact administrator.'
          });
        }
        // Match region and council exactly (case-sensitive for now, can be made case-insensitive if needed)
        query.region = req.user.assignedRegion?.trim();
        query.council = req.user.assignedCouncil?.trim();
      } else if (req.user.assignedLevel === 'Regional') {
        // Regional level: must match region (all councils in that region)
        // Submissions must be at Regional level (after council round)
        if (!req.user.assignedRegion) {
          console.log('Regional judge missing region:', req.user._id, req.user.username);
          return res.json({
            success: true,
            count: 0,
            submissions: [],
            message: 'Judge assignment incomplete. Please contact administrator.'
          });
        }
        // Match region exactly (case-sensitive for now, can be made case-insensitive if needed)
        query.region = req.user.assignedRegion?.trim();
      } else if (req.user.assignedLevel === 'National') {
        // National level: see all submissions at National level only
        // No location filter needed
      }

      // Debug logging
      console.log('Judge query:', {
        judgeId: req.user._id,
        judgeUsername: req.user.username,
        assignedLevel: req.user.assignedLevel,
        assignedRegion: req.user.assignedRegion,
        assignedCouncil: req.user.assignedCouncil,
        query: query
      });
    } else if (req.user.role === 'teacher') {
      // Teachers only see their own submissions
      query.teacherId = req.user._id;
    }
    
    // Apply additional filters (but don't override role-based filters)
    if (status) query.status = status;
    if (year) query.year = parseInt(year);
    if (category) query.category = category;
    if (classLevel) query.class = classLevel;
    if (subject) query.subject = subject;
    // Note: level, region, and council are controlled by role-based filtering above
    
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

    // Debug logging
    if (req.user.role === 'judge') {
      console.log('Judge submissions query result:', {
        judgeId: req.user._id,
        judgeUsername: req.user.username,
        assignedLevel: req.user.assignedLevel,
        assignedRegion: req.user.assignedRegion,
        assignedCouncil: req.user.assignedCouncil,
        query: JSON.stringify(query),
        count: submissions.length,
        sampleSubmission: submissions.length > 0 ? {
          id: submissions[0]._id,
          level: submissions[0].level,
          region: submissions[0].region,
          council: submissions[0].council,
          school: submissions[0].school
        } : null
      });
    }

    const response = {
      success: true,
      count: submissions.length,
      submissions
    };

    // Add debug info in development mode
    if (process.env.NODE_ENV === 'development' && req.user.role === 'judge') {
      response.debug = {
        judgeAssignment: {
          assignedLevel: req.user.assignedLevel,
          assignedRegion: req.user.assignedRegion,
          assignedCouncil: req.user.assignedCouncil
        },
        query: query
      };
    }

    res.json(response);
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

