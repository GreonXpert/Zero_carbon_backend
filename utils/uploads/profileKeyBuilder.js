function sanitize(str) {
  return (str || '')
    .toString()
    .trim()
    .replace(/[^\w.-]+/g, '_') || 'unknown';
}

exports.buildUserProfileS3Key = function buildUserProfileS3Key(user, ext) {
  const ts = Date.now();
  const id = user._id.toString();

  switch (user.userType) {
    case 'super_admin':
      return `profiles/super_admin/${id}_${ts}${ext}`;

    case 'consultant_admin':
      return `profiles/consultant_admin/${sanitize(user.teamName)}/${id}_${ts}_${sanitize(user.userName)}${ext}`;

    case 'consultant':
      return `profiles/consultant/${sanitize(user.teamName)}/${id}_${ts}_${sanitize(user.userName)}${ext}`;

    case 'client_admin':
      return `profiles/client_admin/${sanitize(user.clientId)}/${id}_${ts}_${sanitize(user.userName)}${ext}`;

    case 'client_employee_head':
      return `profiles/employee_head/${sanitize(user.clientId)}/${id}_${ts}_${sanitize(user.userName)}${ext}`;

    case 'employee':
      return `profiles/employee/${sanitize(user.clientId)}/${id}_${ts}_${sanitize(user.userName)}${ext}`;

    case 'auditor':
      return `profiles/auditor/${sanitize(user.clientId)}/${id}_${ts}_${sanitize(user.userName)}${ext}`;

    case 'viewer':
      return `profiles/viewer/${sanitize(user.clientId)}/${id}_${ts}_${sanitize(user.userName)}${ext}`;

    default:
      return `profiles/misc/${id}_${ts}${ext}`;
  }
};
