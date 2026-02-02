const express = require('express');
const User = require('../models/User');
const Submission = require('../models/Submission');
const Evaluation = require('../models/Evaluation');
const SubmissionAssignment = require('../models/SubmissionAssignment');
const { protect, authorize } = require('../middleware/auth');
const { cacheMiddleware } = require('../middleware/cache');

const router = express.Router();

// @route   GET /api/stakeholder/stats
// @desc    Get aggregate competition stats for stakeholder dashboard (read-only, no PII)
// @access  Private (Stakeholder only)
router.get('/stats', protect, authorize('stakeholder'), cacheMiddleware(300), async (req, res) => {
  try {
    const year = req.query.year ? parseInt(req.query.year, 10) : new Date().getFullYear();
    if (isNaN(year)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid year parameter'
      });
    }

    // Totals: use countDocuments only (no raw lists)
    const [totalTeachers, totalSubmissions, totalJudges] = await Promise.all([
      User.countDocuments({ role: 'teacher', status: 'active' }),
      Submission.countDocuments({ year }),
      User.countDocuments({ role: 'judge', status: 'active' })
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

    // Submissions by status for donut chart
    const byStatus = await Submission.aggregate([
      { $match: { year } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
      { $project: { status: '$_id', count: 1, _id: 0 } },
      { $sort: { count: -1 } }
    ]);

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
    // Optimized: Use $lookup instead of loading all IDs into memory
    const assignmentsPerJudge = await SubmissionAssignment.aggregate([
      {
        $lookup: {
          from: 'submissions',
          localField: 'submissionId',
          foreignField: '_id',
          as: 'submission'
        }
      },
      { $unwind: '$submission' },
      { $match: { 'submission.year': year } },
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
      totalJudges,
      regionStats,
      byStatus,
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

// @route   GET /api/stakeholder/submissions-stats
// @desc    Get comprehensive submission statistics with filters (read-only, no PII)
// @access  Private (Stakeholder only)
router.get('/submissions-stats', protect, authorize('stakeholder'), cacheMiddleware(120), async (req, res) => {
  try {
    const year = req.query.year ? parseInt(req.query.year, 10) : new Date().getFullYear();
    if (isNaN(year)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid year parameter'
      });
    }

    const areaOfFocus = req.query.areaOfFocus || null;
    const region = req.query.region || null;
    const council = req.query.council || null;

    // Build base match query
    const matchQuery = { year };
    if (areaOfFocus) matchQuery.areaOfFocus = areaOfFocus;
    if (region) matchQuery.region = region;
    if (council) matchQuery.council = council;

    // Run all aggregations in parallel
    const [
      totalSubmissions,
      totalTeachers,
      byStatus,
      byLevel,
      byAreaOfFocus,
      scoreMetrics,
      disqualifiedCount,
      byRegion,
      byCouncil,
      availableAreasOfFocus
    ] = await Promise.all([
      // Total submissions
      Submission.countDocuments(matchQuery),
      
      // Total distinct teachers
      Submission.aggregate([
        { $match: matchQuery },
        { $group: { _id: '$teacherId' } },
        { $count: 'total' }
      ]).then(result => result[0]?.total ?? 0),

      // By status
      Submission.aggregate([
        { $match: matchQuery },
        { $group: { _id: '$status', count: { $sum: 1 } } },
        { $project: { status: '$_id', count: 1, _id: 0 } },
        { $sort: { count: -1 } }
      ]),

      // By level
      Submission.aggregate([
        { $match: matchQuery },
        { $group: { _id: '$level', count: { $sum: 1 } } },
        { $project: { level: '$_id', count: 1, _id: 0 } },
        { $sort: { count: -1 } }
      ]),

      // By area of focus (only if no areaOfFocus filter)
      !areaOfFocus ? Submission.aggregate([
        { $match: matchQuery },
        { $group: { _id: '$areaOfFocus', count: { $sum: 1 } } },
        { $project: { areaOfFocus: '$_id', count: 1, _id: 0 } },
        { $sort: { count: -1 } }
      ]) : Promise.resolve([]),

      // Score metrics
      Submission.aggregate([
        { $match: { ...matchQuery, averageScore: { $gt: 0 } } },
        {
          $group: {
            _id: null,
            avg: { $avg: '$averageScore' },
            min: { $min: '$averageScore' },
            max: { $max: '$averageScore' },
            count: { $sum: 1 }
          }
        },
        { $project: { _id: 0, averageScore: { $round: ['$avg', 2] }, minScore: { $round: ['$min', 2] }, maxScore: { $round: ['$max', 2] }, submissionsWithScores: '$count' } }
      ]).then(result => result[0] || { averageScore: 0, minScore: 0, maxScore: 0, submissionsWithScores: 0 }),

      // Disqualified count
      Submission.countDocuments({ ...matchQuery, disqualified: true }),

      // By region (only if no region filter)
      !region ? Submission.aggregate([
        { $match: matchQuery },
        { $group: { _id: '$region', count: { $sum: 1 } } },
        { $project: { region: '$_id', count: 1, _id: 0 } },
        { $sort: { count: -1 } }
      ]) : Promise.resolve([]),

      // By council (only if no council filter and region is selected)
      !council && region ? Submission.aggregate([
        { $match: matchQuery },
        { $group: { _id: '$council', count: { $sum: 1 } } },
        { $project: { council: '$_id', count: 1, _id: 0 } },
        { $sort: { count: -1 } }
      ]) : Promise.resolve([]),

      // Available areas of focus for the year
      Submission.aggregate([
        { $match: { year } },
        { $group: { _id: '$areaOfFocus' } },
        { $project: { areaOfFocus: '$_id', _id: 0 } },
        { $sort: { areaOfFocus: 1 } }
      ]).then(result => result.map(r => r.areaOfFocus))
    ]);

    // Also compute availableAreasOfFocus for competition-stats endpoint
    const availableAreasOfFocusForCompetition = await Submission.aggregate([
      { $match: { year } },
      { $group: { _id: '$areaOfFocus' } },
      { $project: { areaOfFocus: '$_id', _id: 0 } },
      { $sort: { areaOfFocus: 1 } }
    ]).then(result => result.map(r => r.areaOfFocus));

    // Determine competitionBreakdown based on filters
    let competitionBreakdown;
    if (council) {
      // Council selected: show competitions (areas of focus) for this council
      const competitionsForCouncil = await Submission.aggregate([
        { $match: { ...matchQuery, council } },
        { $group: { _id: '$areaOfFocus', count: { $sum: 1 } } },
        { $project: { areaOfFocus: '$_id', count: 1, _id: 0 } },
        { $sort: { count: -1 } }
      ]);
      competitionBreakdown = { type: 'competitions', data: competitionsForCouncil };
    } else if (region) {
      // Region selected: show councils (already computed in byCouncil)
      competitionBreakdown = { type: 'councils', data: byCouncil };
    } else {
      // No region: show regions (already computed in byRegion)
      competitionBreakdown = { type: 'regions', data: byRegion };
    }

    res.json({
      success: true,
      year,
      filters: { areaOfFocus, region, council },
      totals: {
        totalSubmissions,
        totalTeachers
      },
      byStatus,
      byLevel,
      scoreMetrics,
      disqualifiedCount,
      competitionBreakdown,
      availableAreasOfFocus
    });
  } catch (error) {
    console.error('Stakeholder submissions stats error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// @route   GET /api/stakeholder/competition-stats
// @desc    Get competition statistics (eliminated, promoted) with filters (read-only, no PII)
// @access  Private (Stakeholder only)
router.get('/competition-stats', protect, authorize('stakeholder'), cacheMiddleware(120), async (req, res) => {
  try {
    const year = req.query.year ? parseInt(req.query.year, 10) : new Date().getFullYear();
    if (isNaN(year)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid year parameter'
      });
    }

    const areaOfFocus = req.query.areaOfFocus || null;
    const region = req.query.region || null;
    const council = req.query.council || null;

    // Build base match query
    const matchQuery = { year };
    if (areaOfFocus) matchQuery.areaOfFocus = areaOfFocus;
    if (region) matchQuery.region = region;
    if (council) matchQuery.council = council;

    // Run all aggregations in parallel
    const [
      totalSubmissions,
      eliminatedCount,
      promotedCount,
      byLevel,
      byAreaOfFocus,
      byRegion,
      availableAreasOfFocus
    ] = await Promise.all([
      // Total submissions
      Submission.countDocuments(matchQuery),

      // Eliminated count
      Submission.countDocuments({ ...matchQuery, status: 'eliminated' }),

      // Promoted count (this is "passed")
      Submission.countDocuments({ ...matchQuery, status: 'promoted' }),

      // Breakdown by level
      Submission.aggregate([
        { $match: matchQuery },
        {
          $group: {
            _id: '$level',
            total: { $sum: 1 },
            eliminated: { $sum: { $cond: [{ $eq: ['$status', 'eliminated'] }, 1, 0] } },
            promoted: { $sum: { $cond: [{ $eq: ['$status', 'promoted'] }, 1, 0] } }
          }
        },
        { $project: { level: '$_id', total: 1, eliminated: 1, promoted: 1, _id: 0 } },
        { $sort: { level: 1 } }
      ]),

      // Breakdown by area of focus (only if no areaOfFocus filter)
      !areaOfFocus ? Submission.aggregate([
        { $match: matchQuery },
        {
          $group: {
            _id: '$areaOfFocus',
            total: { $sum: 1 },
            eliminated: { $sum: { $cond: [{ $eq: ['$status', 'eliminated'] }, 1, 0] } },
            promoted: { $sum: { $cond: [{ $eq: ['$status', 'promoted'] }, 1, 0] } }
          }
        },
        { $project: { areaOfFocus: '$_id', total: 1, eliminated: 1, promoted: 1, _id: 0 } },
        { $sort: { total: -1 } }
      ]) : Promise.resolve([]),

      // Breakdown by region (only if no region filter)
      !region ? Submission.aggregate([
        { $match: matchQuery },
        {
          $group: {
            _id: '$region',
            total: { $sum: 1 },
            eliminated: { $sum: { $cond: [{ $eq: ['$status', 'eliminated'] }, 1, 0] } },
            promoted: { $sum: { $cond: [{ $eq: ['$status', 'promoted'] }, 1, 0] } }
          }
        },
        { $project: { region: '$_id', total: 1, eliminated: 1, promoted: 1, _id: 0 } },
        { $sort: { total: -1 } }
      ]) : Promise.resolve([]),

      // Available areas of focus for the year
      Submission.aggregate([
        { $match: { year } },
        { $group: { _id: '$areaOfFocus' } },
        { $project: { areaOfFocus: '$_id', _id: 0 } },
        { $sort: { areaOfFocus: 1 } }
      ]).then(result => result.map(r => r.areaOfFocus))
    ]);

    const passRate = totalSubmissions > 0 ? Math.round((promotedCount / totalSubmissions) * 100 * 100) / 100 : 0;

    res.json({
      success: true,
      year,
      filters: { areaOfFocus, region, council },
      totals: {
        totalSubmissions,
        eliminatedCount,
        promotedCount,
        passRate
      },
      byLevel,
      byAreaOfFocus: !areaOfFocus ? byAreaOfFocus : [],
      byRegion: !region ? byRegion : [],
      availableAreasOfFocus
    });
  } catch (error) {
    console.error('Stakeholder competition stats error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

module.exports = router;
