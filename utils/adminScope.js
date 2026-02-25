/**
 * Admin scope utilities for level-based access control.
 * Council admins see council-level data in their council.
 * Regional admins see regional-level data in their region.
 * National admins see all data. Superadmin is unrestricted.
 */

/**
 * Get admin scope. Returns null for superadmin (unrestricted).
 * @param {Object} adminUser - User document with role, adminLevel, adminRegion, adminCouncil
 * @returns {{ level: string, region: string, council: string } | null}
 */
function getAdminScope(adminUser) {
  if (!adminUser || adminUser.role !== 'admin') {
    return null; // null = superadmin or non-admin (unrestricted for superadmin)
  }
  if (!adminUser.adminLevel) {
    return { level: 'None', region: null, council: null }; // Admin without level = no access until assigned
  }
  return {
    level: adminUser.adminLevel,
    region: adminUser.adminRegion || null,
    council: adminUser.adminCouncil || null
  };
}

/**
 * Check if admin can access a submission.
 * Council: submission level=Council, region+council match
 * Regional: submission level=Regional, region match
 * National: all submissions
 * @param {Object} adminUser
 * @param {Object} submission - Submission doc with level, region, council
 * @returns {boolean}
 */
function canAdminAccessSubmission(adminUser, submission) {
  const scope = getAdminScope(adminUser);
  if (!scope) return true; // superadmin
  if (scope.level === 'None') return false;

  if (scope.level === 'Council') {
    return (
      submission.level === 'Council' &&
      submission.region === scope.region &&
      submission.council === scope.council
    );
  }
  if (scope.level === 'Regional') {
    return submission.level === 'Regional' && submission.region === scope.region;
  }
  if (scope.level === 'National') {
    return true;
  }
  return false;
}

/**
 * Check if admin can access a user (teacher, judge, stakeholder).
 * Council: teacher region+council match; judge Council level + region+council match; stakeholder no
 * Regional: teacher region match; judge Regional level + region match; stakeholder no
 * National: all
 * @param {Object} adminUser
 * @param {Object} targetUser - User doc with role, region, council, assignedLevel, assignedRegion, assignedCouncil
 * @returns {boolean}
 */
function canAdminAccessUser(adminUser, targetUser) {
  const scope = getAdminScope(adminUser);
  if (!scope) return true; // superadmin
  if (scope.level === 'None') return false;

  if (targetUser.role === 'stakeholder') {
    return scope.level === 'National';
  }
  if (targetUser.role === 'admin' || targetUser.role === 'superadmin') {
    return false; // Only superadmin manages admins
  }
  if (targetUser.role === 'teacher') {
    if (scope.level === 'Council') {
      return targetUser.region === scope.region && targetUser.council === scope.council;
    }
    if (scope.level === 'Regional') {
      return targetUser.region === scope.region;
    }
    return true;
  }
  if (targetUser.role === 'judge') {
    if (scope.level === 'Council') {
      return (
        targetUser.assignedLevel === 'Council' &&
        targetUser.assignedRegion === scope.region &&
        targetUser.assignedCouncil === scope.council
      );
    }
    if (scope.level === 'Regional') {
      return (
        targetUser.assignedLevel === 'Regional' &&
        targetUser.assignedRegion === scope.region
      );
    }
    return true;
  }
  return false;
}

/**
 * Build MongoDB query for submissions list, filtered by admin scope.
 * @param {Object} adminUser
 * @returns {Object|null} MongoDB query or null (no filter = superadmin sees all)
 */
function buildSubmissionQueryForAdmin(adminUser) {
  const scope = getAdminScope(adminUser);
  if (!scope) return {}; // superadmin sees all
  if (scope.level === 'None') return { _id: { $in: [] } }; // no access

  if (scope.level === 'Council') {
    return {
      level: 'Council',
      region: scope.region,
      council: scope.council
    };
  }
  if (scope.level === 'Regional') {
    return {
      level: 'Regional',
      region: scope.region
    };
  }
  if (scope.level === 'National') {
    return {};
  }
  return { _id: { $in: [] } }; // No access
}

/**
 * Build MongoDB query for users list (teachers, judges, optionally stakeholders).
 * Excludes admins/superadmins from scope (they are managed by superadmin only).
 * @param {Object} adminUser
 * @param {Object} options - { includeStakeholders: boolean }
 * @returns {Object} MongoDB query
 */
function buildUserQueryForAdmin(adminUser, options = {}) {
  const { includeStakeholders = true } = options;
  const scope = getAdminScope(adminUser);
  if (!scope) return {}; // superadmin sees all
  if (scope.level === 'None') return { _id: { $in: [] } }; // no access

  if (scope.level === 'Council') {
    return {
      $or: [
        { role: 'teacher', region: scope.region, council: scope.council },
        {
          role: 'judge',
          assignedLevel: 'Council',
          assignedRegion: scope.region,
          assignedCouncil: scope.council
        }
      ]
    };
  }
  if (scope.level === 'Regional') {
    return {
      $or: [
        { role: 'teacher', region: scope.region },
        {
          role: 'judge',
          assignedLevel: 'Regional',
          assignedRegion: scope.region
        }
      ]
    };
  }
  if (scope.level === 'National') {
    const roles = ['teacher', 'judge'];
    if (includeStakeholders) roles.push('stakeholder');
    return { role: { $in: roles } };
  }
  return { _id: { $in: [] } };
}

/**
 * Only national admin or superadmin can register stakeholders.
 * @param {Object} adminUser
 * @returns {boolean}
 */
function adminCanRegisterStakeholder(adminUser) {
  if (!adminUser) return false;
  if (adminUser.role === 'superadmin') return true;
  return adminUser.role === 'admin' && adminUser.adminLevel === 'National';
}

/**
 * Check if admin has a valid scope (can function). Admins without adminLevel cannot.
 */
function adminHasValidScope(adminUser) {
  const scope = getAdminScope(adminUser);
  if (!scope) return true; // superadmin
  return scope.level !== 'None';
}

module.exports = {
  getAdminScope,
  canAdminAccessSubmission,
  canAdminAccessUser,
  buildSubmissionQueryForAdmin,
  buildUserQueryForAdmin,
  adminCanRegisterStakeholder
};
