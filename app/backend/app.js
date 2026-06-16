/**
 * Massar Mock Portal Application
 * Simulates the Moroccan Ministry of Education student portal running on AWS ECS Fargate.
 * 
 * Integration:
 * - AWS Secrets Manager (fetches database credentials at startup)
 * - Amazon Cognito (user authentication and JWT verification)
 * - AWS SQS (sends student results notifications)
 * - Aurora Serverless v2 MySQL via RDS Proxy (relational storage)
 * - ElastiCache Redis (caching student results)
 */

const express = require("express");
const mysql = require("mysql2/promise");
const Redis = require("ioredis");
const { CognitoJwtVerifier } = require("aws-jwt-verify");
const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");
const { SQSClient, SendMessageCommand } = require("@aws-sdk/client-sqs");
const { 
  CognitoIdentityProviderClient, 
  AdminCreateUserCommand, 
  AdminSetUserPasswordCommand, 
  AdminDeleteUserCommand, 
  AdminUpdateUserAttributesCommand 
} = require("@aws-sdk/client-cognito-identity-provider");

const app = express();
app.use(express.json());

// Load and validate crucial environment variables
const REGION = process.env.AWS_REGION || "eu-south-1";
const PORT = process.env.PORT || 3000;

// AWS Clients Instantiations (Credential loading is managed by ECS Task Role)
const secretsClient = new SecretsManagerClient({ region: REGION });
const sqsClient = new SQSClient({ region: REGION });
const cognitoClient = new CognitoIdentityProviderClient({ region: REGION });

// Global holders for Database Credentials and Pool
let dbCredentials = null;
let dbPool = null;

// Initialize JWT Verifier dynamically if environment variables are present
let jwtVerifier = null;
if (process.env.COGNITO_USER_POOL_ID && process.env.USER_POOL_CLIENT_ID) {
  jwtVerifier = CognitoJwtVerifier.create({
    userPoolId: process.env.COGNITO_USER_POOL_ID,
    tokenUse: "access",
    clientId: process.env.USER_POOL_CLIENT_ID,
  });
  console.log("Cognito JWT Verifier successfully configured.");
} else {
  console.warn("Warning: COGNITO_USER_POOL_ID or USER_POOL_CLIENT_ID not defined. JWT verification will fail routes.");
}

// Initialize ElastiCache Redis Client
let redis = null;
if (process.env.ELASTICACHE_ENDPOINT) {
  let redisHost = process.env.ELASTICACHE_ENDPOINT;
  let redisPort = 6379;

  // Split endpoint if it contains host:port format
  if (redisHost.includes(":")) {
    const parts = redisHost.split(":");
    redisHost = parts[0];
    redisPort = parseInt(parts[1], 10);

  }

  console.log(`Configuring Redis connection to ${redisHost}:${redisPort}`);
  redis = new Redis({
    host: redisHost,
    port: redisPort,
    tls: {}, // Enable TLS for in-transit encryption — required since ElastiCache transit_encryption_enabled = true
    lazyConnect: true,          // Prevents startup crashes if Redis is temporarily unreachable
    maxRetriesPerRequest: 1,    // Fails commands fast so we can fall back to database immediately
    retryStrategy(times) {
      console.log(`Redis reconnect attempt #${times}...`);
      return Math.min(times * 1000, 5000); // Retry backoff up to 5s
    }
  });

  redis.on("error", (err) => {
    console.error("Redis Client Error:", err.message);
  });

  redis.on("connect", () => {
    console.log("Redis Client connected.");
  });
} else {
  console.warn("Warning: ELASTICACHE_ENDPOINT environment variable not configured. Redis caching is disabled.");
}

/**
 * Fetches database credentials from Secrets Manager.
 * Reuses cached credentials if already retrieved.
 */
async function getDbCredentials() {
  if (dbCredentials) return dbCredentials;

  const secretArn = process.env.DB_SECRET_ARN;
  if (!secretArn) {
    throw new Error("DB_SECRET_ARN environment variable is not defined");
  }

  console.log(`Fetching database credentials from Secrets Manager: ${secretArn}`);
  try {
    const command = new GetSecretValueCommand({ SecretId: secretArn });
    const data = await secretsClient.send(command);
    if (!data.SecretString) {
      throw new Error("Secrets Manager returned empty SecretString");
    }
    dbCredentials = JSON.parse(data.SecretString);
    return dbCredentials;
  } catch (error) {
    console.error("Error retrieving DB credentials from Secrets Manager:", error.message);
    throw error;
  }
}

