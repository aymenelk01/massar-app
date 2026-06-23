/**
 * Massar Mock Portal Application (test)
 * Simulates the Moroccan Ministry of Education student portal running on AWS ECS Fargate.
 * 
 * Integration:
 * - Amazon Cognito (user authentication and JWT verification)
 * - AWS SQS (sends student results notifications)
 * - Aurora Serverless v2 MySQL via RDS Proxy (relational storage, IAM auth)
 * - ElastiCache Redis (caching student results)
 */

const express = require("express");
const mysql = require("mysql2/promise");
const Redis = require("ioredis");
const { CognitoJwtVerifier } = require("aws-jwt-verify");
const { Signer } = require("@aws-sdk/rds-signer");
const { SQSClient, SendMessageCommand } = require("@aws-sdk/client-sqs");
const { S3Client, HeadObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { 
  CognitoIdentityProviderClient, 
  AdminCreateUserCommand, 
  AdminSetUserPasswordCommand, 
  AdminDeleteUserCommand, 
  AdminUpdateUserAttributesCommand,
  AdminAddUserToGroupCommand,
  ListUsersInGroupCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand
} = require("@aws-sdk/client-cognito-identity-provider");


const app = express();
app.use(express.json());

// Load and validate crucial environment variables
const REGION = process.env.AWS_REGION || "eu-south-1";
const PORT = process.env.PORT || 3000;

// AWS Clients Instantiations (Credential loading is managed by ECS Task Role)
const sqsClient = new SQSClient({ region: REGION });
const s3Client = new S3Client({ region: REGION });
const cognitoClient = new CognitoIdentityProviderClient({ region: REGION });

// Global holder for the MySQL connection pool
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
 * Generates a short-lived IAM authentication token for the RDS Proxy.
 *
 * The token is valid for 15 minutes and is used as the password when
 * opening a new physical connection to the proxy. It is signed with the
 * ECS task role credentials — no static password is stored anywhere.
 */
async function generateIamToken(dbHost, dbUsername) {
  const signer = new Signer({
    hostname: dbHost,
    port: 3306,
    username: dbUsername,
    region: REGION,
  });
  return signer.getAuthToken();
}

/**
 * Creates a new mysql2 pool stamped with a freshly signed IAM token as
 * the password. mysql2 does not support per-connection password hooks
 * through any stable public API, so the correct pattern is to bake the
 * token into the pool at creation time and recreate the pool before the
 * token expires (IAM tokens are valid for 15 minutes).
 *
 * Pool rotation (schedulePoolRotation below) replaces dbPool every 14
 * minutes so in-flight queries always finish on the old pool while new
 * connections automatically use the fresh token.
 */
async function createDbPool(dbHost, dbUsername, dbName) {
  const token = await generateIamToken(dbHost, dbUsername);
  console.log(`[db] IAM token generated for new pool → ${dbHost}`);

  const pool = mysql.createPool({
    host: dbHost,
    user: dbUsername,
    password: token,          // baked-in token; pool is rotated before it expires
    database: dbName,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    ssl: "Amazon RDS",
    enableCleartextPlugin: true,
  });

  return pool;
}

/**
 * Returns the active MySQL connection pool, creating it on first call.
 * Subsequent calls return the cached pool until it is rotated by
 * schedulePoolRotation().
 */
async function getDbPool() {
  if (dbPool) return dbPool;

  const dbHost = process.env.RDS_PROXY_ENDPOINT;
  const dbUsername = process.env.DB_USERNAME || "db_iam_user";
  const dbName = process.env.DB_NAME || "massardb";

  if (!dbHost) {
    throw new Error("RDS_PROXY_ENDPOINT environment variable is not defined");
  }

  console.log(`Creating IAM-authenticated MySQL pool → RDS Proxy: ${dbHost} as '${dbUsername}'`);

  try {
    dbPool = await createDbPool(dbHost, dbUsername, dbName);
    schedulePoolRotation(dbHost, dbUsername, dbName);
    return dbPool;
  } catch (error) {
    console.error("MySQL Connection Pool initialization failed:", error.message);
    dbPool = null;
    throw error;
  }
}

/**
 * Rotates the pool every 14 minutes so the baked-in IAM token is always
 * fresh (tokens expire after 15 minutes). The old pool is ended gracefully
 * so any in-flight queries can drain before connections are closed.
 */
function schedulePoolRotation(dbHost, dbUsername, dbName) {
  // 14 minutes — 1 minute before the 15-minute IAM token expiry
  const ROTATION_INTERVAL_MS = 14 * 60 * 1000;

  setTimeout(async () => {
    try {
      console.log("[db] Rotating MySQL pool with a fresh IAM token...");
      const newPool = await createDbPool(dbHost, dbUsername, dbName);
      const oldPool = dbPool;
      dbPool = newPool;                // swap atomically; in-flight queries finish on oldPool
      schedulePoolRotation(dbHost, dbUsername, dbName); // schedule next rotation
      oldPool.end((err) => {
        if (err) console.warn("[db] Warning while draining old pool:", err.message);
        else console.log("[db] Old pool drained and closed.");
      });
    } catch (err) {
      console.error("[db] Pool rotation failed, retrying in 60s:", err.message);
      // Retry rotation in 60s without killing the existing (still valid) pool
      setTimeout(() => schedulePoolRotation(dbHost, dbUsername, dbName), 60_000);
    }
  }, ROTATION_INTERVAL_MS);
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
 * Helper utility function to dynamically add a registered user to a specified Cognito group.
 */
async function addUserToCognitoGroup(username, groupName) {
  const userPoolId = process.env.COGNITO_USER_POOL_ID;
  if (!userPoolId) {
    console.warn("Cognito Client: COGNITO_USER_POOL_ID not set. Skipping group assignment.");
    return;
  }

  try {
    await cognitoClient.send(new AdminAddUserToGroupCommand({
      UserPoolId: userPoolId,
      Username: username,
      GroupName: groupName
    }));
    console.log(`Successfully added user ${username} to Cognito group: ${groupName}`);
  } catch (error) {
    console.error(`Failed to add user ${username} to Cognito group ${groupName}:`, error.message);
    throw error;
  }
}

/**
 * ExpressJS gatekeeper middleware function.
 * Decodes the incoming Cognito JWT token and verifies if the user belongs to 'teachers' or 'admins' group.
 */
const gatekeeperMiddleware = async (req, res, next) => {
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

    const groups = payload["cognito:groups"] || [];
    if (!groups.includes("teachers") && !groups.includes("admins")) {
      return res.status(403).json({ error: "Forbidden: Access restricted to teachers or administrators only" });
    }
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
 * ROUTE 4a: GET /student/diploma
 * Returns an S3 presigned URL for the student's Baccalaureate diploma.
 * Available only to admitted students when their diploma is ready.
 */
app.get("/api/student/diploma", authMiddleware, async (req, res) => {
  const cognitoUser = req.user.username || req.user["cognito:username"] || req.user.email || "";
  const code_massar = cognitoUser.split("@")[0].toUpperCase();

  if (!code_massar) {
    return res.status(400).json({ error: "Invalid user claim format. Cannot parse code_massar." });
  }

  const bucketName = process.env.DOCUMENTS_BUCKET_NAME;
  if (!bucketName) {
    return res.status(500).json({ error: "DOCUMENTS_BUCKET_NAME environment variable not configured" });
  }

  try {
    const db = await getDbPool();
    
    // Check student status
    const [students] = await db.query(
      "SELECT result FROM students WHERE code_massar = ?",
      [code_massar]
    );

    if (students.length === 0) {
      return res.status(404).json({ error: `Student with code ${code_massar} not found` });
    }

    if (students[0].result !== "Admis") {
      return res.status(403).json({ error: "Diplomas are only available for admitted students." });
    }

    const s3Key = `diplomas/${code_massar}_bac_diploma.pdf`;

    // Verify if the object exists
    try {
      await s3Client.send(new HeadObjectCommand({
        Bucket: bucketName,
        Key: s3Key
      }));
    } catch (s3Error) {
      if (s3Error.name === "NotFound" || s3Error.$metadata?.httpStatusCode === 404) {
        return res.status(404).json({ error: "Diploma not ready yet" });
      }
      console.error(`S3 HeadObject error for student ${code_massar}:`, s3Error.message);
      return res.status(500).json({ error: "Failed to access S3 document storage" });
    }

    // Generate Presigned URL
    try {
      const command = new GetObjectCommand({
        Bucket: bucketName,
        Key: s3Key
      });
      const presignedUrl = await getSignedUrl(s3Client, command, { expiresIn: 900 }); // 15 mins
      return res.status(200).json({ downloadUrl: presignedUrl });
    } catch (presignedError) {
      console.error(`Error generating S3 presigned URL for student ${code_massar}:`, presignedError.message);
      return res.status(500).json({ error: "Failed to generate download link" });
    }
  } catch (error) {
    console.error(`Error processing diploma request for student ${code_massar}:`, error.message);
    return res.status(500).json({ error: "Failed to process diploma download request" });
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
 * ROUTE 4b: POST /admin/generate-diplomas
 * Protected route for administrator to trigger SQS diploma generation.
 * Queries all admitted students, calculates their average, and sends messages to SQS queue.
 */
app.post("/api/admin/generate-diplomas", authMiddleware, adminMiddleware, async (req, res) => {
  const queueUrl = process.env.DOCUMENTS_SQS_QUEUE_URL;
  const bucketName = process.env.DOCUMENTS_BUCKET_NAME;
  if (!queueUrl) {
    return res.status(500).json({ error: "DOCUMENTS_SQS_QUEUE_URL environment variable not configured" });
  }
  if (!bucketName) {
    return res.status(500).json({ error: "DOCUMENTS_BUCKET_NAME environment variable not configured" });
  }

  try {
    const db = await getDbPool();

    // Query all admitted students and calculate their average grade in one query
    const [rows] = await db.query(`
      SELECT 
        s.code_massar, 
        s.full_name, 
        s.result,
        COALESCE(AVG(sr.grade), 10.00) as average
      FROM students s
      LEFT JOIN subject_results sr ON s.id = sr.student_id
      WHERE s.result = 'Admis'
      GROUP BY s.id
    `);

    if (rows.length === 0) {
      return res.status(200).json({ message: "No admitted student records found to generate diplomas", count: 0, queued: 0, skipped: 0 });
    }

    console.log(`Found ${rows.length} admitted students. Checking S3 for existing diplomas...`);

    // Check S3 for existing diplomas in parallel
    const checks = await Promise.all(
      rows.map(async (student) => {
        try {
          await s3Client.send(
            new HeadObjectCommand({
              Bucket: bucketName,
              Key: `diplomas/${student.code_massar}_bac_diploma.pdf`
            })
          );
          return { student, exists: true };
        } catch (err) {
          return { student, exists: false };
        }
      })
    );

    const toQueue = checks.filter(c => !c.exists).map(c => c.student);
    const skippedCount = checks.filter(c => c.exists).length;

    if (toQueue.length === 0) {
      return res.status(200).json({
        message: "All diplomas are already generated for admitted students.",
        count: 0,
        queued: 0,
        skipped: skippedCount
      });
    }

    console.log(`Queueing ${toQueue.length} diploma generation payloads to SQS (${skippedCount} skipped)...`);

    // Prepare SQS SendMessage Promises to process in parallel
    const sendPromises = toQueue.map(student => {
      const messageBody = JSON.stringify({
        code_massar: student.code_massar,
        full_name: student.full_name,
        result: student.result,
        average: parseFloat(parseFloat(student.average).toFixed(2))
      });

      const command = new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: messageBody
      });

      return sqsClient.send(command);
    });

    // Wait for all messages to be queued
    await Promise.all(sendPromises);
    console.log(`Successfully queued ${toQueue.length} diploma generation messages in SQS.`);

    return res.status(200).json({ 
      message: `Diploma generation triggered. Queued ${toQueue.length} and skipped ${skippedCount}.`, 
      count: toQueue.length,
      queued: toQueue.length,
      skipped: skippedCount
    });
  } catch (error) {
    console.error("Failed to trigger diploma generation:", error.message);
    return res.status(500).json({ error: "Failed to process diploma generation" });
  }
});

/**
 * ROUTE 7a: GET /admin/teachers
 * Protected route for admins to list all teachers.
 */
app.get("/api/admin/teachers", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const db = await getDbPool();
    const [rows] = await db.query(
      "SELECT id, username, full_name, email, phone, subject, enabled FROM teachers ORDER BY id DESC"
    );
    return res.status(200).json(rows);
  } catch (error) {
    console.error("Error retrieving teacher list for admin:", error.message);
    return res.status(500).json({ error: "Failed to fetch teacher list from database" });
  }
});

/**
 * ROUTE 7b: POST /admin/teachers
 * Protected route for admins to create a teacher.
 * Body: { username, full_name, email, phone, subject }
 */
app.post("/api/admin/teachers", authMiddleware, adminMiddleware, async (req, res) => {
  const { username, full_name, email, phone, subject } = req.body;
  if (!username || !full_name || !email || !phone || !subject) {
    return res.status(400).json({ error: "Missing required parameters: username, full_name, email, phone, and subject are required" });
  }

  const cleanUsername = username.trim();
  const cleanName = full_name.trim();
  const cleanEmail = email.trim();
  const cleanPhone = phone.trim();
  const cleanSubject = subject.trim();

  try {
    const db = await getDbPool();

    // 1. Insert teacher into database first
    await db.query(
      "INSERT INTO teachers (username, full_name, email, phone, subject) VALUES (?, ?, ?, ?, ?)",
      [cleanUsername, cleanName, cleanEmail, cleanPhone, cleanSubject]
    );

    // 2. Create Cognito user profile for the teacher
    const userPoolId = process.env.COGNITO_USER_POOL_ID;
    if (userPoolId) {
      try {
        await cognitoClient.send(new AdminCreateUserCommand({
          UserPoolId: userPoolId,
          Username: cleanUsername,
          UserAttributes: [
            { Name: "email", Value: cleanEmail },
            { Name: "email_verified", Value: "true" },
            { Name: "phone_number", Value: cleanPhone },
            { Name: "phone_number_verified", Value: "true" },
            { Name: "name", Value: cleanName }
          ],
          MessageAction: "SUPPRESS"
        }));

        // Set permanent password Massar2024!
        await cognitoClient.send(new AdminSetUserPasswordCommand({
          UserPoolId: userPoolId,
          Username: cleanUsername,
          Password: "Massar2024!",
          Permanent: true
        }));

        // Add user to the teachers group
        await addUserToCognitoGroup(cleanUsername, "teachers");
      } catch (cognitoError) {
        console.error(`Cognito registration failed for teacher ${cleanUsername}. Rolling back DB insertion...`, cognitoError.message);
        // Rollback DB
        await db.query("DELETE FROM teachers WHERE username = ?", [cleanUsername]);
        return res.status(500).json({ error: `Cognito User Pool registration failed: ${cognitoError.message}` });
      }
    } else {
      console.warn("Warning: COGNITO_USER_POOL_ID is not defined. Skipping Cognito teacher registration.");
    }

    return res.status(201).json({
      message: "Teacher successfully created",
      teacher: {
        username: cleanUsername,
        full_name: cleanName,
        email: cleanEmail,
        phone: cleanPhone,
        subject: cleanSubject
      }
    });
  } catch (error) {
    console.error("Database error during teacher creation:", error.message);
    return res.status(500).json({ error: `Failed to create teacher: ${error.message}` });
  }
});

/**
 * ROUTE 7c: PUT /admin/teachers/:username
 * Protected route for admins to update teacher profile.
 * Body: { full_name, email, phone, subject }
 */
app.put("/api/admin/teachers/:username", authMiddleware, adminMiddleware, async (req, res) => {
  const username = req.params.username;
  const { full_name, email, phone, subject } = req.body;

  if (!full_name || !email || !phone || !subject) {
    return res.status(400).json({ error: "Missing required parameters: full_name, email, phone, and subject are required" });
  }

  const cleanName = full_name.trim();
  const cleanEmail = email.trim();
  const cleanPhone = phone.trim();
  const cleanSubject = subject.trim();

  try {
    const db = await getDbPool();

    // Check if teacher exists
    const [teachers] = await db.query(
      "SELECT id FROM teachers WHERE username = ?",
      [username]
    );

    if (teachers.length === 0) {
      return res.status(404).json({ error: `Teacher with username ${username} not found` });
    }

    // Update in MySQL
    await db.query(
      "UPDATE teachers SET full_name = ?, email = ?, phone = ?, subject = ? WHERE username = ?",
      [cleanName, cleanEmail, cleanPhone, cleanSubject, username]
    );

    // Update attributes in Cognito User Pool
    const userPoolId = process.env.COGNITO_USER_POOL_ID;
    if (userPoolId) {
      try {
        await cognitoClient.send(new AdminUpdateUserAttributesCommand({
          UserPoolId: userPoolId,
          Username: username,
          UserAttributes: [
            { Name: "email", Value: cleanEmail },
            { Name: "email_verified", Value: "true" },
            { Name: "phone_number", Value: cleanPhone },
            { Name: "phone_number_verified", Value: "true" },
            { Name: "name", Value: cleanName }
          ]
        }));
        console.log(`Successfully updated attributes for Cognito teacher: ${username}`);
      } catch (cognitoError) {
        console.warn(`Failed to update attributes for Cognito teacher ${username} (might not exist in pool):`, cognitoError.message);
      }
    }

    return res.status(200).json({
      message: "Teacher profile updated successfully",
      teacher: {
        username,
        full_name: cleanName,
        email: cleanEmail,
        phone: cleanPhone,
        subject: cleanSubject
      }
    });
  } catch (error) {
    console.error(`Error updating teacher profile for ${username}:`, error.message);
    return res.status(500).json({ error: `Failed to update teacher: ${error.message}` });
  }
});

/**
 * ROUTE 7d: DELETE /admin/teachers/:username
 * Protected route for admins to delete teacher.
 */
app.delete("/api/admin/teachers/:username", authMiddleware, adminMiddleware, async (req, res) => {
  const username = req.params.username;

  try {
    const db = await getDbPool();

    // Delete from MySQL database
    await db.query(
      "DELETE FROM teachers WHERE username = ?",
      [username]
    );

    // Delete user from Cognito User Pool
    const userPoolId = process.env.COGNITO_USER_POOL_ID;
    if (userPoolId) {
      try {
        await cognitoClient.send(new AdminDeleteUserCommand({
          UserPoolId: userPoolId,
          Username: username
        }));
        console.log(`Successfully deleted Cognito user: ${username}`);
      } catch (cognitoError) {
        console.warn(`Failed to delete Cognito teacher ${username} (might not exist in pool):`, cognitoError.message);
      }
    }

    return res.status(200).json({
      message: "Teacher deleted successfully",
      username
    });
  } catch (error) {
    console.error(`Error deleting teacher ${username}:`, error.message);
    return res.status(500).json({ error: `Failed to delete teacher: ${error.message}` });
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
      "SELECT id, code_massar, full_name, email, phone, result, enabled FROM students ORDER BY id DESC"
    );

    const bucketName = process.env.DOCUMENTS_BUCKET_NAME;

    // Enrich students list with diploma existence from S3 in parallel
    const enrichedRows = await Promise.all(
      rows.map(async (student) => {
        if (student.result !== "Admis" || !bucketName) {
          return { ...student, diploma_generated: false };
        }
        try {
          await s3Client.send(
            new HeadObjectCommand({
              Bucket: bucketName,
              Key: `diplomas/${student.code_massar}_bac_diploma.pdf`
            })
          );
          return { ...student, diploma_generated: true };
        } catch (err) {
          // If HeadObject fails (e.g. 404 or other error), we assume it's not generated
          return { ...student, diploma_generated: false };
        }
      })
    );

    return res.status(200).json(enrichedRows);
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
 * ROUTE 11: PUT /admin/students/:id/status
 * Protected route for admins to enable/disable student Cognito account.
 * Body: { enabled } (boolean)
 */
app.put("/api/admin/students/:id/status", authMiddleware, adminMiddleware, async (req, res) => {
  const studentId = parseInt(req.params.id, 10);
  const { enabled } = req.body;

  if (isNaN(studentId)) {
    return res.status(400).json({ error: "Invalid student ID parameter" });
  }
  if (typeof enabled === "undefined") {
    return res.status(400).json({ error: "Missing required parameter: enabled status is required" });
  }

  const targetStatus = !!enabled;

  try {
    const db = await getDbPool();

    // 1. Get student's code_massar
    const [students] = await db.query(
      "SELECT code_massar FROM students WHERE id = ?",
      [studentId]
    );

    if (students.length === 0) {
      return res.status(404).json({ error: `Student with ID ${studentId} not found` });
    }

    const code_massar = students[0].code_massar;

    // 2. Update database status
    await db.query(
      "UPDATE students SET enabled = ? WHERE id = ?",
      [targetStatus ? 1 : 0, studentId]
    );

    // 3. Update Cognito enabled state
    const userPoolId = process.env.COGNITO_USER_POOL_ID;
    if (userPoolId) {
      try {
        if (targetStatus) {
          await cognitoClient.send(new AdminEnableUserCommand({
            UserPoolId: userPoolId,
            Username: code_massar
          }));
        } else {
          await cognitoClient.send(new AdminDisableUserCommand({
            UserPoolId: userPoolId,
            Username: code_massar
          }));
        }
        console.log(`Successfully toggled Cognito status to enabled=${targetStatus} for user ${code_massar}`);
      } catch (cognitoError) {
        console.warn(`Failed to update Cognito status for user ${code_massar}:`, cognitoError.message);
      }
    }

    return res.status(200).json({
      message: `Student account successfully ${targetStatus ? "enabled" : "disabled"}`,
      student_id: studentId,
      code_massar,
      enabled: targetStatus
    });
  } catch (error) {
    console.error(`Error toggling status for student ID ${studentId}:`, error.message);
    return res.status(500).json({ error: "Failed to update student status in database" });
  }
});

/**
 * ROUTE 12: PUT /admin/teachers/:username/status
 * Protected route for admins to enable/disable teacher Cognito account.
 * Body: { enabled } (boolean)
 */
app.put("/api/admin/teachers/:username/status", authMiddleware, adminMiddleware, async (req, res) => {
  const username = req.params.username;
  const { enabled } = req.body;

  if (!username) {
    return res.status(400).json({ error: "Missing username parameter" });
  }
  if (typeof enabled === "undefined") {
    return res.status(400).json({ error: "Missing required parameter: enabled status is required" });
  }

  const targetStatus = !!enabled;

  try {
    const db = await getDbPool();

    // 1. Check if teacher exists
    const [teachers] = await db.query(
      "SELECT id FROM teachers WHERE username = ?",
      [username]
    );

    if (teachers.length === 0) {
      return res.status(404).json({ error: `Teacher with username ${username} not found` });
    }

    // 2. Update database status
    await db.query(
      "UPDATE teachers SET enabled = ? WHERE username = ?",
      [targetStatus ? 1 : 0, username]
    );

    // 3. Update Cognito enabled state
    const userPoolId = process.env.COGNITO_USER_POOL_ID;
    if (userPoolId) {
      try {
        if (targetStatus) {
          await cognitoClient.send(new AdminEnableUserCommand({
            UserPoolId: userPoolId,
            Username: username
          }));
        } else {
          await cognitoClient.send(new AdminDisableUserCommand({
            UserPoolId: userPoolId,
            Username: username
          }));
        }
        console.log(`Successfully toggled Cognito status to enabled=${targetStatus} for teacher ${username}`);
      } catch (cognitoError) {
        console.warn(`Failed to update Cognito status for teacher ${username}:`, cognitoError.message);
      }
    }

    return res.status(200).json({
      message: `Teacher account successfully ${targetStatus ? "enabled" : "disabled"}`,
      username,
      enabled: targetStatus
    });
  } catch (error) {
    console.error(`Error toggling status for teacher ${username}:`, error.message);
    return res.status(500).json({ error: "Failed to update teacher status in database" });
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
    throw error;
  }
}

/**
 * Automatically synchronizes any existing teachers in the database to Cognito.
 * Runs once at startup to ensure the seeded mock teachers are ready to log in.
 */
async function syncExistingTeachersToCognito() {
  const userPoolId = process.env.COGNITO_USER_POOL_ID;
  if (!userPoolId) {
    console.warn("Skipping Cognito teacher sync: COGNITO_USER_POOL_ID is not defined.");
    return;
  }

  try {
    const db = await getDbPool();
    const [teachers] = await db.query("SELECT username, full_name, email, phone, subject FROM teachers");
    console.log(`Checking/syncing ${teachers.length} teachers to Cognito User Pool...`);

    for (const teacher of teachers) {
      const { username, full_name, email, phone } = teacher;
      try {
        // Create user in Cognito (SUPPRESS makes sure no verification email is sent)
        await cognitoClient.send(new AdminCreateUserCommand({
          UserPoolId: userPoolId,
          Username: username,
          UserAttributes: [
            { Name: "email", Value: email },
            { Name: "email_verified", Value: "true" },
            { Name: "phone_number", Value: phone },
            { Name: "phone_number_verified", Value: "true" },
            { Name: "name", Value: full_name }
          ],
          MessageAction: "SUPPRESS"
        }));

        // Set a fixed permanent password that satisfies Cognito policy requirements
        await cognitoClient.send(new AdminSetUserPasswordCommand({
          UserPoolId: userPoolId,
          Username: username,
          Password: "Massar2024!",
          Permanent: true
        }));

        // Add user to the teachers group
        await addUserToCognitoGroup(username, "teachers");
        console.log(`Auto-seeded teacher ${username} to Cognito User Pool.`);
      } catch (err) {
        if (err.name === "UsernameExistsException") {
          // If the user already exists, ensure they have the correct permanent password and group
          try {
            await cognitoClient.send(new AdminSetUserPasswordCommand({
              UserPoolId: userPoolId,
              Username: username,
              Password: "Massar2024!",
              Permanent: true
            }));
            await addUserToCognitoGroup(username, "teachers");
            console.log(`Successfully reset/confirmed password and group for existing Cognito teacher: ${username}`);
          } catch (setPassErr) {
            console.warn(`Failed to set password for existing teacher ${username}:`, setPassErr.message);
          }
          continue;
        }
        console.warn(`Failed to seed teacher ${username} to Cognito:`, err.message);
      }
    }
  } catch (error) {
    console.error("Failed to sync existing teachers to Cognito:", error.message);
    throw error;
  }
}

// Asynchronous startup initialization function
async function startupInitialization() {
  console.log("App booting. Initiating background AWS service connections...");
  
  // Attempt DB initialization and run sync with retries
  const maxRetries = 5;
  const retryDelayMs = 10000;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await getDbPool();
      await syncExistingUsersToCognito();
      await syncExistingTeachersToCognito();
      console.log("Existing users and teachers synchronization completed successfully.");
      break; // Success, exit retry loop
    } catch (error) {
      console.warn(`Cognito user synchronization attempt ${attempt}/${maxRetries} failed:`, error.message);
      if (attempt < maxRetries) {
        console.log(`Retrying user synchronization in ${retryDelayMs / 1000}s...`);
        await new Promise(resolve => setTimeout(resolve, retryDelayMs));
      } else {
        console.error("Critical: Could not sync database mock users to Cognito after max retries.");
      }
    }
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



