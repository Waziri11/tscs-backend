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
- Evaluation and scoring system with 1-to-1 and 1-to-many judging models
- Judge assignment system (round-robin for Council/Regional levels)
- Submission disqualification system
- Leaderboard generation (per area of focus and overall)
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

# Email Configuration (Brevo)
BREVO_API_KEY=your-brevo-api-key
BREVO_SENDER_EMAIL=your-verified-sender@example.com
BREVO_SENDER_NAME=TSCS
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
| `BREVO_API_KEY` | Yes | Brevo Transactional Emails API key |
| `BREVO_SENDER_EMAIL` | Yes | Verified sender email in Brevo |
| `BREVO_SENDER_NAME` | No | Friendly sender name (defaults to `TSCS`) |
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
│   ├── SubmissionAssignment.js # Judge-submission assignments (1-to-1)
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
│   ├── roundScheduler.js   # Automated round processing
│   └── judgeAssignment.js  # Round-robin judge assignment logic
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
- `assignedLevel` (String, Enum: 'Council', 'Regional', 'National', for judges)
- `assignedRegion` (String, for judges)
- `assignedCouncil` (String, for judges)
- `areasOfFocus` (Array of Strings, for judges - multiple areas allowed)
- `department` (String, for admins)
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
- `teacherId` (ObjectId, ref: User, required)
- `roundId` (ObjectId, ref: CompetitionRound, optional)
- `year` (Number, required)
- `level` (String: 'Council', 'Regional', 'National', required)
- `region` (String, required)
- `council` (String, optional - for Council level)
- `subject` (String, required)
- `class` (String, required)
- `category` (String, required)
- `areaOfFocus` (String, required)
- `school` (String, required)
- `teacherName` (String, required)
- `lessonPlanFileName` (String)
- `lessonPlanFileUrl` (String)
- `videoLink` (String, Google Drive link)
- `videoFileName` (String)
- `videoFileUrl` (String)
- `preferredLink` (String: 'Google Drive link', 'Video upload')
- `status` (String: 'submitted', 'under_review', 'evaluated', 'promoted', 'eliminated')
- `averageScore` (Number, calculated from evaluations)
- `assignedJudgeId` (ObjectId, ref: User, for Council/Regional levels)
- `isDisqualified` (Boolean, default: false)
- `disqualificationReason` (String)
- `disqualifiedBy` (ObjectId, ref: User)
- `disqualifiedAt` (Date)
- `evaluations` (Array of ObjectIds, ref: Evaluation)
- `metadata` (Object)
- `createdAt`, `updatedAt` (timestamps)

### SubmissionAssignment Model
**File:** `models/SubmissionAssignment.js`

**Purpose:** Tracks 1-to-1 judge-submission assignments for Council and Regional levels. National level uses 1-to-many judging (no assignments needed).

**Fields:**
- `submissionId` (ObjectId, ref: Submission, required, unique)
- `judgeId` (ObjectId, ref: User, required)
- `level` (String, Enum: 'Council', 'Regional', required)
- `region` (String, required)
- `council` (String, optional - for Council level)
- `assignedAt` (Date, default: Date.now)
- `judgeNotified` (Boolean, default: false)
- `createdAt`, `updatedAt` (timestamps)

**Indexes:**
- `{ judgeId: 1, level: 1 }` - Efficient querying by judge and level
- `{ submissionId: 1, judgeId: 1 }` - Ensure unique assignment
- `{ level: 1, region: 1, council: 1 }` - Location-based queries

### Evaluation Model
**File:** `models/Evaluation.js`

**Fields:**
- `submissionId` (ObjectId, ref: Submission, required)
- `judgeId` (ObjectId, ref: User, required)
- `scores` (Map<String, Number>, required - criteria breakdown)
- `totalScore` (Number, required, calculated)
- `averageScore` (Number, required, calculated)
- `comments` (String, optional)
- `submittedAt` (Date, default: Date.now)
- `createdAt`, `updatedAt` (timestamps)