/**
 * Returns a configured MySQL Connection Pool.
 * If the pool has not been initialized yet, it tries to fetch credentials and create it.
 */
async function getDbPool() {
  if (dbPool) return dbPool;

  try {
    const credentials = await getDbCredentials();
    const dbName = process.env.DB_NAME || "massardb";
    const dbHost = process.env.RDS_PROXY_ENDPOINT;

    if (!dbHost) {
      throw new Error("RDS_PROXY_ENDPOINT environment variable is not defined");
    }

    console.log(`Creating MySQL Connection Pool targeting RDS Proxy: ${dbHost}`);
    dbPool = mysql.createPool({
      host: dbHost,
      user: credentials.username,
      password: credentials.password,
      database: dbName,
      connectionLimit: 10, // Maximum pool size (limit 10)
      waitForConnections: true,
      queueLimit: 0,
      ssl: "Amazon RDS"
    });
    return dbPool;
  } catch (error) {
    console.error("MySQL Connection Pool initialization failed:", error.message);
    throw error;
  }
}

/**
 * Authentication Middleware for checking and verifying Cognito access tokens.
 */
const authMiddleware = async (req, res, next) => {
  if (!jwtVerifier) {
    return res.status(500).json({ error: "Authentication system is not configured on the server" });
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized: Missing or invalid Authorization header" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const payload = await jwtVerifier.verify(token);
    req.user = payload; // Attach decoded JWT payload to the request
    next();
  } catch (error) {
    console.error("JWT Verification failed:", error.message);
    return res.status(401).json({ error: "Unauthorized: Invalid or expired token" });
  }
};

/**
 * Authentication Middleware for verifying that the user belongs to the "teachers" group.
 * Assumes authMiddleware has already run and set req.user.
 */
const teacherMiddleware = (req, res, next) => {
  const groups = req.user["cognito:groups"] || [];
  if (!groups.includes("teachers")) {
    return res.status(403).json({ error: "Forbidden: Access restricted to teachers only" });
  }
  next();
};

/**
 * Authentication Middleware for verifying that the user belongs to the "admins" group.
 * Assumes authMiddleware has already run and set req.user.
 */
const adminMiddleware = (req, res, next) => {
  const groups = req.user["cognito:groups"] || [];
  if (!groups.includes("admins")) {
    return res.status(403).json({ error: "Forbidden: Access restricted to administrators only" });
  }
  next();
};

/**
 * ROUTE 1: GET /health
 * Public health check endpoint utilized by Application Load Balancers.
 * Does not block startup or crash even if DB/Redis is down.
 */
app.get("/health", (req, res) => {
  res.status(200).json({ status: "healthy" });
});

/**
 * ROUTE 3: GET /resultss
 * Protected route to get the authenticated student's results.
 * Pulls code_massar from JWT claims, checks Redis first, then falls back to Aurora MySQL.
 */
