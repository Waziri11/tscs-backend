const express = require('express');
const User = require('../models/User');
const Submission = require('../models/Submission');
const Evaluation = require('../models/Evaluation');
const SubmissionAssignment = require('../models/SubmissionAssignment');
const { protect, authorize } = require('../middleware/auth');

const router = express.Router();

// @route   GET /api/stakeholder/stats
// @desc    Get aggregate competition stats for stakeholder dashboard (read-only, no PII)
// @access  Private (Stakeholder only)
router.get('/stats', protect, authorize('stakeholder'), async (req, res) => {
  try {
    const year = req.query.year ? parseInt(req.query.year, 10) : new Date().getFullYear();
    if (isNaN(year)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid year parameter'
      });
    }

    // Totals: use countDocuments only (no raw lists)
    const [totalTeachers, totalSubmissions] = await Promise.all([
      User.countDocuments({ role: 'teacher', status: 'active' }),
      Submission.countDocuments({ year })
    ]);

    // Region data: aggregate counts by region (no PII)
    const regionAggregation = await Submission.aggregate([
      { $match: { year } },
      {
        $group: {
          _id: '$region',
          submissionsCount: { $sum: 1 },
          teacherCount: { $addToSet: '$teacherId' }
        }
      },
      {
        $project: {
          region: '$_id',
          submissionsCount: 1,
          teachersCount: { $size: '$teacherCount' },
          _id: 0
        }
      },
      { $sort: { submissionsCount: -1 } }
    ]);

    const regionStats = regionAggregation.map(({ region, submissionsCount, teachersCount }) => ({
      region: region || 'Unknown',
      submissionsCount,
      teachersCount
    }));

    // Evaluation data: submissions evaluated count
    const submissionsWithEvaluation = await Evaluation.aggregate([
      { $lookup: { from: 'submissions', localField: 'submissionId', foreignField: '_id', as: 'sub' } },
      { $unwind: '$sub' },
      { $match: { 'sub.year': year } },
      { $group: { _id: '$submissionId' } },
      { $count: 'evaluatedCount' }
    ]);
    const evaluatedCount = submissionsWithEvaluation[0]?.evaluatedCount ?? 0;

    // Judges per level (count only, no list)
    const judgesPerLevel = await User.aggregate([
      { $match: { role: 'judge', status: 'active', assignedLevel: { $in: ['Council', 'Regional', 'National'] } } },
      { $group: { _id: '$assignedLevel', count: { $sum: 1 } } },
      { $project: { level: '$_id', count: 1, _id: 0 } }
    ]);

    // Judges per region (Council/Regional have assignedRegion)
    const judgesPerRegion = await User.aggregate([
      { $match: { role: 'judge', status: 'active', assignedRegion: { $exists: true, $ne: '' } } },
      { $group: { _id: '$assignedRegion', count: { $sum: 1 } } },
      { $project: { region: '$_id', count: 1, _id: 0 } },
      { $sort: { count: -1 } }
    ]);

    // Allocation: submissions per judge (from SubmissionAssignment for Council/Regional; from Evaluation for National)
    // Count assignments per judge for the year (submissions filtered by year)
    const submissionIdsForYear = await Submission.find({ year }).select('_id').lean();

    const assignmentsPerJudge = await SubmissionAssignment.aggregate([
      { $match: { submissionId: { $in: submissionIdsForYear.map(s => s._id) } } },
      { $group: { _id: '$judgeId', assignedCount: { $sum: 1 } } },
      { $group: { _id: null, min: { $min: '$assignedCount' }, max: { $max: '$assignedCount' }, avg: { $avg: '$assignedCount' }, judgeCount: { $sum: 1 } } }
    ]);

    const evaluationsPerJudge = await Evaluation.aggregate([
      { $lookup: { from: 'submissions', localField: 'submissionId', foreignField: '_id', as: 'sub' } },
      { $unwind: '$sub' },
      { $match: { 'sub.year': year } },
      { $group: { _id: '$judgeId', evaluatedCount: { $sum: 1 } } },
      { $group: { _id: null, min: { $min: '$evaluatedCount' }, max: { $max: '$evaluatedCount' }, avg: { $avg: '$evaluatedCount' }, judgeCount: { $sum: 1 } } }
    ]);

    const assignmentStats = assignmentsPerJudge[0] || { min: 0, max: 0, avg: 0, judgeCount: 0 };
    const evaluationStatsAgg = evaluationsPerJudge[0] || { min: 0, max: 0, avg: 0, judgeCount: 0 };

    const allocationByLevel = {
      councilRegional: assignmentStats.judgeCount > 0 ? {
        min: assignmentStats.min,
        max: assignmentStats.max,
        avg: Math.round(assignmentStats.avg * 100) / 100,
        judgesCount: assignmentStats.judgeCount
      } : null,
      national: evaluationStatsAgg.judgeCount > 0 ? {
        min: evaluationStatsAgg.min,
        max: evaluationStatsAgg.max,
        avg: Math.round(evaluationStatsAgg.avg * 100) / 100,
        judgesCount: evaluationStatsAgg.judgeCount
      } : null
    };

    res.json({
      success: true,
      year,
      totalTeachers,
      totalSubmissions,
      regionStats,
      evaluation: {
        totalSubmissions,
        evaluatedCount,
        judgesPerLevel,
        judgesPerRegion,
        allocationByLevel
      }
    });
  } catch (error) {
    console.error('Stakeholder stats error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

module.exports = router;
