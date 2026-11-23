const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mysql = require('mysql2');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const nodemailer = require('nodemailer');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

const sessionMiddleware = session({
    secret: process.env.SESSION_SECRET || 'loveszverseny_titkos_kulcs_2026',
    resave: false,
    saveUninitialized: false
});

app.use(sessionMiddleware);
io.engine.use(sessionMiddleware);

const db = mysql.createConnection({
    host: process.env.MYSQLHOST || process.env.DB_HOST || 'localhost',
    user: process.env.MYSQLUSER || process.env.DB_USER || 'root',
    password: process.env.MYSQLPASSWORD || process.env.DB_PASS || '',
    database: process.env.MYSQLDATABASE || process.env.DB_NAME || 'loveszverseny',
    port: process.env.MYSQLPORT || process.env.DB_PORT || 3306
});

db.connect(err => {
    if (err) {
        console.error('MySQL csatlakozási hiba:', err);
        return;
    }
    console.log('Sikeres csatlakozás a MySQL adatbázishoz!');

    // Adatbázis sémák ellenőrzése és bővítése
    db.query("SHOW COLUMNS FROM competitors LIKE 'gender'", (colErr, cols) => {
        if (!colErr && cols.length === 0) {
            db.query("ALTER TABLE competitors ADD COLUMN gender ENUM('male', 'female') NOT NULL DEFAULT 'male' AFTER birth_date");
        }
    });

    db.query("SHOW COLUMNS FROM tasks LIKE 'type'", (colErr, cols) => {
        if (!colErr && cols.length === 0) {
            db.query("ALTER TABLE tasks ADD COLUMN type ENUM('individual', 'team') NOT NULL DEFAULT 'individual'");
            db.query("ALTER TABLE tasks ADD COLUMN judge_id INT NULL");
            db.query("ALTER TABLE tasks ADD COLUMN base_points INT NOT NULL DEFAULT 150");
            db.query("ALTER TABLE tasks ADD COLUMN deduction_per_sec FLOAT NOT NULL DEFAULT 0.5");
        }
    });

    db.query("SHOW COLUMNS FROM scores LIKE 'team_id'", (colErr, cols) => {
        if (!colErr && cols.length === 0) {
            db.query("ALTER TABLE scores ADD COLUMN team_id INT NULL");
            db.query("ALTER TABLE scores MODIFY COLUMN competitor_id INT NULL");
        }
    });

    db.query("SHOW COLUMNS FROM scores LIKE 'notes'", (colErr, cols) => {
        if (!colErr && cols.length === 0) {
            db.query("ALTER TABLE scores ADD COLUMN notes TEXT NULL");
        }
    });

    // Új táblák: announcements (kiírások) és task_criteria (pontozási szempontok)
    db.query(`CREATE TABLE IF NOT EXISTS announcements (
        id INT AUTO_INCREMENT PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`, () => {});

    db.query(`CREATE TABLE IF NOT EXISTS task_criteria (
        id INT AUTO_INCREMENT PRIMARY KEY,
        task_id INT NOT NULL,
        name VARCHAR(255) NOT NULL,
        unit_name VARCHAR(100) NOT NULL,
        points_per_unit FLOAT NOT NULL DEFAULT 10,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    )`, () => {});

    db.query(`CREATE TABLE IF NOT EXISTS score_criteria_values (
        id INT AUTO_INCREMENT PRIMARY KEY,
        score_id INT NOT NULL,
        criteria_id INT NOT NULL,
        quantity FLOAT NOT NULL DEFAULT 0,
        FOREIGN KEY (score_id) REFERENCES scores(id) ON DELETE CASCADE,
        FOREIGN KEY (criteria_id) REFERENCES task_criteria(id) ON DELETE CASCADE
    )`, () => {});

    // Admin fiók biztosítása
    bcrypt.hash('admin123', 10, (hashErr, hashedPassword) => {
        if (!hashErr) {
            db.query('SELECT * FROM users WHERE username = ?', ['admin'], (qErr, results) => {
                if (!qErr && results.length === 0) {
                    db.query('INSERT INTO users (username, password, role, must_change_password) VALUES (?, ?, ?, ?)', 
                        ['admin', hashedPassword, 'admin', true]);
                }
            });
        }
    });
});

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

