const express = require('express');
const User = require('../models/User');
const Submission = require('../models/Submission');
const Evaluation = require('../models/Evaluation');
const SubmissionAssignment = require('../models/SubmissionAssignment');
const { protect, authorize } = require('../middleware/auth');
const { cacheMiddleware } = require('../middleware/cache');
const { generalLimiter } = require('../middleware/rateLimiter');
const { isValidRegion, isValidCouncil } = require('../data/locations');

const router = express.Router();

// Apply rate limiting to all stakeholder routes
router.use(generalLimiter);

// @route   GET /api/stakeholder/stats
// @desc    Get aggregate competition stats for stakeholder dashboard (read-only, no PII)
// @access  Private (Stakeholder only)
router.get('/stats', protect, authorize('stakeholder'), cacheMiddleware(120), async (req, res) => {
  try {
    const year = req.query.year ? parseInt(req.query.year, 10) : new Date().getFullYear();
    if (isNaN(year)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid year parameter'
      });
    }

    // Parse filter parameters
    const areaOfFocus = req.query.areaOfFocus || null;
    const region = req.query.region || null;
    const council = req.query.council || null;

    // Validate region parameter if provided
    if (region && !isValidRegion(region)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid region parameter'
      });
    }

    // Validate council parameter if provided
    if (council && (!region || !isValidCouncil(region, council))) {
      return res.status(400).json({
        success: false,
        message: 'Invalid council parameter or council does not belong to the specified region'
      });
    }

    // Build base match queries
    const submissionMatchQuery = { year };
    if (areaOfFocus) submissionMatchQuery.areaOfFocus = areaOfFocus;
    if (region) submissionMatchQuery.region = region;
    if (council) submissionMatchQuery.council = council;

    const teacherMatchQuery = { role: 'teacher', status: 'active' };
    if (region) teacherMatchQuery.region = region;
    if (council) teacherMatchQuery.council = council;

    // Get available areas of focus for filter dropdown
    const availableAreasOfFocus = await Submission.distinct('areaOfFocus', { year }).maxTimeMS(30000);

    // Totals based on filters
    const [totalTeachers, totalSubmissions, totalJudges] = await Promise.all([
      User.countDocuments(teacherMatchQuery).maxTimeMS(30000),
      Submission.countDocuments(submissionMatchQuery).maxTimeMS(30000),
      User.countDocuments({ role: 'judge', status: 'active' }).maxTimeMS(30000)
    ]);

    // Dynamic location stats based on filter level
    let locationStats = [];
    let locationStatsType = 'regions'; // 'regions', 'councils', or 'areaOfFocus'

    if (council) {
      // Council selected: show breakdown by area of focus
      locationStatsType = 'areaOfFocus';
      const byAreaOfFocus = await Submission.aggregate([
        { $match: submissionMatchQuery },
        { $group: { _id: '$areaOfFocus', submissionsCount: { $sum: 1 } } },
        { $project: { name: '$_id', submissionsCount: 1, _id: 0 } },
        { $sort: { submissionsCount: -1 } }
      ]).option({ maxTimeMS: 30000, allowDiskUse: true });
      locationStats = byAreaOfFocus;
    } else if (region) {
      // Region selected: show councils within that region
      locationStatsType = 'councils';
      
      // Get all teachers by council in this region
      const teachersByCouncil = await User.aggregate([
        { $match: { ...teacherMatchQuery, council: { $exists: true, $ne: '' } } },
        { $group: { _id: '$council', teachersCount: { $sum: 1 } } },
        { $project: { name: '$_id', teachersCount: 1, _id: 0 } }
      ]).option({ maxTimeMS: 30000, allowDiskUse: true });

      // Get submissions by council
      const submissionsByCouncil = await Submission.aggregate([
        { $match: submissionMatchQuery },
        { $group: { _id: '$council', submissionsCount: { $sum: 1 } } },
        { $project: { name: '$_id', submissionsCount: 1, _id: 0 } }
      ]).option({ maxTimeMS: 30000, allowDiskUse: true });

      const submissionsMap = new Map(submissionsByCouncil.map(item => [item.name, item.submissionsCount]));
      
      locationStats = teachersByCouncil
        .map(({ name, teachersCount }) => ({
          name: name || 'Unknown',
          teachersCount,
          submissionsCount: submissionsMap.get(name) || 0
        }))
        .sort((a, b) => b.teachersCount - a.teachersCount);
    } else {
      // No region filter: show all regions
      locationStatsType = 'regions';
      
      // Get all teachers by region
      const allTeachersByRegion = await User.aggregate([
        { $match: { role: 'teacher', status: 'active', region: { $exists: true, $ne: '' } } },
        { $group: { _id: '$region', teachersCount: { $sum: 1 } } },
        { $project: { name: '$_id', teachersCount: 1, _id: 0 } }
      ]).option({ maxTimeMS: 30000, allowDiskUse: true });

      // Get submissions by region (with area of focus filter if applied)
      const submissionsByRegion = await Submission.aggregate([
        { $match: submissionMatchQuery },
        { $group: { _id: '$region', submissionsCount: { $sum: 1 } } },
        { $project: { name: '$_id', submissionsCount: 1, _id: 0 } }
      ]).option({ maxTimeMS: 30000, allowDiskUse: true });

      const submissionsMap = new Map(submissionsByRegion.map(item => [item.name, item.submissionsCount]));
      
      locationStats = allTeachersByRegion
        .map(({ name, teachersCount }) => ({
          name: name || 'Unknown',
          teachersCount,
          submissionsCount: submissionsMap.get(name) || 0
        }))
        .sort((a, b) => b.teachersCount - a.teachersCount);
    }

    // Submissions by status for donut chart (filtered)
    const byStatus = await Submission.aggregate([
      { $match: submissionMatchQuery },
      { $group: { _id: '$status', count: { $sum: 1 } } },
      { $project: { status: '$_id', count: 1, _id: 0 } },
      { $sort: { count: -1 } }
    ]).option({ maxTimeMS: 30000, allowDiskUse: true });

    // Teachers by location for pie chart (dynamic based on filter)
    let teachersByLocation = [];
    let teachersByLocationType = 'region';

    if (council) {
      // Show teachers by area of focus they submitted to (if any)
      teachersByLocationType = 'areaOfFocus';
      teachersByLocation = [{ name: council, teachersCount: totalTeachers }];
    } else if (region) {
      teachersByLocationType = 'council';
      teachersByLocation = await User.aggregate([
        { $match: { ...teacherMatchQuery, council: { $exists: true, $ne: '' } } },
        { $group: { _id: '$council', teachersCount: { $sum: 1 } } },
        { $project: { name: '$_id', teachersCount: 1, _id: 0 } },
        { $sort: { teachersCount: -1 } }
      ]).option({ maxTimeMS: 30000, allowDiskUse: true });
    } else {
      teachersByLocationType = 'region';
      teachersByLocation = await User.aggregate([
        { $match: { role: 'teacher', status: 'active', region: { $exists: true, $ne: '' } } },
        { $group: { _id: '$region', teachersCount: { $sum: 1 } } },
        { $project: { name: '$_id', teachersCount: 1, _id: 0 } },
        { $sort: { teachersCount: -1 } }
      ]).option({ maxTimeMS: 30000, allowDiskUse: true });
    }

    // Evaluation data (filtered)
    const evalMatchQuery = { 'sub.year': year };
    if (areaOfFocus) evalMatchQuery['sub.areaOfFocus'] = areaOfFocus;
    if (region) evalMatchQuery['sub.region'] = region;
    if (council) evalMatchQuery['sub.council'] = council;

    const submissionsWithEvaluation = await Evaluation.aggregate([
      { $lookup: { from: 'submissions', localField: 'submissionId', foreignField: '_id', as: 'sub' } },
      { $unwind: '$sub' },
      { $match: evalMatchQuery },
      { $group: { _id: '$submissionId' } },
      { $count: 'evaluatedCount' }
    ]).option({ maxTimeMS: 30000, allowDiskUse: true });
    const evaluatedCount = submissionsWithEvaluation[0]?.evaluatedCount ?? 0;

    // Judges data (not filtered by submission filters)
    const judgesPerLevel = await User.aggregate([
      { $match: { role: 'judge', status: 'active', assignedLevel: { $in: ['Council', 'Regional', 'National'] } } },
      { $group: { _id: '$assignedLevel', count: { $sum: 1 } } },
      { $project: { level: '$_id', count: 1, _id: 0 } }
    ]).option({ maxTimeMS: 30000 });

    const judgesPerRegion = await User.aggregate([
      { $match: { role: 'judge', status: 'active', assignedRegion: { $exists: true, $ne: '' } } },
      { $group: { _id: '$assignedRegion', count: { $sum: 1 } } },
      { $project: { region: '$_id', count: 1, _id: 0 } },
      { $sort: { count: -1 } }
    ]).option({ maxTimeMS: 30000 });

    res.json({
      success: true,
      year,
      filters: { areaOfFocus, region, council },
      availableAreasOfFocus,
      totalTeachers,
      totalSubmissions,
      totalJudges,
      locationStats: {
        type: locationStatsType,
        data: locationStats
      },
      byStatus,
      teachersByLocation: {
        type: teachersByLocationType,
        data: teachersByLocation
      },
      evaluation: {
        totalSubmissions,
        evaluatedCount,
        judgesPerLevel,
        judgesPerRegion
      }
    });
  } catch (error) {
    console.error('Stakeholder stats error:', error);
    const isProduction = process.env.NODE_ENV === 'production';
    res.status(500).json({
      success: false,
      message: isProduction 
        ? 'An error occurred while processing your request. Please try again later.'
        : (error.message || 'Server error')
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

    // Validate region parameter if provided
    if (region && !isValidRegion(region)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid region parameter'
      });
    }

    // Validate council parameter if provided (must be valid within the region)
    if (council && (!region || !isValidCouncil(region, council))) {
      return res.status(400).json({
        success: false,
        message: 'Invalid council parameter or council does not belong to the specified region'
      });
    }

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
      Submission.countDocuments(matchQuery).maxTimeMS(30000),
      
      // Total distinct teachers
      Submission.aggregate([
        { $match: matchQuery },
        { $group: { _id: '$teacherId' } },
        { $count: 'total' }
      ]).option({ maxTimeMS: 30000, allowDiskUse: true }).then(result => result[0]?.total ?? 0),

      // By status
      Submission.aggregate([
        { $match: matchQuery },
        { $group: { _id: '$status', count: { $sum: 1 } } },
        { $project: { status: '$_id', count: 1, _id: 0 } },
        { $sort: { count: -1 } }
      ]).option({ maxTimeMS: 30000, allowDiskUse: true }),

      // By level
      Submission.aggregate([
        { $match: matchQuery },
        { $group: { _id: '$level', count: { $sum: 1 } } },
        { $project: { level: '$_id', count: 1, _id: 0 } },
        { $sort: { count: -1 } }
      ]).option({ maxTimeMS: 30000, allowDiskUse: true }),

      // By area of focus (only if no areaOfFocus filter)
      !areaOfFocus ? Submission.aggregate([
        { $match: matchQuery },
        { $group: { _id: '$areaOfFocus', count: { $sum: 1 } } },
        { $project: { areaOfFocus: '$_id', count: 1, _id: 0 } },
        { $sort: { count: -1 } }
      ]).option({ maxTimeMS: 30000, allowDiskUse: true }) : Promise.resolve([]),

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
      ]).option({ maxTimeMS: 30000, allowDiskUse: true }).then(result => result[0] || { averageScore: 0, minScore: 0, maxScore: 0, submissionsWithScores: 0 }),

      // Disqualified count
      Submission.countDocuments({ ...matchQuery, disqualified: true }).maxTimeMS(30000),

      // By region (only if no region filter)
      !region ? Submission.aggregate([
        { $match: matchQuery },
        { $group: { _id: '$region', count: { $sum: 1 } } },
        { $project: { region: '$_id', count: 1, _id: 0 } },
        { $sort: { count: -1 } }
      ]).option({ maxTimeMS: 30000, allowDiskUse: true }) : Promise.resolve([]),

      // By council (only if no council filter and region is selected)
      !council && region ? Submission.aggregate([
        { $match: matchQuery },
        { $group: { _id: '$council', count: { $sum: 1 } } },
        { $project: { council: '$_id', count: 1, _id: 0 } },
        { $sort: { count: -1 } }
      ]).option({ maxTimeMS: 30000, allowDiskUse: true }) : Promise.resolve([]),

      // Available areas of focus for the year
      Submission.aggregate([
        { $match: { year } },
        { $group: { _id: '$areaOfFocus' } },
        { $project: { areaOfFocus: '$_id', _id: 0 } },
        { $sort: { areaOfFocus: 1 } }
      ]).option({ maxTimeMS: 30000, allowDiskUse: true }).then(result => result.map(r => r.areaOfFocus))
    ]);

    // Determine competitionBreakdown based on filters
    let competitionBreakdown;
    if (council) {
      // Council selected: show competitions (areas of focus) for this council
      const competitionsForCouncil = await Submission.aggregate([
        { $match: { ...matchQuery, council } },
        { $group: { _id: '$areaOfFocus', count: { $sum: 1 } } },
        { $project: { areaOfFocus: '$_id', count: 1, _id: 0 } },
        { $sort: { count: -1 } }
      ]).option({ maxTimeMS: 30000, allowDiskUse: true });
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
    const isProduction = process.env.NODE_ENV === 'production';
    res.status(500).json({
      success: false,
      message: isProduction 
        ? 'An error occurred while processing your request. Please try again later.'
        : (error.message || 'Server error')
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

    // Validate region parameter if provided
    if (region && !isValidRegion(region)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid region parameter'
      });
    }

    // Validate council parameter if provided (must be valid within the region)
    if (council && (!region || !isValidCouncil(region, council))) {
      return res.status(400).json({
        success: false,
        message: 'Invalid council parameter or council does not belong to the specified region'
      });
    }

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
      Submission.countDocuments(matchQuery).maxTimeMS(30000),

      // Eliminated count
      Submission.countDocuments({ ...matchQuery, status: 'eliminated' }).maxTimeMS(30000),

      // Promoted count (this is "passed")
      Submission.countDocuments({ ...matchQuery, status: 'promoted' }).maxTimeMS(30000),

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
      ]).option({ maxTimeMS: 30000, allowDiskUse: true }),

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
      ]).option({ maxTimeMS: 30000, allowDiskUse: true }) : Promise.resolve([]),

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
      ]).option({ maxTimeMS: 30000, allowDiskUse: true }) : Promise.resolve([]),

      // Available areas of focus for the year
      Submission.aggregate([
        { $match: { year } },
        { $group: { _id: '$areaOfFocus' } },
        { $project: { areaOfFocus: '$_id', _id: 0 } },
        { $sort: { areaOfFocus: 1 } }
      ]).option({ maxTimeMS: 30000, allowDiskUse: true }).then(result => result.map(r => r.areaOfFocus))
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
    const isProduction = process.env.NODE_ENV === 'production';
    res.status(500).json({
      success: false,
      message: isProduction 
        ? 'An error occurred while processing your request. Please try again later.'
        : (error.message || 'Server error')
    });
  }
});

