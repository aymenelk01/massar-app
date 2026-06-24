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
const { BedrockRuntimeClient, ConverseCommand } = require("@aws-sdk/client-bedrock-runtime");


const app = express();
app.use(express.json());

// Load and validate crucial environment variables
const REGION = process.env.AWS_REGION || "eu-south-1";
const PORT = process.env.PORT || 3000;

// AWS Clients Instantiations (Credential loading is managed by ECS Task Role)
const sqsClient     = new SQSClient({ region: REGION });
const s3Client      = new S3Client({ region: REGION });
const cognitoClient = new CognitoIdentityProviderClient({ region: REGION });
const bedrockClient = new BedrockRuntimeClient({ region: REGION });

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
 * so any in-flight queries can drain before connections are closed
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

const MOROCCAN_COEFFICIENTS = {
  "Sciences Physiques": {
    "Examen Régional": {
      "Langue arabe": 2,
      "Français": 4,
      "Éducation islamique": 2,
      "Histoire-Géographie": 2
    },
    "Contrôle Continu": {
      "Mathématiques": 7,
      "Physique-Chimie": 7,
      "Sciences de la Vie et de la Terre": 5,
      "Philosophie": 2,
      "Anglais": 2
    },
    "Examen National": {
      "Mathématiques": 7,
      "Physique-Chimie": 7,
      "Sciences de la Vie et de la Terre": 5,
      "Philosophie": 2,
      "Anglais": 2
    }
  },
  "Sciences Mathématiques A": {
    "Examen Régional": {
      "Langue arabe": 2,
      "Français": 4,
      "Éducation islamique": 2,
      "Histoire-Géographie": 2
    },
    "Contrôle Continu": {
      "Mathématiques": 9,
      "Physique-Chimie": 7,
      "Sciences de la Vie et de la Terre": 3,
      "Philosophie": 2,
      "Anglais": 2
    },
    "Examen National": {
      "Mathématiques": 9,
      "Physique-Chimie": 7,
      "Sciences de la Vie et de la Terre": 3,
      "Philosophie": 2,
      "Anglais": 2
    }
  }
};