// --- AUTH ---
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    db.query('SELECT * FROM users WHERE username = ?', [username], async (err, results) => {
        if (err || results.length === 0) {
            return res.status(401).json({ success: false, message: 'Hibás felhasználónév vagy jelszó!' });
        }
        const user = results[0];
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(401).json({ success: false, message: 'Hibás felhasználónév vagy jelszó!' });
        }

        req.session.user = { id: user.id, username: user.username, role: user.role };
        res.json({ success: true, mustChangePassword: user.must_change_password === 1, role: user.role });
    });
});

app.post('/api/logout', (req, res) => {
    req.session.destroy(() => {
        res.json({ success: true });
    });
});

app.post('/api/change-password', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ success: false, message: 'Nincs bejelentkezve!' });
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) {
        return res.status(400).json({ success: false, message: 'Az új jelszónak legalább 6 karakter hosszúnak kell lennie!' });
    }
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    db.query('UPDATE users SET password = ?, must_change_password = FALSE WHERE id = ?', [hashedPassword, req.session.user.id], (err) => {
        if (err) return res.status(500).json({ success: false, message: 'Hiba történt.' });
        res.json({ success: true, message: 'Sikeres jelszóváltoztatás!', role: req.session.user.role });
    });
});

// --- ANNOUNCEMENTS (KIÍRÁSOK) ---
app.get('/api/announcements', (req, res) => {
    db.query('SELECT * FROM announcements ORDER BY created_at DESC', (err, results) => {
        if (err) return res.status(500).json({ error: 'Adatbázis hiba' });
        res.json(results);
    });
});

app.post('/api/admin/announcements', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') return res.status(403).json({ error: 'Jogosulatlan' });
    const { title, content } = req.body;
    db.query('INSERT INTO announcements (title, content) VALUES (?, ?)', [title, content], (err) => {
        if (err) return res.status(400).json({ success: false, message: 'Hiba a kiírás mentésekor.' });
        res.json({ success: true });
    });
});

app.put('/api/admin/announcements/:id', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') return res.status(403).json({ error: 'Jogosulatlan' });
    const { title, content } = req.body;
    db.query('UPDATE announcements SET title = ?, content = ? WHERE id = ?', [title, content, req.params.id], (err) => {
        if (err) return res.status(400).json({ success: false, message: 'Hiba a módosításkor.' });
        res.json({ success: true });
    });
});

app.delete('/api/admin/announcements/:id', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') return res.status(403).json({ error: 'Jogosulatlan' });
    db.query('DELETE FROM announcements WHERE id = ?', [req.params.id], (err) => {
        res.json({ success: !err });
    });
});

