const express = require('express');
const Submission = require('../models/Submission');
const SubmissionAssignment = require('../models/SubmissionAssignment');
const CompetitionRound = require('../models/CompetitionRound');
const { protect, authorize } = require('../middleware/auth');
const { logger } = require('../utils/logger');
const notificationService = require('../services/notificationService');
const { manuallyAssignSubmission, getEligibleJudges, getAssignedJudge } = require('../utils/judgeAssignment');
const User = require('../models/User');
const { cacheMiddleware, invalidateCacheOnChange } = require('../middleware/cache');
const { buildSubmissionQueryForAdmin, canAdminAccessSubmission, canAdminAccessUser } = require('../utils/adminScope');
const {
  ACTIONABLE_ROUND_STATUSES,
  getActionableRoundIdsForLevel,
  resolveSubmissionRoundContext,
  isRoundActionable
} = require('../utils/roundContext');

const router = express.Router();

const parseBooleanParam = (value) => {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return false;
  return ['true', '1', 'yes'].includes(value.toLowerCase());
};

// All routes require authentication
router.use(protect);

// @route   GET /api/submissions
// @desc    Get all submissions (with filters)
// @access  Private
router.get('/', cacheMiddleware(30), async (req, res) => {
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
      search,
      page = 1,
      limit = 20
    } = req.query;

    const parsedYear = (typeof year !== 'undefined' && year !== null && Number.isFinite(Number(year)))
      ? Number(year)
      : null;
    const query = {};
    const andClauses = [];

    let responseMessage = null;
    let judgeAssignmentsInActionableRounds = 0;
    let activeRoundIds = [];

    // Role-based filtering (applied first, cannot be overridden)
    if (req.user.role === 'judge') {
      if (!req.user.assignedLevel) {
        return res.json({
          success: true,
          count: 0,
          submissions: [],
          message: 'Judge assignment not configured. Please contact administrator.'
        });
      }

      query.level = req.user.assignedLevel;
      activeRoundIds = await getActionableRoundIdsForLevel({
        level: req.user.assignedLevel,
        year: parsedYear
      });

      if (activeRoundIds.length === 0) {
        query._id = { $in: [] };
        responseMessage = 'No active or ended round is available for your assigned level.';
      } else {
        query.roundId = { $in: activeRoundIds };
      }

      if (req.user.assignedLevel === 'Council') {
        if (!req.user.assignedRegion || !req.user.assignedCouncil) {
          return res.json({
            success: true,
            count: 0,
            submissions: [],
            message: 'Judge assignment incomplete. Please contact administrator.'
          });
        }
        query.region = req.user.assignedRegion?.trim();
        query.council = req.user.assignedCouncil?.trim();
      } else if (req.user.assignedLevel === 'Regional') {
        if (!req.user.assignedRegion) {
          return res.json({
            success: true,
            count: 0,
            submissions: [],
            message: 'Judge assignment incomplete. Please contact administrator.'
          });
        }
        query.region = req.user.assignedRegion?.trim();
      }
    } else if (req.user.role === 'teacher') {
      query.teacherId = req.user._id;
    } else if (req.user.role === 'admin') {
      Object.assign(query, buildSubmissionQueryForAdmin(req.user));
    }

    // Apply additional filters
    if (status) {
      query.status = status;
    } else if (req.user.role === 'judge') {
      query.status = { $nin: ['promoted', 'eliminated'] };
    }

    if (parsedYear) query.year = parsedYear;
    if (category) query.category = category;
    if (classLevel) query.class = classLevel;
    if (subject) query.subject = subject;

    if (search) {
      andClauses.push({
        $or: [
          { teacherName: { $regex: search, $options: 'i' } },
          { school: { $regex: search, $options: 'i' } },
          { category: { $regex: search, $options: 'i' } },
          { subject: { $regex: search, $options: 'i' } }
        ]
      });
    }

    // Council/Regional judges: ensure assignment and submission round are exactly aligned.
    if (req.user.role === 'judge' && (req.user.assignedLevel === 'Council' || req.user.assignedLevel === 'Regional')) {
      let assignmentPairs = [];

      if (activeRoundIds.length > 0) {
        const assignmentDocs = await SubmissionAssignment.find({
          judgeId: req.user._id,
          level: req.user.assignedLevel,
          roundId: { $in: activeRoundIds }
        })
          .select('submissionId roundId')
          .lean();

        assignmentPairs = assignmentDocs.map((assignment) => ({
          _id: assignment.submissionId,
          roundId: assignment.roundId
        }));
      }

      judgeAssignmentsInActionableRounds = assignmentPairs.length;

      if (assignmentPairs.length > 0) {
        andClauses.push({ $or: assignmentPairs });
      } else {
        query._id = { $in: [] };
        if (!responseMessage) {
          const historicalRoundIds = (
            await CompetitionRound.find({
              level: req.user.assignedLevel,
              ...(parsedYear ? { year: parsedYear } : {}),
              status: { $nin: ACTIONABLE_ROUND_STATUSES }
            }).select('_id')
          ).map((round) => round._id);

          const historicalAssignments = historicalRoundIds.length > 0
            ? await SubmissionAssignment.countDocuments({
              judgeId: req.user._id,
              level: req.user.assignedLevel,
              roundId: { $in: historicalRoundIds }
            })
            : 0;

          responseMessage = historicalAssignments > 0
            ? 'No current-round assignments found. You have historical assignments in closed or archived rounds.'
            : 'No submissions are assigned to you in active or ended rounds.';
        }
      }
    }

    if (andClauses.length > 0) {
      query.$and = andClauses;
    }

    const pageNum = parseInt(page, 10) || 1;
    const limitNum = parseInt(limit, 10) || 20;
    const skip = (pageNum - 1) * limitNum;

    const total = await Submission.countDocuments(query);
    const submissions = await Submission.find(query)
      .populate('teacherId', 'name email username')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum)
      .lean();

    const response = {
      success: true,
      count: submissions.length,
      total,
      page: pageNum,
      pages: Math.ceil(total / limitNum),
      limit: limitNum,
      submissions
    };

    if (responseMessage) {
      response.message = responseMessage;
    }

    if (process.env.NODE_ENV === 'development' && req.user.role === 'judge') {
      response.debug = {
        judgeAssignment: {
          assignedLevel: req.user.assignedLevel,
          assignedRegion: req.user.assignedRegion,
          assignedCouncil: req.user.assignedCouncil,
          assignmentsInActionableRounds: judgeAssignmentsInActionableRounds
        },
        query
      };
    }

    logger.logUserActivity(
      'User viewed submissions list',
      req.user._id,
      req,
      {
        role: req.user.role,
        filters: { level, status, year, category, subject, region, council },
        count: submissions.length
      },
      'read'
    ).catch((err) => {
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

    // Judge scope: only assigned submissions at their exact level and round context
    if (req.user.role === 'judge') {
      if (!req.user.assignedLevel || req.user.assignedLevel !== submission.level) {
        return res.status(403).json({
          success: false,
          message: 'Not authorized to access this submission'
        });
      }

      const roundContext = await resolveSubmissionRoundContext(submission, {
        includeHistorical: false,
        allowFallbackByYearLevel: false
      });

      if (!roundContext.round || !isRoundActionable(roundContext.round)) {
        return res.status(403).json({
          success: false,
          message: 'Submission is not in an active or ended round context'
        });
      }

      if (submission.level === 'Council' || submission.level === 'Regional') {
        const assignment = await SubmissionAssignment.findOne({
          submissionId: submission._id,
          judgeId: req.user._id,
          roundId: roundContext.round._id
        }).select('_id');

        if (!assignment) {
          return res.status(403).json({
            success: false,
            message: 'Not authorized to access this submission'
          });
        }
      } else if (submission.level === 'National' && req.user.assignedLevel !== 'National') {
        return res.status(403).json({
          success: false,
          message: 'Not authorized to access this submission'
        });
      }
    }

    // Admin scope: only allow viewing submissions in their scope
    if (req.user.role === 'admin' && !canAdminAccessSubmission(req.user, submission)) {
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
      },
      'read'
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
router.post('/', authorize('teacher', 'admin', 'superadmin'), invalidateCacheOnChange('cache:/api/submissions*'), async (req, res) => {
  try {
    const submissionData = {
      ...req.body,
      teacherId: req.user.role === 'teacher' ? req.user._id : req.body.teacherId || req.user._id
    };

    // Log the attempt for debugging
    console.log('Processing submission for teacher:', submissionData.teacherId);

    const { videoFileName, videoFileUrl, videoOriginalBytes } = req.body;
    const hasVideoInfo = typeof videoFileName === 'string' && videoFileName.trim() &&
      typeof videoFileUrl === 'string' && videoFileUrl.trim();

    if (hasVideoInfo) {
      submissionData.videoFileName = videoFileName.trim();
      submissionData.videoFileUrl = videoFileUrl.trim();
      const parsedBytes = Number(videoOriginalBytes);
      if (!Number.isNaN(parsedBytes)) {
        submissionData.videoOriginalBytes = parsedBytes;
      }
    }

    // Validate required fields
    if (!submissionData.areaOfFocus) {
      return res.status(400).json({
        success: false,
        message: 'Area of focus is required'
      });
    }

    if (!submissionData.year) {
      return res.status(400).json({
        success: false,
        message: 'Year is required'
      });
    }

    // Check if teacher already has a submission in the same area of focus for the same year
    const existingSubmission = await Submission.findOne({
      teacherId: submissionData.teacherId,
      areaOfFocus: submissionData.areaOfFocus,
      year: submissionData.year
    });

    if (existingSubmission) {
      return res.status(400).json({
        success: false,
        message: `You have already submitted an entry for "${submissionData.areaOfFocus}" in ${submissionData.year}. Each teacher can only submit one entry per area of focus per year.`,
        existingSubmission: {
          id: existingSubmission._id,
          areaOfFocus: existingSubmission.areaOfFocus,
          year: existingSubmission.year,
          status: existingSubmission.status,
          level: existingSubmission.level
        }
      });
    }

    console.log('Creating submission with data:', {
      ...submissionData,
      videoFileUrl: submissionData.videoFileUrl ? 'PRESENT' : 'MISSING',
      lessonPlanFileUrl: submissionData.lessonPlanFileUrl ? 'PRESENT' : 'MISSING'
    });

    const submission = await Submission.create(submissionData);
    console.log('Submission created successfully:', submission._id);

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
      'create'
    );

    // Round snapshots are frozen at activation.
    // New submissions are not auto-assigned into currently running rounds.

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

    res.status(201).json({
      success: true,
      submission
    });
  } catch (error) {
    console.error('Create submission error:', error);
    
    // Return detailed error message to client
    res.status(500).json({
      success: false,
      message: error.message || 'Server error',
      // Include stack trace if needed for debugging, or validation errors if any
      details: error.errors ? Object.keys(error.errors).map(key => ({ field: key, message: error.errors[key].message })) : null
    });
  }
});

// @route   PUT /api/submissions/:id
// @desc    Update submission
// @access  Private (Teacher owns it, or Admin/Superadmin)
router.put('/:id', authorize('teacher', 'admin', 'superadmin'), invalidateCacheOnChange('cache:/api/submissions*'), async (req, res) => {
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

    // Admin scope: only allow updating submissions in their scope
    if (req.user.role === 'admin' && !canAdminAccessSubmission(req.user, submission)) {
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
        logSeverity,
        'update'
      );
    } else {
      await logger.logUserActivity(
        logAction,
        req.user._id,
        req,
        {
          submissionId: req.params.id,
          updatedFields: Object.keys(req.body)
        },
        'update'
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
router.delete('/:id', authorize('admin', 'superadmin'), invalidateCacheOnChange('cache:/api/submissions*'), async (req, res) => {
  try {
    const submission = await Submission.findById(req.params.id);

    if (!submission) {
      return res.status(404).json({
        success: false,
        message: 'Submission not found'
      });
    }

    // Admin scope: only allow deleting submissions in their scope
    if (req.user.role === 'admin' && !canAdminAccessSubmission(req.user, submission)) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to delete this submission'
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
      'error',
      'delete'
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

// @route   GET /api/submissions/leaderboard/council
// @desc    Get council level leaderboard (per area of focus and overall)
// @access  Private (Admin, Superadmin, Judge)
router.get('/leaderboard/council', authorize('admin', 'superadmin'), async (req, res) => {
  try {
    let { year, region, council, areaOfFocus, includeDisqualified = false } = req.query;

    // Admin scope: enforce region/council from scope for council/regional admins
    if (req.user.role === 'admin') {
      if (req.user.adminLevel === 'Council' && req.user.adminRegion && req.user.adminCouncil) {
        region = req.user.adminRegion;
        council = req.user.adminCouncil;
      } else if (req.user.adminLevel === 'Regional' && req.user.adminRegion) {
        region = req.user.adminRegion;
      }
    }

    // Build query for council level submissions
    const query = {
      level: 'Council',
      status: { $in: ['evaluated', 'promoted', 'eliminated'] }
    };

    if (year) query.year = parseInt(year);
    if (region) query.region = region;
    if (council) query.council = council;
    if (areaOfFocus) query.areaOfFocus = areaOfFocus;

    // Exclude disqualified unless explicitly requested
    if (!includeDisqualified) {
      query.disqualified = { $ne: true };
    }

    // Get submissions sorted by average score (descending)
    let submissions = await Submission.find(query)
      .populate('teacherId', 'name email')
      .sort({ averageScore: -1, createdAt: 1 }); // Secondary sort by creation date for tie-breaking

    // Group by area of focus for per-area leaderboards
    const byAreaOfFocus = {};
    submissions.forEach(sub => {
      const area = sub.areaOfFocus || 'Unknown';
      if (!byAreaOfFocus[area]) {
        byAreaOfFocus[area] = [];
      }
      byAreaOfFocus[area].push(sub);
    });

    // Generate rankings
    const generateRankings = (subs) => {
      return subs.map((sub, index) => ({
        ...sub.toObject(),
        rank: index + 1,
        willAdvance: index < 3 && !sub.disqualified // Top 3 advance (if not disqualified)
      }));
    };

    // Per area of focus leaderboards
    const areaLeaderboards = {};
    Object.keys(byAreaOfFocus).forEach(area => {
      areaLeaderboards[area] = generateRankings(byAreaOfFocus[area]);
    });

    // Overall leaderboard (all areas combined)
    const overallLeaderboard = generateRankings(submissions);

    res.json({
      success: true,
      leaderboards: {
        byAreaOfFocus: areaLeaderboards,
        overall: overallLeaderboard
      },
      summary: {
        totalSubmissions: submissions.length,
        areasOfFocus: Object.keys(byAreaOfFocus),
        disqualified: submissions.filter(s => s.disqualified).length
      }
    });
  } catch (error) {
    console.error('Get council leaderboard error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   GET /api/submissions/leaderboard/regional
// @desc    Get regional level leaderboard
// @access  Private (Admin, Superadmin, Judge)
router.get('/leaderboard/regional', authorize('admin', 'superadmin'), async (req, res) => {
  try {
    let { year, region, areaOfFocus, includeDisqualified = false } = req.query;

    // Admin scope: enforce region from scope for regional admins
    if (req.user.role === 'admin' && req.user.adminLevel === 'Regional' && req.user.adminRegion) {
      region = req.user.adminRegion;
    }

    const query = {
      level: 'Regional',
      status: { $in: ['evaluated', 'promoted', 'eliminated'] }
    };

    if (year) query.year = parseInt(year);
    if (region) query.region = region;
    if (areaOfFocus) query.areaOfFocus = areaOfFocus;

    if (!includeDisqualified) {
      query.disqualified = { $ne: true };
    }

    let submissions = await Submission.find(query)
      .populate('teacherId', 'name email')
      .sort({ averageScore: -1, createdAt: 1 });

    const byAreaOfFocus = {};
    submissions.forEach(sub => {
      const area = sub.areaOfFocus || 'Unknown';
      if (!byAreaOfFocus[area]) {
        byAreaOfFocus[area] = [];
      }
      byAreaOfFocus[area].push(sub);
    });

    const generateRankings = (subs) => {
      return subs.map((sub, index) => ({
        ...sub.toObject(),
        rank: index + 1,
        willAdvance: index < 3 && !sub.disqualified
      }));
    };

    const areaLeaderboards = {};
    Object.keys(byAreaOfFocus).forEach(area => {
      areaLeaderboards[area] = generateRankings(byAreaOfFocus[area]);
    });

    const overallLeaderboard = generateRankings(submissions);

    res.json({
      success: true,
      leaderboards: {
        byAreaOfFocus: areaLeaderboards,
        overall: overallLeaderboard
      },
      summary: {
        totalSubmissions: submissions.length,
        areasOfFocus: Object.keys(byAreaOfFocus),
        disqualified: submissions.filter(s => s.disqualified).length
      }
    });
  } catch (error) {
    console.error('Get regional leaderboard error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   GET /api/submissions/leaderboard/national
// @desc    Get national level leaderboard
// @access  Private (Admin, Superadmin, Judge)
router.get('/leaderboard/national', authorize('admin', 'superadmin'), async (req, res) => {
  try {
    const { year, areaOfFocus, includeDisqualified = false } = req.query;

    const query = {
      level: 'National',
      status: { $in: ['evaluated', 'promoted', 'eliminated'] }
    };

    if (year) query.year = parseInt(year);
    if (areaOfFocus) query.areaOfFocus = areaOfFocus;

    if (!includeDisqualified) {
      query.disqualified = { $ne: true };
    }

    let submissions = await Submission.find(query)
      .populate('teacherId', 'name email')
      .sort({ averageScore: -1, createdAt: 1 });

    const byAreaOfFocus = {};
    submissions.forEach(sub => {
      const area = sub.areaOfFocus || 'Unknown';
      if (!byAreaOfFocus[area]) {
        byAreaOfFocus[area] = [];
      }
      byAreaOfFocus[area].push(sub);
    });

    const generateRankings = (subs) => {
      return subs.map((sub, index) => ({
        ...sub.toObject(),
        rank: index + 1
      }));
    };

    const areaLeaderboards = {};
    Object.keys(byAreaOfFocus).forEach(area => {
      areaLeaderboards[area] = generateRankings(byAreaOfFocus[area]);
    });

    const overallLeaderboard = generateRankings(submissions);

    res.json({
      success: true,
      leaderboards: {
        byAreaOfFocus: areaLeaderboards,
        overall: overallLeaderboard
      },
      summary: {
        totalSubmissions: submissions.length,
        areasOfFocus: Object.keys(byAreaOfFocus),
        disqualified: submissions.filter(s => s.disqualified).length
      }
    });
  } catch (error) {
    console.error('Get national leaderboard error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   GET /api/submissions/:id/eligible-judges
// @desc    Get eligible judges for a submission (Admin/Superadmin only)
// @access  Private (Admin, Superadmin)
router.get('/:id/eligible-judges', authorize('admin', 'superadmin'), async (req, res) => {
  try {
    const submission = await Submission.findById(req.params.id);
    if (!submission) {
      return res.status(404).json({
        success: false,
        message: 'Submission not found'
      });
    }
    if (req.user.role === 'admin' && !canAdminAccessSubmission(req.user, submission)) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to access this submission'
      });
    }

    const result = await getEligibleJudges(req.params.id);
    
    if (!result.success) {
      return res.status(404).json({
        success: false,
        message: result.error
      });
    }

    res.json({
      success: true,
      judges: result.judges,
      message: result.message || `${result.judges.length} eligible judge(s) found`
    });
  } catch (error) {
    console.error('Get eligible judges error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   GET /api/submissions/:id/assigned-judge
// @desc    Get assigned judge for a submission (Admin/Superadmin only)
// @access  Private (Admin, Superadmin)
router.get('/:id/assigned-judge', authorize('admin', 'superadmin'), async (req, res) => {
  try {
    const submission = await Submission.findById(req.params.id);
    
    if (!submission) {
      return res.status(404).json({
        success: false,
        message: 'Submission not found'
      });
    }
    if (req.user.role === 'admin' && !canAdminAccessSubmission(req.user, submission)) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to access this submission'
      });
    }

    // Only Council and Regional levels have assignments
    if (submission.level === 'National') {
      return res.json({
        success: true,
        assignment: null,
        message: 'National level does not require assignment'
      });
    }

    const includeHistorical = parseBooleanParam(req.query.includeHistorical);
    const assignmentResult = await getAssignedJudge(req.params.id, {
      roundId: req.query.roundId || null,
      includeHistorical,
      submission
    });

    if (!assignmentResult.success) {
      return res.status(400).json({
        success: false,
        message: assignmentResult.error || 'Failed to resolve assignment context'
      });
    }

    const assignment = assignmentResult.assignment;
    const resolvedRound = assignmentResult.round || assignment?.roundId || null;
    
    res.json({
      success: true,
      assignment: assignment ? {
        judgeId: assignment.judgeId._id,
        judgeName: assignment.judgeId.name,
        judgeEmail: assignment.judgeId.email,
        assignedAt: assignment.assignedAt,
        roundId: assignment.roundId?._id || assignment.roundId || null,
        roundStatus: assignment.roundId?.status || resolvedRound?.status || null,
        isHistorical: assignmentResult.isHistorical === true
      } : null,
      roundContext: resolvedRound ? {
        roundId: resolvedRound._id || resolvedRound,
        roundStatus: resolvedRound.status || null,
        isActionable: isRoundActionable(resolvedRound)
      } : null,
      message: assignment
        ? assignmentResult.isHistorical ? 'Historical judge assignment found' : 'Judge assigned'
        : 'No judge assigned for the current round context'
    });
  } catch (error) {
    console.error('Get assigned judge error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   POST /api/submissions/:id/assign-judge
// @desc    Manually assign or reassign a submission to a judge (Admin/Superadmin only)
// @access  Private (Admin, Superadmin)
router.post('/:id/assign-judge', authorize('admin', 'superadmin'), async (req, res) => {
  try {
    const { judgeId } = req.body;

    if (!judgeId) {
      return res.status(400).json({
        success: false,
        message: 'Judge ID is required'
      });
    }

    const submission = await Submission.findById(req.params.id);
    if (!submission) {
      return res.status(404).json({
        success: false,
        message: 'Submission not found'
      });
    }
    if (req.user.role === 'admin' && !canAdminAccessSubmission(req.user, submission)) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to access this submission'
      });
    }

    const judge = await User.findById(judgeId);
    if (!judge) {
      return res.status(404).json({
        success: false,
        message: 'Judge not found'
      });
    }
    if (req.user.role === 'admin' && !canAdminAccessUser(req.user, judge)) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to assign this judge'
      });
    }

    const roundResolution = await resolveSubmissionRoundContext(submission, {
      explicitRoundId: req.body.roundId || req.query.roundId || null,
      includeHistorical: false,
      allowFallbackByYearLevel: true
    });

    if (!roundResolution.round) {
      return res.status(400).json({
        success: false,
        message: 'No active or ended round found for this submission'
      });
    }

    const result = await manuallyAssignSubmission(req.params.id, judgeId, {
      roundId: roundResolution.round._id
    });

    if (!result.success) {
      return res.status(400).json({
        success: false,
        message: result.error
      });
    }

    // Log the assignment/reassignment
    await logger.logAdminAction(
      result.message.includes('reassigned') ? 'Admin reassigned submission to judge' : 'Admin assigned submission to judge',
      req.user._id,
      req,
      {
        submissionId: req.params.id,
        judgeId: judgeId,
        assignmentId: result.assignment._id.toString()
      },
      'success',
      'update'
    );

    res.json({
      success: true,
      assignment: {
        id: result.assignment._id,
        submissionId: result.assignment.submissionId,
        judgeId: result.assignment.judgeId,
        assignedAt: result.assignment.assignedAt,
        roundId: result.assignment.roundId,
        roundStatus: roundResolution.round.status
      },
      message: result.message
    });
  } catch (error) {
    console.error('Assign judge error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

module.exports = router;
