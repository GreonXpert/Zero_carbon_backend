const ALLOWED = ['reduction', 'decarbonization', 'organization', 'process'];

function normalizeAssessmentLevels(levels) {
  const arr = Array.isArray(levels) ? levels : (levels ? [levels] : []);
  return arr
    .map(v => String(v || '').trim().toLowerCase())
    .flatMap(v => {
      if (!v) return [];
      if (v === 'organisation') return ['organization'];
      if (v === 'both') return ['organization', 'process']; // legacy support
      return [v];
    })
    .filter(v => ALLOWED.includes(v))
    .filter((v, i, a) => a.indexOf(v) === i);
}

function computeRequirements(levels) {
  const hasOrg  = levels.includes('organization');
  const hasProc = levels.includes('process');
  const hasRed  = levels.includes('reduction');

  // Only require projectProfile when it's reduction ONLY (no org/process)
  const requireProjectProfile   = hasRed && !hasOrg && !hasProc;

  // If org or process is present (pre-activation), emissionsProfile is required
  const requireEmissionsProfile = hasOrg || hasProc;

  return { requireProjectProfile, requireEmissionsProfile };
}

/**
 * Validate conditional sections for the chosen assessment levels.
 * If opts.stage === 'active' (post-onboarding), we skip requirements.
 */
function validateSubmissionForLevels(submissionData, levels, opts = {}) {
  const errors = [];

  // After onboarding: no need to validate presence of projectProfile/emissionsProfile
  if (opts.stage === 'active' || opts.skipRequirements) {
    return { ...computeRequirements(levels), errors };
  }

  const flags = computeRequirements(levels);

  // projectProfile checks (reduction-only)
  if (flags.requireProjectProfile) {
    const pp = submissionData.projectProfile || submissionData.ProjectProfile || [];
    if (!Array.isArray(pp) || pp.length === 0) {
      errors.push('projectProfile must contain at least one project.');
    } else {
      pp.forEach((p, i) => {
        if (!p?.projectName) errors.push(`projectProfile[${i}].projectName is required`);
        if (!p?.projectType) errors.push(`projectProfile[${i}].projectType is required`);
      });
    }
  }

  // emissionsProfile checks (org/process present)
  if (flags.requireEmissionsProfile) {
    if (!submissionData.emissionsProfile) {
      errors.push('emissionsProfile is required for this assessmentLevel combination.');
    }
  }

  return { ...flags, errors };
}

module.exports = {
  ALLOWED,
  normalizeAssessmentLevels,
  computeRequirements,
  validateSubmissionForLevels
};
