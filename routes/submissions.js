const express = require('express');
const Submission = require('../models/Submission');
const { protect, authorize } = require('../middleware/auth');
const { logger } = require('../utils/logger');
const notificationService = require('../services/notificationService');
const { assignJudgeToSubmission } = require('../utils/judgeAssignment');
const User = require('../models/User');

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

      // Filter by areas of focus if judge has any assigned
      if (req.user.areasOfFocus && req.user.areasOfFocus.length > 0) {
        query.areaOfFocus = { $in: req.user.areasOfFocus };
      }

    } else if (req.user.role === 'teacher') {
      // Teachers only see their own submissions
      query.teacherId = req.user._id;
    }
    
    // Apply additional filters (but don't override role-based filters)
    if (status) {
      query.status = status;
    } else if (req.user.role === 'judge') {
      // Judges should not see promoted/eliminated submissions in their active assignment list
      // Unless they explicitly filter for them via status parameter
      query.status = { $nin: ['promoted', 'eliminated'] };
    }
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
          assignedCouncil: req.user.assignedCouncil,
          areasOfFocus: req.user.areasOfFocus
        },
        query: query
      };
    }

    // Log submission list view (non-blocking - don't let logging delay the response)
    logger.logUserActivity(
      'User viewed submissions list',
      req.user._id,
      req,
      { 
        role: req.user.role,
        filters: { level, status, year, category, subject, region, council },
        count: submissions.length
      }
    ).catch(err => {
      // Log error but don't fail the request
      console.error('Error logging user activity:', err);
    });

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
      // Log unauthorized access attempt
      await logger.logSecurity(
        'Unauthorized submission access attempt',
        req.user._id,
        req,
        { submissionId: req.params.id },
        'warning'
      );
      
      return res.status(403).json({
        success: false,
        message: 'Not authorized to access this submission'
      });
    }

    // Log submission view
    await logger.logUserActivity(
      'User viewed submission details',
      req.user._id,
      req,
      { 
        submissionId: submission._id.toString(),
        submissionLevel: submission.level,
        teacherId: submission.teacherId._id.toString()
      }
    );

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

    // Log submission creation
    const logAction = req.user.role === 'teacher' 
      ? 'User submitted new entry' 
      : `${req.user.role} created submission`;
    
    await logger.logUserActivity(
      logAction,
      req.user._id,
      req,
      {
        submissionId: submission._id.toString(),
        level: submission.level,
        category: submission.category,
        subject: submission.subject,
        areaOfFocus: submission.areaOfFocus
      },
      'success'
    );

    // Assign judge to submission (for Council and Regional levels only)
    let assignmentResult = null;
    if (submission.level === 'Council' || submission.level === 'Regional') {
      assignmentResult = await assignJudgeToSubmission(submission);
      
      if (assignmentResult.success && assignmentResult.assignment) {
        // Notify admins and superadmins about the assignment
        const admins = await User.find({ 
          role: { $in: ['admin', 'superadmin'] },
          status: 'active'
        }).select('_id');
        
        for (const admin of admins) {
          notificationService.createNotification({
            userId: admin._id,
            type: 'system_announcement',
            title: 'New Submission Assignment',
            message: `Submission from ${submission.teacherName} (${submission.subject} - ${submission.areaOfFocus}) has been assigned to Judge ${assignmentResult.judge.name} for ${submission.level} level evaluation.`,
            metadata: {
              submissionId: submission._id.toString(),
              judgeId: assignmentResult.judge._id.toString(),
              judgeName: assignmentResult.judge.name,
              teacherName: submission.teacherName,
              subject: submission.subject,
              areaOfFocus: submission.areaOfFocus,
              level: submission.level
            },
            isSystem: true
          }).catch(error => {
            console.error('Error creating admin notification:', error);
          });
        }
      }
    }

    // Create notification for teacher when submission is successful
    if (req.user.role === 'teacher' || submissionData.teacherId) {
      const teacherId = req.user.role === 'teacher' ? req.user._id : submissionData.teacherId;
      const roundName = `${submission.level} Round`;
      
      // Create notification (non-blocking - don't fail submission if notification fails)
      notificationService.handleSubmissionSuccessful({
        userId: teacherId,
        submissionId: submission._id.toString(),
        roundName: roundName,
        subject: submission.subject
      }).catch(error => {
        // Log error but don't fail the submission
        console.error('Error creating submission notification:', error);
      });
    }

    // Include assignment info in response
    const responseData = {
      success: true,
      submission
    };

    if (assignmentResult && assignmentResult.assignment) {
      responseData.assignment = {
        judgeId: assignmentResult.judge._id,
        judgeName: assignmentResult.judge.name
      };
    }

    res.status(201).json(responseData);
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

    // Determine log action based on what was updated
    const levelChanged = req.body.level && req.body.level !== submission.level;
    const statusChanged = req.body.status && req.body.status !== submission.status;
    
    let logAction = 'User updated submission';
    let logSeverity = 'info';
    
    if (levelChanged && req.user.role !== 'teacher') {
      logAction = `Admin ${req.body.level > submission.level ? 'promoted' : 'demoted'} submission to ${req.body.level} level`;
      logSeverity = 'success';
    } else if (statusChanged) {
      if (req.body.status === 'approved') {
        logAction = 'Admin approved submission';
        logSeverity = 'success';
      } else if (req.body.status === 'eliminated') {
        logAction = 'Admin eliminated submission';
        logSeverity = 'warning';
      }
    }

    // Log submission update
    if (req.user.role === 'admin' || req.user.role === 'superadmin') {
      await logger.logAdminAction(
        logAction,
        req.user._id,
        req,
        {
          submissionId: req.params.id,
          previousLevel: submission.level,
          newLevel: req.body.level || submission.level,
          previousStatus: submission.status,
          newStatus: req.body.status || submission.status,
          updatedFields: Object.keys(req.body)
        },
        logSeverity
      );
    } else {
      await logger.logUserActivity(
        logAction,
        req.user._id,
        req,
        {
          submissionId: req.params.id,
          updatedFields: Object.keys(req.body)
        }
      );
    }

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

    // Log submission deletion before deleting
    await logger.logAdminAction(
      'Admin deleted submission',
      req.user._id,
      req,
      {
        submissionId: req.params.id,
        teacherId: submission.teacherId?.toString(),
        teacherName: submission.teacherName,
        level: submission.level,
        category: submission.category,
        subject: submission.subject
      },
      'error'
    );

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

