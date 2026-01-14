const CompetitionRound = require('../models/CompetitionRound');
const Submission = require('../models/Submission');
const Evaluation = require('../models/Evaluation');
const User = require('../models/User');
const Quota = require('../models/Quota');

// Safely import logger
let logger = null;
try {
  const loggerModule = require('./logger');
  logger = loggerModule.logger;
} catch (error) {
  logger = {
    logSystemEvent: () => Promise.resolve(),
    logError: () => Promise.resolve()
  };
}

// Helper: Get next level
const getNextLevel = (currentLevel) => {
  const levels = ['Council', 'Regional', 'National'];
  const index = levels.indexOf(currentLevel);
  return index >= 0 && index < levels.length - 1 ? levels[index + 1] : null;
};

// Helper: Check if all judges have completed evaluations
const checkAllJudgesCompleted = async (level, year, region = null, council = null) => {
  try {
    const submissionQuery = {
      level,
      year: parseInt(year),
      status: { $in: ['submitted', 'evaluated'] }
    };
    
    // Only add region/council filters if round is not nationwide
    if (region) submissionQuery.region = region;
    if (council) submissionQuery.council = council;

    const submissions = await Submission.find(submissionQuery);
    
    if (submissions.length === 0) return { allCompleted: true, pendingCount: 0 };

    // Get judges assigned to this round's level and location
    const judgeQuery = { role: 'judge', assignedLevel: level, status: 'active' };
    
    // For nationwide rounds, get all judges at that level
    // For specific locations, filter by location
    if (region && council) {
      // Council-level round with specific location
      judgeQuery.assignedRegion = region;
      judgeQuery.assignedCouncil = council;
    } else if (region) {
      // Regional-level round with specific region
      judgeQuery.assignedRegion = region;
    }
    // If no region/council, it's nationwide - get all judges at that level

    const judges = await User.find(judgeQuery);
    
    if (judges.length === 0) {
      return { allCompleted: false, pendingCount: submissions.length, reason: 'No judges assigned' };
    }

    // For Council/Regional: Check if assigned judge evaluated each submission
    // For National: Check if all judges evaluated each submission
    let pendingCount = 0;
    
    for (const submission of submissions) {
      const evaluations = await Evaluation.find({ submissionId: submission._id });
      const evaluatedJudgeIds = evaluations.map(e => e.judgeId.toString());
      
      if (level === 'Council' || level === 'Regional') {
        // 1-to-1 judging: Check if assigned judge evaluated
        const SubmissionAssignment = require('../models/SubmissionAssignment');
        const assignment = await SubmissionAssignment.findOne({ submissionId: submission._id });
        
        if (!assignment) {
          pendingCount++;
          continue;
        }
        
        const assignedJudgeEvaluated = evaluatedJudgeIds.includes(assignment.judgeId.toString());
        if (!assignedJudgeEvaluated) {
          pendingCount++;
        }
      } else {
        // National level: All judges must evaluate
        const allJudgesEvaluated = judges.every(judge => 
          evaluatedJudgeIds.includes(judge._id.toString())
        );
        
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

// Helper: Advance submissions to next level
const advanceSubmissions = async (level, year, region = null, council = null) => {
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
    
    // Only add region/council filters if round is not nationwide
    // If region/council are null, query all submissions at that level (nationwide)
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

    // Group submissions by location for quota application
    const groups = {};
    submissions.forEach(sub => {
      let locationKey;
      if (level === 'Council') {
        // Group by region and council
        locationKey = `${sub.region || 'unknown'}::${sub.council || 'unknown'}`;
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

    const toPromote = [];
    const toEliminate = [];
    const leaderboard = [];

    // Process each location group based on quota and build leaderboard per location
    Object.keys(groups).forEach(locationKey => {
      const locationSubs = groups[locationKey].sort((a, b) => 
        (b.averageScore || 0) - (a.averageScore || 0)
      );

      // Build leaderboard for this location group
      locationSubs.forEach((sub, index) => {
        const rank = index + 1;
        const isPromoted = locationSubs.length <= quota || index < quota;
        
        if (isPromoted) {
          toPromote.push(sub);
        } else {
          toEliminate.push(sub);
        }
        
        // Add to leaderboard with position within location group
        leaderboard.push({
          submissionId: sub._id.toString(),
          teacherId: sub.teacherId?._id?.toString() || sub.teacherId?.toString(),
          rank: rank,
          averageScore: sub.averageScore || 0,
          totalSubmissions: locationSubs.length,
          locationKey: locationKey,
          status: isPromoted ? 'promoted' : 'eliminated'
        });
      });
    });

    const promotedIds = [];
    const eliminatedIds = [];

    for (const sub of toPromote) {
      await Submission.findByIdAndUpdate(sub._id, {
        level: nextLevel,
        status: 'approved'
      });
      promotedIds.push(sub._id.toString());
      
      // Update leaderboard entry with new level
      const lbEntry = leaderboard.find(lb => lb.submissionId === sub._id.toString());
      if (lbEntry) {
        lbEntry.newLevel = nextLevel;
      }
    }

    for (const sub of toEliminate) {
      await Submission.findByIdAndUpdate(sub._id, {
        status: 'eliminated'
      });
      eliminatedIds.push(sub._id.toString());
    }

    return {
      success: true,
      promoted: promotedIds.length,
      eliminated: eliminatedIds.length,
      promotedIds,
      eliminatedIds,
      leaderboard
    };
  } catch (error) {
    console.error('Error advancing submissions:', error);
    return { success: false, error: error.message };
  }
};

// Check and process rounds that should end
const checkAndProcessRounds = async () => {
  try {
    // Check if MongoDB is connected before running queries
    const mongoose = require('mongoose');
    if (mongoose.connection.readyState !== 1) {
      // Connection not ready, skip this check
      if (process.env.NODE_ENV === 'development') {
        console.log('MongoDB not connected, skipping round check');
      }
      return;
    }

    const now = new Date();
    
    // Find active rounds that should end
    const activeRounds = await CompetitionRound.find({
      status: 'active'
    });

    for (const round of activeRounds) {
      const actualEndTime = round.getActualEndTime();
      
      if (now >= actualEndTime) {
        console.log(`[Round Scheduler] Round ${round._id} (${round.level}) has ended`);
        
        // Check if we should wait for all judges
        if (round.waitForAllJudges) {
          const completionStatus = await checkAllJudgesCompleted(
            round.level,
            round.year,
            round.region || null,  // Explicitly pass null for nationwide
            round.council || null  // Explicitly pass null for nationwide
          );

          if (!completionStatus.allCompleted) {
            console.log(`[Round Scheduler] Round ${round._id} waiting for judges: ${completionStatus.pendingCount} pending`);
            // Don't advance yet, but mark as ended (will be closed when judges finish)
            round.status = 'ended';
            round.endedAt = now;
            await round.save();
            continue;
          }
        }

        // Auto-advance if enabled
        if (round.autoAdvance) {
          console.log(`[Round Scheduler] Auto-advancing round ${round._id} (${round.level})`);
          const advanceResult = await advanceSubmissions(
            round.level,
            round.year,
            round.region || null,  // Explicitly pass null for nationwide
            round.council || null  // Explicitly pass null for nationwide
          );

          if (advanceResult.success) {
            console.log(`[Round Scheduler] Advanced: ${advanceResult.promoted} promoted, ${advanceResult.eliminated} eliminated`);
            
            // Send notifications to teachers with leaderboard data
            const { notifyTeachersOnPromotion, notifyTeachersOnElimination } = require('./notifications');
            const leaderboard = advanceResult.leaderboard || [];
            
            if (advanceResult.promotedIds && advanceResult.promotedIds.length > 0) {
              const nextLevel = getNextLevel(round.level);
              if (nextLevel) {
                notifyTeachersOnPromotion(advanceResult.promotedIds, nextLevel, leaderboard).catch(err => 
                  console.error('Error sending promotion notifications:', err)
                );
              }
            }
            if (advanceResult.eliminatedIds && advanceResult.eliminatedIds.length > 0) {
              notifyTeachersOnElimination(advanceResult.eliminatedIds, leaderboard).catch(err => 
                console.error('Error sending elimination notifications:', err)
              );
            }
            
            // Log the auto-advancement
            if (logger) {
              logger.logSystemEvent(
                'Competition round auto-advanced',
                null,
                {
                  roundId: round._id.toString(),
                  year: round.year,
                  level: round.level,
                  region: round.region,
                  council: round.council,
                  promoted: advanceResult.promoted,
                  eliminated: advanceResult.eliminated
                },
                'success'
              ).catch(() => {});
            }
          } else {
            console.error(`[Round Scheduler] Failed to advance round ${round._id}:`, advanceResult.error);
          }
        }

        // Mark round as ended/closed
        round.status = 'ended';
        round.endedAt = now;
        if (round.autoAdvance) {
          round.status = 'closed';
          round.closedAt = now;
        }
        await round.save();
        console.log(`[Round Scheduler] Round ${round._id} marked as ${round.status}`);
      }
    }
  } catch (error) {
    console.error('Error checking rounds:', error);
    if (logger) {
      logger.logError(
        'Error in round scheduler',
        null,
        null,
        { error: error.message },
        'error'
      ).catch(() => {});
    }
  }
};

// Start the scheduler (check every minute)
let schedulerInterval = null;

const startScheduler = () => {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
  }

  // Wait a bit for connection to be fully established before first check
  setTimeout(() => {
    checkAndProcessRounds();
  }, 2000); // Wait 2 seconds after connection

  // Then check every minute
  schedulerInterval = setInterval(checkAndProcessRounds, 60 * 1000);
  
  if (process.env.NODE_ENV === 'development') {
    console.log('Round scheduler started');
  }
};

const stopScheduler = () => {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
  }
  if (reminderInterval) {
    clearInterval(reminderInterval);
    reminderInterval = null;
  }
};

module.exports = {
  startScheduler,
  stopScheduler,
  checkAndProcessRounds,
  advanceSubmissions,
  checkAllJudgesCompleted
};

