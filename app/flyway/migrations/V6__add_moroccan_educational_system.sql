-- V6: Add Moroccan Educational System Columns and Seed Real Data

-- Step 1: Add columns to students table
ALTER TABLE students ADD COLUMN branch VARCHAR(100) NOT NULL DEFAULT 'Sciences Physiques';
ALTER TABLE students ADD COLUMN average_regional DECIMAL(4,2) NOT NULL DEFAULT 0.00;
ALTER TABLE students ADD COLUMN average_cc DECIMAL(4,2) NOT NULL DEFAULT 0.00;
ALTER TABLE students ADD COLUMN average_national DECIMAL(4,2) NOT NULL DEFAULT 0.00;
ALTER TABLE students ADD COLUMN average DECIMAL(4,2) NOT NULL DEFAULT 0.00;

-- Step 2: Delete simple old mock data from subject_results
DELETE FROM subject_results;

-- Step 3: Add exam_type column to subject_results
ALTER TABLE subject_results ADD COLUMN exam_type ENUM('Contrôle Continu', 'Examen Régional', 'Examen National') NOT NULL;

-- Step 4: Update students table with realistic branches, averages, and statuses
UPDATE students SET
  branch = 'Sciences Physiques',
  average_regional = 14.10,
  average_cc = 15.48,
  average_national = 15.98,
  average = 15.39,
  result = 'Admis'
WHERE id = 1;

UPDATE students SET
  branch = 'Sciences Mathématiques A',
  average_regional = 16.70,
  average_cc = 17.63,
  average_national = 18.41,
  average = 17.79,
  result = 'Admis'
WHERE id = 2;

UPDATE students SET
  branch = 'Sciences Physiques',
  average_regional = 8.70,
  average_cc = 9.41,
  average_national = 8.46,
  average = 8.76,
  result = 'Ajourné'
WHERE id = 3;

UPDATE students SET
  branch = 'Sciences Physiques',
  average_regional = 11.00,
  average_cc = 11.74,
  average_national = 12.28,
  average = 11.83,
  result = 'Admis'
WHERE id = 4;

UPDATE students SET
  branch = 'Sciences Mathématiques A',
  average_regional = 7.80,
  average_cc = 8.37,
  average_national = 7.46,
  average = 7.77,
  result = 'Ajourné'
WHERE id = 5;

-- Step 5: Seed realistic subject results matching Moroccan coefficients and branches

-- Student 1 (Yassine El Idrissi - Sciences Physiques - Admis)
-- Regional (Arabic, French, Islamic Ed, History-Geography)
INSERT INTO subject_results (student_id, subject_name, exam_type, grade) VALUES
(1, 'Français', 'Examen Régional', 14.50),
(1, 'Langue arabe', 'Examen Régional', 13.00),
(1, 'Éducation islamique', 'Examen Régional', 16.00),
(1, 'Histoire-Géographie', 'Examen Régional', 12.50);

-- Continuous Assessment (CC)
INSERT INTO subject_results (student_id, subject_name, exam_type, grade) VALUES
(1, 'Mathématiques', 'Contrôle Continu', 15.00),
(1, 'Physique-Chimie', 'Contrôle Continu', 16.50),
(1, 'Sciences de la Vie et de la Terre', 'Contrôle Continu', 15.50),
(1, 'Philosophie', 'Contrôle Continu', 13.00),
(1, 'Anglais', 'Contrôle Continu', 16.00);

-- National
INSERT INTO subject_results (student_id, subject_name, exam_type, grade) VALUES
(1, 'Mathématiques', 'Examen National', 16.00),
(1, 'Physique-Chimie', 'Examen National', 17.00),
(1, 'Sciences de la Vie et de la Terre', 'Examen National', 16.50),
(1, 'Philosophie', 'Examen National', 12.00),
(1, 'Anglais', 'Examen National', 15.00);


-- Student 2 (Fatim-Zahra El Alami - Sciences Mathématiques A - Admis)
-- Regional
INSERT INTO subject_results (student_id, subject_name, exam_type, grade) VALUES
(2, 'Français', 'Examen Régional', 17.00),
(2, 'Langue arabe', 'Examen Régional', 15.50),
(2, 'Éducation islamique', 'Examen Régional', 18.00),
(2, 'Histoire-Géographie', 'Examen Régional', 16.00);

-- Continuous Assessment (CC)
INSERT INTO subject_results (student_id, subject_name, exam_type, grade) VALUES
(2, 'Mathématiques', 'Contrôle Continu', 18.50),
(2, 'Physique-Chimie', 'Contrôle Continu', 18.00),
(2, 'Sciences de la Vie et de la Terre', 'Contrôle Continu', 16.00),
(2, 'Philosophie', 'Contrôle Continu', 15.00),
(2, 'Anglais', 'Contrôle Continu', 17.50);