**Indexes:**
- `{ submissionId: 1, judgeId: 1 }` - Unique evaluation per judge-submission pair
- `{ submissionId: 1 }` - Query all evaluations for a submission

**Note:** For Council/Regional levels, only one evaluation per submission is allowed (1-to-1 judging). For National level, multiple evaluations are allowed (1-to-many judging).

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
- **For Council/Regional levels:** Automatically assigns a judge using round-robin algorithm
- **For Council/Regional levels:** Sends notifications to assigned judge, admins, and superadmins

**Query Parameters (GET /):**
- `level`: Filter by level (Council, Regional, National)
- `status`: Filter by status (submitted, under_review, evaluated, promoted, eliminated)
- `year`: Filter by competition year
- `subject`: Filter by subject
- `class`: Filter by class
- `region`: Filter by region
- `council`: Filter by council
- `areaOfFocus`: Filter by area of focus
- `search`: Search in teacher name/email

**Judge Filtering:**
- **Council/Regional judges:** Only see submissions explicitly assigned to them via `SubmissionAssignment`
- **National judges:** See all submissions matching their `areasOfFocus` within their assigned location

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
| GET | `/:id/judge-progress` | Get judge progress for a round |
| GET | `/:id/judge-progress/export` | Export judge progress as CSV |

### Evaluation Routes (`/api/evaluations`)
**File:** `routes/evaluations.js`
**Access:** Judge

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | Get evaluations (filtered by judge) |
| GET | `/:id` | Get evaluation by ID |
| POST | `/` | Create/update evaluation |
| PUT | `/:id` | Update evaluation |
| DELETE | `/:id` | Delete evaluation |
| POST | `/:submissionId/disqualify` | Flag submission for disqualification (Council/Regional only) |

**Evaluation Logic:**
- **Council/Regional Levels (1-to-1):**
  - Only the assigned judge (via `SubmissionAssignment`) can evaluate
  - Single evaluation per submission
  - Final score = assigned judge's average score
- **National Level (1-to-many):**
  - Multiple judges can evaluate the same submission
  - Judges are filtered by `areasOfFocus` matching submission's `areaOfFocus`
  - Final score = average of all judges' average scores

**Disqualification Endpoint:**
- `POST /api/evaluations/:submissionId/disqualify`
- Only available for Council/Regional level submissions
- Only the assigned judge can disqualify
- Requires `reason` in request body
- Updates submission with `isDisqualified: true` and related fields

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

