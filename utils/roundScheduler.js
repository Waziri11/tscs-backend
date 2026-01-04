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
    
    if (region) submissionQuery.region = region;
    if (council) submissionQuery.council = council;

    const submissions = await Submission.find(submissionQuery);
    
    if (submissions.length === 0) return { allCompleted: true, pendingCount: 0 };

    const judgeQuery = { role: 'judge', assignedLevel: level, status: 'active' };
    if (level === 'Council' && region && council) {
      judgeQuery.assignedRegion = region;
      judgeQuery.assignedCouncil = council;
    } else if (level === 'Regional' && region) {
      judgeQuery.assignedRegion = region;
    }
    
    const judges = await User.find(judgeQuery);
    
    if (judges.length === 0) {
      return { allCompleted: false, pendingCount: submissions.length, reason: 'No judges assigned' };
    }

    let pendingCount = 0;
    for (const submission of submissions) {
      const evaluations = await Evaluation.find({ submissionId: submission._id });
      const evaluatedJudgeIds = evaluations.map(e => e.judgeId.toString());
      
      const allJudgesEvaluated = judges.every(judge => 
        evaluatedJudgeIds.includes(judge._id.toString())
      );
      
      if (!allJudgesEvaluated) {
        pendingCount++;
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

    const groups = {};
    submissions.forEach(sub => {
      let locationKey;
      if (level === 'Council') {
        locationKey = `${sub.region}::${sub.council}`;
      } else if (level === 'Regional') {
        locationKey = sub.region;
      } else {
        locationKey = 'national';
      }
      
      if (!groups[locationKey]) {
        groups[locationKey] = [];
      }
      groups[locationKey].push(sub);
    });

    const toPromote = [];
    const toEliminate = [];

    Object.keys(groups).forEach(locationKey => {
      const locationSubs = groups[locationKey].sort((a, b) => 
        (b.averageScore || 0) - (a.averageScore || 0)
      );

      if (locationSubs.length <= quota) {
        toPromote.push(...locationSubs);
      } else {
        toPromote.push(...locationSubs.slice(0, quota));
        toEliminate.push(...locationSubs.slice(quota));
      }
    });

    const promotedIds = [];
    const eliminatedIds = [];

    for (const sub of toPromote) {
      await Submission.findByIdAndUpdate(sub._id, {
        level: nextLevel,
        status: 'approved'
      });
      promotedIds.push(sub._id.toString());
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
      eliminatedIds
    };
  } catch (error) {
    console.error('Error advancing submissions:', error);
    return { success: false, error: error.message };
  }
};

// Check and process rounds that should end
const checkAndProcessRounds = async () => {
  try {
    const now = new Date();
    
    // Find active rounds that should end
    const activeRounds = await CompetitionRound.find({
      status: 'active'
    });

    for (const round of activeRounds) {
      const actualEndTime = round.getActualEndTime();
      
      if (now >= actualEndTime) {
        
        // Check if we should wait for all judges
        if (round.waitForAllJudges) {
          const completionStatus = await checkAllJudgesCompleted(
            round.level,
            round.year,
            round.region,
            round.council
          );

          if (!completionStatus.allCompleted) {
            // Don't end yet, but mark as ended (will be closed when judges finish)
            round.status = 'ended';
            round.endedAt = now;
            await round.save();
            continue;
          }
        }

        // Auto-advance if enabled
        if (round.autoAdvance) {
          const advanceResult = await advanceSubmissions(
            round.level,
            round.year,
            round.region,
            round.council
          );

          if (advanceResult.success) {
            
            // Send notifications to teachers
            const { notifyTeachersOnPromotion, notifyTeachersOnElimination } = require('./notifications');
            if (advanceResult.promotedIds && advanceResult.promotedIds.length > 0) {
              const nextLevel = getNextLevel(round.level);
              if (nextLevel) {
                notifyTeachersOnPromotion(advanceResult.promotedIds, nextLevel).catch(err => 
                  console.error('Error sending promotion notifications:', err)
                );
              }
            }
            if (advanceResult.eliminatedIds && advanceResult.eliminatedIds.length > 0) {
              notifyTeachersOnElimination(advanceResult.eliminatedIds).catch(err => 
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
                  promoted: advanceResult.promoted,
                  eliminated: advanceResult.eliminated
                },
                'success'
              ).catch(() => {});
            }
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

  // Check immediately on start
  checkAndProcessRounds();

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

