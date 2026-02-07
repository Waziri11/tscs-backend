const mongoose = require('mongoose');
const Submission = require('../models/Submission');
const Quota = require('../models/Quota');
const Evaluation = require('../models/Evaluation');
const User = require('../models/User');
const SubmissionAssignment = require('../models/SubmissionAssignment');
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

    // At Council level, group by areaOfFocus so each area gets its own quota
    const promotedIds = [];
    const eliminatedIds = [];
    const leaderboard = [];

    if (level === 'Council') {
      // Group by areaOfFocus within this location
      const areaGroups = {};
      eligibleSubmissions.forEach(entry => {
        const areaKey = entry.areaOfFocus || 'unknown';
        if (!areaGroups[areaKey]) areaGroups[areaKey] = [];
        areaGroups[areaKey].push(entry);
      });

      // Apply quota per area
      for (const [areaKey, areaSubs] of Object.entries(areaGroups)) {
        areaSubs.sort((a, b) => {
          if (b.averageScore !== a.averageScore) return (b.averageScore || 0) - (a.averageScore || 0);
          return new Date(a.createdAt) - new Date(b.createdAt);
        });

        const toPromote = areaSubs.length <= quota ? areaSubs : areaSubs.slice(0, quota);
        const toEliminate = areaSubs.length <= quota ? [] : areaSubs.slice(quota);

        for (const entry of toPromote) {
          promotedIds.push(entry._id.toString());
          leaderboard.push({
            submissionId: entry._id.toString(),
            teacherId: entry.teacherId?._id?.toString() || entry.teacherId?.toString(),
            rank: entry.rank,
            averageScore: entry.averageScore || 0,
            totalSubmissions: areaSubs.length,
            locationKey: location,
            areaOfFocus: areaKey,
            status: 'promoted',
            newLevel: nextLevel
          });
        }
        for (const entry of toEliminate) {
          eliminatedIds.push(entry._id.toString());
          leaderboard.push({
            submissionId: entry._id.toString(),
            teacherId: entry.teacherId?._id?.toString() || entry.teacherId?.toString(),
            rank: entry.rank,
            averageScore: entry.averageScore || 0,
            totalSubmissions: areaSubs.length,
            locationKey: location,
            areaOfFocus: areaKey,
            status: 'eliminated'
          });
        }
      }
    } else {
      // Regional/National: no area grouping, just sort and apply quota
      eligibleSubmissions.sort((a, b) => {
        if (b.averageScore !== a.averageScore) return (b.averageScore || 0) - (a.averageScore || 0);
        return new Date(a.createdAt) - new Date(b.createdAt);
      });

      const toPromote = eligibleSubmissions.length <= quota ? eligibleSubmissions : eligibleSubmissions.slice(0, quota);
      const toEliminate = eligibleSubmissions.length <= quota ? [] : eligibleSubmissions.slice(quota);

      for (const entry of toPromote) {
        promotedIds.push(entry._id.toString());
        leaderboard.push({
          submissionId: entry._id.toString(),
          teacherId: entry.teacherId?._id?.toString() || entry.teacherId?.toString(),
          rank: entry.rank,
          averageScore: entry.averageScore || 0,
          totalSubmissions: eligibleSubmissions.length,
          locationKey: location,
          status: 'promoted',
          newLevel: nextLevel
        });
      }
      for (const entry of toEliminate) {
        eliminatedIds.push(entry._id.toString());
        leaderboard.push({
          submissionId: entry._id.toString(),
          teacherId: entry.teacherId?._id?.toString() || entry.teacherId?.toString(),
          rank: entry.rank,
          averageScore: entry.averageScore || 0,
          totalSubmissions: eligibleSubmissions.length,
          locationKey: location,
          status: 'eliminated'
        });
      }
    }

    // Perform DB updates atomically
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        if (promotedIds.length > 0) {
          await Submission.bulkWrite(
            promotedIds.map(id => ({
              updateOne: {
                filter: { _id: id },
                update: { $set: { level: nextLevel, status: 'promoted' } }
              }
            })),
            { session }
          );
        }
        if (eliminatedIds.length > 0) {
          await Submission.bulkWrite(
            eliminatedIds.map(id => ({
              updateOne: {
                filter: { _id: id },
                update: { $set: { status: 'eliminated' } }
              }
            })),
            { session }
          );
        }
      });
    } finally {
      session.endSession();
    }

    // Send notifications
    if (promotedIds.length > 0) {
      notifyTeachersOnPromotion(promotedIds, nextLevel, leaderboard).catch(err =>
        console.error('Error sending promotion notifications:', err)
      );
    }
    if (eliminatedIds.length > 0) {
      notifyTeachersOnElimination(eliminatedIds, leaderboard).catch(err =>
        console.error('Error sending elimination notifications:', err)
      );
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

/**
 * Check if all judges have completed evaluations for a round
 * @param {String} level
 * @param {Number} year
 * @param {String|null} region
 * @param {String|null} council
 * @returns {Promise<Object>}
 */
const checkAllJudgesCompleted = async (level, year, region = null, council = null) => {
  try {
    const submissionQuery = {
      level,
      year: parseInt(year),
      status: { $in: ['submitted', 'evaluated'] }
    };
    if (region) submissionQuery.region = region;
    if (council) submissionQuery.council = council;

    const submissions = await Submission.find(submissionQuery);
    if (submissions.length === 0) return { allCompleted: true, pendingCount: 0 };

    const judgeQuery = { role: 'judge', assignedLevel: level, status: 'active' };
    if (region && council) {
      judgeQuery.assignedRegion = region;
      judgeQuery.assignedCouncil = council;
    } else if (region) {
      judgeQuery.assignedRegion = region;
    }

    const judges = await User.find(judgeQuery);
    if (judges.length === 0) {
      return { allCompleted: false, pendingCount: submissions.length, reason: 'No judges assigned' };
    }

    const submissionIds = submissions.map(s => s._id);
    const evaluationGroups = await Evaluation.aggregate([
      { $match: { submissionId: { $in: submissionIds } } },
      { $group: { _id: '$submissionId', judgeIds: { $addToSet: '$judgeId' } } }
    ]);

    const evaluationMap = new Map(
      evaluationGroups.map(group => [
        group._id.toString(),
        group.judgeIds.map(id => id.toString())
      ])
    );

    let assignmentMap = new Map();
    if (level === 'Council' || level === 'Regional') {
      const assignments = await SubmissionAssignment.find({ submissionId: { $in: submissionIds } })
        .select('submissionId judgeId');
      assignmentMap = new Map(
        assignments.map(a => [a.submissionId.toString(), a.judgeId.toString()])
      );
    }

    let pendingCount = 0;
    const judgeIds = judges.map(j => j._id.toString());

    for (const submission of submissions) {
      const evaluatedJudgeIds = evaluationMap.get(submission._id.toString()) || [];

      if (level === 'Council' || level === 'Regional') {
        const assignedJudgeId = assignmentMap.get(submission._id.toString());
        if (!assignedJudgeId || !evaluatedJudgeIds.includes(assignedJudgeId)) {
          pendingCount++;
        }
      } else {
        const allJudgesEvaluated = judgeIds.every(id => evaluatedJudgeIds.includes(id));
        if (!allJudgesEvaluated) {
          pendingCount++;
        }
      }
    }

    return {
      allCompleted: pendingCount === 0,
      pendingCount,
      totalSubmissions: submissions.length,
      totalJudges: judges.length
    };
  } catch (error) {
    console.error('Error checking judge completion:', error);
    return { allCompleted: false, pendingCount: -1, error: error.message };
  }
};

/**
 * Advance submissions for a round (used by round scheduler)
 * @param {String} level
 * @param {Number} year
 * @param {String|null} region
 * @param {String|null} council
 * @param {String|null} roundId
 * @returns {Promise<Object>}
 */
const advanceSubmissionsForRound = async (level, year, region = null, council = null, roundId = null) => {
  try {
    const nextLevel = getNextLevel(level);
    if (!nextLevel) {
      return { success: false, error: 'Already at top level' };
    }

    const query = {
      level,
      year: parseInt(year),
      status: { $in: ['submitted', 'evaluated'] }
    };
    if (region) query.region = region;
    if (council) query.council = council;

    const submissions = await Submission.find(query)
      .populate('teacherId', 'name email')
      .sort({ averageScore: -1 });

    if (submissions.length === 0) {
      return { success: false, error: 'No submissions found' };
    }

    const quotaDoc = await Quota.findOne({ year: parseInt(year), level });
    const quota = quotaDoc ? quotaDoc.quota : 0;

    // Group submissions by location (Council includes areaOfFocus)
    const groups = {};
    submissions.forEach(sub => {
      let locationKey;
      if (level === 'Council') {
        locationKey = `${sub.region || 'unknown'}::${sub.council || 'unknown'}`;
        if (sub.areaOfFocus) {
          locationKey += `::${sub.areaOfFocus}`;
        }
      } else if (level === 'Regional') {
        locationKey = sub.region || 'unknown';
      } else {
        locationKey = 'national';
      }
      if (!groups[locationKey]) groups[locationKey] = [];
      groups[locationKey].push(sub);
    });

    const toPromote = [];
    const toEliminate = [];
    const leaderboard = [];

    Object.keys(groups).forEach(locationKey => {
      const locationSubs = groups[locationKey].sort((a, b) =>
        (b.averageScore || 0) - (a.averageScore || 0)
      );

      locationSubs.forEach((sub, index) => {
        const rank = index + 1;
        const isPromoted = locationSubs.length <= quota || index < quota;
        if (isPromoted) {
          toPromote.push(sub);
        } else {
          toEliminate.push(sub);
        }
        leaderboard.push({
          submissionId: sub._id.toString(),
          teacherId: sub.teacherId?._id?.toString() || sub.teacherId?.toString(),
          rank,
          averageScore: sub.averageScore || 0,
          totalSubmissions: locationSubs.length,
          locationKey,
          status: isPromoted ? 'promoted' : 'eliminated'
        });
      });
    });

    const promotedIds = toPromote.map(sub => sub._id.toString());
    const eliminatedIds = toEliminate.map(sub => sub._id.toString());

    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        if (promotedIds.length > 0) {
          await Submission.bulkWrite(
            promotedIds.map(id => ({
              updateOne: {
                filter: { _id: id },
                update: { 
                  $set: { 
                    level: nextLevel, 
                    status: 'promoted',
                    ...(roundId ? { promotedFromRoundId: roundId } : {})
                  } 
                }
              }
            })),
            { session }
          );
        }
        if (eliminatedIds.length > 0) {
          await Submission.bulkWrite(
            eliminatedIds.map(id => ({
              updateOne: {
                filter: { _id: id },
                update: { $set: { status: 'eliminated' } }
              }
            })),
            { session }
          );
        }
      });
    } finally {
      session.endSession();
    }

    promotedIds.forEach((id) => {
      const lbEntry = leaderboard.find(lb => lb.submissionId === id);
      if (lbEntry) {
        lbEntry.newLevel = nextLevel;
      }
    });

    return {
      success: true,
      promoted: promotedIds.length,
      eliminated: eliminatedIds.length,
      promotedIds,
      eliminatedIds,
      leaderboard
    };
  } catch (error) {
    console.error('Error advancing submissions for round:', error);
    return { success: false, error: error.message };
  }
};

module.exports = {
  getNextLevel,
  advanceSubmissionsForLocation,
  advanceSubmissionsGlobal,
  advanceSubmissionsForRound,
  checkAllJudgesCompleted
};