app.get("/api/results", authMiddleware, async (req, res) => {
  // Extract user identifier from claims (expects email or username: e.g. K130029841@taalim.ma or K130029841)
  const cognitoUser = req.user.username || req.user["cognito:username"] || req.user.email || "";
  const code_massar = cognitoUser.split("@")[0].toUpperCase();

  if (!code_massar) {
    return res.status(400).json({ error: "Invalid user claim format. Cannot parse code_massar." });
  }

  const cacheKey = `results:${code_massar}`;
  let cachedResults = null;

  // 1. Try fetching from Redis Cache (Failure-safe)
  if (redis && redis.status === "ready") {
    try {
      const data = await redis.get(cacheKey);
      if (data) {
        cachedResults = JSON.parse(data);
        console.log(`Cache HIT for student: ${code_massar}`);
      }
    } catch (err) {
      console.warn(`Redis GET failed for ${cacheKey}, falling back to DB:`, err.message);
    }
  }

  if (cachedResults) {
    return res.status(200).json(cachedResults);
  }

  // 2. Cache Miss: Query Aurora MySQL via RDS Proxy
  try {
    const db = await getDbPool();
    
    // Fetch Student data
    const [students] = await db.query(
      "SELECT id, code_massar, full_name, email, phone, result FROM students WHERE code_massar = ?",
      [code_massar]
    );

    if (students.length === 0) {
      return res.status(404).json({ error: `Results for student with code ${code_massar} not found` });
    }

    const student = students[0];

    // Fetch Subject Grades
    const [subjectGrades] = await db.query(
      "SELECT subject_name, grade FROM subject_results WHERE student_id = ?",
      [student.id]
    );

    // Format the response payload
    const payload = {
      full_name: student.full_name,
      code_massar: student.code_massar,
      result: student.result,
      subject_results: subjectGrades.map(row => ({
        subject_name: row.subject_name,
        grade: parseFloat(row.grade)
      }))
    };

    // 3. Write back to Redis Cache (Failure-safe, TTL: 300 seconds)
    if (redis && redis.status === "ready") {
      try {
        await redis.set(cacheKey, JSON.stringify(payload), "EX", 300);
        console.log(`Cached results for student ${code_massar} for 300 seconds.`);
      } catch (err) {
        console.warn(`Redis SET failed for ${cacheKey}:`, err.message);
      }
    }

    return res.status(200).json(payload);
  } catch (error) {
    console.error(`Error retrieving results for student ${code_massar}:`, error.message);
    return res.status(500).json({ error: "Failed to fetch student results from database or they are no students available" });
  }
});

/**
 * ROUTE 5: GET /teacher/students
 * Protected route for teachers to list all students and their grades.
 */
app.get("/api/teacher/students", authMiddleware, teacherMiddleware, async (req, res) => {
  try {
    const db = await getDbPool();
    const [rows] = await db.query(`
      SELECT 
        s.id, 
        s.code_massar, 
        s.full_name, 
        s.email, 
        s.phone, 
        s.result,
        sr.subject_name,
        sr.grade
      FROM students s
      LEFT JOIN subject_results sr ON s.id = sr.student_id
    `);

    const studentMap = {};
    rows.forEach(row => {
      if (!studentMap[row.id]) {
        studentMap[row.id] = {
          id: row.id,
          code_massar: row.code_massar,
          full_name: row.full_name,
          email: row.email,
          phone: row.phone,
          result: row.result,
          subject_results: []
        };
      }
      if (row.subject_name) {
        studentMap[row.id].subject_results.push({
          subject_name: row.subject_name,
          grade: parseFloat(row.grade)
        });
      }
    });

    return res.status(200).json(Object.values(studentMap));
  } catch (error) {
    console.error("Error retrieving student list for teacher:", error.message);
    return res.status(500).json({ error: "Failed to fetch student list from database" });
  }
});

/**
 * ROUTE 6: POST /teacher/grades
 * Protected route for teachers to input/edit student grades.
 * Body: { code_massar, subject_name, grade }
 */
