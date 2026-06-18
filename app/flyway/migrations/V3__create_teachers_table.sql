-- V3: Create teachers table and seed mock teacher
-- Creates the teachers table for storing business/application data of teachers.

CREATE TABLE IF NOT EXISTS teachers (
    id         INT AUTO_INCREMENT PRIMARY KEY,
    username   VARCHAR(50)  UNIQUE NOT NULL,
    full_name  VARCHAR(100) NOT NULL,
    email      VARCHAR(100) NOT NULL,
    phone      VARCHAR(20)  NOT NULL,
    subject    VARCHAR(100) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seed a mock teacher (Flyway ensures this runs once)
INSERT INTO teachers (username, full_name, email, phone, subject) VALUES
('t.bennani', 'Tariq Bennani', 't.bennani@taalim.ma', '+212600112233', 'Mathématiques');
