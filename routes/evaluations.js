const express = require('express');
const Evaluation = require('../models/Evaluation');
const Submission = require('../models/Submission');
const { protect, authorize } = require('../middleware/auth');

const router = express.Router();

// All routes require authentication
router.use(protect);

// @route   GET /api/evaluations
// @desc    Get all evaluations (with filters)
// @access  Private
router.get('/', async (req, res) => {
  try {
    const { submissionId, judgeId } = req.query;
    
    let query = {};
    
    if (submissionId) {
      query.submissionId = submissionId;
    }
    
    // Judges only see their own evaluations
    if (req.user.role === 'judge') {
      query.judgeId = req.user._id;
    } else if (judgeId) {
      query.judgeId = judgeId;
    }

    const evaluations = await Evaluation.find(query)
      .populate('submissionId', 'teacherName category subject level')
      .populate('judgeId', 'name username')
      .sort({ submittedAt: -1 });

    res.json({
      success: true,
      count: evaluations.length,
      evaluations
    });
  } catch (error) {
    console.error('Get evaluations error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   GET /api/evaluations/:id
// @desc    Get single evaluation
// @access  Private
router.get('/:id', async (req, res) => {
  try {
    const evaluation = await Evaluation.findById(req.params.id)
      .populate('submissionId')
      .populate('judgeId', 'name username');

    if (!evaluation) {
      return res.status(404).json({
        success: false,
        message: 'Evaluation not found'
      });
    }

    // Judges can only see their own evaluations
    if (req.user.role === 'judge' && evaluation.judgeId._id.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to access this evaluation'
      });
    }

    res.json({
      success: true,
      evaluation
    });
  } catch (error) {
    console.error('Get evaluation error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// @route   POST /api/evaluations
// @desc    Create/update evaluation (judges only)
// @access  Private (Judge)
router.post('/', authorize('judge'), async (req, res) => {
  try {
    const { submissionId, scores, comments } = req.body;

    // Validate input
    if (!submissionId || !scores) {
      return res.status(400).json({
        success: false,
        message: 'Please provide submissionId and scores'
      });
    }

    // Check if submission exists
    const submission = await Submission.findById(submissionId);
    if (!submission) {
      return res.status(404).json({
        success: false,
        message: 'Submission not found'
      });
    }

    // Calculate totals
    const scoreValues = Object.values(scores);
    const totalScore = scoreValues.reduce((sum, score) => sum + (score || 0), 0);
    const averageScore = scoreValues.length > 0 ? totalScore / scoreValues.length : 0;

    // Create or update evaluation
    const evaluation = await Evaluation.findOneAndUpdate(
      { submissionId, judgeId: req.user._id },
      {
        submissionId,
        judgeId: req.user._id,
        scores,
        totalScore,
        averageScore,
        comments: comments || '',
        submittedAt: new Date()
      },
      { new: true, upsert: true, runValidators: true }
    ).populate('submissionId', 'teacherName category subject');

    // Update submission average score (recalculate from all evaluations)
    await updateSubmissionAverageScore(submissionId);

    res.status(201).json({
      success: true,
      evaluation
    });
  } catch (error) {
    console.error('Create evaluation error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// Helper function to update submission average score
async function updateSubmissionAverageScore(submissionId) {
  try {
    const evaluations = await Evaluation.find({ submissionId });
    
    if (evaluations.length === 0) {
      await Submission.findByIdAndUpdate(submissionId, { averageScore: 0 });
      return;
    }

    const totalAverage = evaluations.reduce((sum, eval) => sum + eval.averageScore, 0);
    const overallAverage = totalAverage / evaluations.length;

    await Submission.findByIdAndUpdate(submissionId, {
      averageScore: Math.round(overallAverage * 100) / 100,
      status: 'evaluated'
    });
  } catch (error) {
    console.error('Error updating submission average score:', error);
  }
}

// @route   GET /api/evaluations/submission/:submissionId
// @desc    Get all evaluations for a submission
// @access  Private
router.get('/submission/:submissionId', async (req, res) => {
  try {
    const evaluations = await Evaluation.find({ submissionId: req.params.submissionId })
      .populate('judgeId', 'name username assignedLevel')
      .sort({ submittedAt: -1 });

    res.json({
      success: true,
      count: evaluations.length,
      evaluations
    });
  } catch (error) {
    console.error('Get submission evaluations error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

module.exports = router;

