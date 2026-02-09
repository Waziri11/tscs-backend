const mongoose = require('mongoose');
const Submission = require('../models/Submission');
const Quota = require('../models/Quota');
const Evaluation = require('../models/Evaluation');
const User = require('../models/User');
const SubmissionAssignment = require('../models/SubmissionAssignment');
const Leaderboard = require('../models/Leaderboard');
const { getLeaderboard, generateLocationKey, updateLeaderboardForSubmission } = require('./leaderboardUtils');
const { assignJudgeToSubmission } = require('./judgeAssignment');
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
 * Advance submissions to next level for a specific areaOfFocus and location
 * @param {Number} year - Competition year
 * @param {String} areaOfFocus - Area of focus (competition type)
 * @param {String} level - Current level
 * @param {String} locationKey - Location key (region::council, region, or 'national')
 * @returns {Promise<Object>} Result with promoted and eliminated counts
 */
const advanceSubmissionsForLocation = async (year, areaOfFocus, level, locationKey) => {
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

    // Get leaderboard for this areaOfFocus/year/level/location
    const leaderboardDoc = await getLeaderboard(year, areaOfFocus, level, locationKey);
    
    if (!leaderboardDoc || leaderboardDoc.entries.length === 0) {
      return {
        success: false,
        error: 'No submissions found for this location and area of focus'
      };
    }

    // Filter out already promoted or eliminated submissions
    const eligibleEntries = leaderboardDoc.entries.filter(
      entry => entry.status !== 'promoted' && entry.status !== 'eliminated'
    );

    if (eligibleEntries.length === 0) {
      return {
        success: false,
        error: 'No eligible submissions to advance (all already processed)'
      };
    }

    // Sort by rank (already sorted in leaderboard)
    const toPromote = eligibleEntries.length <= quota ? eligibleEntries : eligibleEntries.slice(0, quota);
    const toEliminate = eligibleEntries.length <= quota ? [] : eligibleEntries.slice(quota);

    const promotedIds = toPromote.map(e => e.submissionId.toString());
    const eliminatedIds = toEliminate.map(e => e.submissionId.toString());

    // Build leaderboard data for notifications
    const leaderboard = [
      ...toPromote.map(entry => ({
        submissionId: entry.submissionId.toString(),
        teacherId: entry.teacherId.toString(),
        rank: entry.rank,
        averageScore: entry.averageScore,
        totalSubmissions: eligibleEntries.length,
        locationKey,
        areaOfFocus,
        status: 'promoted',
        newLevel: nextLevel
      })),
      ...toEliminate.map(entry => ({
        submissionId: entry.submissionId.toString(),
        teacherId: entry.teacherId.toString(),
        rank: entry.rank,
        averageScore: entry.averageScore,
        totalSubmissions: eligibleEntries.length,
        locationKey,
        areaOfFocus,
        status: 'eliminated'
      }))
    ];

    // Perform DB updates atomically
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        if (promotedIds.length > 0) {
          // Update submissions to next level
          await Submission.bulkWrite(
            promotedIds.map(id => ({
              updateOne: {
                filter: { _id: id },
                update: { $set: { level: nextLevel, status: 'promoted' } }
              }
            })),
            { session }
          );

          // Auto-assign promoted submissions to regional judges (Council → Regional only)
          if (level === 'Council' && nextLevel === 'Regional') {
            const promotedSubmissions = await Submission.find({ _id: { $in: promotedIds } })
              .session(session);
            
            for (const submission of promotedSubmissions) {
              // Auto-assign to regional judge using round-robin
              await assignJudgeToSubmission(submission).catch(err => {
                console.error(`Error assigning judge to submission ${submission._id}:`, err);
                // Continue with other assignments even if one fails
              });
            }
          }
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

    // Update leaderboard entries to reflect new statuses
    if (promotedIds.length > 0 || eliminatedIds.length > 0) {
      // Update leaderboard entries status using arrayFilters
      const promotedObjectIds = promotedIds.map(id => new mongoose.Types.ObjectId(id));
      const eliminatedObjectIds = eliminatedIds.map(id => new mongoose.Types.ObjectId(id));

      if (promotedObjectIds.length > 0) {
        await Leaderboard.updateOne(
          { _id: leaderboardDoc._id },
          { 
            $set: { 
              'entries.$[elem].status': 'promoted',
              lastUpdated: new Date()
            }
          },
          { 
            arrayFilters: [{ 'elem.submissionId': { $in: promotedObjectIds } }] 
          }
        );
      }
      if (eliminatedObjectIds.length > 0) {
        await Leaderboard.updateOne(
          { _id: leaderboardDoc._id },
          { 
            $set: { 
              'entries.$[elem].status': 'eliminated',
              lastUpdated: new Date()
            }
          },
          { 
            arrayFilters: [{ 'elem.submissionId': { $in: eliminatedObjectIds } }] 
          }
        );
      }

      // Update leaderboards at next level for promoted submissions
      for (const entry of toPromote) {
        const submission = await Submission.findById(entry.submissionId);
        if (submission) {
          await updateLeaderboardForSubmission(submission._id);
        }
      }
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
      locationKey,
      areaOfFocus,
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
 * Advance submissions to next level for all locations for a specific areaOfFocus (global)
 * @param {Number} year - Competition year
 * @param {String} areaOfFocus - Area of focus
 * @param {String} level - Current level
 * @returns {Promise<Object>} Result with promoted and eliminated counts per location
 */
const advanceSubmissionsGlobal = async (year, areaOfFocus, level) => {
  try {
    const nextLevel = getNextLevel(level);
    if (!nextLevel) {
      return {
        success: false,
        error: 'Already at top level (National). Cannot advance further.'
      };
    }

    // Get all leaderboards for this year, areaOfFocus, and level
    const leaderboards = await Leaderboard.find({
      year: parseInt(year),
      areaOfFocus,
      level
    });

    if (leaderboards.length === 0) {
      return {
        success: false,
        error: 'No leaderboards found for this area of focus and level'
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

    for (const leaderboard of leaderboards) {
      const locationResult = await advanceSubmissionsForLocation(
        year,
        areaOfFocus,
        level,
        leaderboard.locationKey
      );
      
      if (locationResult.success) {
        results.totalPromoted += locationResult.promoted;
        results.totalEliminated += locationResult.eliminated;
        results.allPromotedIds.push(...locationResult.promotedIds);
        results.allEliminatedIds.push(...locationResult.eliminatedIds);
        results.locationResults[leaderboard.locationKey] = {
          promoted: locationResult.promoted,
          eliminated: locationResult.eliminated
        };
      } else {
        results.locationResults[leaderboard.locationKey] = {
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

