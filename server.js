const express = require("express");
const { Pool } = require("pg");
require("dotenv").config();

const app = express();

const pool = new Pool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
const session = require("express-session");

app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        maxAge: 1000 * 60 * 60
    }
}));
app.use(express.static(__dirname));
// Student registration
app.post("/register", async (req, res) => {
    const {
        full_name,
        reg_number,
        email,
        phone,
        course,
        year_of_study,
        password
    } = req.body;

    // Check that required fields are provided
    if (!full_name || !reg_number || !email ||
        !course || !year_of_study || !password) {
        return res.status(400).send("Please fill in all required fields.");
    }

    const year = Number(year_of_study);

    if (!Number.isInteger(year) || year < 1 || year > 7) {
        return res.status(400).send("Invalid year of study.");
    }

    if (password.length < 8) {
        return res.status(400).send("Password must have at least 8 characters.");
    }

    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        // Securely hash the student's password
        const bcrypt = require("bcrypt");
        const passwordHash = await bcrypt.hash(password, 12);

        // Save student details
        const student = await client.query(
            `INSERT INTO students
            (full_name, reg_number, email, phone, course, year_of_study)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING student_id`,
            [
                full_name.trim(),
                reg_number.trim(),
                email.trim().toLowerCase(),
                phone || null,
                course.trim(),
                year
            ]
        );

        // Create the student's login account
        await client.query(
            `INSERT INTO users (student_id, password_hash)
             VALUES ($1, $2)`,
            [student.rows[0].student_id, passwordHash]
        );

        await client.query("COMMIT");

        res.send(`
            <h2>Registration successful!</h2>
            <p>Your student account has been created.</p>
            <a href="/index.html">Go to Login</a>
        `);

    } catch (error) {
        await client.query("ROLLBACK");
        console.error(error);

        if (error.code === "23505") {
            return res.status(409).send(
                "This registration number or email is already registered."
            );
        }

        res.status(500).send("Registration failed. Please try again.");

    } finally {
        client.release();
    }
});
// Student login
app.post("/login", async (req, res) => {
    const { reg_number, password } = req.body;

    if (!reg_number || !password) {
        return res.status(400).send("Enter your registration number and password.");
    }

    try {
        const result = await pool.query(
            `SELECT students.student_id,
                    students.full_name,
                    students.reg_number,
                    users.password_hash
             FROM students
             JOIN users ON students.student_id = users.student_id
             WHERE students.reg_number = $1`,
            [reg_number.trim()]
        );

        if (result.rows.length === 0) {
            return res.status(401).send("Invalid registration number or password.");
        }

        const student = result.rows[0];
        const bcrypt = require("bcrypt");

        const passwordMatch = await bcrypt.compare(
            password,
            student.password_hash
        );

        if (!passwordMatch) {
            return res.status(401).send("Invalid registration number or password.");
        }

        req.session.studentId = student.student_id;
        req.session.studentName = student.full_name;

        res.redirect("/dashboard.html");

    } catch (error) {
        console.error(error);
        res.status(500).send("Login failed. Please try again.");
    }
});
// Get logged-in student's details
app.get("/api/me", async (req, res) => {
    if (!req.session.studentId) {
        return res.status(401).json({
            message: "Please log in first."
        });
    }

    try {
        const result = await pool.query(
            `SELECT full_name, reg_number, email,
                    phone, course, year_of_study
             FROM students
             WHERE student_id = $1`,
            [req.session.studentId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                message: "Student not found."
            });
        }

        res.json(result.rows[0]);

    } catch (error) {
        console.error(error);
        res.status(500).json({
            message: "Could not load student details."
        });
    }
});

app.get("/api/units", async (req, res) => {
    if (!req.session.studentId) {
        return res.status(401).json({
            message: "Please log in first."
        });
    }

    try {
        const result = await pool.query(
            `SELECT units.unit_code,
                    units.unit_name,
                    units.semester
             FROM student_units
             JOIN units ON student_units.unit_id = units.unit_id
             WHERE student_units.student_id = $1
             ORDER BY units.unit_code`,
            [req.session.studentId]
        );

        res.json(result.rows);

    } catch (error) {
        console.error(error);
        res.status(500).json({
            message: "Could not load units."
        });
    }
});

app.get("/api/results", async (req, res) => {
    if (!req.session.studentId) {
        return res.status(401).json({
            message: "Please log in first."
        });
    }

    try {
        const result = await pool.query(
            `SELECT units.unit_code,
                    units.unit_name,
                    results.marks,
                    results.grade
             FROM results
             JOIN units ON results.unit_id = units.unit_id
             WHERE results.student_id = $1
             ORDER BY units.unit_code`,
            [req.session.studentId]
        );

        res.json(result.rows);

    } catch (error) {
        console.error(error);
        res.status(500).json({
            message: "Could not load results."
        });
    }
});

app.get("/test-db", async (req, res) => {
    try {
        const result = await pool.query("SELECT NOW()");
        res.send("PostgreSQL connected successfully! " + result.rows[0].now);
    } catch (error) {
        console.error(error);
        res.status(500).send("Database connection failed.");
    }
});
app.get("/logout", (req, res) => {
    req.session.destroy(() => {
        res.redirect("/index.html");
    });
});
app.listen(process.env.PORT || 3000, () => {
    console.log("Server running on http://localhost:3000");
});