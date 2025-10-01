// utils/assessmentLevel.js
const ALLOWED = ['reduction', 'decarbonization', 'organization', 'process'];

function normalizeAssessmentLevels(input) {
  const arr = Array.isArray(input) ? input : (input ? [input] : []);
  const normed = arr
    .map(s => String(s).toLowerCase().trim())
    .map(s => (s === 'organisation' ? 'organization' : s))
    .filter(s => ALLOWED.includes(s));
  return [...new Set(normed)];
}

function computeRequirements(levels) {
  const set = new Set(levels);
  const hasReduction   = set.has('reduction');
  const hasOrgOrProc   = set.has('organization') || set.has('process');

  // Rules you asked for:
  // - reduction only  => ProjectProfile required, EmissionsProfile NOT required
  // - reduction + (organization or process) => BOTH required
  // - (organization or process) only => ProjectProfile required, EmissionsProfile NOT required
  // - decarbonization alone doesn't change these rules (remains compatible)
  return {
    requireProjectProfile: hasReduction || hasOrgOrProc,
    requireEmissionsProfile: hasReduction && hasOrgOrProc
  };
}

function validateSubmissionForLevels(submissionData, levels) {
  const flags = computeRequirements(levels);
  const errors = [];

  // projectProfile checks
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

  // emissionsProfile checks
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