### Leaderboard Routes (`/api/submissions/leaderboard`)
**File:** `routes/submissions.js`
**Access:** Admin, Superadmin, Judge

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/leaderboard/council` | Get council level leaderboard |
| GET | `/leaderboard/regional` | Get regional level leaderboard |
| GET | `/leaderboard/national` | Get national level leaderboard |

**Query Parameters:**
- `year` (required): Competition year
- `region` (required for council/regional): Region filter
- `council` (required for council): Council filter
- `areaOfFocus` (optional): Filter by area of focus (use 'all' for overall)

**Response Format:**
- **Council:** Returns `overallLeaderboard` and `leaderboardByArea` (top 3 per area)
- **Regional/National:** Returns single `leaderboard` array
- All leaderboards exclude disqualified submissions
- Sorted by `averageScore` descending (highest first)
- Includes rank, submission details, teacher info, and scores

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
- `handleJudgeAssigned(data)` - Creates notification and sends email when judge is assigned to a submission

**Notification Types:**
- `submission_successful` - Sent to teachers when submission is created
- `submission_promoted` - Sent when submission advances to next round
- `submission_eliminated` - Sent when submission is eliminated
- `judge_assigned` - Sent to judges when assigned to a submission (Council/Regional)
- `evaluation_reminder` - Sent to judges for pending evaluations
- `round_started`, `round_ending_soon`, `round_ended` - Competition round events
- `admin_notification` - Sent to admins/superadmins when submissions are assigned to judges

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

**judgeAssignment.js**
- Round-robin judge assignment algorithm
- Assigns judges to Council/Regional submissions automatically
- Ensures even distribution of submissions among available judges
- Finds judges by level, region, and council
- Creates `SubmissionAssignment` records
- Sends notifications to judges, admins, and superadmins
- **Function:** `assignJudgeToSubmission(submission)` - Returns assignment result

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

---

## Judging Process

### Judge Assignment System

**Assignment Algorithm:** Round-robin distribution for even workload distribution

**Council Level:**
- Each submission is assigned to exactly one judge from the same council
- Judge evaluates and provides final score (1-to-1 judging)
- Judges see only submissions assigned to them
- Judges can flag submissions for disqualification

**Regional Level:**
- Each submission is assigned to exactly one judge from the same region
- Judge evaluates and provides final score (1-to-1 judging)
- Judges see only submissions assigned to them
- Judges can flag submissions for disqualification

**National Level:**
- No explicit assignment (1-to-many judging)
- Multiple judges evaluate the same submission simultaneously
- Judges are filtered by `areasOfFocus` matching submission's area
- Final score = average of all judges' scores

### Score Calculation

**Council/Regional (1-to-1):**
```javascript
finalScore = assignedJudge.averageScore
```

**National (1-to-many):**
```javascript
finalScore = average(allJudges.map(j => j.averageScore))
```

### Disqualification System

- Only Council/Regional level submissions can be disqualified by judges
- Only the assigned judge can disqualify their assigned submission
- Disqualified submissions are excluded from leaderboards
- Disqualified submissions do not advance to next round
- Main advancement criteria: Top N based on quota (leaderboard ranking)

### Leaderboard System

**Council Level:**
- Per area of focus leaderboards (top 3 per area)
- Overall leaderboard (all submissions ranked)
- Grouped by region, council, and area of focus

**Regional Level:**
- Single leaderboard for all submissions in the region
- Can be filtered by area of focus

**National Level:**
- Single leaderboard for all submissions
- Can be filtered by area of focus

**All Levels:**
- Exclude disqualified submissions
- Rank by `averageScore` (descending)
- Include rank, submission details, teacher info, scores

### Round Closure Logic

**Judge Completion Check:**
- **Council/Regional:** Checks if assigned judge has evaluated
- **National:** Checks if all judges (matching `areasOfFocus`) have evaluated

**Advancement Logic:**
- Excludes disqualified submissions
- Applies quota per location (and area for Council)
- Promotes top N submissions based on quota
- Marks remaining as eliminated

## Recent Updates (2024-2025)

### Judging Process Implementation (January 2025)
- Implemented 1-to-1 judging for Council/Regional levels
- Implemented 1-to-many judging for National level
- Added round-robin judge assignment system
- Added `SubmissionAssignment` model for tracking assignments
- Added disqualification system for judges
- Added leaderboard endpoints (council, regional, national)
- Updated evaluation logic to differentiate between judging models
- Updated round closure logic to handle both judging models
- Added notifications for judge assignments
- Updated User model: Added `areasOfFocus` field, removed `specialization` and `experience`
- Updated Submission model: Added disqualification fields and `assignedJudgeId`

### Judge Progress Export
- Added CSV export endpoint for judge progress
- Includes judge details, location, assigned/completed/pending counts, and progress percentage
- Accessible via `/api/competition-rounds/:id/judge-progress/export`
- Updated to use `SubmissionAssignment` for Council/Regional judges

### Development Workflow
- Updated root `package.json` to wait for backend before starting frontend
- Uses `wait-on` to prevent Vite proxy ECONNREFUSED errors
- Backend starts first, then frontend waits for port 5000

---

**Last Updated:** January 2025
**Version:** 1.2.0
