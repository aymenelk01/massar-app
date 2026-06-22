-- V5: Create IAM database user for application authentication
-- =============================================================
-- Creates a MySQL user that authenticates exclusively via AWS IAM tokens
-- (no password). The ECS task role is granted rds-db:connect permission
-- on this user in Terraform (modules/compute/iam.tf), which issues a
-- short-lived token used instead of a password.
--
-- This user name MUST match the dbuser segment in the IAM policy ARN:
--   arn:aws:rds-db:<region>:<account>:dbuser:<proxy-resource-id>/db_iam_user
--
-- Reference: https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/UsingWithRDS.IAMDBAuth.DBAccounts.html

-- Step 1: Create the user with AWSAuthenticationPlugin (IAM-only, no password).
-- IF NOT EXISTS makes this migration safe to re-run (idempotent).
CREATE USER IF NOT EXISTS 'db_iam_user'@'%'
    IDENTIFIED WITH AWSAuthenticationPlugin AS 'RDS';

-- Step 2: Grant the application only the privileges it actually needs.
-- DML access on all current and future tables in the application schema.
-- The master user (Flyway) retains DDL rights for schema migrations.
GRANT SELECT, INSERT, UPDATE, DELETE
    ON massardb.*
    TO 'db_iam_user'@'%';

-- Step 3: Require SSL for every connection made by this user.
-- This enforces encryption in transit from the RDS Proxy to Aurora,
-- consistent with the proxy's require_tls = true setting.
ALTER USER 'db_iam_user'@'%' REQUIRE SSL;

-- Step 4: Flush privileges to ensure the grant takes effect immediately.
FLUSH PRIVILEGES;
