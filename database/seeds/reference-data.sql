-- Reference rows from the Laravel CourseSeeder and SkillSeeder.
-- Existing matching rows are kept as-is.
INSERT INTO courses (nama_bahasa,kode,deskripsi) VALUES
    ('English','eng','Kursus Bahasa Inggris'),
    ('Korean','kor','Kursus Bahasa Korea'),
    ('Thai','th','Kursus Bahasa Thailand')
ON CONFLICT (kode) DO NOTHING;

INSERT INTO skills (nama_skill,kode) VALUES
    ('Reading','reading'),
    ('Writing','writing'),
    ('Listening','listening'),
    ('Speaking','speaking'),
    ('Grammar','grammar')
ON CONFLICT (kode) DO NOTHING;