// --- REGISTRATION & USERS & COMPETITORS ---
app.post('/api/register', (req, res) => {
    const { name, school, birth_place, birth_date, gender, food_allergies, email } = req.body;
    if (!gender || (gender !== 'male' && gender !== 'female')) {
        return res.status(400).json({ success: false, message: 'Kérjük, válassza ki a nemét!' });
    }
    const token = uuidv4();
    const query = `INSERT INTO competitors (name, school, birth_place, birth_date, gender, food_allergies, email, verification_token) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
    
    db.query(query, [name, school, birth_place, birth_date, gender, food_allergies, email, token], async (err) => {
        if (err) return res.status(400).json({ success: false, message: 'Ez az e-mail cím már regisztrálva van!' });

        const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
        const verifyLink = `${baseUrl}/api/verify?token=${token}`;
        try {
            await transporter.sendMail({
                from: '"Lövészverseny Csapat" <noreply@loveszverseny.hu>',
                to: email,
                subject: 'Jelentkezés megerősítése',
                html: `<h3>Kedves ${name}!</h3><p>Kérjük, kattintson az alábbi linkre az e-mail címe megerősítéséhez:</p><a href="${verifyLink}">Megerősítés</a>`
            });
            res.json({ success: true, message: 'Sikeres regisztráció! Kérjük, ellenőrizze az e-mail fiókját.' });
        } catch (e) {
            res.status(500).json({ success: false, message: 'Hiba történt az e-mail küldésekor.' });
        }
    });
});

app.get('/api/verify', (req, res) => {
    const token = req.query.token;
    db.query(`UPDATE competitors SET is_email_verified = TRUE, verification_token = NULL WHERE verification_token = ?`, [token], (err, result) => {
        if (err || result.affectedRows === 0) return res.send('<h1>Érvénytelen vagy lejárt megerősítő link!</h1>');
        res.send('<h1>Sikeres e-mail megerősítés! Jelentkezését továbbítottuk az adminisztrátornak.</h1>');
    });
});

app.post('/api/admin/users', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') return res.status(403).json({ error: 'Jogosulatlan' });
    const { username, password, role } = req.body;
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        db.query('INSERT INTO users (username, password, role, must_change_password) VALUES (?, ?, ?, TRUE)', [username, hashedPassword, role], (err) => {
            if (err) return res.status(400).json({ success: false, message: 'A felhasználónév már létezik!' });
            res.json({ success: true });
        });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.get('/api/admin/users', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') return res.status(403).json({ error: 'Jogosulatlan' });
    db.query('SELECT id, username, role, must_change_password, created_at FROM users', (err, results) => {
        res.json(results);
    });
});

app.delete('/api/admin/users/:id', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') return res.status(403).json({ error: 'Jogosulatlan' });
    if (parseInt(req.params.id) === req.session.user.id) return res.status(400).json({ success: false, message: 'Saját magad nem törölheted!' });
    db.query('DELETE FROM users WHERE id = ?', [req.params.id], (err) => {
        res.json({ success: !err });
    });
});

app.get('/api/admin/pending', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') return res.status(403).json({ error: 'Jogosulatlan' });
    db.query(`SELECT * FROM competitors WHERE is_email_verified = TRUE AND status = 'pending_admin'`, (err, results) => {
        res.json(results);
    });
});

app.post('/api/admin/approve', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') return res.status(403).json({ error: 'Jogosulatlan' });
    const { competitorId, teamId } = req.body;
    db.query(`UPDATE competitors SET status = 'approved', team_id = ? WHERE id = ?`, [teamId || null, competitorId], (err) => {
        res.json({ success: !err });
    });
});

app.get('/api/admin/all-competitors', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') return res.status(403).json({ error: 'Jogosulatlan' });
    db.query('SELECT c.*, t.name as team_name, t.team_number FROM competitors c LEFT JOIN teams t ON c.team_id = t.id ORDER BY c.id DESC', (err, results) => {
        res.json(results);
    });
});

app.put('/api/admin/competitors/:id', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') return res.status(403).json({ error: 'Jogosulatlan' });
    const { name, school, birth_place, birth_date, gender, food_allergies, email, status, team_id } = req.body;
    db.query(`UPDATE competitors SET name = ?, school = ?, birth_place = ?, birth_date = ?, gender = ?, food_allergies = ?, email = ?, status = ?, team_id = ? WHERE id = ?`,
        [name, school, birth_place, birth_date, gender, food_allergies, email, status, team_id || null, req.params.id], (err) => {
            res.json({ success: !err });
        });
});

app.delete('/api/admin/competitors/:id', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') return res.status(403).json({ error: 'Jogosulatlan' });
    db.query('DELETE FROM competitors WHERE id = ?', [req.params.id], (err) => {
        res.json({ success: !err });
    });
});

// --- TEAMS ---
app.post('/api/admin/teams', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') return res.status(403).json({ error: 'Jogosulatlan' });
    const { team_number, name } = req.body;
    db.query(`INSERT INTO teams (team_number, name) VALUES (?, ?)`, [team_number, name], (err) => {
        if (err) return res.status(400).json({ success: false, message: 'A sorszám vagy név már létezik.' });
        res.json({ success: true });
    });
});

app.get('/api/admin/teams', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Nincs bejelentkezve' });
    db.query(`SELECT * FROM teams ORDER BY team_number ASC`, (err, teams) => {
        if (err) return res.status(500).json({ error: err });
        db.query(`SELECT id, name, school, gender, status, team_id FROM competitors WHERE team_id IS NOT NULL`, (cErr, members) => {
            const enriched = teams.map(t => ({
                ...t,
                members: members ? members.filter(m => m.team_id === t.id) : []
            }));
            res.json(enriched);
        });
    });
});

app.delete('/api/admin/teams/:id', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') return res.status(403).json({ error: 'Jogosulatlan' });
    db.query(`UPDATE competitors SET team_id = NULL WHERE team_id = ?`, [req.params.id], () => {
        db.query(`DELETE FROM teams WHERE id = ?`, [req.params.id], (err) => {
            res.json({ success: !err });
        });
    });
});

app.post('/api/admin/teams/:id/members', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') return res.status(403).json({ error: 'Jogosulatlan' });
    db.query(`UPDATE competitors SET team_id = ?, status = 'approved' WHERE id = ?`, [req.params.id, req.body.competitorId], (err) => {
        res.json({ success: !err });
    });
});

app.delete('/api/admin/teams/:teamId/members/:competitorId', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') return res.status(403).json({ error: 'Jogosulatlan' });
    db.query(`UPDATE competitors SET team_id = NULL WHERE id = ? AND team_id = ?`, [req.params.competitorId, req.params.teamId], (err) => {
        res.json({ success: !err });
    });
});

// --- TASKS & CRITERIA (FELADATOK ÉS SZEMPONTOK) ---
app.get('/api/tasks', (req, res) => {
    db.query(`SELECT t.*, u.username as judge_name FROM tasks t LEFT JOIN users u ON t.judge_id = u.id`, (err, results) => {
        if (err) return res.status(500).json({ error: 'Adatbázis hiba' });
        // Lekérdezzük a szempontokat is minden feladathoz
        db.query(`SELECT * FROM task_criteria`, (cErr, criteria) => {
            const tasksWithCriteria = results.map(t => ({
                ...t,
                criteria: criteria ? criteria.filter(c => c.task_id === t.id) : []
            }));
            res.json(tasksWithCriteria);
        });
    });
});

app.post('/api/admin/tasks', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') return res.status(403).json({ error: 'Jogosulatlan' });
    const { title, description, type, judge_id, base_points, deduction_per_sec, criteria } = req.body;
    db.query(`INSERT INTO tasks (title, description, type, judge_id, base_points, deduction_per_sec) VALUES (?, ?, ?, ?, ?, ?)`,
        [title, description || '', type || 'individual', judge_id || null, base_points || 150, deduction_per_sec || 0.5], (err, result) => {
            if (err) return res.status(400).json({ success: false, message: 'Hiba a feladat létrehozásakor.' });
            const taskId = result.insertId;

            if (criteria && Array.isArray(criteria) && criteria.length > 0) {
                const criteriaValues = criteria.map(c => [taskId, c.name, c.unit_name, c.points_per_unit || 10]);
                db.query(`INSERT INTO task_criteria (task_id, name, unit_name, points_per_unit) VALUES ?`, [criteriaValues], () => {
                    res.json({ success: true });
                });
            } else {
                res.json({ success: true });
            }
        });
});

app.put('/api/admin/tasks/:id', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') return res.status(403).json({ error: 'Jogosulatlan' });
    const taskId = req.params.id;
    const { title, description, type, judge_id, base_points, deduction_per_sec, criteria } = req.body;

    db.query(`UPDATE tasks SET title = ?, description = ?, type = ?, judge_id = ?, base_points = ?, deduction_per_sec = ? WHERE id = ?`,
        [title, description || '', type || 'individual', judge_id || null, base_points || 150, deduction_per_sec || 0.5, taskId], (err) => {
            if (err) return res.status(400).json({ success: false, message: 'Hiba a feladat frissítésekor.' });

            // Először töröljük a régi szempontokat, majd beszúrjuk az újakat
            db.query(`DELETE FROM task_criteria WHERE task_id = ?`, [taskId], () => {
                if (criteria && Array.isArray(criteria) && criteria.length > 0) {
                    const criteriaValues = criteria.map(c => [taskId, c.name, c.unit_name, c.points_per_unit || 10]);
                    db.query(`INSERT INTO task_criteria (task_id, name, unit_name, points_per_unit) VALUES ?`, [criteriaValues], () => {
                        res.json({ success: true });
                    });
                } else {
                    res.json({ success: true });
                }
            });
        });
});

app.delete('/api/admin/tasks/:id', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') return res.status(403).json({ error: 'Jogosulatlan' });
    db.query('DELETE FROM tasks WHERE id = ?', [req.params.id], (err) => {
        res.json({ success: !err });
    });
});

// Bíró saját feladatai szempontokkal
app.get('/api/judge/tasks', (req, res) => {
    if (!req.session.user || (req.session.user.role !== 'judge' && req.session.user.role !== 'admin')) return res.status(403).json({ error: 'Jogosulatlan' });
    const query = req.session.user.role === 'admin' 
        ? 'SELECT * FROM tasks' 
        : 'SELECT * FROM tasks WHERE judge_id = ?';
    const params = req.session.user.role === 'admin' ? [] : [req.session.user.id];
    db.query(query, params, (err, tasks) => {
        if (err) return res.status(500).json({ error: 'Adatbázis hiba' });
        db.query(`SELECT * FROM task_criteria`, (cErr, criteria) => {
            const enriched = tasks.map(t => ({
                ...t,
                criteria: criteria ? criteria.filter(c => c.task_id === t.id) : []
            }));
            res.json(enriched);
        });
    });
});

// Bíró által rögzített eredmények lekérdezése szerkesztéshez
app.get('/api/judge/scores', (req, res) => {
    if (!req.session.user || (req.session.user.role !== 'judge' && req.session.user.role !== 'admin')) return res.status(403).json({ error: 'Jogosulatlan' });
    const judgeId = req.session.user.id;
    const query = req.session.user.role === 'admin'
        ? `SELECT s.*, t.title as task_name, t.type as task_type, c.name as competitor_name, th.name as team_name 
           FROM scores s 
           JOIN tasks t ON s.task_id = t.id 
           LEFT JOIN competitors c ON s.competitor_id = c.id 
           LEFT JOIN teams th ON s.team_id = th.id 
           ORDER BY s.id DESC`
        : `SELECT s.*, t.title as task_name, t.type as task_type, c.name as competitor_name, th.name as team_name 
           FROM scores s 
           JOIN tasks t ON s.task_id = t.id 
           LEFT JOIN competitors c ON s.competitor_id = c.id 
           LEFT JOIN teams th ON s.team_id = th.id 
           WHERE s.judge_id = ? 
           ORDER BY s.id DESC`;
    const params = req.session.user.role === 'admin' ? [] : [judgeId];

    db.query(query, params, (err, scores) => {
        if (err) return res.status(500).json({ error: 'Adatbázis hiba' });
        res.json(scores);
    });
});

app.put('/api/judge/scores/:id', (req, res) => {
    if (!req.session.user || (req.session.user.role !== 'judge' && req.session.user.role !== 'admin')) return res.status(403).json({ error: 'Jogosulatlan' });
    const scoreId = req.params.id;
    const { time_string, manual_points, notes, criteria_quantities } = req.body;

    let totalSeconds = 0;
    if (time_string && time_string.includes(':')) {
        const parts = time_string.split(':');
        totalSeconds = (parseInt(parts[0]) || 0) * 60 + (parseFloat(parts[1]) || 0);
    } else {
        totalSeconds = parseFloat(time_string) || 0;
    }

    db.query('SELECT s.*, t.base_points, t.deduction_per_sec FROM scores s JOIN tasks t ON s.task_id = t.id WHERE s.id = ?', [scoreId], (err, scoreRes) => {
        if (err || scoreRes.length === 0) return res.status(404).json({ error: 'Eredmény nem található' });
        const scoreRecord = scoreRes[0];

        let awarded_points = manual_points !== undefined && manual_points !== '' 
            ? parseFloat(manual_points) 
            : Math.max(0, scoreRecord.base_points - (totalSeconds * scoreRecord.deduction_per_sec));

        // Ha vannak szempont szerinti mennyiségek, hozzáadjuk/levonjuk őket
        if (criteria_quantities && typeof criteria_quantities === 'object') {
            // Lekérdezzük a szempontokat
            db.query('SELECT * FROM task_criteria WHERE task_id = ?', [scoreRecord.task_id], (cErr, criteriaList) => {
                if (!cErr && criteriaList) {
                    criteriaList.forEach(crit => {
                        const qty = parseFloat(criteria_quantities[crit.id]) || 0;
                        awarded_points += (qty * crit.points_per_unit);
                    });
                }
                updateScoreRecord();
            });
        } else {
            updateScoreRecord();
        }

        function updateScoreRecord() {
            db.query('UPDATE scores SET recorded_time = ?, awarded_points = ?, notes = ? WHERE id = ?', [totalSeconds, awarded_points, notes || '', scoreId], (upErr) => {
                if (upErr) return res.status(500).json({ success: false, message: 'Hiba a mentéskor.' });
                finalizeScore(io);
                res.json({ success: true, message: 'Eredmény frissítve!' });
            });
        }
    });
});

app.delete('/api/judge/scores/:id', (req, res) => {
    if (!req.session.user || (req.session.user.role !== 'judge' && req.session.user.role !== 'admin')) return res.status(403).json({ error: 'Jogosulatlan' });
    db.query('DELETE FROM scores WHERE id = ?', [req.params.id], (err) => {
        if (!err) finalizeScore(io);
        res.json({ success: !err });
    });
});

// --- RESULTS ---
function getFullResults(callback) {
    const individualSql = `
        SELECT c.id, c.name, c.school, c.gender, t.name as team_name, c.team_id,
               COALESCE(SUM(s.awarded_points), 0) as total_points, 
               MIN(s.recorded_time) as best_time 
        FROM competitors c 
        LEFT JOIN teams t ON c.team_id = t.id 
        LEFT JOIN scores s ON c.id = s.competitor_id 
        WHERE c.status = 'approved'
        GROUP BY c.id 
        ORDER BY total_points DESC, best_time ASC
    `;

    const teamSql = `
        SELECT t.id, t.team_number, t.name,
               (COALESCE((SELECT SUM(s.awarded_points) FROM competitors c2 JOIN scores s ON c2.id = s.competitor_id WHERE c2.team_id = t.id AND c2.status = 'approved'), 0) +
                COALESCE((SELECT SUM(s2.awarded_points) FROM scores s2 WHERE s2.team_id = t.id), 0)) as total_points,
               COUNT(DISTINCT c.id) as member_count
        FROM teams t
        LEFT JOIN competitors c ON t.id = c.team_id AND c.status = 'approved'
        GROUP BY t.id
        ORDER BY total_points DESC
        LIMIT 5
    `;

    db.query(individualSql, (err, individuals) => {
        if (err) return callback(err);
        db.query(teamSql, (tErr, topTeams) => {
            if (tErr) return callback(tErr);
            const topMale = individuals.filter(c => c.gender === 'male').slice(0, 3);
            const topFemale = individuals.filter(c => c.gender === 'female').slice(0, 3);
            callback(null, {
                scoreboard: individuals,
                topTeams: topTeams,
                topMale: topMale,
                topFemale: topFemale
            });
        });
    });
}

app.get('/api/results', (req, res) => {
    getFullResults((err, data) => {
        if (err) return res.status(500).json({ error: 'Adatbázis hiba' });
        res.json(data);
    });
});

app.get('/api/team-details/:teamId', (req, res) => {
    const teamId = req.params.teamId;
    db.query('SELECT * FROM teams WHERE id = ?', [teamId], (err, teamRes) => {
        if (err || teamRes.length === 0) return res.status(404).json({ error: 'Csapat nem található' });
        const team = teamRes[0];

        db.query("SELECT * FROM competitors WHERE team_id = ? AND status = 'approved'", [teamId], (cErr, members) => {
            db.query(`SELECT s.*, t.title as task_name, t.type as task_type, c.name as competitor_name 
                      FROM scores s 
                      JOIN tasks t ON s.task_id = t.id 
                      LEFT JOIN competitors c ON s.competitor_id = c.id 
                      WHERE s.team_id = ? OR s.competitor_id IN (SELECT id FROM competitors WHERE team_id = ?)`, [teamId, teamId], (sErr, scores) => {
                res.json({
                    team: team,
                    members: members,
                    scores: scores
                });
            });
        });
    });
});

// Pontszám rögzítés szempontokkal, megjegyzéssel
io.on('connection', (socket) => {
    socket.on('submit_score', (data) => {
        const user = socket.request.session?.user;
        if (!user || (user.role !== 'judge' && user.role !== 'admin')) {
            socket.emit('score_error', { message: 'Nincs jogosultságod pontszámot rögzíteni!' });
            return;
        }

        const { task_id, time_string, competitor_id, team_id, manual_points, notes, criteria_quantities } = data;

        let totalSeconds = 0;
        if (time_string && time_string.includes(':')) {
            const parts = time_string.split(':');
            totalSeconds = (parseInt(parts[0]) || 0) * 60 + (parseFloat(parts[1]) || 0);
        } else {
            totalSeconds = parseFloat(time_string) || 0;
        }

        db.query('SELECT * FROM tasks WHERE id = ?', [task_id], (err, taskRes) => {
            if (err || taskRes.length === 0) {
                socket.emit('score_error', { message: 'Érvénytelen feladat!' });
                return;
            }
            const task = taskRes[0];

            let awarded_points = manual_points !== undefined && manual_points !== '' 
                ? parseFloat(manual_points) 
                : Math.max(0, task.base_points - (totalSeconds * task.deduction_per_sec));

            // Szempontok feldolgozása
            if (criteria_quantities && typeof criteria_quantities === 'object') {
                db.query('SELECT * FROM task_criteria WHERE task_id = ?', [task_id], (cErr, criteriaList) => {
                    if (!cErr && criteriaList) {
                        criteriaList.forEach(crit => {
                            const qty = parseFloat(criteria_quantities[crit.id]) || 0;
                            awarded_points += (qty * crit.points_per_unit);
                        });
                    }
                    saveScoreToDb();
                });
            } else {
                saveScoreToDb();
            }

            function saveScoreToDb() {
                if (task.type === 'team') {
                    db.query(`INSERT INTO scores (task_id, judge_id, recorded_time, awarded_points, team_id, notes) VALUES (?, ?, ?, ?, ?, ?)`,
                        [task_id, user.id, totalSeconds, awarded_points, team_id, notes || ''], (sErr) => {
                            if (sErr) {
                                socket.emit('score_error', { message: 'Adatbázis hiba.' });
                                return;
                            }
                            finalizeScore(io);
                            socket.emit('score_saved', { message: 'Csapat pontszám sikeresen rögzítve!' });
                        });
                } else {
                    db.query(`INSERT INTO scores (task_id, judge_id, recorded_time, awarded_points, competitor_id, notes) VALUES (?, ?, ?, ?, ?, ?)`,
                        [task_id, user.id, totalSeconds, awarded_points, competitor_id, notes || ''], (sErr) => {
                            if (sErr) {
                                socket.emit('score_error', { message: 'Adatbázis hiba.' });
                                return;
                            }
                            finalizeScore(io);
                            socket.emit('score_saved', { message: 'Egyéni pontszám sikeresen rögzítve!' });
                        });
                }
            }
        });
    });
});

function finalizeScore(ioInstance) {
    getFullResults((err, resultsData) => {
        if (!err) {
            ioInstance.emit('update_scoreboard', resultsData.scoreboard);
            ioInstance.emit('update_results', resultsData);
        }
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`A szerver fut a http://localhost:${PORT} címen`);
});
