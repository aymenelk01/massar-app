-- V7: Add 1ère Bac Students and Level Column

-- Step 1: Alter students table to allow 'En cours' status and add level column
ALTER TABLE students MODIFY COLUMN result ENUM('Admis', 'Ajourné', 'En cours') NOT NULL;
ALTER TABLE students ADD COLUMN level ENUM('1ère Bac', '2ème Bac') NOT NULL DEFAULT '2ème Bac';

-- Step 2: Seed 1ère Bac students
INSERT INTO students (code_massar, full_name, email, phone, branch, level, average_regional, average_cc, average_national, average, result) VALUES
('S139048562', 'Salma Bennani', 's.bennani@taalim.ma', '+212660000001', 'Sciences Physiques', '1ère Bac', 13.20, 13.83, 0.00, 0.00, 'En cours'),
('T142958473', 'Karim Tazi', 'k.tazi@taalim.ma', '+212660000002', 'Sciences Mathématiques A', '1ère Bac', 9.50, 9.78, 0.00, 0.00, 'En cours');

-- Step 3: Seed subject results for Student 6 (Salma Bennani - 1ère Bac - Sciences Physiques)
-- Regional (Arabic, French, Islamic Ed, History-Geography)
INSERT INTO subject_results (student_id, subject_name, exam_type, grade) VALUES
(6, 'Français', 'Examen Régional', 12.00),
(6, 'Langue arabe', 'Examen Régional', 14.00),
(6, 'Éducation islamique', 'Examen Régional', 15.00),
(6, 'Histoire-Géographie', 'Examen Régional', 13.00);

-- Continuous Assessment (CC)
INSERT INTO subject_results (student_id, subject_name, exam_type, grade) VALUES
(6, 'Mathématiques', 'Contrôle Continu', 14.00),
(6, 'Physique-Chimie', 'Contrôle Continu', 13.50),
(6, 'Sciences de la Vie et de la Terre', 'Contrôle Continu', 15.00),
(6, 'Philosophie', 'Contrôle Continu', 12.00),
(6, 'Anglais', 'Contrôle Continu', 14.00);


-- Step 4: Seed subject results for Student 7 (Karim Tazi - 1ère Bac - Sciences Mathématiques A)
-- Regional
INSERT INTO subject_results (student_id, subject_name, exam_type, grade) VALUES
(7, 'Français', 'Examen Régional', 09.00),
(7, 'Langue arabe', 'Examen Régional', 10.00),
(7, 'Éducation islamique', 'Examen Régional', 11.50),
(7, 'Histoire-Géographie', 'Examen Régional', 08.00);

-- Continuous Assessment (CC)
INSERT INTO subject_results (student_id, subject_name, exam_type, grade) VALUES
(7, 'Mathématiques', 'Contrôle Continu', 10.00),
(7, 'Physique-Chimie', 'Contrôle Continu', 09.00),
(7, 'Sciences de la Vie et de la Terre', 'Contrôle Continu', 11.00),
(7, 'Philosophie', 'Contrôle Continu', 10.00),
(7, 'Anglais', 'Contrôle Continu', 09.50);
