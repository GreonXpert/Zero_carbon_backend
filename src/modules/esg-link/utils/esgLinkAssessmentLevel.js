const ALLOWED_MODULES = ['esg_link_core'];
const ALLOWED_FRAMEWORKS = ['BRSR', 'GRI', 'TCFD', 'CDP', 'SASB', 'UNGC', 'ISO_26000', 'SDG'];

function validateEsgLinkAssessmentLevel(esgLinkAssessmentLevel) {
  const errors = [];

  // Both module and frameworks are individually optional —
  // but the overall object must carry at least one meaningful selection.
  const hasModule     = esgLinkAssessmentLevel?.module != null && esgLinkAssessmentLevel.module !== '';
  const frameworks    = esgLinkAssessmentLevel?.frameworks || [];
  const hasFrameworks = Array.isArray(frameworks) && frameworks.length > 0;

  if (!hasModule && !hasFrameworks) {
    errors.push(
      'esgLinkAssessmentLevel must include at least a module ("esg_link_core") or one or more frameworks'
    );
  }

  // If module is provided, validate its value
  if (hasModule && !ALLOWED_MODULES.includes(esgLinkAssessmentLevel.module)) {
    errors.push(`esgLinkAssessmentLevel.module must be one of: ${ALLOWED_MODULES.join(', ')}`);
  }

  // Validate frameworks array if provided
  if (!Array.isArray(frameworks)) {
    errors.push('esgLinkAssessmentLevel.frameworks must be an array');
  } else {
    const invalid = frameworks.filter(f => !ALLOWED_FRAMEWORKS.includes(f));
    if (invalid.length) {
      errors.push(`Invalid frameworks: ${invalid.join(', ')}. Allowed: ${ALLOWED_FRAMEWORKS.join(', ')}`);
    }
  }

  return errors;
}

module.exports = { validateEsgLinkAssessmentLevel, ALLOWED_MODULES, ALLOWED_FRAMEWORKS };
