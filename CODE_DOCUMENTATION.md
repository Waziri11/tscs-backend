# TSCS Backend - Developer Documentation

## Table of Contents
1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Setup & Installation](#setup--installation)
4. [Environment Variables](#environment-variables)
5. [Project Structure](#project-structure)
6. [Database Models](#database-models)
7. [API Routes](#api-routes)
8. [Authentication & Authorization](#authentication--authorization)
9. [Middleware](#middleware)
10. [Services](#services)
11. [File Uploads](#file-uploads)
12. [Error Handling](#error-handling)
13. [Deployment](#deployment)
14. [Scripts & Utilities](#scripts--utilities)

---

## Overview

The TSCS (Teacher Submission Competition System) backend is a Node.js/Express REST API that manages:
- User authentication and authorization (Teachers, Judges, Admins, Superadmins)
- Competition and round management
- Submission handling (lesson plans and videos)
- Evaluation and scoring system
- Quota management
- Email notifications
- System logging
- Landing page content management

**Tech Stack:**
- **Runtime:** Node.js
- **Framework:** Express.js
- **Database:** MongoDB (Mongoose ODM)
- **Authentication:** JWT (JSON Web Tokens)
- **File Upload:** Multer
- **Email:** Nodemailer (Gmail SMTP)
- **Security:** Helmet, CORS, express-rate-limit, express-mongo-sanitize

---

## Architecture

### Request Flow
```
Client Request → CORS → Rate Limiter → Express Middleware → Route Handler → 
Middleware (auth/authorize) → Controller Logic → Database → Response
```

### Key Components
1. **Routes** (`/routes`): Define API endpoints
2. **Models** (`/models`): MongoDB schemas
3. **Middleware** (`/middleware`): Authentication, authorization, logging
4. **Services** (`/services`): Business logic (email, notifications, OTP)
5. **Utils** (`/utils`): Helper functions (schedulers, error handlers)
6. **Config** (`/config`): Database and app configuration

---

## Setup & Installation

### Prerequisites
- Node.js (v14+)
- MongoDB (local or Atlas)
- Gmail account with App Password (for email service)

### Installation Steps

1. **Install Dependencies**
   ```bash
   cd tscs-backend
   npm install
   ```

2. **Environment Setup**
   - Copy `.env.example` to `.env`
   - Fill in all required environment variables (see [Environment Variables](#environment-variables))

3. **Database Setup**
   - Ensure MongoDB is running (local) or have MongoDB Atlas connection string
   - Database will be created automatically on first connection

4. **Create Superadmin**
   ```bash
   npm run create-superadmin
   ```

5. **Start Development Server**
   ```bash
   npm run dev  # Uses nodemon for auto-reload
   # OR
   npm start    # Production mode
   ```

6. **Seed Landing Page (Optional)**
   ```bash
   npm run seed:landing
   ```

---

## Environment Variables

Create a `.env` file in the `tscs-backend` directory:

```env
# Server Configuration
PORT=5000
NODE_ENV=development

# MongoDB Atlas Connection String
MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/tscs?retryWrites=true&w=majority

# JWT Secret Key (change this in production)
JWT_SECRET=your-super-secret-jwt-key-change-this-in-production

# CORS Origin (Frontend URL)
CLIENT_URL=http://localhost:5173

# Email Configuration (Gmail SMTP)
GMAIL_USER=your-email@gmail.com
GMAIL_APP_PASSWORD=your-gmail-app-password
EMAIL_FROM_NAME=TSCS
```

### Variable Descriptions

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Server port (default: 5000) |
| `NODE_ENV` | No | Environment: `development` or `production` |
| `MONGODB_URI` | Yes | MongoDB connection string |
| `JWT_SECRET` | Yes | Secret key for JWT token signing |
| `CLIENT_URL` | Yes | Frontend URL for CORS |
| `GMAIL_USER` | Yes | Gmail account email |
| `GMAIL_APP_PASSWORD` | Yes | Gmail App Password (not regular password) |
| `EMAIL_FROM_NAME` | No | Email sender name (default: "TSCS") |

---

## Project Structure

```
tscs-backend/
├── config/
│   └── database.js          # MongoDB connection
├── middleware/
│   ├── auth.js             # JWT authentication & authorization
│   └── logger.js           # Request logging
├── models/
│   ├── User.js             # User schema
│   ├── Competition.js      # Competition schema
│   ├── CompetitionRound.js # Round schema
│   ├── Submission.js       # Submission schema
│   ├── Evaluation.js       # Evaluation schema
│   ├── Quota.js            # Quota schema
│   ├── TieBreaking.js      # Tie-breaking schema
│   ├── Notification.js     # Notification schema
│   ├── EmailLog.js         # Email logging
│   ├── EmailOTP.js         # OTP storage
│   ├── PasswordReset.js    # Password reset tokens
│   ├── SystemLog.js        # System activity logs
│   └── LandingPage.js      # Landing page content
├── routes/
│   ├── auth.js             # Authentication routes
│   ├── users.js            # User management
│   ├── submissions.js     # Submission CRUD
│   ├── competitions.js    # Competition management
│   ├── competitionRounds.js # Round management
│   ├── evaluations.js     # Evaluation routes
│   ├── quotas.js           # Quota management
│   ├── tieBreaking.js      # Tie-breaking routes
│   ├── systemLogs.js       # System logs
│   ├── landingPage.js     # Landing page CRUD
│   ├── uploads.js         # File upload/download
│   └── notifications.js    # Notification routes
├── services/
│   ├── emailService.js     # Email sending service
│   ├── notificationService.js # Notification service
│   └── otpService.js       # OTP generation/verification
├── utils/
│   ├── errorHandler.js     # Error handling utilities
│   ├── logger.js           # Logging utilities
│   ├── notifications.js    # Notification helpers
│   └── roundScheduler.js   # Automated round processing
├── validation/
│   └── quotas.js           # Quota validation schemas
├── scripts/
│   ├── migrateUploads.js   # File migration script
│   └── seedLandingPage.js  # Landing page seeder
├── uploads/
│   ├── lesson-plan/        # PDF lesson plans
│   └── videos/             # Video submissions
├── server.js               # Main application entry
├── create-superadmin.js    # Superadmin creation script
└── package.json
```

---

## Database Models

### User Model
**File:** `models/User.js`

**Fields:**
- `username` (String, unique, required)
- `password` (String, hashed, required)
- `name` (String, required)
- `email` (String, unique, required)
- `emailVerified` (Boolean, default: false)
- `phone` (String, optional)
- `gender` (Enum: 'Male', 'Female')
- `role` (Enum: 'teacher', 'judge', 'admin', 'superadmin')
- `status` (Enum: 'active', 'inactive', 'suspended')
- `assignedLevel` (String, for judges)
- `assignedCategory` (String, for judges)
- `assignedClass` (String, for judges)
- `assignedSubject` (String, for judges)
- `assignedRegion` (String, for judges)
- `assignedCouncil` (String, for judges)
- `location` (Object: region, council)
- `createdAt`, `updatedAt` (timestamps)

**Methods:**
- `matchPassword(plainPassword)`: Compare password with hash

### Competition Model
**File:** `models/Competition.js`

**Fields:**
- `year` (Number, required, unique)
- `status` (String: 'draft', 'active', 'completed')
- `createdBy` (ObjectId, ref: User)

### CompetitionRound Model
**File:** `models/CompetitionRound.js`

**Fields:**
- `year` (Number, required)
- `level` (String: 'Council', 'Regional', 'National')
- `status` (String: 'open', 'closed', 'completed')
- `startDate`, `endDate` (Date)
- `closedBy` (ObjectId, ref: User)
- `metadata` (Object)

### Submission Model
**File:** `models/Submission.js`

**Fields:**
- `teacher` (ObjectId, ref: User, required)
- `round` (ObjectId, ref: CompetitionRound, required)
- `subject` (String, required)
- `class` (String, required)
- `category` (String, required)
- `lessonPlanFileName` (String)
- `lessonPlanFileUrl` (String)
- `videoLink` (String, Google Drive link)
- `videoFileName` (String)
- `videoFileUrl` (String)
- `preferredLink` (String: 'Google Drive link', 'Video upload')
- `status` (String: 'pending', 'evaluated', 'promoted', 'eliminated')
- `score` (Number)
- `evaluations` (Array of ObjectIds, ref: Evaluation)
- `metadata` (Object)

### Evaluation Model
**File:** `models/Evaluation.js`

**Fields:**
- `submission` (ObjectId, ref: Submission, required)
- `judge` (ObjectId, ref: User, required)
- `score` (Number, required, 0-100)
- `comments` (String)
- `criteria` (Object: breakdown of scores)
- `status` (String: 'pending', 'completed')
- `createdAt`, `updatedAt` (timestamps)

### Other Models
- **Quota**: Manages submission quotas per region/council
- **TieBreaking**: Handles tie-breaking scenarios
- **Notification**: User notifications
- **EmailLog**: Email sending logs
- **EmailOTP**: OTP storage for email verification
- **PasswordReset**: Password reset tokens
- **SystemLog**: System activity logging
- **LandingPage**: Landing page content sections

---

## API Routes

### Base URL
- Development: `http://localhost:5000/api`
- Production: `https://your-backend-url.com/api`

### Authentication Routes (`/api/auth`)
**File:** `routes/auth.js`

| Method | Endpoint | Description | Auth Required |
|--------|----------|-------------|----------------|
| POST | `/login` | User login | No |
| POST | `/register` | Teacher registration | No |
| GET | `/me` | Get current user | Yes |
| PUT | `/profile` | Update user profile | Yes |
| POST | `/verify-otp-and-login` | Verify OTP and login (admin/judge) | No |
| POST | `/resend-otp` | Resend OTP email | No |
| POST | `/forgot-password` | Request password reset | No |
| POST | `/verify-password-reset-otp` | Verify password reset OTP | No |
| POST | `/reset-password` | Reset password with OTP | No |

**Example Login Request:**
```json
POST /api/auth/login
{
  "email": "user@example.com",
  "password": "password123"
}
```

**Example Response:**
```json
{
  "success": true,
  "token": "jwt_token_here",
  "user": {
    "id": "...",
    "name": "John Doe",
    "email": "user@example.com",
    "role": "teacher"
  }
}
```

### User Routes (`/api/users`)
**File:** `routes/users.js`
**Access:** Admin, Superadmin

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | Get all users (paginated) |
| GET | `/:id` | Get user by ID |
| POST | `/` | Create new user (admin/judge) |
| PUT | `/:id` | Update user |
| DELETE | `/:id` | Delete user |
| PUT | `/:id/status` | Update user status |

### Submission Routes (`/api/submissions`)
**File:** `routes/submissions.js`

| Method | Endpoint | Description | Role Access |
|--------|----------|-------------|-------------|
| GET | `/` | Get submissions (filtered) | All |
| GET | `/:id` | Get submission details | All |
| POST | `/` | Create submission (creates notification for teacher) | Teacher |
| PUT | `/:id` | Update submission | Teacher |
| DELETE | `/:id` | Delete submission | Teacher |
| GET | `/draft/:id` | Get draft submission | Teacher |
| POST | `/draft` | Save draft submission | Teacher |
| PUT | `/draft/:id` | Update draft submission | Teacher |

**Note:** When a submission is successfully created via `POST /`, the system automatically:
- Creates a system notification for the teacher with type `submission_successful`
- Sends an email notification to the teacher
- Includes submission details (subject, round name) in the notification

**Query Parameters (GET /):**
- `level`: Filter by level (Council, Regional, National)
- `status`: Filter by status (pending, evaluated, promoted, eliminated)
- `year`: Filter by competition year
- `subject`: Filter by subject
- `class`: Filter by class
- `region`: Filter by region
- `council`: Filter by council
- `search`: Search in teacher name/email

### Competition Routes (`/api/competitions`)
**File:** `routes/competitions.js`

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | Get all competitions |
| GET | `/:year` | Get competition by year |
| POST | `/` | Create competition (Superadmin) |
| PUT | `/:year` | Update competition (Superadmin) |

### Competition Round Routes (`/api/competition-rounds`)
**File:** `routes/competitionRounds.js`
**Access:** Superadmin

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | Get all rounds |
| GET | `/:id` | Get round by ID |
| POST | `/` | Create round |
| PUT | `/:id` | Update round |
| DELETE | `/:id` | Delete round |
| POST | `/:id/close` | Close round |
| POST | `/:id/advance` | Advance submissions to next round |

### Evaluation Routes (`/api/evaluations`)
**File:** `routes/evaluations.js`
**Access:** Judge

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | Get evaluations |
| GET | `/:id` | Get evaluation by ID |
| POST | `/` | Create evaluation |
| PUT | `/:id` | Update evaluation |
| DELETE | `/:id` | Delete evaluation |

### Upload Routes (`/api/uploads`)
**File:** `routes/uploads.js`

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/lesson-plan` | Upload lesson plan PDF |
| POST | `/video` | Upload video file |
| GET | `/files/:filename` | Download file |

**File Limits:**
- Lesson Plans: PDF only, 10MB max
- Videos: MP4, WebM, OGG, MOV, AVI, 500MB max

### Other Routes
- **Quotas** (`/api/quotas`): Manage submission quotas
- **Tie Breaking** (`/api/tie-breaking`): Handle tie-breaking
- **System Logs** (`/api/system-logs`): View system logs (Superadmin)
- **Landing Page** (`/api/landing-page`): Manage landing page content
- **Notifications** (`/api/notifications`): User notifications

---

## Authentication & Authorization

### JWT Authentication

**Token Format:**
```
Authorization: Bearer <jwt_token>
```

**Token Structure:**
- Contains user ID and role
- Expires after 30 days
- Stored in localStorage on frontend

### Middleware

**Protect Middleware** (`middleware/auth.js`)
- Verifies JWT token
- Attaches user to `req.user`
- Checks user status (must be 'active')

**Usage:**
```javascript
const { protect } = require('../middleware/auth');
router.get('/protected-route', protect, handler);
```

**Authorize Middleware** (`middleware/auth.js`)
- Checks user role
- Must be used after `protect`

**Usage:**
```javascript
const { authorize } = require('../middleware/auth');
router.get('/admin-only', protect, authorize('admin', 'superadmin'), handler);
```

### Role-Based Access

| Role | Permissions |
|------|-------------|
| **Teacher** | Create/edit own submissions, view own submissions |
| **Judge** | View assigned submissions, create evaluations |
| **Admin** | Manage users (teachers/judges), view all submissions, manage competitions |
| **Superadmin** | Full system access, manage rounds, system logs, landing page |

---

## Middleware

### Custom Middleware

1. **protect** (`middleware/auth.js`)
   - Verifies JWT token
   - Ensures user is active

2. **authorize** (`middleware/auth.js`)
   - Role-based access control
   - Usage: `authorize('admin', 'superadmin')`

3. **logger** (`middleware/logger.js`)
   - Logs user activities
   - Creates SystemLog entries

### Third-Party Middleware

- **CORS**: Cross-origin resource sharing
- **Helmet**: Security headers
- **express-rate-limit**: Rate limiting with `trustProxy: 1` (trusts only first proxy to prevent IP spoofing)
- **express-mongo-sanitize**: MongoDB injection prevention
- **express.json()**: JSON body parser
- **express.urlencoded()**: URL-encoded body parser

### Trust Proxy Configuration

The application uses `app.set('trust proxy', 1)` to trust only the first proxy (hosting provider). This:
- Prevents IP spoofing attacks
- Works correctly behind reverse proxies (Render, Railway, etc.)
- Ensures accurate client IP detection for rate limiting
- Rate limiters are configured with `trustProxy: 1` to match this setting

---

## Services

### Email Service (`services/emailService.js`)

**Methods:**
- `initialize()`: Initialize SMTP transporter
- `sendEmail(options)`: Send email
- `sendOTPVerification(email, otp, userName)`: Send OTP email
- `sendPasswordResetOTP(email, otp, userName)`: Send password reset OTP
- `sendSystemNotification(...)`: Send system notification
- `sendSubmissionSuccessfulEmail(...)`: Submission confirmation
- `sendSubmissionResultEmail(...)`: Evaluation results
- `testConnection()`: Test SMTP connection

**Email Templates:**
- OTP Verification
- Password Reset
- System Notifications
- Submission Confirmations
- Evaluation Results
- Reminders

### Notification Service (`services/notificationService.js`)

**Methods:**
- `createNotification(userId, type, title, message, metadata)`
- `markAsRead(notificationId)`
- `getUserNotifications(userId, filters)`
- `handleSubmissionSuccessful(data)` - Creates notification and sends email when teacher submits successfully

**Notification Types:**
- `submission_successful` - Sent to teachers when submission is created
- `submission_promoted` - Sent when submission advances to next round
- `submission_eliminated` - Sent when submission is eliminated
- `judge_assigned` - Sent to judges when assigned to a round
- `evaluation_reminder` - Sent to judges for pending evaluations
- `round_started`, `round_ending_soon`, `round_ended` - Competition round events

### OTP Service (`services/otpService.js`)

**Methods:**
- `generateOTP()`: Generate 6-digit OTP
- `hashOTP(otp)`: Hash OTP
- `verifyOTP(plainOTP, hashedOTP)`: Verify OTP
- `createOTP(email)`: Create and store OTP
- `verifyOTPAndUpdate(email, otp)`: Verify and mark as used

---

## File Uploads

### Configuration (`routes/uploads.js`)

**Storage:**
- Lesson Plans: `uploads/lesson-plan/`
- Videos: `uploads/videos/`

**Multer Configuration:**
- Lesson Plans: PDF only, 10MB limit
- Videos: MP4 only, 110MB limit

**File Naming:**
- Format: `{timestamp}-{userId}-{originalFilename}`
- Prevents filename conflicts

**Access:**
- Files served via `/api/uploads/files/:filename`
- Requires authentication token (query param or header)

---

## Error Handling

### Error Response Format
```json
{
  "success": false,
  "message": "Error message here"
}
```

### HTTP Status Codes
- `200`: Success
- `201`: Created
- `400`: Bad Request
- `401`: Unauthorized
- `403`: Forbidden
- `404`: Not Found
- `500`: Internal Server Error

### Error Handler (`utils/errorHandler.js`)
- Centralized error handling
- Logs errors to SystemLog
- Returns appropriate status codes

---

## Deployment

### Railway Deployment

1. **Environment Variables**
   - Set all variables in Railway dashboard
   - Ensure `NODE_ENV=production`
   - Set `CLIENT_URL` to frontend URL

2. **Build Configuration**
   - No build step required
   - Start command: `npm start`

3. **File Storage**
   - Uploads stored in `uploads/` directory
   - Consider using cloud storage (S3) for production

### Health Check
- Endpoint: `/api/health`
- Returns server status and timestamp

---

## Scripts & Utilities

### Available Scripts

```bash
npm start              # Start production server
npm run dev            # Start development server (nodemon)
npm run create-superadmin  # Create superadmin user
npm run seed:landing   # Seed landing page content
```

### Utility Scripts

**migrateUploads.js**
- Migrates files from root `uploads/` to subfolders
- Run: `node scripts/migrateUploads.js`

**roundScheduler.js**
- Automated round processing
- Runs every 5 minutes
- Checks for rounds to close/advance

---

## Best Practices

1. **Security**
   - Always use `protect` middleware for authenticated routes
   - Use `authorize` for role-based access
   - Validate input with Joi schemas
   - Sanitize user input

2. **Error Handling**
   - Always use try-catch blocks
   - Return consistent error format
   - Log errors appropriately

3. **Database**
   - Use Mongoose validation
   - Index frequently queried fields
   - Use pagination for large datasets

4. **Performance**
   - Use `.select()` to limit returned fields
   - Implement pagination
   - Cache frequently accessed data

5. **Code Organization**
   - Keep routes thin, move logic to services
   - Reuse common functions
   - Document complex logic

---

## Troubleshooting

### Common Issues

1. **MongoDB Connection Error**
   - Check `MONGODB_URI` is correct
   - Ensure MongoDB is running/accessible

2. **Email Not Sending**
   - Verify Gmail credentials
   - Check App Password is correct (not regular password)
   - Test connection: `emailService.testConnection()`

3. **CORS Errors**
   - Verify `CLIENT_URL` matches frontend URL exactly
   - Check CORS configuration in `server.js`

4. **JWT Errors**
   - Ensure `JWT_SECRET` is set
   - Check token expiration
   - Verify token format

---

## Support & Resources

- **MongoDB Documentation:** https://docs.mongodb.com/
- **Express.js Documentation:** https://expressjs.com/
- **Mongoose Documentation:** https://mongoosejs.com/
- **JWT Documentation:** https://jwt.io/

---

**Last Updated:** 2024
**Version:** 1.0.0

