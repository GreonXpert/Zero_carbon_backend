// utils/sanitizers/userSanitizer.js
class UserSanitizer {
  static consultantAdminFields() {
    return {
      required: ['email', 'password', 'contactNumber', 'userName', 'address'],
      optional: ['teamName', 'employeeId'],
      forbidden: ['userType', 'isActive', 'permissions', 'createdBy', 'clientId', 'sandbox']
    };
  }
  
  static sanitize(data, allowedFields) {
    const sanitized = {};
    const { required, optional } = allowedFields;
    
    // Check required fields
    for (const field of required) {
      if (!data[field]) {
        throw new Error(`Missing required field: ${field}`);
      }
      sanitized[field] = data[field];
    }
    
    // Add optional fields if present
    for (const field of optional) {
      if (data[field] !== undefined) {
        sanitized[field] = data[field];
      }
    }
    
    return sanitized;
  }
}

// Then in controller:
const userData = UserSanitizer.sanitize(
  req.body, 
  UserSanitizer.consultantAdminFields()
);