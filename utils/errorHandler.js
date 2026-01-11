// Standardized error response utility
const sendErrorResponse = (res, error, statusCode = 500, operation = 'operation') => {
  // Log the full error for debugging (server-side only)
  console.error(`${operation} error:`, error);

  // Determine appropriate error message based on environment
  let message = 'Server error';
  let errors = null;

  if (process.env.NODE_ENV === 'development') {
    // In development, show detailed error info
    message = error.message || message;
  } else {
    // In production, use generic messages but log specifics
    message = getProductionErrorMessage(error, operation);
  }

  // Handle validation errors specifically
  if (error.name === 'ValidationError') {
    message = 'Validation failed';
    errors = Object.values(error.errors).map(err => err.message);
    statusCode = 400;
  }

  // Handle duplicate key errors (MongoDB)
  if (error.code === 11000) {
    message = 'Duplicate entry found';
    errors = ['A quota already exists for this year and level combination'];
    statusCode = 409;
  }

  res.status(statusCode).json({
    success: false,
    message,
    ...(errors && { errors })
  });
};

// Get production-safe error messages
const getProductionErrorMessage = (error, operation) => {
  // Map common error types to user-friendly messages
  const errorMappings = {
    'CastError': `${operation} failed due to invalid data format`,
    'ValidationError': 'Invalid data provided',
    'MongoError': operation === 'database' ? 'Database operation failed' : 'Operation failed'
  };

  return errorMappings[error.name] || 'Server error';
};

// Async error wrapper to catch rejected promises
const asyncHandler = (fn) => {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

module.exports = {
  sendErrorResponse,
  asyncHandler
};
