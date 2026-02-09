const CompetitionRound = require('../models/CompetitionRound');
const Submission = require('../models/Submission');
const Evaluation = require('../models/Evaluation');
const User = require('../models/User');
const Quota = require('../models/Quota');
const Leaderboard = require('../models/Leaderboard');
const { getNextLevel, advanceSubmissionsForRound, checkAllJudgesCompleted } = require('./advancementService');
const { generateLocationKey, calculateAndUpdateLeaderboard } = require('./leaderboardUtils');

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


// Check and process rounds that should end
const checkAndProcessRounds = async () => {
  try {
    // Check if MongoDB is connected before running queries
    const mongoose = require('mongoose');
    if (mongoose.connection.readyState !== 1) {
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
        // Check if we should wait for all judges
        if (round.waitForAllJudges) {
          const completionStatus = await checkAllJudgesCompleted(
            round.level,
            round.year,
            round.region || null,  // Explicitly pass null for nationwide
            round.council || null  // Explicitly pass null for nationwide
          );

          if (!completionStatus.allCompleted) {
            // Don't advance yet, but mark as ended (will be closed when judges finish)
            round.status = 'ended';
            round.endedAt = now;
            await round.save();
            continue;
          }
        }

        // Auto-advance if enabled
        if (round.autoAdvance) {
          const advanceResult = await advanceSubmissionsForRound(
            round.level,
            round.year,
            round.region || null,  // Explicitly pass null for nationwide
            round.council || null,  // Explicitly pass null for nationwide
            round._id
          );

          if (advanceResult.success) {
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
                'success',
                'update'
              ).catch(() => {});
            }
          } else {
            console.error(`[Round Scheduler] Failed to advance round ${round._id}:`, advanceResult.error);
          }
        }

        // Finalize leaderboards for this round
        try {
          // Get submissions for this round to determine affected leaderboards
          const submissionQuery = {
            year: round.year,
            level: round.level,
            status: { $in: ['submitted', 'evaluated', 'promoted', 'eliminated'] }
          };
          if (round.region) submissionQuery.region = round.region;
          if (round.council) submissionQuery.council = round.council;

          const roundSubmissions = await Submission.find(submissionQuery);
          
          // Get unique areaOfFocus values
          const areaOfFocusSet = new Set();
          roundSubmissions.forEach(sub => {
            if (sub.areaOfFocus) {
              areaOfFocusSet.add(sub.areaOfFocus);
            }
          });

          // Finalize leaderboards for each areaOfFocus
          for (const areaOfFocus of areaOfFocusSet) {
            const locationKeySet = new Set();
            roundSubmissions
              .filter(sub => sub.areaOfFocus === areaOfFocus)
              .forEach(sub => {
                const locationKey = generateLocationKey(round.level, sub.region, sub.council);
                locationKeySet.add(locationKey);
              });

            for (const locationKey of locationKeySet) {
              // Recalculate and finalize leaderboard
              await calculateAndUpdateLeaderboard(
                round.year,
                areaOfFocus,
                round.level,
                locationKey,
                {
                  region: round.region,
                  council: round.council
                }
              );

              await Leaderboard.updateOne(
                {
                  year: round.year,
                  areaOfFocus,
                  level: round.level,
                  locationKey
                },
                {
                  $set: {
                    isFinalized: true,
                    lastUpdated: new Date()
                  }
                }
              );
            }
          }
        } catch (leaderboardError) {
          console.error('Error finalizing leaderboards:', leaderboardError);
          // Don't fail the round closure if leaderboard finalization fails
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

  // Wait a bit for connection to be fully established before first check
  setTimeout(() => {
    checkAndProcessRounds();
  }, 2000); // Wait 2 seconds after connection

  // Then check every 15 seconds
  schedulerInterval = setInterval(checkAndProcessRounds, 15 * 1000);
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
  checkAndProcessRounds
};

