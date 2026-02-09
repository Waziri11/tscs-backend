const mongoose = require('mongoose');
const Submission = require('../models/Submission');
const Leaderboard = require('../models/Leaderboard');
const Evaluation = require('../models/Evaluation');
const Quota = require('../models/Quota');

/**
 * Calculate average score for a submission based on evaluations
 * @param {String} submissionId - Submission ID
 * @returns {Promise<Number>} Average score
 */
const calculateAverageScore = async (submissionId) => {
  try {
    const evaluations = await Evaluation.find({ submissionId });
    
    if (evaluations.length === 0) {
      return 0;
    }

    // If evaluations have averageScore field, use that
    const hasAverageScore = evaluations.some(e => e.averageScore && e.averageScore > 0);
    if (hasAverageScore) {
      const totalAverage = evaluations.reduce((sum, eval) => sum + (eval.averageScore || 0), 0);
      return totalAverage / evaluations.length;
    }

    // Otherwise, calculate from scores/criteriaScores
    let totalScore = 0;
    evaluations.forEach(evaluation => {
      // Try criteriaScores first (frontend format), then scores (backend format)
      let scoresObj = {};
      if (evaluation.criteriaScores) {
        scoresObj = evaluation.criteriaScores;
      } else if (evaluation.scores) {
        // Convert Map to object if needed
        if (evaluation.scores instanceof Map) {
          scoresObj = Object.fromEntries(evaluation.scores);
        } else {
          scoresObj = evaluation.scores;
        }
      }
      
      const criteriaTotal = Object.values(scoresObj).reduce(
        (sum, score) => sum + (parseFloat(score) || 0),
        0
      );
      totalScore += criteriaTotal;
    });

    return evaluations.length > 0 ? totalScore / evaluations.length : 0;
  } catch (error) {
    console.error('Error calculating average score:', error);
    return 0;
  }
};

/**
 * Generate location key based on level and submission data
 * @param {String} level - Competition level
 * @param {String} region - Region
 * @param {String} council - Council (optional)
 * @returns {String} Location key
 */
const generateLocationKey = (level, region, council = null) => {
  if (level === 'Council') {
    return `${region || 'unknown'}::${council || 'unknown'}`;
  } else if (level === 'Regional') {
    return region || 'unknown';
  } else {
    return 'national';
  }
};

/**
 * Calculate and update leaderboard for a specific areaOfFocus/year/level/location combination
 * @param {Number} year - Competition year
 * @param {String} areaOfFocus - Area of focus (competition type)
 * @param {String} level - Competition level
 * @param {String} locationKey - Location key (region::council, region, or 'national')
 * @param {Object} options - Options (region, council for querying)
 * @returns {Promise<Object>} Updated leaderboard document
 */
const calculateAndUpdateLeaderboard = async (year, areaOfFocus, level, locationKey, options = {}) => {
  try {
    // Build query for submissions
    const query = {
      year: parseInt(year),
      areaOfFocus,
      level,
      status: { $in: ['submitted', 'evaluated', 'promoted', 'eliminated'] },
      disqualified: { $ne: true }
    };

    // Apply location filters based on level
    if (level === 'Council') {
      const parts = locationKey.split('::');
      query.region = parts[0] || options.region;
      query.council = parts[1] || options.council;
    } else if (level === 'Regional') {
      query.region = locationKey !== 'national' ? locationKey : options.region;
    }
    // National level: no location filter needed

    // Get submissions with populated teacher info
    const submissions = await Submission.find(query)
      .populate('teacherId', 'name email')
      .sort({ averageScore: -1, createdAt: 1 });

    // Calculate/update average scores and get evaluation counts
    const submissionsWithScores = await Promise.all(
      submissions.map(async (sub) => {
        let averageScore = sub.averageScore || 0;
        
        // Get evaluation count
        const evaluationCount = await Evaluation.countDocuments({ submissionId: sub._id });
        
        // If no average score, calculate it
        if (!averageScore || averageScore === 0) {
          averageScore = await calculateAverageScore(sub._id);
          // Update submission if score was calculated
          if (averageScore > 0) {
            await Submission.findByIdAndUpdate(sub._id, { averageScore });
          }
        }

        return {
          ...sub.toObject(),
          averageScore,
          evaluationCount
        };
      })
    );

    // Filter out submissions with no scores (not yet evaluated)
    const evaluatedSubmissions = submissionsWithScores.filter(
      sub => sub.averageScore > 0 || sub.status === 'evaluated' || sub.status === 'promoted' || sub.status === 'eliminated'
    );

    // Sort by average score descending, then by creation date ascending (for tie-breaking)
    evaluatedSubmissions.sort((a, b) => {
      if (b.averageScore !== a.averageScore) {
        return (b.averageScore || 0) - (a.averageScore || 0);
      }
      return new Date(a.createdAt) - new Date(b.createdAt);
    });

    // Create leaderboard entries
    const entries = evaluatedSubmissions.map((sub, index) => ({
      submissionId: sub._id,
      teacherId: sub.teacherId?._id || sub.teacherId,
      teacherName: sub.teacherId?.name || sub.teacherName,
      teacherEmail: sub.teacherId?.email || '',
      school: sub.school,
      region: sub.region,
      council: sub.council,
      category: sub.category,
      class: sub.class,
      subject: sub.subject,
      areaOfFocus: sub.areaOfFocus,
      rank: index + 1,
      averageScore: sub.averageScore || 0,
      totalEvaluations: sub.evaluationCount || 0,
      status: sub.status === 'promoted' ? 'promoted' : sub.status === 'eliminated' ? 'eliminated' : 'evaluated'
    }));

    // Get quota for this level
    const quotaDoc = await Quota.findOne({ year: parseInt(year), level });
    const quota = quotaDoc ? quotaDoc.quota : 0;

    // Upsert leaderboard document
    const leaderboard = await Leaderboard.findOneAndUpdate(
      { year: parseInt(year), areaOfFocus, level, locationKey },
      {
        entries,
        lastUpdated: new Date(),
        totalSubmissions: entries.length,
        quota
      },
      { new: true, upsert: true, runValidators: true }
    );

    return leaderboard;
  } catch (error) {
    console.error('Error calculating and updating leaderboard:', error);
    throw error;
  }
};