app.post("/api/teacher/grades", authMiddleware, teacherMiddleware, async (req, res) => {
  const { code_massar, subject_name, grade } = req.body;

  if (!code_massar || !subject_name || typeof grade === "undefined") {
    return res.status(400).json({ error: "Missing required parameters: code_massar, subject_name, and grade are required" });
  }

  const parsedGrade = parseFloat(grade);
  if (isNaN(parsedGrade) || parsedGrade < 0 || parsedGrade > 20) {
    return res.status(400).json({ error: "Grade must be a valid number between 0 and 20" });
  }

  const normalizedCode = code_massar.trim().toUpperCase();

  try {
    const db = await getDbPool();

    // 1. Get student ID
    const [students] = await db.query(
      "SELECT id FROM students WHERE code_massar = ?",
      [normalizedCode]
    );

    if (students.length === 0) {
      return res.status(404).json({ error: `Student with code ${normalizedCode} not found` });
    }

    const studentId = students[0].id;

    // 2. Check if grade exists
    const [grades] = await db.query(
      "SELECT id FROM subject_results WHERE student_id = ? AND subject_name = ?",
      [studentId, subject_name]
    );

    if (grades.length > 0) {
      // Update
      await db.query(
        "UPDATE subject_results SET grade = ? WHERE student_id = ? AND subject_name = ?",
        [parsedGrade, studentId, subject_name]
      );
    } else {
      // Insert
      await db.query(
        "INSERT INTO subject_results (student_id, subject_name, grade) VALUES (?, ?, ?)",
        [studentId, subject_name, parsedGrade]
      );
    }

    // 3. Recalculate average and update student status (Admis vs Ajourné)
    const [allGrades] = await db.query(
      "SELECT grade FROM subject_results WHERE student_id = ?",
      [studentId]
    );

    let total = 0;
    allGrades.forEach(row => {
      total += parseFloat(row.grade);
    });
    const average = allGrades.length > 0 ? (total / allGrades.length) : 0;
    const finalResult = average >= 10.0 ? "Admis" : "Ajourné";

    await db.query(
      "UPDATE students SET result = ? WHERE id = ?",
      [finalResult, studentId]
    );

    // 4. Invalidate/Delete Redis Cache key for the student
    const cacheKey = `results:${normalizedCode}`;
    if (redis && redis.status === "ready") {
      try {
        await redis.del(cacheKey);
        console.log(`Cache invalidated for key: ${cacheKey}`);
      } catch (err) {
        console.warn(`Failed to delete Redis cache key ${cacheKey}:`, err.message);
      }
    }

    return res.status(200).json({
      message: "Grade successfully updated",
      student_code: normalizedCode,
      subject: subject_name,
      grade: parsedGrade,
      new_average: parseFloat(average.toFixed(2)),
      new_result: finalResult
    });
  } catch (error) {
    console.error(`Error updating grade for student ${normalizedCode}:`, error.message);
    return res.status(500).json({ error: "Failed to update grade in database" });
  }
});

/**
 * ROUTE 4: POST /admin/release-results
 * Protected route for administrator to trigger SQS notification releases.
 * Queries all students from DB, and sends messages to SQS queue.
 */
app.post("/api/admin/release-results", authMiddleware, adminMiddleware, async (req, res) => {
  const queueUrl = process.env.SQS_QUEUE_URL;
  if (!queueUrl) {
    return res.status(500).json({ error: "SQS Queue URL environment variable not configured" });
  }

  try {
    const db = await getDbPool();

    // Query all students and their subject grades
    const [rows] = await db.query(`
      SELECT 
        s.id, 
        s.full_name, 
        s.email, 
        s.phone, 
        s.result,
        sr.subject_name,
        sr.grade
      FROM students s
      LEFT JOIN subject_results sr ON s.id = sr.student_id
    `);

    if (rows.length === 0) {
      return res.status(200).json({ message: "No student records found to release", count: 0 });
    }

    // Group rows by student id to build array of subjects per student
    const studentMap = {};
    rows.forEach(row => {
      if (!studentMap[row.id]) {
        studentMap[row.id] = {
          full_name: row.full_name,
          email: row.email,
          phone: row.phone,
          result: row.result,
          subjects: []
        };
      }
      if (row.subject_name) {
        studentMap[row.id].subjects.push({
          subject_name: row.subject_name,
          grade: parseFloat(row.grade)
        });
      }
    });

    const studentsList = Object.values(studentMap);
    console.log(`Found ${studentsList.length} students. Sending notification payloads to SQS...`);

    // Prepare SQS SendMessage Promises to process in parallel
    const sendPromises = studentsList.map(student => {
      const messageBody = JSON.stringify({
        email: student.email,
        phone: student.phone,
        result: student.result,
        full_name: student.full_name,
        subjects: student.subjects
      });

      const command = new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: messageBody
      });

      return sqsClient.send(command);
    });

    // Wait for all messages to be queued
    await Promise.all(sendPromises);
    console.log(`Successfully queued ${studentsList.length} notification messages in SQS.`);

    return res.status(200).json({ 
      message: "Results released", 
      count: studentsList.length 
    });
  } catch (error) {
    console.error("Failed to release results:", error.message);
    return res.status(500).json({ error: "Failed to process results release" });
  }
});

/**
 * ROUTE 7: GET /admin/students
 * Protected route for admins to list all students.
 */
