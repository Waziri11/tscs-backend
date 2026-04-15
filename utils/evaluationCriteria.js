/**
 * Weighted evaluation criteria: validation, normalization, leaf flattening, score checks.
 */

const DEFAULT_MAX_POINTS = 10;

/**
 * @param {Array} criteria - raw criteria from API
 * @returns {{ ok: boolean, message?: string, normalized?: Array }}
 */
function validateAndNormalizeEvaluationCriteria(criteria) {
  if (!Array.isArray(criteria) || criteria.length === 0) {
    return { ok: false, message: 'evaluationCriteria must be a non-empty array' };
  }

  const topKeys = new Set();
  const normalized = [];

  for (let i = 0; i < criteria.length; i++) {
    const c = criteria[i];
    if (!c || typeof c !== 'object') {
      return { ok: false, message: `Invalid criterion at index ${i}` };
    }
    const key = typeof c.key === 'string' ? c.key.trim() : '';
    const label = typeof c.label === 'string' ? c.label.trim() : '';
    if (!key || !label) {
      return { ok: false, message: `Each criterion needs key and label (index ${i})` };
    }
    if (topKeys.has(key)) {
      return { ok: false, message: `Duplicate criterion key: ${key}` };
    }
    topKeys.add(key);

    let maxPoints = Number(c.maxPoints);
    if (!Number.isFinite(maxPoints) || maxPoints <= 0) {
      maxPoints = DEFAULT_MAX_POINTS;
    }

    const order = Number.isFinite(Number(c.order)) ? Number(c.order) : i;
    const subsRaw = Array.isArray(c.subcriteria) ? c.subcriteria : [];
    const subcriteria = [];

    if (subsRaw.length > 0) {
      const subKeys = new Set();
      let subSum = 0;
      for (let j = 0; j < subsRaw.length; j++) {
        const s = subsRaw[j];
        if (!s || typeof s !== 'object') {
          return { ok: false, message: `Invalid subcriterion under ${key} at index ${j}` };
        }
        const sk = typeof s.key === 'string' ? s.key.trim() : '';
        const sl = typeof s.label === 'string' ? s.label.trim() : '';
        if (!sk || !sl) {
          return { ok: false, message: `Subcriterion needs key and label (${key}, index ${j})` };
        }
        if (topKeys.has(sk) || subKeys.has(sk)) {
          return { ok: false, message: `Duplicate key: ${sk}` };
        }
        subKeys.add(sk);
        let sm = Number(s.maxPoints);
        if (!Number.isFinite(sm) || sm <= 0) {
          return { ok: false, message: `Subcriterion ${sk} needs maxPoints > 0` };
        }
        subSum += sm;
        subcriteria.push({
          key: sk,
          label: sl,
          order: Number.isFinite(Number(s.order)) ? Number(s.order) : j,
          maxPoints: sm
        });
      }
      if (Math.abs(subSum - maxPoints) > 1e-9) {
        return {
          ok: false,
          message: `Criterion "${label}": subcriteria maxPoints must sum to parent max (${maxPoints}), got ${subSum}`
        };
      }
    }

    normalized.push({
      key,
      label,
      order,
      maxPoints,
      subcriteria
    });
  }

  return { ok: true, normalized };
}

/**
 * Walk Competition document to area evaluation criteria array (same as GET route).
 */
function getEvaluationCriteriaFromCompetition(competition, categoryName, classLevel, subjectName, areaName) {
  if (!competition) return null;
  const categoryObj = competition.categories.find((c) => c.name === categoryName);
  if (!categoryObj) return null;
  const classObj = categoryObj.classes.find((c) => c.name === classLevel);
  if (!classObj) return null;
  const subjectObj = classObj.subjects.find((s) => s.name === subjectName);
  if (!subjectObj) return null;
  const areaObj = subjectObj.areasOfFocus.find((a) => a.name === areaName);
  if (!areaObj) return null;
  return areaObj.evaluationCriteria || [];
}

/**
 * @param {Array} criteria - normalized criteria
 * @returns {number} sum of top-level maxPoints
 */
function maxRubricTotal(criteria) {
  if (!Array.isArray(criteria)) return 0;
  return criteria.reduce((sum, c) => sum + (Number(c.maxPoints) || 0), 0);
}

/**
 * Flatten to scored leaves: parent without subcriteria -> one leaf; with subcriteria -> each sub.
 * @returns {Array<{ key: string, label: string, maxPoints: number, displayPath: string }>}
 */