-- National
INSERT INTO subject_results (student_id, subject_name, exam_type, grade) VALUES
(2, 'Mathématiques', 'Examen National', 19.50),
(2, 'Physique-Chimie', 'Examen National', 19.00),
(2, 'Sciences de la Vie et de la Terre', 'Examen National', 17.00),
(2, 'Philosophie', 'Examen National', 14.00),
(2, 'Anglais', 'Examen National', 18.00);


-- Student 3 (Amina Benslimane - Sciences Physiques - Ajourné)
-- Regional
INSERT INTO subject_results (student_id, subject_name, exam_type, grade) VALUES
(3, 'Français', 'Examen Régional', 08.00),
(3, 'Langue arabe', 'Examen Régional', 09.00),
(3, 'Éducation islamique', 'Examen Régional', 10.00),
(3, 'Histoire-Géographie', 'Examen Régional', 08.50);

-- Continuous Assessment (CC)
INSERT INTO subject_results (student_id, subject_name, exam_type, grade) VALUES
(3, 'Mathématiques', 'Contrôle Continu', 09.00),
(3, 'Physique-Chimie', 'Contrôle Continu', 09.50),
(3, 'Sciences de la Vie et de la Terre', 'Contrôle Continu', 10.00),
(3, 'Philosophie', 'Contrôle Continu', 09.00),
(3, 'Anglais', 'Contrôle Continu', 09.50);

-- National
INSERT INTO subject_results (student_id, subject_name, exam_type, grade) VALUES
(3, 'Mathématiques', 'Examen National', 08.00),
(3, 'Physique-Chimie', 'Examen National', 08.50),
(3, 'Sciences de la Vie et de la Terre', 'Examen National', 09.00),
(3, 'Philosophie', 'Examen National', 09.00),
(3, 'Anglais', 'Examen National', 08.00);


-- Student 4 (Mehdi Tagnaouti - Sciences Physiques - Admis)
-- Regional
INSERT INTO subject_results (student_id, subject_name, exam_type, grade) VALUES
(4, 'Français', 'Examen Régional', 10.00),
(4, 'Langue arabe', 'Examen Régional', 11.00),
(4, 'Éducation islamique', 'Examen Régional', 12.00),
(4, 'Histoire-Géographie', 'Examen Régional', 11.00);

-- Continuous Assessment (CC)
INSERT INTO subject_results (student_id, subject_name, exam_type, grade) VALUES
(4, 'Mathématiques', 'Contrôle Continu', 11.50),
(4, 'Physique-Chimie', 'Contrôle Continu', 12.00),
(4, 'Sciences de la Vie et de la Terre', 'Contrôle Continu', 12.50),
(4, 'Philosophie', 'Contrôle Continu', 10.50),
(4, 'Anglais', 'Contrôle Continu', 11.00);

-- National
INSERT INTO subject_results (student_id, subject_name, exam_type, grade) VALUES
(4, 'Mathématiques', 'Examen National', 12.00),
(4, 'Physique-Chimie', 'Examen National', 12.50),
(4, 'Sciences de la Vie et de la Terre', 'Examen National', 13.00),
(4, 'Philosophie', 'Examen National', 11.00),
(4, 'Anglais', 'Examen National', 12.00);


-- Student 5 (Ayoub Cherkaoui - Sciences Mathématiques A - Ajourné)
-- Regional
INSERT INTO subject_results (student_id, subject_name, exam_type, grade) VALUES
(5, 'Français', 'Examen Régional', 07.50),
(5, 'Langue arabe', 'Examen Régional', 09.00),
(5, 'Éducation islamique', 'Examen Régional', 08.00),
(5, 'Histoire-Géographie', 'Examen Régional', 07.00);

-- Continuous Assessment (CC)
INSERT INTO subject_results (student_id, subject_name, exam_type, grade) VALUES
(5, 'Mathématiques', 'Contrôle Continu', 08.00),
(5, 'Physique-Chimie', 'Contrôle Continu', 08.50),
(5, 'Sciences de la Vie et de la Terre', 'Contrôle Continu', 09.00),
(5, 'Philosophie', 'Contrôle Continu', 08.00),
(5, 'Anglais', 'Contrôle Continu', 09.00);

-- National
INSERT INTO subject_results (student_id, subject_name, exam_type, grade) VALUES
(5, 'Mathématiques', 'Examen National', 07.00),
(5, 'Physique-Chimie', 'Examen National', 07.50),
(5, 'Sciences de la Vie et de la Terre', 'Examen National', 08.00),
(5, 'Philosophie', 'Examen National', 08.50),
(5, 'Anglais', 'Examen National', 07.50);
