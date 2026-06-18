-- V4: Add enabled status to students and teachers tables
-- Allows the administrator to temporarily disable/suspend accounts.

ALTER TABLE students ADD COLUMN enabled TINYINT(1) NOT NULL DEFAULT 1;
ALTER TABLE teachers ADD COLUMN enabled TINYINT(1) NOT NULL DEFAULT 1;