/**
 * Get leaderboard for a specific areaOfFocus/year/level/location combination
 * @param {Number} year - Competition year
 * @param {String} areaOfFocus - Area of focus
 * @param {String} level - Competition level
 * @param {String} locationKey - Location key
 * @param {Boolean} forceRecalculate - Force recalculation even if leaderboard exists
 * @returns {Promise<Object>} Leaderboard document
 */
const getLeaderboard = async (year, areaOfFocus, level, locationKey, forceRecalculate = false) => {
  try {
    let leaderboard = await Leaderboard.findOne({
      year: parseInt(year),
      areaOfFocus,
      level,
      locationKey
    });

    if (!leaderboard || forceRecalculate) {
      // Calculate and update leaderboard
      const parts = locationKey.split('::');
      leaderboard = await calculateAndUpdateLeaderboard(
        year,
        areaOfFocus,
        level,
        locationKey,
        {
          region: parts[0],
          council: parts[1]
        }
      );
    }

    return leaderboard;
  } catch (error) {
    console.error('Error getting leaderboard:', error);
    throw error;
  }
};

/**
 * Get all leaderboards matching filters
 * @param {Object} filters - Filters (year, areaOfFocus, level, region, council)
 * @returns {Promise<Array>} Array of leaderboard documents
 */
const getLeaderboards = async (filters = {}) => {
  try {
    const query = {};
    
    if (filters.year) query.year = parseInt(filters.year);
    if (filters.areaOfFocus) query.areaOfFocus = filters.areaOfFocus;
    if (filters.level) query.level = filters.level;
    if (filters.locationKey) query.locationKey = filters.locationKey;
    if (filters.isFinalized !== undefined) query.isFinalized = filters.isFinalized;

    // If region/council provided, build locationKey filter
    if (filters.region || filters.council) {
      if (filters.level === 'Council' && filters.region && filters.council) {
        query.locationKey = `${filters.region}::${filters.council}`;
      } else if (filters.level === 'Regional' && filters.region) {
        query.locationKey = filters.region;
      }
    }

    const leaderboards = await Leaderboard.find(query)
      .sort({ year: -1, level: 1, locationKey: 1 });

    return leaderboards;
  } catch (error) {
    console.error('Error getting leaderboards:', error);
    throw error;
  }
};

/**
 * Get all available locations for a year, level, and areaOfFocus
 * @param {Number} year - Competition year
 * @param {String} level - Competition level
 * @param {String} areaOfFocus - Area of focus
 * @returns {Promise<Array>} Array of location keys
 */
const getAvailableLocations = async (year, level, areaOfFocus = null) => {
  try {
    const matchStage = {
      year: parseInt(year),
      level,
      status: { $in: ['submitted', 'evaluated', 'promoted', 'eliminated'] },
      disqualified: { $ne: true }
    };

    if (areaOfFocus) {
      matchStage.areaOfFocus = areaOfFocus;
    }

    const groupId = level === 'Council'
      ? { region: '$region', council: '$council' }
      : level === 'Regional'
        ? { region: '$region' }
        : { national: 'national' };

    const locations = await Submission.aggregate([
      { $match: matchStage },
      { $group: { _id: groupId } }
    ]);

    return locations.map(loc => {
      if (level === 'Council') {
        const r = loc._id.region || 'unknown';
        const c = loc._id.council || 'unknown';
        return `${r}::${c}`;
      }
      if (level === 'Regional') {
        return loc._id.region || 'unknown';
      }
      return 'national';
    });
  } catch (error) {
    console.error('Error getting available locations:', error);
    return [];
  }
};

/**
 * Update leaderboard when a submission's score changes
 * @param {String} submissionId - Submission ID
 * @returns {Promise<void>}
 */
const updateLeaderboardForSubmission = async (submissionId) => {
  try {
    const submission = await Submission.findById(submissionId)
      .populate('teacherId', 'name email');
    
    if (!submission) return;

    const locationKey = generateLocationKey(submission.level, submission.region, submission.council);
    
    // Recalculate and update the leaderboard
    await calculateAndUpdateLeaderboard(
      submission.year,
      submission.areaOfFocus,
      submission.level,
      locationKey,
      {
        region: submission.region,
        council: submission.council
      }
    );
  } catch (error) {
    console.error('Error updating leaderboard for submission:', error);
    // Don't throw - this is a background update
  }
};

module.exports = {
  calculateAverageScore,
  generateLocationKey,
  calculateAndUpdateLeaderboard,
  getLeaderboard,
  getLeaderboards,
  getAvailableLocations,
  updateLeaderboardForSubmission
};