// @route   GET /api/stakeholder/teachers-by-region
// @desc    Get teachers count by region or council (read-only, no PII)
// @access  Private (Stakeholder only)
router.get('/teachers-by-region', protect, authorize('stakeholder'), cacheMiddleware(120), async (req, res) => {
  try {
    const region = req.query.region || null;

    // Validate region parameter if provided
    if (region && !isValidRegion(region)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid region parameter'
      });
    }

    let data;
    if (region) {
      // Region filter applied: return councils within that region
      data = await User.aggregate([
        { $match: { role: 'teacher', status: 'active', region, council: { $exists: true, $ne: '' } } },
        { $group: { _id: '$council', teachersCount: { $sum: 1 } } },
        { $project: { council: '$_id', teachersCount: 1, _id: 0 } },
        { $sort: { teachersCount: -1 } }
      ]).option({ maxTimeMS: 30000, allowDiskUse: true });
    } else {
      // No region filter: return all regions
      data = await User.aggregate([
        { $match: { role: 'teacher', status: 'active', region: { $exists: true, $ne: '' } } },
        { $group: { _id: '$region', teachersCount: { $sum: 1 } } },
        { $project: { region: '$_id', teachersCount: 1, _id: 0 } },
        { $sort: { teachersCount: -1 } }
      ]).option({ maxTimeMS: 30000, allowDiskUse: true });
    }

    res.json({
      success: true,
      region: region || null,
      data
    });
  } catch (error) {
    console.error('Stakeholder teachers by region error:', error);
    const isProduction = process.env.NODE_ENV === 'production';
    res.status(500).json({
      success: false,
      message: isProduction 
        ? 'An error occurred while processing your request. Please try again later.'
        : (error.message || 'Server error')
    });
  }
});

module.exports = router;
