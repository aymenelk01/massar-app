-- V1: Create initial schema
-- Creates the massardb tables if they do not already exist.
-- Uses IF NOT EXISTS to be idempotent and safe for existing databases.

CREATE TABLE IF NOT EXISTS students (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    code_massar     VARCHAR(50)  UNIQUE NOT NULL,
    full_name       VARCHAR(100) NOT NULL,
    email           VARCHAR(100) NOT NULL,
    phone           VARCHAR(20)  NOT NULL,
    result          ENUM('Admis', 'Ajourné') NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS subject_results (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    student_id   INT            NOT NULL,
    subject_name VARCHAR(100)   NOT NULL,
    grade        DECIMAL(4,2)   NOT NULL,
    FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
