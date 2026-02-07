const express = require('express');
const TieBreaking = require('../models/TieBreaking');
const { protect, authorize } = require('../middleware/auth');
const { logger } = require('../utils/logger');

const router = express.Router();

// All routes require authentication
router.use(protect);

// @route   GET /api/tie-breaking
// @desc    Get all tie-breaking rounds
// @access  Private
router.get('/', async (req, res) => {
  try {
    const { year, level, status } = req.query;
    
    let query = {};
    
    if (year) query.year = parseInt(year);
    if (level) query.level = level;
    if (status) query.status = status;
    
    // Judges only see tie-breaking rounds for their assigned level
    if (req.user.role === 'judge') {
      query.level = req.user.assignedLevel;
    }

    const tieBreaks = await TieBreaking.find(query)
      .populate('submissionIds', 'teacherName category subject level region council school')
      .populate('votes.judgeId', 'name username')
      .populate('winners', 'teacherName category subject')
      .sort({ createdAt: -1 });

    // Log tie-breaking list view
    await logger.logUserActivity(
      'User viewed tie-breaking rounds',
      req.user._id,
      req,
      { filters: { year, level, status }, count: tieBreaks.length },
      'read'
    );

    res.json({
      success: true,
      count: tieBreaks.length,
      tieBreaks
    });
  } catch (error) {
    console.error('Get tie-breaking rounds error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   GET /api/tie-breaking/:id
// @desc    Get single tie-breaking round
// @access  Private
router.get('/:id', async (req, res) => {
  try {
    const tieBreak = await TieBreaking.findById(req.params.id)
      .populate('submissionIds', 'teacherName category subject level averageScore')
      .populate('votes.judgeId', 'name username')
      .populate('winners', 'teacherName category subject');

    if (!tieBreak) {
      return res.status(404).json({
        success: false,
        message: 'Tie-breaking round not found'
      });
    }

    res.json({
      success: true,
      tieBreak
    });
  } catch (error) {
    console.error('Get tie-breaking round error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   POST /api/tie-breaking/:id/vote
// @desc    Submit vote for tie-breaking round (judges only)
// @access  Private (Judge)
router.post('/:id/vote', authorize('judge'), async (req, res) => {
  try {
    const { submissionId } = req.body;

    if (!submissionId) {
      return res.status(400).json({
        success: false,
        message: 'Please provide submissionId'
      });
    }

    const tieBreak = await TieBreaking.findById(req.params.id);

    if (!tieBreak) {
      return res.status(404).json({
        success: false,
        message: 'Tie-breaking round not found'
      });
    }

    if (tieBreak.status === 'resolved') {
      return res.status(400).json({
        success: false,
        message: 'This tie-breaking round has already been resolved'
      });
    }

    // Check if submission is in the tied submissions
    if (!tieBreak.submissionIds.some(id => id.toString() === submissionId)) {
      return res.status(400).json({
        success: false,
        message: 'Submission is not part of this tie-breaking round'
      });
    }

    // Check if judge has already voted
    const existingVote = tieBreak.votes.find(
      vote => vote.judgeId.toString() === req.user._id.toString()
    );

    if (existingVote) {
      return res.status(400).json({
        success: false,
        message: 'You have already voted in this tie-breaking round'
      });
    }

    // Add vote
    tieBreak.votes.push({
      judgeId: req.user._id,
      submissionId,
      votedAt: new Date()
    });

    await tieBreak.save();

    // Log tie-breaking vote
    await logger.logUserActivity(
      'Judge submitted tie-breaking vote',
      req.user._id,
      req,
      {
        tieBreakId: req.params.id,
        submissionId: submissionId,
        level: tieBreak.level
      },
      'update'
    );

    res.json({
      success: true,
      tieBreak
    });
  } catch (error) {
    console.error('Submit vote error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// @route   POST /api/tie-breaking/:id/resolve
// @desc    Resolve a tie-breaking round by counting votes (admin/superadmin only)
// @access  Private (Admin/Superadmin)
router.post('/:id/resolve', authorize('admin', 'superadmin'), async (req, res) => {
  try {
    const tieBreak = await TieBreaking.findById(req.params.id)
      .populate('submissionIds', 'averageScore');

    if (!tieBreak) {
      return res.status(404).json({
        success: false,
        message: 'Tie-breaking round not found'
      });
    }

    if (tieBreak.status === 'resolved') {
      return res.status(400).json({
        success: false,
        message: 'This tie-breaking round has already been resolved'
      });
    }

    if (tieBreak.votes.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No votes have been cast yet. Cannot resolve.'
      });
    }

    // Count votes per submission
    const voteCounts = {};
    tieBreak.votes.forEach(vote => {
      const subId = vote.submissionId.toString();
      voteCounts[subId] = (voteCounts[subId] || 0) + 1;
    });

    // Sort submissions by vote count DESC, then by averageScore DESC as tiebreaker
    const submissionsWithVotes = tieBreak.submissionIds.map(sub => ({
      _id: sub._id.toString(),
      votes: voteCounts[sub._id.toString()] || 0,
      averageScore: sub.averageScore || 0,
    }));

    submissionsWithVotes.sort((a, b) => {
      if (b.votes !== a.votes) return b.votes - a.votes;
      return b.averageScore - a.averageScore;
    });

    // Determine how many to promote: use optional quota from body, default to 1
    const quota = req.body.quota || 1;
    const winners = submissionsWithVotes.slice(0, quota).map(s => s._id);

    // Update the tie-break record
    tieBreak.winners = winners;
    tieBreak.status = 'resolved';
    tieBreak.resolvedAt = new Date();
    await tieBreak.save();

    // Log resolution
    await logger.logAdminAction(
      'Admin resolved tie-breaking round',
      req.user._id,
      req,
      {
        tieBreakId: req.params.id,
        winnerCount: winners.length,
        totalVotes: tieBreak.votes.length,
        voteCounts,
      },
      'success',
      'update'
    );

    // Populate for response
    const resolved = await TieBreaking.findById(req.params.id)
      .populate('submissionIds', 'teacherName category subject level averageScore')
      .populate('winners', 'teacherName category subject')
      .populate('votes.judgeId', 'name username');

    res.json({
      success: true,
      message: `Tie-breaking resolved. ${winners.length} winner(s) selected.`,
      tieBreak: resolved,
      voteCounts,
    });
  } catch (error) {
    console.error('Resolve tie-breaking error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// @route   POST /api/tie-breaking
// @desc    Create tie-breaking round (admin/superadmin only)
// @access  Private (Admin/Superadmin)
router.post('/', authorize('admin', 'superadmin'), async (req, res) => {
  try {
    const tieBreak = await TieBreaking.create(req.body);

    // Log tie-breaking round creation
    await logger.logAdminAction(
      'Admin created tie-breaking round',
      req.user._id,
      req,
      {
        tieBreakId: tieBreak._id.toString(),
        level: tieBreak.level,
        submissionCount: tieBreak.submissionIds.length,
        quota: tieBreak.quota
      },
      'info',
      'create'
    );

    res.status(201).json({
      success: true,
      tieBreak
    });
  } catch (error) {
    console.error('Create tie-breaking round error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

module.exports = router;

