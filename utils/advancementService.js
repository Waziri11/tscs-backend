const Submission = require('../models/Submission');
const Quota = require('../models/Quota');
const { calculateLeaderboard, getLeaderboardByLocation } = require('./leaderboardUtils');
const { notifyTeachersOnPromotion, notifyTeachersOnElimination } = require('./notifications');

/**
 * Get next level from current level
 * @param {String} level - Current level
 * @returns {String|null} Next level or null if at top level
 */
const getNextLevel = (level) => {
  const levelMap = {
    'Council': 'Regional',
    'Regional': 'National',
    'National': null
  };
  return levelMap[level] || null;
};

/**
 * Advance submissions to next level for a specific location
 * @param {Number} year - Competition year
 * @param {String} level - Current level
 * @param {String} location - Location key (region::council, region, or 'national')
 * @returns {Promise<Object>} Result with promoted and eliminated counts
 */
const advanceSubmissionsForLocation = async (year, level, location) => {
  try {
    const nextLevel = getNextLevel(level);
    if (!nextLevel) {
      return {
        success: false,
        error: 'Already at top level (National). Cannot advance further.'
      };
    }

    // Get quota for current level
    const quotaDoc = await Quota.findOne({ year: parseInt(year), level });
    if (!quotaDoc) {
      return {
        success: false,
        error: `No quota set for ${level} level in year ${year}. Please set quota before advancing.`
      };
    }
    const quota = quotaDoc.quota;

    // Get leaderboard entries for this location
    const leaderboardEntries = await getLeaderboardByLocation(year, level, location);
    
    if (leaderboardEntries.length === 0) {
      return {
        success: false,
        error: 'No submissions found for this location'
      };
    }

    // Filter out already promoted or eliminated submissions
    const eligibleSubmissions = leaderboardEntries.filter(
      entry => entry.status !== 'promoted' && entry.status !== 'eliminated'
    );

    if (eligibleSubmissions.length === 0) {
      return {
        success: false,
        error: 'No eligible submissions to advance (all already processed)'
      };
    }

    // Sort by average score descending (already sorted in leaderboard, but ensure)
    eligibleSubmissions.sort((a, b) => {
      if (b.averageScore !== a.averageScore) {
        return (b.averageScore || 0) - (a.averageScore || 0);
      }
      return new Date(a.createdAt) - new Date(b.createdAt);
    });

    // Determine which submissions to promote and eliminate
    const toPromote = [];
    const toEliminate = [];

    if (eligibleSubmissions.length <= quota) {
      // All advance if within quota
      toPromote.push(...eligibleSubmissions);
    } else {
      // Top N advance, rest eliminated
      toPromote.push(...eligibleSubmissions.slice(0, quota));
      toEliminate.push(...eligibleSubmissions.slice(quota));
    }

    // Update submissions
    const promotedIds = [];
    const eliminatedIds = [];
    const leaderboard = [];

    for (const entry of toPromote) {
      await Submission.findByIdAndUpdate(entry._id, {
        level: nextLevel,
        status: 'promoted'
      });
      promotedIds.push(entry._id.toString());
      
      leaderboard.push({
        submissionId: entry._id.toString(),
        teacherId: entry.teacherId?._id?.toString() || entry.teacherId?.toString(),
        rank: entry.rank,
        averageScore: entry.averageScore || 0,
        totalSubmissions: entry.totalSubmissions,
        locationKey: location,
        status: 'promoted',
        newLevel: nextLevel
      });
    }

    for (const entry of toEliminate) {
      await Submission.findByIdAndUpdate(entry._id, {
        status: 'eliminated'
      });
      eliminatedIds.push(entry._id.toString());
      
      leaderboard.push({
        submissionId: entry._id.toString(),
        teacherId: entry.teacherId?._id?.toString() || entry.teacherId?.toString(),
        rank: entry.rank,
        averageScore: entry.averageScore || 0,
        totalSubmissions: entry.totalSubmissions,
        locationKey: location,
        status: 'eliminated'
      });
    }

    // Send notifications
    if (promotedIds.length > 0) {
      await notifyTeachersOnPromotion(promotedIds, nextLevel, leaderboard);
    }
    if (eliminatedIds.length > 0) {
      await notifyTeachersOnElimination(eliminatedIds, leaderboard);
    }

    return {
      success: true,
      promoted: promotedIds.length,
      eliminated: eliminatedIds.length,
      promotedIds,
      eliminatedIds,
      leaderboard,
      location,
      quota
    };
  } catch (error) {
    console.error('Error advancing submissions for location:', error);
    return {
      success: false,
      error: error.message || 'Failed to advance submissions'
    };
  }
};

/**
 * Advance submissions to next level for all locations (global)
 * @param {Number} year - Competition year
 * @param {String} level - Current level
 * @returns {Promise<Object>} Result with promoted and eliminated counts per location
 */
const advanceSubmissionsGlobal = async (year, level) => {
  try {
    const nextLevel = getNextLevel(level);
    if (!nextLevel) {
      return {
        success: false,
        error: 'Already at top level (National). Cannot advance further.'
      };
    }

    // Get all leaderboard data for this year and level
    const leaderboard = await calculateLeaderboard(year, level);
    const locations = Object.keys(leaderboard);

    if (locations.length === 0) {
      return {
        success: false,
        error: 'No submissions found for this level'
      };
    }

    // Advance each location
    const results = {
      success: true,
      totalPromoted: 0,
      totalEliminated: 0,
      locationResults: {},
      allPromotedIds: [],
      allEliminatedIds: []
    };

    for (const location of locations) {
      const locationResult = await advanceSubmissionsForLocation(year, level, location);
      
      if (locationResult.success) {
        results.totalPromoted += locationResult.promoted;
        results.totalEliminated += locationResult.eliminated;
        results.allPromotedIds.push(...locationResult.promotedIds);
        results.allEliminatedIds.push(...locationResult.eliminatedIds);
        results.locationResults[location] = {
          promoted: locationResult.promoted,
          eliminated: locationResult.eliminated
        };
      } else {
        results.locationResults[location] = {
          error: locationResult.error
        };
      }
    }

    return results;
  } catch (error) {
    console.error('Error advancing submissions globally:', error);
    return {
      success: false,
      error: error.message || 'Failed to advance submissions globally'
    };
  }
};

module.exports = {
  getNextLevel,
  advanceSubmissionsForLocation,
  advanceSubmissionsGlobal
};