app.get("/api/admin/students", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const db = await getDbPool();
    const [rows] = await db.query(
      "SELECT id, code_massar, full_name, email, phone, result FROM students ORDER BY id DESC"
    );
    return res.status(200).json(rows);
  } catch (error) {
    console.error("Error retrieving student list for admin:", error.message);
    return res.status(500).json({ error: "Failed to fetch student list from database" });
  }
});

/**
 * ROUTE 8: POST /admin/students
 * Protected route for admins to create a student.
 * Body: { full_name, email, phone }
 */
app.post("/api/admin/students", authMiddleware, adminMiddleware, async (req, res) => {
  const { full_name, email, phone } = req.body;
  if (!full_name || !email || !phone) {
    return res.status(400).json({ error: "Missing required parameters: full_name, email, and phone are required" });
  }

  const cleanName = full_name.trim();
  const cleanEmail = email.trim();
  const cleanPhone = phone.trim();

  const maxAttempts = 3;
  let attempts = 0;
  let success = false;
  let code_massar = null;

  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

  try {
    const db = await getDbPool();

    while (attempts < maxAttempts && !success) {
      attempts++;
      // Generate Massar code: 1 letter + 9 digits
      const randomLetter = letters[Math.floor(Math.random() * letters.length)];
      let digits = "";
      for (let i = 0; i < 9; i++) {
        digits += Math.floor(Math.random() * 10);
      }
      code_massar = `${randomLetter}${digits}`;

      try {
        await db.query(
          "INSERT INTO students (code_massar, full_name, email, phone, result) VALUES (?, ?, ?, ?, 'Ajourné')",
          [code_massar, cleanName, cleanEmail, cleanPhone]
        );
        success = true;
      } catch (error) {
        if (error.errno === 1062 || error.code === "ER_DUP_ENTRY") {
          console.warn(`Massar code collision for code ${code_massar}. Attempt ${attempts}/${maxAttempts}. Retrying...`);
          if (attempts >= maxAttempts) {
            console.error("Max database insertion attempts reached due to Massar code collisions.");
            return res.status(500).json({ error: "Failed to generate a unique Massar code after multiple attempts. Please try again." });
          }
        } else {
          // Any other error is thrown immediately
          throw error;
        }
      }
    }

    // 2. Create Cognito user profile for the student
    const userPoolId = process.env.COGNITO_USER_POOL_ID;
    if (userPoolId) {
      try {
        // Create user in Cognito (SUPPRESS makes sure no verification email is sent)
        await cognitoClient.send(new AdminCreateUserCommand({
          UserPoolId: userPoolId,
          Username: code_massar,
          UserAttributes: [
            { Name: "email", Value: cleanEmail },
            { Name: "email_verified", Value: "true" },
            { Name: "phone_number", Value: cleanPhone },
            { Name: "phone_number_verified", Value: "true" },
            { Name: "name", Value: cleanName }
          ],
          MessageAction: "SUPPRESS"
        }));
        console.log(`Successfully created Cognito user profile for student: ${code_massar}`);

        // Set a fixed permanent password that satisfies all Cognito policy requirements
        // (uppercase, lowercase, digit, special char) to bypass FORCE_CHANGE_PASSWORD
        const permanentPassword = "Massar2024!";
        await cognitoClient.send(new AdminSetUserPasswordCommand({
          UserPoolId: userPoolId,
          Username: code_massar,
          Password: permanentPassword,
          Permanent: true
        }));
        console.log(`Successfully set permanent password for Cognito student: ${code_massar}`);

      } catch (cognitoError) {
        console.error(`Cognito registration failed for student ${code_massar}. Rolling back DB insertion...`, cognitoError.message);
        // Rollback: delete student from the database so we don't have inconsistent states
        await db.query("DELETE FROM students WHERE code_massar = ?", [code_massar]);
        return res.status(500).json({ error: `Cognito User Pool registration failed: ${cognitoError.message}` });
      }
    } else {
      console.warn("Warning: COGNITO_USER_POOL_ID is not defined. Skipping Cognito user registration.");
    }

    return res.status(201).json({
      message: "Student successfully created",
      student: {
        code_massar,
        full_name: cleanName,
        email: cleanEmail,
        phone: cleanPhone,
        result: "Ajourné"
      }
    });
  } catch (error) {
    console.error("Database error during student creation:", error.message);
    return res.status(500).json({ error: "Failed to insert student into database" });
  }
});