function calculateStudentAverages(branch, grades, level) {
  const spec = MOROCCAN_COEFFICIENTS[branch] || MOROCCAN_COEFFICIENTS["Sciences Physiques"];
  const is1Bac = level === '1ère Bac';

  const regionalGrades = grades.filter(g => g.exam_type === 'Examen Régional');
  const ccGrades = grades.filter(g => g.exam_type === 'Contrôle Continu');
  const nationalGrades = grades.filter(g => g.exam_type === 'Examen National');

  const calcComponentAverage = (componentName, componentGrades) => {
    const coefs = spec[componentName];
    let sumProducts = 0;
    let sumCoefs = 0;

    componentGrades.forEach(g => {
      const coef = coefs[g.subject_name];
      if (coef !== undefined) {
        sumProducts += parseFloat(g.grade) * coef;
        sumCoefs += coef;
      }
    });

    if (sumCoefs > 0) {
      return sumProducts / sumCoefs;
    }
    return 0.0;
  };

  const avgRegional = calcComponentAverage('Examen Régional', regionalGrades);
  const avgCC = calcComponentAverage('Contrôle Continu', ccGrades);
  const avgNational = is1Bac ? 0.0 : calcComponentAverage('Examen National', nationalGrades);

  // 1ère Bac: 50% Régional + 50% CC (no national exam). Result is 'En cours' (not final).
  // 2ème Bac: 25% Régional + 25% CC + 50% National.
  const overallAverage = is1Bac
    ? (avgRegional * 0.50) + (avgCC * 0.50)
    : (avgRegional * 0.25) + (avgCC * 0.25) + (avgNational * 0.50);

  const result = is1Bac ? 'En cours' : (overallAverage >= 10.00 ? 'Admis' : 'Ajourné');

  return {
    average_regional: parseFloat(avgRegional.toFixed(2)),
    average_cc: parseFloat(avgCC.toFixed(2)),
    average_national: parseFloat(avgNational.toFixed(2)),
    average: parseFloat(overallAverage.toFixed(2)),
    result: result
  };
}

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
      "SELECT id, code_massar, full_name, email, phone, branch, level, average_regional, average_cc, average_national, average, result FROM students WHERE code_massar = ?",
      [code_massar]
    );

    if (students.length === 0) {
      return res.status(404).json({ error: `Results for student with code ${code_massar} not found` });
    }

    const student = students[0];

    // Fetch Subject Grades
    const [subjectGrades] = await db.query(
      "SELECT subject_name, exam_type, grade FROM subject_results WHERE student_id = ?",
      [student.id]
    );

    // Format the response payload
    const payload = {
      full_name: student.full_name,
      code_massar: student.code_massar,
      branch: student.branch,
      level: student.level || '2ème Bac',
      average_regional: parseFloat(student.average_regional || 0.0),
      average_cc: parseFloat(student.average_cc || 0.0),
      average_national: parseFloat(student.average_national || 0.0),
      average: parseFloat(student.average || 0.0),
      result: student.result,
      subject_results: subjectGrades.map(row => ({
        subject_name: row.subject_name,
        exam_type: row.exam_type,
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
      if (
        s3Error.name === "NotFound" || 
        s3Error.name === "AccessDenied" || 
        s3Error.$metadata?.httpStatusCode === 404 || 
        s3Error.$metadata?.httpStatusCode === 403
      ) {
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
        s.branch,
        s.level,
        s.average_regional,
        s.average_cc,
        s.average_national,
        s.average,
        s.result,
        sr.subject_name,
        sr.exam_type,
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
          branch: row.branch,
          level: row.level || '2ème Bac',
          average_regional: parseFloat(row.average_regional || 0.0),
          average_cc: parseFloat(row.average_cc || 0.0),
          average_national: parseFloat(row.average_national || 0.0),
          average: parseFloat(row.average || 0.0),
          result: row.result,
          subject_results: []
        };
      }
      if (row.subject_name) {
        studentMap[row.id].subject_results.push({
          subject_name: row.subject_name,
          exam_type: row.exam_type,
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
 * Body: { code_massar, grades: [{ subject_name, exam_type, grade }] } or single { code_massar, subject_name, exam_type, grade }
 */
app.post("/api/teacher/grades", authMiddleware, teacherMiddleware, async (req, res) => {
  const { code_massar, subject_name, exam_type, grade, grades } = req.body;

  if (!code_massar) {
    return res.status(400).json({ error: "Missing required parameter: code_massar is required" });
  }

  const normalizedCode = code_massar.trim().toUpperCase();

  // Support both bulk updates (grades array) and single updates
  let gradesToUpdate = [];
  if (Array.isArray(grades)) {
    gradesToUpdate = grades;
  } else {
    if (!subject_name || !exam_type || typeof grade === "undefined") {
      return res.status(400).json({ error: "Missing required parameters: subject_name, exam_type, and grade are required for single update" });
    }
    gradesToUpdate = [{ subject_name, exam_type, grade }];
  }

  // Validate all grades first
  for (const g of gradesToUpdate) {
    if (!g.subject_name || !g.exam_type || typeof g.grade === "undefined" || g.grade === null) {
      return res.status(400).json({ error: "Each grade entry must contain subject_name, exam_type, and grade" });
    }
    const parsedGrade = parseFloat(g.grade);
    if (isNaN(parsedGrade) || parsedGrade < 0 || parsedGrade > 20) {
      return res.status(400).json({ error: `Grade for ${g.subject_name} (${g.exam_type}) must be a valid number between 0 and 20` });
    }
  }

  try {
    const db = await getDbPool();

    // 1. Get student ID
    const [students] = await db.query(
      "SELECT id, branch, level FROM students WHERE code_massar = ?",
      [normalizedCode]
    );

    if (students.length === 0) {
      return res.status(404).json({ error: `Student with code ${normalizedCode} not found` });
    }

    const studentId = students[0].id;
    const studentBranch = students[0].branch;
    const studentLevel = students[0].level || '2ème Bac';

    // 2. Perform updates/inserts for all grades
    for (const g of gradesToUpdate) {
      const parsedGrade = parseFloat(g.grade);
      const [existing] = await db.query(
        "SELECT id FROM subject_results WHERE student_id = ? AND subject_name = ? AND exam_type = ?",
        [studentId, g.subject_name, g.exam_type]
      );

      if (existing.length > 0) {
        // Update
        await db.query(
          "UPDATE subject_results SET grade = ? WHERE student_id = ? AND subject_name = ? AND exam_type = ?",
          [parsedGrade, studentId, g.subject_name, g.exam_type]
        );
      } else {
        // Insert
        await db.query(
          "INSERT INTO subject_results (student_id, subject_name, exam_type, grade) VALUES (?, ?, ?, ?)",
          [studentId, g.subject_name, g.exam_type, parsedGrade]
        );
      }
    }

    // 3. Recalculate average and update student status (Admis vs Ajourné)
    const [allGrades] = await db.query(
      "SELECT subject_name, exam_type, grade FROM subject_results WHERE student_id = ?",
      [studentId]
    );

    const averages = calculateStudentAverages(studentBranch, allGrades, studentLevel);

    await db.query(
      "UPDATE students SET average_regional = ?, average_cc = ?, average_national = ?, average = ?, result = ? WHERE id = ?",
      [
        averages.average_regional,
        averages.average_cc,
        averages.average_national,
        averages.average,
        averages.result,
        studentId
      ]
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
      message: "Grades successfully updated",
      student_code: normalizedCode,
      updated_count: gradesToUpdate.length,
      new_averages: averages
    });
  } catch (error) {
    console.error(`Error updating grades for student ${normalizedCode}:`, error.message);
    return res.status(500).json({ error: "Failed to update grades in database" });
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
        s.average,
        sr.subject_name,
        sr.exam_type,
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
          average: row.average,
          subjects: []
        };
      }
      if (row.subject_name) {
        studentMap[row.id].subjects.push({
          subject_name: `${row.subject_name} (${row.exam_type})`,
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
        average: student.average,
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

    // Query all admitted students and retrieve their average and branch directly
    const [rows] = await db.query(`
      SELECT 
        s.code_massar, 
        s.full_name, 
        s.result,
        s.branch,
        s.average
      FROM students s
      WHERE s.result = 'Admis' AND s.level = '2ème Bac'
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
        branch: student.branch,
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
      "SELECT id, code_massar, full_name, email, phone, branch, level, average, result, enabled FROM students ORDER BY id DESC"
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
  const { full_name, email, phone, branch, level } = req.body;
  if (!full_name || !email || !phone) {
    return res.status(400).json({ error: "Missing required parameters: full_name, email, and phone are required" });
  }
  const cleanBranch = (branch || "Sciences Physiques").trim();
  const cleanLevel = (level || "2ème Bac").trim();

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
        const initialResult = cleanLevel === '1ère Bac' ? 'En cours' : 'Ajourné';
        await db.query(
          "INSERT INTO students (code_massar, full_name, email, phone, branch, level, result) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [code_massar, cleanName, cleanEmail, cleanPhone, cleanBranch, cleanLevel, initialResult]
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
  const { full_name, email, phone, branch, level } = req.body;

  if (isNaN(studentId)) {
    return res.status(400).json({ error: "Invalid student ID parameter" });
  }
  if (!full_name || !email || !phone) {
    return res.status(400).json({ error: "Missing required parameters: full_name, email, and phone are required" });
  }

  const cleanName = full_name.trim();
  const cleanEmail = email.trim();
  const cleanPhone = phone.trim();
  const cleanBranch = (branch || "Sciences Physiques").trim();
  const cleanLevel = (level || "2ème Bac").trim();

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
      "UPDATE students SET full_name = ?, email = ?, phone = ?, branch = ?, level = ? WHERE id = ?",
      [cleanName, cleanEmail, cleanPhone, cleanBranch, cleanLevel, studentId]
    );

    // Recalculate average grades in case the branch changed
    const [allGrades] = await db.query(
      "SELECT subject_name, exam_type, grade FROM subject_results WHERE student_id = ?",
      [studentId]
    );

    const averages = calculateStudentAverages(cleanBranch, allGrades, cleanLevel);

    await db.query(
      "UPDATE students SET average_regional = ?, average_cc = ?, average_national = ?, average = ?, result = ? WHERE id = ?",
      [
        averages.average_regional,
        averages.average_cc,
        averages.average_national,
        averages.average,
        averages.result,
        studentId
      ]
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

/**
 * ROUTE: POST /api/guidance/generate
 * Protected route (students only — no Cognito group = student).
 * Fetches the authenticated student's academic record from Aurora, pre-calculates
 * eligibility thresholds for Moroccan higher-education paths, then calls Amazon
 * Bedrock (amazon.nova-pro-v1:0 via ConverseCommand) with a strict system prompt
 * that forces qualitative-only analysis.  The model MUST NOT recompute averages.
 */
app.post("/api/guidance/generate", authMiddleware, async (req, res) => {
  // ── 1. Identity resolution ─────────────────────────────────────────────
  const cognitoUser = req.user.username || req.user["cognito:username"] || req.user.email || "";
  const code_massar = cognitoUser.split("@")[0].toUpperCase();

  if (!code_massar) {
    return res.status(400).json({ error: "Invalid user claim format. Cannot parse code_massar." });
  }

  // Reject admins and teachers — guidance is a student-only feature.
  const groups = req.user["cognito:groups"] || [];
  if (groups.includes("admins") || groups.includes("teachers")) {
    return res.status(403).json({ error: "Forbidden: Guidance reports are only available to students." });
  }

  try {
    // ── 2. Fetch student record from Aurora ───────────────────────────────
    const db = await getDbPool();

    const [students] = await db.query(
      `SELECT id, full_name, branch, level, result,
              average_regional, average_cc, average_national, average
       FROM students WHERE code_massar = ?`,
      [code_massar]
    );

    if (students.length === 0) {
      return res.status(404).json({ error: "Student record not found." });
    }

    const student = students[0];

    // Guidance is meaningful only for 2ème Bac students with a final result.
    if ((student.level || "2ème Bac") === "1ère Bac") {
      return res.status(400).json({
        error: "Guidance reports are only available for 2ème Baccalaureate students after their final exams."
      });
    }

    // ── 3. Fetch subject grades ────────────────────────────────────────────
    const [subjectRows] = await db.query(
      `SELECT subject_name, exam_type, grade
       FROM subject_results WHERE student_id = ?
       ORDER BY exam_type, subject_name`,
      [student.id]
    );

    // ── 4. Build subject grade map grouped by exam type ───────────────────
    const gradesByType = {};
    subjectRows.forEach(row => {
      if (!gradesByType[row.exam_type]) gradesByType[row.exam_type] = {};
      gradesByType[row.exam_type][row.subject_name] = parseFloat(row.grade);
    });

    // Retrieve per-subject coefficients for this student's branch.
    const branchCoefs = MOROCCAN_COEFFICIENTS[student.branch] || MOROCCAN_COEFFICIENTS["Sciences Physiques"];

    // Annotate each grade with its coefficient for transparency in the prompt.
    const annotatedGrades = [];
    subjectRows.forEach(row => {
      const coef = branchCoefs[row.exam_type]?.[row.subject_name] ?? null;
      annotatedGrades.push({
        subject: row.subject_name,
        exam_type: row.exam_type,
        grade: parseFloat(row.grade),
        coefficient: coef,
        status: parseFloat(row.grade) >= 10 ? "Passed" : "Failed"
      });
    });

    // ── 5. Pre-calculate eligibility thresholds (server-side only) ────────
    //   These hard thresholds are sourced from Moroccan CNEA/orientation guides.
    //   The LLM must ONLY interpret these; it must NOT recompute them.
    const overall = parseFloat(student.average || 0);
    const regionalAvg = parseFloat(student.average_regional || 0);
    const ccAvg = parseFloat(student.average_cc || 0);
    const nationalAvg = parseFloat(student.average_national || 0);
    const branch = student.branch || "Sciences Physiques";

    const mathGrade = (gradesByType["Examen National"]?.["Mathématiques"]
                    ?? gradesByType["Contrôle Continu"]?.["Mathématiques"]
                    ?? 0);
    const physGrade = (gradesByType["Examen National"]?.["Physique-Chimie"]
                    ?? gradesByType["Contrôle Continu"]?.["Physique-Chimie"]
                    ?? 0);
    const svtGrade  = (gradesByType["Examen National"]?.["Sciences de la Vie et de la Terre"]
                    ?? gradesByType["Contrôle Continu"]?.["Sciences de la Vie et de la Terre"]
                    ?? 0);
    const frGrade   = (gradesByType["Examen Régional"]?.["Français"] ?? 0);
    const engGrade  = (gradesByType["Examen National"]?.["Anglais"]
                    ?? gradesByType["Contrôle Continu"]?.["Anglais"]
                    ?? 0);

    const eligibility = {
      // Admitted or deferred
      bac_result: student.result,           // "Admis" | "Ajourné"
      rattrapage_eligible: student.result === "Ajourné" && overall >= 8.0,

      // Grandes Écoles / Prépa
      cpge_eligible: student.result === "Admis" && overall >= 14.0
                     && mathGrade >= 12 && physGrade >= 12,

      // Engineering
      ensa_eligible: student.result === "Admis" && overall >= 12.0
                     && mathGrade >= 12,
      ensa_competitive: student.result === "Admis" && overall >= 14.0
                        && mathGrade >= 14,

      // Medicine / Pharmacy
      fmp_eligible: student.result === "Admis" && overall >= 14.0
                    && svtGrade >= 14 && physGrade >= 12,

      // Commerce / Management (ENCG)
      encg_eligible: student.result === "Admis" && overall >= 12.0,

      // Technology institutes (EST)
      est_eligible: student.result === "Admis" && overall >= 10.0,

      // Sciences / Research faculties (FST, FS)
      fst_eligible: student.result === "Admis" && overall >= 11.0
                    && (mathGrade >= 10 || physGrade >= 10),

      // Honour mentions (Mention)
      mention: overall >= 16.0 ? "Très Bien"
             : overall >= 14.0 ? "Bien"
             : overall >= 12.0 ? "Assez Bien"
             : overall >= 10.0 ? "Passable"
             : "N/A"
    };

    // Determine cross-region inference profile ID based on AWS Region to support regional availability
    let modelId = "amazon.nova-pro-v1:0"; 
    const currentRegion = process.env.AWS_REGION || "eu-south-1";
    if (currentRegion.startsWith("us-")) {
      modelId = "us.amazon.nova-pro-v1:0";
    } else if (currentRegion.startsWith("eu-")) {
      modelId = "eu.amazon.nova-pro-v1:0";
    } else if (currentRegion.startsWith("ap-")) {
      modelId = "ap.amazon.nova-pro-v1:0";
    } else {
      modelId = "us.amazon.nova-pro-v1:0"; // default fallback cross-region profile
    }

    // ── 6. Compose the Bedrock prompt payload ────────────────────────────
    const systemPrompt = [
      {
        text: [
          "You are MassarAI, an expert Moroccan academic advisor with deep, authoritative knowledge of Morocco's complete higher education system.",
          "Your mission is to produce a personalized, honest, detailed, and actionable academic guidance report in English.",
          "",
          "═══════════════════════════════════════════════════════",
          "ABSOLUTE RULES — violating any of these is unacceptable:",
          "═══════════════════════════════════════════════════════",
          "1. NEVER perform mathematical calculations or modify numerical values.",
          "   All averages, grades, and eligibility flags are pre-validated server-side. Trust them as ground truth.",
          "2. NEVER recommend a pathway whose eligibility flag is false.",
          "3. NEVER invent schools, programs, or requirements not in your knowledge base below.",
          "4. Always be HONEST — if scores are low, say so respectfully but clearly.",
          "5. Start DIRECTLY with ## Academic Summary — no preamble, no greetings.",
          "6. Use these exact section headers (##):",
          "   ## Academic Summary",
          "   ## Strengths & Areas for Improvement",
          "   ## Higher Education Pathways",
          "   ## Recommended Next Steps",
          "",
          "═══════════════════════════════════════════════════════",
          "MOROCCAN HIGHER EDUCATION KNOWLEDGE BASE",
          "═══════════════════════════════════════════════════════",
          "",
          "## BACCALAUREATE MENTION SYSTEM",
          "- Passable:    10.00 – 11.99/20",
          "- Assez Bien:  12.00 – 13.99/20",
          "- Bien:        14.00 – 15.99/20",
          "- Très Bien:   16.00 – 20.00/20",
          "",
          "## SESSION DE RATTRAPAGE (Supplementary Exam)",
          "- Eligible: students with overall average between 8.00 and 9.99/20 in the ordinary session.",
          "- Students below 8.00 or with an eliminatory zero are NOT eligible.",
          "- What is retaken: ALL national exam (Examen National) papers only.",
          "- What is KEPT: Contrôle Continu (CC) grades and Examen Régional grades — these are NOT retaken.",
          "- Scoring rule: For each national subject, the BEST grade between the two sessions is used.",
          "- Final average formula remains: 25% Régional + 25% CC + 50% National.",
          "- Inscription: automatic after ordinary results announcement; exams held approximately 2 weeks later (July).",
          "- Results: published on bac.men.gov.ma or taalim.ma.",
          "- Strategy: Focus revision on high-coefficient subjects in your branch to maximize the final average above 10/20.",
          "",
          "## TRACK 1 — CLASSES PRÉPARATOIRES AUX GRANDES ÉCOLES (CPGE)",
          "- 2-year intensive program (Mathématiques + Sciences) after the Baccalaureate.",
          "- Leads to the Concours National Commun (CNC) for top engineering schools.",
          "- Tracks: MPSI/MP (Maths-Physics-Engineering), PC (Physics-Chemistry), PSI (Physics-Engineering), TSI (Technology), BCPST (Biology-Agronomy).",
          "- Admission: highly selective; file-based on Baccalaureate grades. Realistic threshold: overall ≥ 14/20, strong Maths (≥ 14) and Physics (≥ 12).",
          "- After 2 years of CPGE, students sit the CNC to enter top schools (EMI, ENSIAS, EHTP, ENSMR, ENSEM, INPT, etc.).",
          "- CPGE centers: many public high schools offer it (e.g., Lycée Mohammed V Casablanca, Lycée Ibn Youssef Marrakech, Lycée Mohammed Khair-Eddine Marrakech).",
          "",
          "## TRACK 2 — TOP ENGINEERING SCHOOLS (via CNC after CPGE)",
          "- EMI: École Mohammadia d'Ingénieurs (Rabat) — most prestigious engineering school, ~15 specialties.",
          "- ENSIAS: École Nationale Supérieure d'Informatique et d'Analyse des Systèmes (Rabat) — top CS/IT school.",
          "- EHTP: École Hassania des Travaux Publics (Casablanca) — civil/public works engineering.",
          "- ENSEM: École Nationale Supérieure d'Électricité et de Mécanique (Casablanca).",
          "- ENSMR: École Nationale Supérieure des Mines de Rabat — mining, environment, energy.",
          "- INPT: Institut National des Postes et Télécommunications (Rabat) — telecom and ICT.",
          "- ENSAM: École Nationale Supérieure d'Arts et Métiers (Rabat, Casablanca, Meknès).",
          "- IAV Hassan II: Institut Agronomique et Vétérinaire (Rabat) — agronomy, veterinary science.",
          "- ECC: École Centrale Casablanca — engineering, affiliated with Centrale group.",
          "- INSEA: Institut National de Statistique et d'Économie Appliquée (Rabat) — statistics/data science.",
          "- AIAC: Académie Internationale Mohammed VI de l'Aviation Civile — aeronautics/aviation.",
          "",
          "## TRACK 3 — ENSA NETWORK (Direct entry after Baccalaureate — Integrated Prep)",
          "- ENSA (Écoles Nationales des Sciences Appliquées): 16 schools, 5-year engineering cycle (2 integrated prep + 3 engineering).",
          "- Admission: pre-selection based on Bac average (platform tawjihi.ma or cursussup.gov.ma), then placement exam.",
          "- Realistic pre-selection threshold: overall ≥ 12/20, Maths ≥ 12 (competitive spots often go to 14+).",
          "- ENSA locations: Agadir (ENSAA), Tanger (ENSAT), Kénitra (ENSAK), Fès (ENSAF), Marrakech (ENSAM-not to be confused with Arts et Métiers), Oujda (ENSAO), Tétouan, Béni Mellal, El Jadida, Safi, Dakhla, Meknès, Laâyoune, Settat, Nador, Guelmim.",
          "- Specialties vary by campus but include: Computer Science, Civil Engineering, Electrical Engineering, Industrial Engineering, etc.",
          "",
          "## TRACK 4 — MEDICINE, PHARMACY & DENTISTRY (FMP/FMPO)",
          "- Competitive national common entrance exam (Concours Commun Médical) — format: QCM in Maths, Physics, Chemistry, SVT; 2 hours.",
          "- Pre-selection seuil: overall Bac average ≥ 12/20 (national threshold set for 2026-2027 academic year).",
          "- However, in practice only students with averages of 15+ are realistically competitive for medicine places.",
          "- Places 2026: ~5,790 Medicine, ~1,090 Pharmacy, ~460 Dentistry nationally.",
          "- Faculties: FMPR (Rabat), FMPC (Casablanca), FMPF (Fès), FMPM (Marrakech), FMPO (Oujda), FMPA (Agadir), FMPT (Tanger).",
          "- Inscription: cursussup.gov.ma (mid-June to mid-July); exam ~July.",
          "- Private medicine schools: UIR (Rabat), UM6SS — very high fees, same competitive exam.",
          "",
          "## TRACK 5 — ENCG (Commerce & Management)",
          "- ENCG: Écoles Nationales de Commerce et de Gestion — 5-year Bac+5 management degree.",
          "- Admission: TAFEM (Test d'Admissibilité à la Formation en Management) — pre-selection on Bac average, then written exam.",
          "- Pre-selection threshold varies annually (typically around 12/20 but highly competitive).",
          "- Eligible Bac streams: Sciences Économiques, Sciences de Gestion et Comptabilité, Sciences Mathématiques A/B, Sciences Expérimentales.",
          "- 17 ENCG campuses across Morocco: Casablanca, Agadir, Dakhla, El Jadida, Fès, Guelmim, Kenitra, Laâyoune, Marrakech, Meknès, Nador, Oujda, Rabat, Safi, Settat, Tanger, Béni Mellal.",
          "- Specialties: Marketing, Finance, Commerce International, Audit, Contrôle de Gestion, RH, Informatique de Gestion.",
          "",
          "## TRACK 6 — FST (Faculté des Sciences et Techniques)",
          "- Public university faculties of applied sciences — Bac+5 (License, Master, Doctorat).",
          "- Admission: regulated, file-based pre-selection. Realistic threshold: overall ≥ 11/20, Maths or Physics ≥ 10.",
          "- Specialties: Maths-Physique, Chimie-Physique, Sciences de l'Ingénieur, Informatique, Génie Civil, etc.",
          "- FST locations: FST Marrakech (UCAM), FST Fès (USMBA), FST Settat (UH1), FST Beni Mellal, FST Errachidia, FST Al Hoceima, FST Mohammedia, FST Tanger.",
          "",
          "## TRACK 7 — FS (Faculté des Sciences — Fundamental Sciences)",
          "- Near-open access (all Bac holders with ≥ 10/20 may register).",
          "- Programs: Licence in Maths, Physics, Chemistry, Biology, Geology, Computer Science.",
          "- Leads to Master's and Doctorat; less professionally direct than FST.",
          "- Found at all public universities: Mohammed V Rabat, Hassan II Casablanca, Cadi Ayyad Marrakech, Sidi Mohammed Ben Abdellah Fès, Mohammed I Oujda, Ibn Tofaïl Kénitra, etc.",
          "",
          "## TRACK 8 — EST (École Supérieure de Technologie)",
          "- 2-year technical program (DUT — Diplôme Universitaire de Technologie), Bac+2.",
          "- Selective admission based on Bac average (tawjihi.ma); threshold typically ≥ 10/20.",
          "- Practical, professional-focused training.",
          "- Specialties: Techniques de Management, Génie Électrique, Génie Mécanique, Informatique, Commerce et Logistique, etc.",
          "- EST locations across Morocco: Salé, Casablanca, Agadir, Fès, Meknès, Oujda, Marrakech, etc.",
          "",
          "## TRACK 9 — FSJES (Droit, Économie, Sciences Sociales)",
          "- Open access for all Bac holders (≥ 10/20). No selection exam.",
          "- Programs: Droit, Sciences Économiques, Sciences de Gestion, Sociologie.",
          "- Highly crowded faculties. Not selective but leads to License, Master, Doctorat.",
          "- Found at all major universities.",
          "",
          "## TRACK 10 — OFPPT / ISTA / BTS (Vocational Training)",
          "- OFPPT (Office de la Formation Professionnelle et de la Promotion du Travail) — vocational training.",
          "- ISTA: Institut Spécialisé de Technologie Appliquée — practical, employer-linked training.",
          "- BTS: Brevet de Technicien Supérieur — 2-year program in lycées techniques.",
          "- Specialties: Informatique, Réseaux, Électronique, Mécanique, Commerce, Hôtellerie, etc.",
          "- Excellent for students who prefer hands-on, employment-focused careers.",
          "- Admission: file-based, Bac average ≥ 10 in relevant subjects.",
          "",
          "## PRIVATE UNIVERSITIES",
          "- UIR: Université Internationale de Rabat — engineering, management, law. Private but university-grade.",
          "- Mundiapolis Casablanca — business and management.",
          "- UIC: Université Internationale de Casablanca.",
          "- UPM: Université Privée de Marrakech.",
          "- HEM: Haute École de Management (Casablanca, Rabat, Fès, Marrakech, Tanger) — top private business school.",
          "- ISCAE: Institut Supérieur de Commerce et d'Administration des Entreprises (Casablanca, Rabat) — prestigious public/private MBA school (post-Bac+3 or Bac+5 entry via concours).",
          "- Private schools require fees but often have less-competitive entry; some have accreditation from French/Canadian universities.",
          "",
          "## IMPORTANT ORIENTATION PLATFORMS",
          "- cursussup.gov.ma: for ENCG, ENSA, FMP/Medicine concours registration.",
          "- tawjihi.ma: for EST, BTS pre-inscriptions.",
          "- bac.men.gov.ma / taalim.ma: for rattrapage results and Bac records.",
          "",
          "═══════════════════════════════════════════════════════",
          "TONE & FORMAT REQUIREMENTS:",
          "═══════════════════════════════════════════════════════",
          "- Be honest and realistic about scores — do not sugarcoat poor performance.",
          "- Be encouraging and empathetic — always suggest a constructive path forward.",
          "- Be specific: name actual schools, concours, and platforms relevant to the student's branch and scores.",
          "- Keep the report well-structured but thorough — aim for 500-800 words.",
          "- Use bullet points within sections for clarity.",
          "- Do NOT include generic advice. Every sentence should be actionable and specific to this student's actual data.",
        ].join("\n")
      }
    ];

    const userMessage = {
      role: "user",
      content: [
        {
          text: JSON.stringify({
            student: {
              full_name: student.full_name,
              branch: branch,
              level: "2ème Baccalaureate"
            },
            averages: {
              examen_regional: regionalAvg.toFixed(2),
              controle_continu: ccAvg.toFixed(2),
              examen_national: nationalAvg.toFixed(2),
              moyenne_generale: overall.toFixed(2),
              formula: "25% Régional + 25% CC + 50% National"
            },
            grades_by_subject: annotatedGrades,
            eligibility,
            note: "All numerical data above is pre-validated and authoritative. Do NOT recalculate."
          }, null, 2)
        }
      ]
    };

    // ── 7. Call Amazon Bedrock ConverseCommand ────────────────────────────
    const bedrockResponse = await bedrockClient.send(
      new ConverseCommand({
        modelId: modelId,
        system: systemPrompt,
        messages: [userMessage],
        inferenceConfig: {
          maxTokens: 2048,
          temperature: 0.4,   // Slightly lower = more consistent, factual output
          topP: 0.9
        }
      })
    );

    // Extract text from the Converse API response structure
    const outputMessage = bedrockResponse.output?.message?.content ?? [];
    const guidanceText = outputMessage
      .filter(block => block.text)
      .map(block => block.text)
      .join("\n")
      .trim();

    if (!guidanceText) {
      console.error(`Bedrock returned empty content for student ${code_massar}`);
      return res.status(502).json({ error: "The AI guidance service returned an empty response. Please try again." });
    }

    console.log(`Guidance report generated for student ${code_massar} (${student.result})`);

    return res.status(200).json({
      guidance: guidanceText,
      result: student.result,
      overall_average: overall.toFixed(2),
      mention: eligibility.mention
    });

  } catch (error) {
    // Surface actionable Bedrock errors without leaking internal details
    if (error.name === "AccessDeniedException" || error.$metadata?.httpStatusCode === 403) {
      console.error(`Bedrock access denied for student ${code_massar}:`, error.message);
      return res.status(503).json({ error: "The AI guidance service is not accessible. Please contact your administrator." });
    }
    if (error.name === "ValidationException") {
      console.error(`Bedrock validation error for student ${code_massar}:`, error.message);
      return res.status(400).json({ error: "Could not process the guidance request. Please try again." });
    }
    console.error(`Guidance generation error for student ${code_massar}:`, error.message);
    return res.status(500).json({ error: "An unexpected error occurred while generating your guidance report." });
  }
});

/**
 * ROUTE: POST /api/guidance/chat
 * Protected route — students only (admins and teachers are rejected).
 *
 * Implements a stateless conversational AI advisor powered by Amazon Bedrock
 * (amazon.nova-pro-v1:0 via ConverseCommand).  The client owns the full
 * conversation history and replays it on every request; nothing is stored
 * server-side.
 *
 * First-message behaviour:
 *   When the client sends exactly one user message (i.e. the very first turn),
 *   the server fetches the student's live grades from Aurora and prepends them
 *   as a structured data block inside the system prompt.  This gives the model
 *   authoritative, up-to-date context without the student having to provide it.
 *
 * Subsequent turns:
 *   The client replays the full history (all prior user + assistant messages).
 *   The system prompt is always rebuilt with the same grade context on every
 *   call — the model never needs server-state memory.
 *
 * Request body: { messages: [{ role: "user"|"assistant", content: string }] }
 * Response:     { reply: string }
 */
app.post("/api/guidance/chat", authMiddleware, async (req, res) => {
  // ── 1. Identity resolution ─────────────────────────────────────────────
  const cognitoUser = req.user.username || req.user["cognito:username"] || req.user.email || "";
  const code_massar = cognitoUser.split("@")[0].toUpperCase();

  if (!code_massar) {
    return res.status(400).json({ error: "Invalid user claim format. Cannot parse code_massar." });
  }

  // ── 2. Students-only guard ─────────────────────────────────────────────
  const groups = req.user["cognito:groups"] || [];
  if (groups.includes("admins") || groups.includes("teachers")) {
    return res.status(403).json({ error: "Forbidden: The AI chat advisor is only available to students." });
  }

  // ── 3. Validate request body ───────────────────────────────────────────
  const { messages } = req.body;

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "Request body must contain a non-empty 'messages' array." });
  }

  // Validate each message has the required shape
  for (const msg of messages) {
    if (!msg.role || !["user", "assistant"].includes(msg.role) || typeof msg.content !== "string") {
      return res.status(400).json({
        error: "Each message must have a 'role' ('user' or 'assistant') and a 'content' string."
      });
    }
  }

  // The last message must be from the user (we are responding to it)
  if (messages[messages.length - 1].role !== "user") {
    return res.status(400).json({ error: "The last message in the conversation must be from the 'user'." });
  }

  try {
    // ── 4. Fetch student grades from Aurora ────────────────────────────────
    //   Always fetch on every request so the system prompt always reflects the
    //   latest data (teachers may have updated grades between turns).
    const db = await getDbPool();

    const [students] = await db.query(
      `SELECT id, full_name, branch, level, result,
              average_regional, average_cc, average_national, average
       FROM students WHERE code_massar = ?`,
      [code_massar]
    );

    if (students.length === 0) {
      return res.status(404).json({ error: "Student record not found." });
    }

    const student = students[0];

    const [subjectRows] = await db.query(
      `SELECT subject_name, exam_type, grade
       FROM subject_results WHERE student_id = ?
       ORDER BY exam_type, subject_name`,
      [student.id]
    );

    // Group subject rows by exam type for clearer context
    const nationalGrades = [];
    const regionalGrades = [];
    const ccGrades = [];

    subjectRows.forEach(r => {
      const line = `    - ${r.subject_name}: ${parseFloat(r.grade).toFixed(2)}/20`;
      if (r.exam_type === "Examen National") {
        nationalGrades.push(line);
      } else if (r.exam_type === "Examen Régional") {
        regionalGrades.push(line);
      } else if (r.exam_type === "Contrôle Continu") {
        ccGrades.push(line);
      }
    });

    const gradeLines = [];
    if (nationalGrades.length > 0) {
      gradeLines.push("  * Examen National (National Exam — 50% weight):");
      gradeLines.push(...nationalGrades);
    }
    if (regionalGrades.length > 0) {
      gradeLines.push("  * Examen Régional (Regional Exam — 25% weight):");
      gradeLines.push(...regionalGrades);
    }
    if (ccGrades.length > 0) {
      gradeLines.push("  * Contrôle Continu (Continuous Assessment — 25% weight):");
      gradeLines.push(...ccGrades);
    }
    if (gradeLines.length === 0) {
      gradeLines.push("  (No subject grades recorded yet.)");
    }

    const gradesByType = {};
    subjectRows.forEach(row => {
      if (!gradesByType[row.exam_type]) gradesByType[row.exam_type] = {};
      gradesByType[row.exam_type][row.subject_name] = parseFloat(row.grade);
    });

    const overall      = parseFloat(student.average          || 0);
    const regionalAvg  = parseFloat(student.average_regional || 0);
    const ccAvg        = parseFloat(student.average_cc       || 0);
    const nationalAvg  = parseFloat(student.average_national || 0);
    const branch       = student.branch || "Sciences Physiques";
    const level        = student.level  || "2ème Bac";

    const mention =
      overall >= 16 ? "Très Bien" :
      overall >= 14 ? "Bien"      :
      overall >= 12 ? "Assez Bien":
      overall >= 10 ? "Passable"  : "N/A";

    const mathGrade = (gradesByType["Examen National"]?.["Mathématiques"]
                    ?? gradesByType["Contrôle Continu"]?.["Mathématiques"]
                    ?? 0);
    const physGrade = (gradesByType["Examen National"]?.["Physique-Chimie"]
                    ?? gradesByType["Contrôle Continu"]?.["Physique-Chimie"]
                    ?? 0);
    const svtGrade  = (gradesByType["Examen National"]?.["Sciences de la Vie et de la Terre"]
                    ?? gradesByType["Contrôle Continu"]?.["Sciences de la Vie et de la Terre"]
                    ?? 0);

    const isRattrapageEligible = student.result === "Ajourné" && overall >= 8.0;
    const cpgeEligible = student.result === "Admis" && overall >= 14.0
                     && mathGrade >= 12 && physGrade >= 12;
    const ensaEligible = student.result === "Admis" && overall >= 12.0
                     && mathGrade >= 12;
    const fmpEligible = student.result === "Admis" && overall >= 14.0
                    && svtGrade >= 14 && physGrade >= 12;
    const encgEligible = student.result === "Admis" && overall >= 12.0;
    const estEligible = student.result === "Admis" && overall >= 10.0;
    const fstEligible = student.result === "Admis" && overall >= 11.0
                    && (mathGrade >= 10 || physGrade >= 10);

    // ── 5. Build the system prompt ─────────────────────────────────────────
    const systemPromptText = [
      "You are MassarAI, an expert Moroccan academic advisor specialising in the Baccalaureate system and higher-education orientation.",
      "You are speaking directly with a student in a live chat session.",
      "",
      "════════════════════════════════════════════════════",
      "STRICT BEHAVIOURAL RULES — never violate these:",
      "════════════════════════════════════════════════════",
      "1. Answer ONLY questions related to the student's academic situation, Baccalaureate results,",
      "   university tracks, orientation, and future studies in Morocco.",
      "2. If the student asks about anything outside this scope (politics, personal life, coding help,",
      "   general knowledge, etc.), politely decline and redirect them to their academic questions.",
      "3. NEVER perform mathematical calculations — all averages below are pre-computed and authoritative.",
      "   Trust them as ground truth and never modify them.",
      "4. Be HONEST, direct, and constructive: if the student failed, say so clearly and respectfully.",
      "   Never sugarcoat a failure or give false hope (e.g. suggesting they qualify for universities if they failed).",
      "   Always accompany honesty with a concrete, realistic action plan based on their eligibility flags below.",
      "5. Be specific: cite real Moroccan schools, concours names, and orientation platforms",
      "   (cursussup.gov.ma, tawjihi.ma, bac.men.gov.ma).",
      "6. Keep replies concise and conversational — this is a chat, not a report.",
      "   Use short paragraphs or bullet points when listing options.",
      "7. Do NOT repeat the student's full grade table back to them unless they explicitly ask.",
      "8. Do NOT invent schools, thresholds, or requirements not grounded in your knowledge.",
      "9. NEVER contradict the pre-calculated Eligibility Status flags below. For example, if the student asks if they are eligible for rattrapage (retakes) and it is marked NOT ELIGIBLE, you must state that they are NOT eligible, explaining that their overall average (e.g. 2.78/20) does not meet the minimum required 8.00/20 threshold. Never say they are eligible or that the threshold is 2/20.",
      "10. If the student is ELIGIBLE for Rattrapage (overall average 8.00–9.99/20, result = Ajourné):",
      "    - Explain the rules: only National Exam papers are retaken (Regional and CC are kept).",
      "    - Explain that the final subject grade is the BEST score between ordinary and retake sessions.",
      "    - Help them target a revision strategy: focus on high-coefficient subjects (e.g. Maths, Physics, SVT depending on stream) where they got low grades, as improvement there yields the biggest impact to push their average above 10.00/20.",
      "11. If the student is NOT eligible for Rattrapage (average < 8.00/20, result = Ajourné):",
      "    - Be direct and honest that they cannot retake the exam this year.",
      "    - Guide them to concrete alternatives: repeat the year at school (if allowed), register as a 'Candidat Libre' (Free Candidate) for next year's Baccalaureate, or apply to OFPPT vocational training (Niveau Qualification) which accepts 'Niveau 2ème Année Bac' (completed the year but without diploma).",
      "",
      "════════════════════════════════════════════════════",
      "STUDENT'S ACADEMIC RECORD (pre-validated, authoritative):",
      "════════════════════════════════════════════════════",
      `Name:    ${student.full_name}`,
      `Branch:  ${branch}`,
      `Level:   ${level}`,
      `Result:  ${student.result}`,
      `Mention: ${mention}`,
      "",
      "Averages (formula: 25% Régional + 25% CC + 50% National):",
      `  Examen Régional:  ${regionalAvg.toFixed(2)}/20`,
      `  Contrôle Continu: ${ccAvg.toFixed(2)}/20`,
      `  Examen National:  ${nationalAvg.toFixed(2)}/20`,
      `  Moyenne Générale: ${overall.toFixed(2)}/20`,
      "",
      "Eligibility Status (derived server-side, trust these absolutely):",
      `  Rattrapage Session (Retakes): ${isRattrapageEligible ? "ELIGIBLE" : "NOT ELIGIBLE"} (Requires result = Ajourné AND overall average between 8.00 and 9.99/20)`,
      `  CPGE (Preparatory Classes): ${cpgeEligible ? "ELIGIBLE" : "NOT ELIGIBLE"}`,
      `  ENSA (Engineering Network): ${ensaEligible ? "ELIGIBLE" : "NOT ELIGIBLE"}`,
      `  FMP (Medicine/Pharmacy): ${fmpEligible ? "ELIGIBLE" : "NOT ELIGIBLE"}`,
      `  ENCG (Business/Management): ${encgEligible ? "ELIGIBLE" : "NOT ELIGIBLE"}`,
      `  EST (Technology Institutes): ${estEligible ? "ELIGIBLE" : "NOT ELIGIBLE"}`,
      `  FST (Faculty of Sciences & Techniques): ${fstEligible ? "ELIGIBLE" : "NOT ELIGIBLE"}`,
      "",
      "Subject grades:",
      ...(gradeLines.length > 0 ? gradeLines : ["  (No subject grades recorded yet.)"]),
      "",
      "════════════════════════════════════════════════════",
      "MOROCCAN HIGHER EDUCATION QUICK REFERENCE:",
      "════════════════════════════════════════════════════",
      "- CPGE (Grandes Écoles prep): ≥ 14/20 overall, Maths ≥ 14, Physics ≥ 12",
      "- ENSA network (integrated engineering, 16 schools): ≥ 12/20, Maths ≥ 12",
      "- Medicine/Pharmacy (FMP concours): ≥ 14/20 overall, SVT ≥ 14, Physics ≥ 12 (competitive realistically 15+)",
      "- ENCG (management, 17 campuses): ≥ 12/20 overall",
      "- FST (applied sciences faculties): ≥ 11/20, Maths or Physics ≥ 10",
      "- EST (2-year DUT technology): ≥ 10/20 overall",
      "- FS (fundamental sciences, near open-access): ≥ 10/20",
      "- FSJES (law, economics — open access): ≥ 10/20",
      "- OFPPT/ISTA/BTS (vocational): ≥ 10/20 in relevant subjects",
      "- Rattrapage session rules: only National Exam papers are retaken (Regional and CC are kept). Best score between ordinary and retake is kept for each retaken subject.",
      "- Failed Baccalaureate alternatives: repeat the year at school, register as a 'Candidat Libre' (Free Candidate) for next year's Baccalaureate, or apply to OFPPT/ISTA (Niveau Qualification) which accepts 'Niveau 2ème Année Bac' (completed 2nd year of Baccalaureate without passing the exam).",
      "- Key platforms: cursussup.gov.ma, tawjihi.ma, bac.men.gov.ma",
    ].join("\n");

    // ── 6. Build the Bedrock messages array ────────────────────────────────
    //   Map the client history to the Bedrock ConverseCommand format:
    //   each message content is an array of text blocks.
    const bedrockMessages = messages.map(msg => ({
      role: msg.role,
      content: [{ text: msg.content }]
    }));

    // ── 7. Resolve cross-region inference profile ID ───────────────────────
    let modelId;
    const currentRegion = process.env.AWS_REGION || "eu-south-1";
    if (currentRegion.startsWith("us-")) {
      modelId = "us.amazon.nova-pro-v1:0";
    } else if (currentRegion.startsWith("eu-")) {
      modelId = "eu.amazon.nova-pro-v1:0";
    } else if (currentRegion.startsWith("ap-")) {
      modelId = "ap.amazon.nova-pro-v1:0";
    } else {
      modelId = "us.amazon.nova-pro-v1:0"; // default cross-region fallback
    }

    // ── 8. Call Amazon Bedrock ─────────────────────────────────────────────
    const bedrockResponse = await bedrockClient.send(
      new ConverseCommand({
        modelId,
        system: [{ text: systemPromptText }],
        messages: bedrockMessages,
        inferenceConfig: {
          maxTokens: 1024,
          temperature: 0.5,
          topP: 0.9
        }
      })
    );

    // ── 9. Extract and return the assistant's reply ───────────────────────
    const outputBlocks = bedrockResponse.output?.message?.content ?? [];
    const replyText = outputBlocks
      .filter(block => block.text)
      .map(block => block.text)
      .join("\n")
      .trim();

    if (!replyText) {
      console.error(`[guidance/chat] Bedrock returned empty content for student ${code_massar}`);
      return res.status(502).json({ error: "The AI advisor returned an empty response. Please try again." });
    }

    console.log(`[guidance/chat] Reply generated for student ${code_massar} (turn ${messages.length})`);

    return res.status(200).json({ reply: replyText });

  } catch (error) {
    if (error.name === "AccessDeniedException" || error.$metadata?.httpStatusCode === 403) {
      console.error(`[guidance/chat] Bedrock access denied for student ${code_massar}:`, error.message);
      return res.status(503).json({ error: "The AI advisor service is not accessible. Please contact your administrator." });
    }
    if (error.name === "ValidationException") {
      console.error(`[guidance/chat] Bedrock validation error for student ${code_massar}:`, error.message);
      return res.status(400).json({ error: "Could not process the chat request. Please try again." });
    }
    if (error.name === "ThrottlingException" || error.$metadata?.httpStatusCode === 429) {
      console.warn(`[guidance/chat] Bedrock throttled for student ${code_massar}`);
      return res.status(429).json({ error: "The AI advisor is temporarily busy. Please wait a moment and try again." });
    }
    console.error(`[guidance/chat] Unexpected error for student ${code_massar}:`, error.message);
    return res.status(500).json({ error: "An unexpected error occurred. Please try again." });
  }
});

// Start Server listening on port 3000 (required by AWS target group)
app.listen(PORT, () => {
  console.log(`Moroccan Ministry of Education (Massar Mock Portal) running on port ${PORT}`);
  startupInitialization();
});