function flattenLeafDescriptors(criteria) {
  if (!Array.isArray(criteria)) return [];
  const out = [];
  const sorted = [...criteria].sort((a, b) => (a.order || 0) - (b.order || 0));
  for (const c of sorted) {
    const subs = Array.isArray(c.subcriteria) ? c.subcriteria : [];
    if (subs.length === 0) {
      const mp = Number(c.maxPoints) > 0 ? Number(c.maxPoints) : DEFAULT_MAX_POINTS;
      out.push({
        key: c.key,
        label: c.label,
        maxPoints: mp,
        displayPath: c.label
      });
    } else {
      const subSorted = [...subs].sort((a, b) => (a.order || 0) - (b.order || 0));
      for (const s of subSorted) {
        const mp = Number(s.maxPoints) > 0 ? Number(s.maxPoints) : 0;
        out.push({
          key: s.key,
          label: s.label,
          maxPoints: mp,
          displayPath: `${c.label} › ${s.label}`
        });
      }
    }
  }
  return out;
}

/**
 * @param {Object} scores - plain object key -> number
 * @param {Array} criteria - normalized criteria from DB
 * @returns {{ ok: boolean, message?: string, totalScore?: number, averageScore?: number, maxTotal?: number }}
 */
function validateScoresAgainstCriteria(scores, criteria) {
  if (!scores || typeof scores !== 'object') {
    return { ok: false, message: 'scores must be an object' };
  }

  const leaves = flattenLeafDescriptors(criteria);
  const leafKeys = new Set(leaves.map((l) => l.key));
  const maxTotal = maxRubricTotal(criteria);

  for (const key of Object.keys(scores)) {
    if (!leafKeys.has(key)) {
      return { ok: false, message: `Unknown score key: ${key}` };
    }
  }

  for (const leaf of leaves) {
    if (!Object.prototype.hasOwnProperty.call(scores, leaf.key)) {
      return { ok: false, message: `Missing score for: ${leaf.displayPath}` };
    }
    const raw = scores[leaf.key];
    const val = typeof raw === 'number' ? raw : parseFloat(raw);
    if (!Number.isFinite(val) || val < 0) {
      return { ok: false, message: `Invalid score for ${leaf.displayPath}` };
    }
    if (val > leaf.maxPoints + 1e-9) {
      return {
        ok: false,
        message: `Score for ${leaf.displayPath} exceeds maximum (${leaf.maxPoints})`
      };
    }
  }

  const sortedCriteria = [...criteria].sort((a, b) => (a.order || 0) - (b.order || 0));
  for (const c of sortedCriteria) {
    const subs = Array.isArray(c.subcriteria) ? c.subcriteria : [];
    if (subs.length === 0) continue;
    let sum = 0;
    for (const s of subs) {
      const v = scores[s.key];
      sum += typeof v === 'number' ? v : parseFloat(v);
    }
    const parentMax = Number(c.maxPoints) || 0;
    if (sum > parentMax + 1e-6) {
      return {
        ok: false,
        message: `Scores for "${c.label}" exceed maximum subtotal ${parentMax} (got ${sum.toFixed(2)})`
      };
    }
  }

  let totalScore = 0;
  for (const leaf of leaves) {
    const v = scores[leaf.key];
    totalScore += typeof v === 'number' ? v : parseFloat(v);
  }

  const averageScore = maxTotal > 0 ? Math.round((totalScore / maxTotal) * 1000000) / 1000000 : 0;

  return { ok: true, totalScore, averageScore, maxTotal };
}

/**
 * Normalize criteria as stored in DB (legacy docs may omit maxPoints / subcriteria).
 */
function normalizeStoredCriteria(criteria) {
  if (!Array.isArray(criteria)) return [];
  return criteria.map((c, i) => {
    const subsRaw = Array.isArray(c.subcriteria) ? c.subcriteria : [];
    const subs = subsRaw.map((s, j) => ({
      key: String(s.key || '').trim(),
      label: String(s.label || '').trim(),
      order: s.order != null ? Number(s.order) : j,
      maxPoints: Number(s.maxPoints) > 0 ? Number(s.maxPoints) : DEFAULT_MAX_POINTS
    }));
    let maxPoints = Number(c.maxPoints) > 0 ? Number(c.maxPoints) : DEFAULT_MAX_POINTS;
    if (subs.length > 0) {
      const sumSubs = subs.reduce((a, s) => a + s.maxPoints, 0);
      if (sumSubs > 0) {
        maxPoints = sumSubs;
      }
    }
    return {
      key: String(c.key || '').trim(),
      label: String(c.label || '').trim(),
      order: c.order != null ? Number(c.order) : i,
      maxPoints,
      subcriteria: subs
    };
  });
}

module.exports = {
  DEFAULT_MAX_POINTS,
  validateAndNormalizeEvaluationCriteria,
  getEvaluationCriteriaFromCompetition,
  maxRubricTotal,
  flattenLeafDescriptors,
  validateScoresAgainstCriteria,
  normalizeStoredCriteria
};