/**
 * ROUTE 9: PUT /admin/students/:id
 * Protected route for admins to modify student profile.
 * Body: { full_name, email, phone }
 */
app.put("/api/admin/students/:id", authMiddleware, adminMiddleware, async (req, res) => {
  const studentId = parseInt(req.params.id, 10);
  const { full_name, email, phone } = req.body;

  if (isNaN(studentId)) {
    return res.status(400).json({ error: "Invalid student ID parameter" });
  }
  if (!full_name || !email || !phone) {
    return res.status(400).json({ error: "Missing required parameters: full_name, email, and phone are required" });
  }

  const cleanName = full_name.trim();
  const cleanEmail = email.trim();
  const cleanPhone = phone.trim();

  try {
    const db = await getDbPool();

    // Check if student exists & get massar code for cache invalidation
    const [students] = await db.query(
      "SELECT code_massar FROM students WHERE id = ?",
      [studentId]
    );

    if (students.length === 0) {
      return res.status(404).json({ error: `Student with ID ${studentId} not found` });
    }

    const code_massar = students[0].code_massar;

    // Update student details
    await db.query(
      "UPDATE students SET full_name = ?, email = ?, phone = ? WHERE id = ?",
      [cleanName, cleanEmail, cleanPhone, studentId]
    );

    // Update attributes in Cognito User Pool
    const userPoolId = process.env.COGNITO_USER_POOL_ID;
    if (userPoolId) {
      try {
        await cognitoClient.send(new AdminUpdateUserAttributesCommand({
          UserPoolId: userPoolId,
          Username: code_massar,
          UserAttributes: [
            { Name: "email", Value: cleanEmail },
            { Name: "email_verified", Value: "true" },
            { Name: "phone_number", Value: cleanPhone },
            { Name: "phone_number_verified", Value: "true" },
            { Name: "name", Value: cleanName }
          ]
        }));
        console.log(`Successfully updated attributes for Cognito user: ${code_massar}`);
      } catch (cognitoError) {
        console.warn(`Failed to update attributes for Cognito user ${code_massar} (might not exist in pool):`, cognitoError.message);
      }
    }

    // Invalidate/Delete Redis Cache key for the student
    const cacheKey = `results:${code_massar}`;
    if (redis && redis.status === "ready") {
      try {
        await redis.del(cacheKey);
        console.log(`Cache invalidated for key: ${cacheKey}`);
      } catch (err) {
        console.warn(`Failed to delete Redis cache key ${cacheKey}:`, err.message);
      }
    }

    return res.status(200).json({
      message: "Student profile updated successfully",
      student: {
        id: studentId,
        code_massar,
        full_name: cleanName,
        email: cleanEmail,
        phone: cleanPhone
      }
    });
  } catch (error) {
    console.error(`Error updating student profile ID ${studentId}:`, error.message);
    return res.status(500).json({ error: "Failed to update student in database" });
  }
});

/**
 * ROUTE 10: DELETE /admin/students/:id
 * Protected route for admins to delete student record.
 */
app.delete("/api/admin/students/:id", authMiddleware, adminMiddleware, async (req, res) => {
  const studentId = parseInt(req.params.id, 10);

  if (isNaN(studentId)) {
    return res.status(400).json({ error: "Invalid student ID parameter" });
  }

  try {
    const db = await getDbPool();

    // Get student Massar code first for cache invalidation
    const [students] = await db.query(
      "SELECT code_massar FROM students WHERE id = ?",
      [studentId]
    );

    if (students.length === 0) {
      return res.status(404).json({ error: `Student with ID ${studentId} not found` });
    }

    const code_massar = students[0].code_massar;

    // Delete student (cascades automatically to subject_results table)
    await db.query(
      "DELETE FROM students WHERE id = ?",
      [studentId]
    );

    // Delete user from Cognito User Pool
    const userPoolId = process.env.COGNITO_USER_POOL_ID;
    if (userPoolId) {
      try {
        await cognitoClient.send(new AdminDeleteUserCommand({
          UserPoolId: userPoolId,
          Username: code_massar
        }));
        console.log(`Successfully deleted Cognito user: ${code_massar}`);
      } catch (cognitoError) {
        console.warn(`Failed to delete Cognito user ${code_massar} (might not exist in pool):`, cognitoError.message);
      }
    }

    // Invalidate/Delete Redis Cache key for the student
    const cacheKey = `results:${code_massar}`;
    if (redis && redis.status === "ready") {
      try {
        await redis.del(cacheKey);
        console.log(`Cache invalidated for key: ${cacheKey}`);
      } catch (err) {
        console.warn(`Failed to delete Redis cache key ${cacheKey}:`, err.message);
      }
    }

    return res.status(200).json({
      message: "Student deleted successfully",
      student_id: studentId,
      code_massar
    });
  } catch (error) {
    console.error(`Error deleting student ID ${studentId}:`, error.message);
    return res.status(500).json({ error: "Failed to delete student from database" });
  }
});

