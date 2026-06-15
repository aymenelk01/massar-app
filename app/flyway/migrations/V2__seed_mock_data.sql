-- V2: Seed mock student data
-- Inserts 5 mock Moroccan students and their subject results.
-- Flyway ensures this runs only once.

INSERT INTO students (code_massar, full_name, email, phone, result) VALUES
('K130029841', 'Yassine El Idrissi',   'y.elidrissi@taalim.ma',   '+212661234567', 'Admis'),
('D145690832', 'Fatim-Zahra El Alami', 'fz.elalami@taalim.ma',    '+212675987654', 'Admis'),
('R130987452', 'Amina Benslimane',     'a.benslimane@taalim.ma',  '+212654321098', 'Ajourné'),
('M120934857', 'Mehdi Tagnaouti',      'm.tagnaouti@taalim.ma',   '+212612987456', 'Admis'),
('G135764201', 'Ayoub Cherkaoui',      'a.cherkaoui@taalim.ma',   '+212623456789', 'Ajourné');

-- Student 1: Yassine El Idrissi (Admis)
INSERT INTO subject_results (student_id, subject_name, grade) VALUES
(1, 'Mathématiques',                   16.50),
(1, 'Physique-Chimie',                 17.25),
(1, 'Sciences de la Vie et de la Terre', 15.00),
(1, 'Philosophie',                     12.00);

-- Student 2: Fatim-Zahra El Alami (Admis)
INSERT INTO subject_results (student_id, subject_name, grade) VALUES
(2, 'Mathématiques',                   19.00),
(2, 'Physique-Chimie',                 18.50),
(2, 'Sciences de la Vie et de la Terre', 17.75),
(2, 'Philosophie',                     14.50);

-- Student 3: Amina Benslimane (Ajourné)
INSERT INTO subject_results (student_id, subject_name, grade) VALUES
(3, 'Mathématiques',                   08.50),
(3, 'Physique-Chimie',                 09.00),
(3, 'Sciences de la Vie et de la Terre', 11.25),
(3, 'Philosophie',                     09.50);

-- Student 4: Mehdi Tagnaouti (Admis)
INSERT INTO subject_results (student_id, subject_name, grade) VALUES
(4, 'Mathématiques',                   13.00),
(4, 'Physique-Chimie',                 12.50),
(4, 'Sciences de la Vie et de la Terre', 14.00),
(4, 'Philosophie',                     11.00);

-- Student 5: Ayoub Cherkaoui (Ajourné)
INSERT INTO subject_results (student_id, subject_name, grade) VALUES
(5, 'Mathématiques',                   07.00),
(5, 'Physique-Chimie',                 08.50),
(5, 'Sciences de la Vie et de la Terre', 09.75),
(5, 'Philosophie',                     10.00);
