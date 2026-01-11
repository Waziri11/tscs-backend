const Joi = require('joi');

// Validation schemas for quotas
const quotaValidations = {
  // For creating new quotas or upserting
  create: Joi.object({
    year: Joi.number()
      .integer()
      .min(2020)
      .max(2030)
      .required()
      .messages({
        'number.min': 'Year must be 2020 or later',
        'number.max': 'Year cannot be later than 2030'
      }),

    level: Joi.string()
      .valid('Council', 'Regional', 'National')
      .required()
      .messages({
        'any.only': 'Level must be one of: Council, Regional, National'
      }),

    quota: Joi.number()
      .integer()
      .min(1)
      .max(10000)
      .required()
      .messages({
        'number.min': 'Quota must be at least 1',
        'number.max': 'Quota cannot exceed 10,000'
      })
  }),

  // For updating existing quotas (only quota field can be updated)
  update: Joi.object({
    quota: Joi.number()
      .integer()
      .min(1)
      .max(10000)
      .required()
      .messages({
        'number.min': 'Quota must be at least 1',
        'number.max': 'Quota cannot exceed 10,000'
      })
  }).min(1).messages({
    'object.min': 'At least one field must be provided for update'
  }),

  // For query parameters in GET requests
  query: Joi.object({
    year: Joi.number()
      .integer()
      .min(2020)
      .max(2030)
      .optional(),

    level: Joi.string()
      .valid('Council', 'Regional', 'National')
      .optional(),

    page: Joi.number()
      .integer()
      .min(1)
      .default(1)
      .optional(),

    limit: Joi.number()
      .integer()
      .min(1)
      .max(100)
      .default(50)
      .optional()
  }),

  // For URL parameters
  params: Joi.object({
    year: Joi.number()
      .integer()
      .min(2020)
      .max(2030)
      .required(),

    level: Joi.string()
      .valid('Council', 'Regional', 'National')
      .required()
  })
};

// Validation middleware function
const validate = (schema) => {
  return (req, res, next) => {
    const { error, value } = schema.validate(req.body, { abortEarly: false });

    if (error) {
      const errors = error.details.map(detail => detail.message);
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors
      });
    }

    // Replace req.body with validated/sanitized data
    req.body = value;
    next();
  };
};

// Query validation middleware
const validateQuery = (schema) => {
  return (req, res, next) => {
    const { error, value } = schema.validate(req.query, { abortEarly: false });

    if (error) {
      const errors = error.details.map(detail => detail.message);
      return res.status(400).json({
        success: false,
        message: 'Query validation failed',
        errors
      });
    }

    // Replace req.query with validated/sanitized data
    req.query = value;
    next();
  };
};

// Params validation middleware
const validateParams = (schema) => {
  return (req, res, next) => {
    const { error, value } = schema.validate(req.params, { abortEarly: false });

    if (error) {
      const errors = error.details.map(detail => detail.message);
      return res.status(400).json({
        success: false,
        message: 'Parameter validation failed',
        errors
      });
    }

    // Replace req.params with validated/sanitized data
    req.params = value;
    next();
  };
};

module.exports = {
  quotaValidations,
  validate,
  validateQuery,
  validateParams
};