/**
 * Automatically synchronizes any existing students in the database to Cognito.
 * Runs once at startup to ensure the seeded mock students are ready to log in.
 */
async function syncExistingUsersToCognito() {
  const userPoolId = process.env.COGNITO_USER_POOL_ID;
  if (!userPoolId) {
    console.warn("Skipping Cognito sync: COGNITO_USER_POOL_ID is not defined.");
    return;
  }

  try {
    const db = await getDbPool();
    const [students] = await db.query("SELECT code_massar, full_name, email, phone FROM students");
    console.log(`Checking/syncing ${students.length} students to Cognito User Pool...`);

    for (const student of students) {
      const { code_massar, full_name, email, phone } = student;
      try {
        // Create user in Cognito (SUPPRESS makes sure no verification email is sent)
        await cognitoClient.send(new AdminCreateUserCommand({
          UserPoolId: userPoolId,
          Username: code_massar,
          UserAttributes: [
            { Name: "email", Value: email },
            { Name: "email_verified", Value: "true" },
            { Name: "phone_number", Value: phone },
            { Name: "phone_number_verified", Value: "true" },
            { Name: "name", Value: full_name }
          ],
          MessageAction: "SUPPRESS"
        }));

        // Set a fixed permanent password that satisfies all Cognito policy requirements
        // (uppercase, lowercase, digit, special char)
        await cognitoClient.send(new AdminSetUserPasswordCommand({
          UserPoolId: userPoolId,
          Username: code_massar,
          Password: "Massar2024!",
          Permanent: true
        }));
        console.log(`Auto-seeded student ${code_massar} to Cognito User Pool.`);
      } catch (err) {
        if (err.name === "UsernameExistsException") {
          // If the user already exists, ensure they have the correct permanent password set (moving them out of FORCE_CHANGE_PASSWORD if they were stuck)
          try {
            await cognitoClient.send(new AdminSetUserPasswordCommand({
              UserPoolId: userPoolId,
              Username: code_massar,
              Password: "Massar2024!",
              Permanent: true
            }));
            console.log(`Successfully reset/confirmed password for existing Cognito student: ${code_massar}`);
          } catch (setPassErr) {
            console.warn(`Failed to set password for existing student ${code_massar}:`, setPassErr.message);
          }
          continue;
        }
        console.warn(`Failed to seed student ${code_massar} to Cognito:`, err.message);
      }
    }
  } catch (error) {
    console.error("Failed to sync existing users to Cognito:", error.message);
  }
}

// Asynchronous startup initialization function
async function startupInitialization() {
  console.log("App booting. Initiating background AWS service connections...");
  
  // Attempt DB initialization asynchronously
  try {
    await getDbPool();
    console.log("Initial database connection check: SUCCESS.");
    // Synchronize database records to Cognito User Pool
    await syncExistingUsersToCognito();
  } catch (error) {
    console.warn("Initial database connection check: FAILED. Application will proceed to start, and retry connection on-demand.", error.message);
  }

  // Attempt Redis connection check asynchronously
  if (redis) {
    redis.connect().catch((err) => {
      console.warn("Initial Redis connection check: FAILED. App will proceed and run with caching disabled.", err.message);
    });
  }
}

// Start Server listening on port 3000 (required by AWS target group)
app.listen(PORT, () => {
  console.log(`Moroccan Ministry of Education (Massar Mock Portal) running on port ${PORT}`);
  startupInitialization();
});



