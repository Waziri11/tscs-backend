const mongoose = require('mongoose');
const Submission = require('../models/Submission');
const CompetitionRound = require('../models/CompetitionRound');
const Evaluation = require('../models/Evaluation');

/**
 * Get all submission IDs that were tracked in any round's snapshot for a given year and level
 * @param {Number} year - Competition year
 * @param {String} level - Competition level (Council, Regional, National)
 * @returns {Promise<Array>} Array of submission IDs
 */
const getTrackedSubmissionIds = async (year, level) => {
  try {
    // Find all rounds for this year and level that have snapshots
    const rounds = await CompetitionRound.find({
      year: parseInt(year),
      level,
      pendingSubmissionsSnapshot: { $exists: true, $ne: [] }
    }).select('pendingSubmissionsSnapshot');

    // Collect all unique submission IDs from all rounds
    const allSubmissionIds = new Set();
    rounds.forEach(round => {
      round.pendingSubmissionsSnapshot.forEach(subId => {
        allSubmissionIds.add(subId.toString());
      });
    });

    return Array.from(allSubmissionIds);
  } catch (error) {
    console.error('Error getting tracked submission IDs:', error);
    return [];
  }
};

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
 * Group submissions by location based on level
 * @param {Array} submissions - Array of submission objects
 * @param {String} level - Competition level
 * @param {Boolean} includeAreaOfFocus - If true, also groups by areaOfFocus at Council level
 * @returns {Object} Object with location keys and submission arrays
 */
const groupByLocation = (submissions, level, includeAreaOfFocus = false) => {
  const groups = {};

  submissions.forEach(sub => {
    let locationKey;
    
    if (level === 'Council') {
      // Group by region::council, optionally also by areaOfFocus for advancement
      locationKey = `${sub.region || 'unknown'}::${sub.council || 'unknown'}`;
      if (includeAreaOfFocus && sub.areaOfFocus) {
        locationKey += `::${sub.areaOfFocus}`;
      }
    } else if (level === 'Regional') {
      // Group by region
      locationKey = sub.region || 'unknown';
    } else {
      // National level: single group
      locationKey = 'national';
    }

    if (!groups[locationKey]) {
      groups[locationKey] = [];
    }
    groups[locationKey].push(sub);
  });

  return groups;
};

/**
 * Calculate leaderboard for a given year and level
 * @param {Number} year - Competition year
 * @param {String} level - Competition level
 * @param {Object} filters - Optional filters (region, council)
 * @returns {Promise<Object>} Leaderboard data grouped by location
 */
const calculateLeaderboard = async (year, level, filters = {}) => {
  try {
    // Get all tracked submission IDs for this year and level
    const trackedIds = await getTrackedSubmissionIds(year, level);

    if (trackedIds.length === 0) {
      return {};
    }

    // Build query for submissions
    const query = {
      _id: { $in: trackedIds },
      year: parseInt(year),
      level
    };

    // Apply location filters if provided
    if (filters.region) query.region = filters.region;
    if (filters.council) query.council = filters.council;
    if (filters.areaOfFocus) query.areaOfFocus = filters.areaOfFocus;

    // Get submissions with populated teacher info
    const submissions = await Submission.find(query)
      .populate('teacherId', 'name email')
      .sort({ averageScore: -1, createdAt: 1 });

    // Calculate/update average scores for submissions that don't have them
    const submissionsWithScores = await Promise.all(
      submissions.map(async (sub) => {
        let averageScore = sub.averageScore || 0;
        
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
          averageScore
        };
      })
    );

    // Filter out submissions with no scores (not yet evaluated)
    const evaluatedSubmissions = submissionsWithScores.filter(
      sub => sub.averageScore > 0 || sub.status === 'evaluated' || sub.status === 'promoted' || sub.status === 'eliminated'
    );

    // Group by location (Council level includes areaOfFocus for per-area advancement)
    const locationGroups = groupByLocation(evaluatedSubmissions, level, level === 'Council');

    // Rank submissions within each location group
    const leaderboard = {};
    
    Object.keys(locationGroups).forEach(locationKey => {
      const locationSubs = locationGroups[locationKey];
      
      // Sort by average score descending, then by creation date ascending (for tie-breaking)
      locationSubs.sort((a, b) => {
        if (b.averageScore !== a.averageScore) {
          return (b.averageScore || 0) - (a.averageScore || 0);
        }
        return new Date(a.createdAt) - new Date(b.createdAt);
      });

      // Add rank to each submission
      leaderboard[locationKey] = locationSubs.map((sub, index) => ({
        ...sub,
        rank: index + 1,
        totalSubmissions: locationSubs.length,
        locationKey
      }));
    });

    return leaderboard;
  } catch (error) {
    console.error('Error calculating leaderboard:', error);
    throw error;
  }
};

/**
 * Get leaderboard for a specific location
 * @param {Number} year - Competition year
 * @param {String} level - Competition level
 * @param {String} location - Location key (region::council, region, or 'national')
 * @returns {Promise<Array>} Array of leaderboard entries
 */
const getLeaderboardByLocation = async (year, level, location) => {
  try {
    const filters = {};
    
    if (level === 'Council' && location !== 'national') {
      const parts = location.split('::');
      filters.region = parts[0];
      filters.council = parts[1];
      if (parts[2]) filters.areaOfFocus = parts[2];
    } else if (level === 'Regional' && location !== 'national') {
      filters.region = location;
    }

    const leaderboard = await calculateLeaderboard(year, level, filters);
    return leaderboard[location] || [];
  } catch (error) {
    console.error('Error getting leaderboard by location:', error);
    throw error;
  }
};

/**
 * Get all available locations for a year and level
 * @param {Number} year - Competition year
 * @param {String} level - Competition level
 * @returns {Promise<Array>} Array of location keys
 */
const getAvailableLocations = async (year, level) => {
  try {
    const trackedIds = await getTrackedSubmissionIds(year, level);
    if (trackedIds.length === 0) return [];

    const matchIds = trackedIds.map(id => new mongoose.Types.ObjectId(id));
    const matchStage = {
      _id: { $in: matchIds },
      year: parseInt(year),
      level
    };

    const groupId = level === 'Council'
      ? { region: '$region', council: '$council', areaOfFocus: '$areaOfFocus' }
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
        const a = loc._id.areaOfFocus || 'unknown';
        return `${r}::${c}::${a}`;
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

module.exports = {
  getTrackedSubmissionIds,
  calculateAverageScore,
  groupByLocation,
  calculateLeaderboard,
  getLeaderboardByLocation,
  getAvailableLocations
};

