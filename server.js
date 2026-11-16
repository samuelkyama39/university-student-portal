const path = require("path");
const express = require("express");
const { Pool } = require("pg");
const session = require("express-session");
const bcrypt = require("bcrypt");
const axios = require("axios");
require("dotenv").config();

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// DATABASE CONNECTION
const pool = new Pool(
    process.env.DATABASE_URL
        ? {
            connectionString: process.env.DATABASE_URL,
            ssl: process.env.NODE_ENV === "production"
                ? { rejectUnauthorized: false }
                : false
        }
        : {
            host: process.env.DB_HOST,
            port: process.env.DB_PORT,
            database: process.env.DB_NAME,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD
        }
);

// SESSION
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        maxAge: 1000 * 60 * 60
    }
}));

// SERVE WEBSITE FILES
app.use(express.static(path.join(__dirname, "public")));

// MPESA CONFIGURATION
const mpesaBaseUrl =
    process.env.DARAJA_ENVIRONMENT === "production"
        ? "https://api.safaricom.co.ke"
        : "https://sandbox.safaricom.co.ke";

// GENERATE MPESA ACCESS TOKEN
async function getMpesaAccessToken() {
    const credentials = Buffer.from(
        `${process.env.DARAJA_CONSUMER_KEY}:${process.env.DARAJA_CONSUMER_SECRET}`
    ).toString("base64");

    const response = await axios.get(
        `${mpesaBaseUrl}/oauth/v1/generate?grant_type=client_credentials`,
        {
            headers: {
                Authorization: `Basic ${credentials}`
            }
        }
    );

    return response.data.access_token;
}

// GENERATE KENYA TIME TIMESTAMP: YYYYMMDDHHmmss
function getMpesaTimestamp() {
    const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Africa/Nairobi",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23"
    }).formatToParts(new Date());

    const values = {};

    for (const part of parts) {
        values[part.type] = part.value;
    }

    return (
        values.year +
        values.month +
        values.day +
        values.hour +
        values.minute +
        values.second
    );
}

// STUDENT REGISTRATION
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

        const passwordHash = await bcrypt.hash(password, 12);

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

// STUDENT LOGIN
app.post("/login", async (req, res) => {
    const { reg_number, password } = req.body;

    if (!reg_number || !password) {
        return res.status(400).send(
            "Enter your registration number and password."
        );
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
            return res.status(401).send(
                "Invalid registration number or password."
            );
        }

        const student = result.rows[0];

        const passwordMatch = await bcrypt.compare(
            password,
            student.password_hash
        );

        if (!passwordMatch) {
            return res.status(401).send(
                "Invalid registration number or password."
            );
        }

        req.session.studentId = student.student_id;
        req.session.studentName = student.full_name;

        res.redirect("/dashboard.html");

    } catch (error) {
        console.error(error);
        res.status(500).send("Login failed. Please try again.");
    }
});

// GET LOGGED-IN STUDENT DETAILS
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

// GET AVAILABLE UNITS
app.get("/api/available-units", async (req, res) => {
    if (!req.session.studentId) {
        return res.status(401).json({
            message: "Please log in first."
        });
    }

    try {
        const result = await pool.query(
            `SELECT unit_id, unit_code, unit_name, semester
             FROM units
             ORDER BY semester, unit_code`
        );

        res.json(result.rows);

    } catch (error) {
        console.error(error);
        res.status(500).json({
            message: "Could not load available units."
        });
    }
});

// GET REGISTERED UNITS
app.get("/api/units", async (req, res) => {
    if (!req.session.studentId) {
        return res.status(401).json({
            message: "Please log in first."
        });
    }

    try {
        const result = await pool.query(
            `SELECT units.unit_id,
                    units.unit_code,
                    units.unit_name,
                    units.semester,
                    student_units.registration_date
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

// REGISTER FOR A UNIT
app.post("/api/units/register", async (req, res) => {
    if (!req.session.studentId) {
        return res.status(401).json({
            message: "Please log in first."
        });
    }

    const unitId = Number(req.body.unit_id);

    if (!Number.isInteger(unitId) || unitId <= 0) {
        return res.status(400).json({
            message: "Invalid unit ID."
        });
    }

    try {
        const result = await pool.query(
            `INSERT INTO student_units (student_id, unit_id)
             VALUES ($1, $2)
             ON CONFLICT (student_id, unit_id) DO NOTHING
             RETURNING id`,
            [req.session.studentId, unitId]
        );

        if (result.rowCount === 0) {
            return res.status(409).json({
                message: "You have already registered for this unit."
            });
        }

        res.status(201).json({
            message: "Unit registered successfully!"
        });

    } catch (error) {
        console.error(error);

        if (error.code === "23503") {
            return res.status(404).json({
                message: "Unit not found."
            });
        }

        res.status(500).json({
            message: "Could not register for this unit."
        });
    }
});

// REMOVE REGISTERED UNIT
app.delete("/api/units/:unitId", async (req, res) => {
    if (!req.session.studentId) {
        return res.status(401).json({
            message: "Please log in first."
        });
    }

    const unitId = Number(req.params.unitId);

    if (!Number.isInteger(unitId) || unitId <= 0) {
        return res.status(400).json({
            message: "Invalid unit ID."
        });
    }

    try {
        const result = await pool.query(
            `DELETE FROM student_units
             WHERE student_id = $1 AND unit_id = $2
             RETURNING id`,
            [req.session.studentId, unitId]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({
                message: "Registered unit not found."
            });
        }

        res.json({
            message: "Unit registration removed successfully."
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({
            message: "Could not remove unit registration."
        });
    }
});

// GET STUDENT RESULTS
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

// GET STUDENT FEE STATEMENT
app.get("/api/fees", async (req, res) => {
    if (!req.session.studentId) {
        return res.status(401).json({
            message: "Please log in first."
        });
    }

    try {
        const result = await pool.query(
            `SELECT
                fi.invoice_id,
                fi.invoice_number,
                fi.description,
                fi.amount_due,
                fi.due_date,
                fi.status,
                COALESCE(
                    SUM(
                        CASE
                            WHEN fp.payment_status = 'Completed'
                            THEN fp.amount_paid
                            ELSE 0
                        END
                    ), 0
                ) AS amount_paid
             FROM fee_invoices fi
             LEFT JOIN fee_payments fp
                ON fi.invoice_id = fp.invoice_id
             WHERE fi.student_id = $1
             GROUP BY fi.invoice_id
             ORDER BY fi.created_at DESC`,
            [req.session.studentId]
        );

        const invoices = result.rows.map(invoice => ({
            ...invoice,
            balance:
                Number(invoice.amount_due) -
                Number(invoice.amount_paid)
        }));

        res.json(invoices);

    } catch (error) {
        console.error(error);
        res.status(500).json({
            message: "Could not load fee statement."
        });
    }
});

// INITIATE MPESA STK PUSH
app.post("/api/mpesa/stkpush", async (req, res) => {
    if (!req.session.studentId) {
        return res.status(401).json({
            message: "Please log in first."
        });
    }

    const invoiceId = Number(req.body.invoice_id);
    const amount = Number(req.body.amount);

    let phone = String(req.body.phone || "").replace(/\s+/g, "");

    if (!Number.isInteger(invoiceId) || invoiceId <= 0) {
        return res.status(400).json({
            message: "Invalid invoice."
        });
    }

    if (!Number.isInteger(amount) || amount <= 0) {
        return res.status(400).json({
            message: "Enter a valid payment amount."
        });
    }

    if (phone.startsWith("0")) {
        phone = "254" + phone.substring(1);
    } else if (phone.startsWith("+254")) {
        phone = phone.substring(1);
    }

    if (!/^254[71]\d{8}$/.test(phone)) {
        return res.status(400).json({
            message: "Enter a valid Kenyan Safaricom phone number."
        });
    }

    if (
        !process.env.DARAJA_CONSUMER_KEY ||
        !process.env.DARAJA_CONSUMER_SECRET ||
        !process.env.DARAJA_SHORTCODE ||
        !process.env.DARAJA_PASSKEY ||
        !process.env.DARAJA_CALLBACK_URL
    ) {
        return res.status(500).json({
            message: "M-Pesa configuration is incomplete."
        });
    }

    const client = await pool.connect();

    let paymentId;

    try {
        await client.query("BEGIN");

        const invoiceResult = await client.query(
            `SELECT invoice_id, amount_due
             FROM fee_invoices
             WHERE invoice_id = $1
             AND student_id = $2
             FOR UPDATE`,
            [invoiceId, req.session.studentId]
        );

        if (invoiceResult.rows.length === 0) {
            await client.query("ROLLBACK");

            return res.status(404).json({
                message: "Fee invoice not found."
            });
        }

        const invoice = invoiceResult.rows[0];

        const paidResult = await client.query(
            `SELECT COALESCE(SUM(amount_paid), 0) AS total_paid
             FROM fee_payments
             WHERE invoice_id = $1
             AND payment_status = 'Completed'`,
            [invoiceId]
        );

        const balance =
            Number(invoice.amount_due) -
            Number(paidResult.rows[0].total_paid);

        if (balance <= 0) {
            await client.query("ROLLBACK");

            return res.status(400).json({
                message: "This invoice has already been paid."
            });
        }

        if (amount > balance) {
            await client.query("ROLLBACK");

            return res.status(400).json({
                message: `Payment cannot exceed the outstanding balance of KSh ${balance}.`
            });
        }

        const pendingResult = await client.query(
            `SELECT payment_id
             FROM fee_payments
             WHERE invoice_id = $1
             AND payment_status = 'Pending'
             LIMIT 1`,
            [invoiceId]
        );

        if (pendingResult.rows.length > 0) {
            await client.query("ROLLBACK");

            return res.status(409).json({
                message: "A payment is already pending for this invoice. Please wait."
            });
        }

        const paymentResult = await client.query(
            `INSERT INTO fee_payments
             (invoice_id, amount_paid, payment_method, payment_status)
             VALUES ($1, $2, 'M-Pesa', 'Pending')
             RETURNING payment_id`,
            [invoiceId, amount]
        );

        paymentId = paymentResult.rows[0].payment_id;

        await client.query("COMMIT");

        const accessToken = await getMpesaAccessToken();

        const shortcode = process.env.DARAJA_SHORTCODE;
        const timestamp = getMpesaTimestamp();

        const password = Buffer.from(
            shortcode + process.env.DARAJA_PASSKEY + timestamp
        ).toString("base64");

        const stkResponse = await axios.post(
            `${mpesaBaseUrl}/mpesa/stkpush/v1/processrequest`,
            {
                BusinessShortCode: shortcode,
                Password: password,
                Timestamp: timestamp,
                TransactionType: "CustomerPayBillOnline",
                Amount: amount,
                PartyA: phone,
                PartyB: shortcode,
                PhoneNumber: phone,
                CallBackURL: process.env.DARAJA_CALLBACK_URL,
                AccountReference: `INV-${invoiceId}`,
                TransactionDesc: "Student fee payment"
            },
            {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    "Content-Type": "application/json"
                },
                timeout: 30000
            }
        );

        const mpesaData = stkResponse.data;

        if (
            !mpesaData.CheckoutRequestID ||
            !mpesaData.MerchantRequestID
        ) {
            throw new Error(
                mpesaData.errorMessage || "M-Pesa did not return a checkout ID."
            );
        }

        await pool.query(
            `UPDATE fee_payments
             SET checkout_request_id = $1,
                 merchant_request_id = $2
             WHERE payment_id = $3`,
            [
                mpesaData.CheckoutRequestID,
                mpesaData.MerchantRequestID,
                paymentId
            ]
        );

        res.json({
            success: true,
            message: "M-Pesa prompt sent. Check your phone and enter your M-Pesa PIN.",
            payment_id: paymentId
        });

    } catch (error) {
        console.error(
            "M-Pesa STK Push error:",
            error.response?.data || error.message
        );

        if (paymentId) {
            // Keep the payment pending if Safaricom's response is uncertain.
            // Do not mark it failed just because the connection timed out.
            if (error.response?.data) {
                await pool.query(
                    `UPDATE fee_payments
                     SET payment_status = 'Failed'
                     WHERE payment_id = $1
                     AND checkout_request_id IS NULL`,
                    [paymentId]
                ).catch(console.error);
            }
        }

        res.status(500).json({
            message: error.response?.data?.errorMessage ||
                "Could not initiate M-Pesa payment. Please check your payment status before trying again."
        });

    } finally {
        client.release();
    }
});

// MPESA CALLBACK
// Safaricom sends the final payment result to this route.
app.post("/api/mpesa/callback", async (req, res) => {
    const callback = req.body?.Body?.stkCallback;

    // Acknowledge the callback request.
    res.status(200).json({
        ResultCode: 0,
        ResultDesc: "Accepted"
    });

    if (!callback || !callback.CheckoutRequestID) {
        console.error("Invalid M-Pesa callback received.");
        return;
    }

    const checkoutRequestId = callback.CheckoutRequestID;
    const resultCode = String(callback.ResultCode);

    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        const paymentResult = await client.query(
            `SELECT payment_id, invoice_id, amount_paid
             FROM fee_payments
             WHERE checkout_request_id = $1
             FOR UPDATE`,
            [checkoutRequestId]
        );

        if (paymentResult.rows.length === 0) {
            await client.query("ROLLBACK");

            console.error(
                "No payment found for checkout:",
                checkoutRequestId
            );

            return;
        }

        const payment = paymentResult.rows[0];

        // Ignore duplicate callbacks.
        const currentPayment = await client.query(
            `SELECT payment_status
             FROM fee_payments
             WHERE payment_id = $1`,
            [payment.payment_id]
        );

        if (currentPayment.rows[0].payment_status !== "Pending") {
            await client.query("ROLLBACK");
            return;
        }

        if (resultCode === "0") {
            const items =
                callback.CallbackMetadata?.Item || [];

            const getItem = (name) => {
                const item = items.find(entry => entry.Name === name);
                return item ? item.Value : null;
            };

            const receiptNumber = getItem("MpesaReceiptNumber");
            const callbackAmount = Number(getItem("Amount"));

            // Only complete the payment when the receipt and amount match.
            if (
                !receiptNumber ||
                callbackAmount !== Number(payment.amount_paid)
            ) {
                await client.query(
                    `UPDATE fee_payments
                     SET payment_status = 'Failed',
                         result_code = $1,
                         result_description = $2
                     WHERE payment_id = $3
                     AND payment_status = 'Pending'`,
                    [
                        resultCode,
                        "Payment details did not match the pending payment.",
                        payment.payment_id
                    ]
                );

                await client.query("COMMIT");
                return;
            }

            await client.query(
                `UPDATE fee_payments
                 SET payment_status = 'Completed',
                     mpesa_receipt_number = $1,
                     result_code = $2,
                     result_description = $3
                 WHERE payment_id = $4
                 AND payment_status = 'Pending'`,
                [
                    receiptNumber,
                    resultCode,
                    callback.ResultDesc || "Payment successful",
                    payment.payment_id
                ]
            );

            // Recalculate the invoice balance.
            const totals = await client.query(
                `SELECT
                    fi.amount_due,
                    COALESCE(
                        SUM(
                            CASE
                                WHEN fp.payment_status = 'Completed'
                                THEN fp.amount_paid
                                ELSE 0
                            END
                        ), 0
                    ) AS total_paid
                 FROM fee_invoices fi
                 LEFT JOIN fee_payments fp
                    ON fi.invoice_id = fp.invoice_id
                 WHERE fi.invoice_id = $1
                 GROUP BY fi.invoice_id`,
                [payment.invoice_id]
            );

            const amountDue = Number(totals.rows[0].amount_due);
            const totalPaid = Number(totals.rows[0].total_paid);

            let invoiceStatus = "Unpaid";

            if (totalPaid >= amountDue) {
                invoiceStatus = "Paid";
            } else if (totalPaid > 0) {
                invoiceStatus = "Partially Paid";
            }

            await client.query(
                `UPDATE fee_invoices
                 SET status = $1
                 WHERE invoice_id = $2`,
                [invoiceStatus, payment.invoice_id]
            );

            console.log(
                "M-Pesa payment completed. Receipt:",
                receiptNumber
            );

        } else {
            await client.query(
                `UPDATE fee_payments
                 SET payment_status = 'Failed',
                     result_code = $1,
                     result_description = $2
                 WHERE payment_id = $3
                 AND payment_status = 'Pending'`,
                [
                    resultCode,
                    callback.ResultDesc || "M-Pesa payment failed.",
                    payment.payment_id
                ]
            );

            console.log(
                "M-Pesa payment failed:",
                callback.ResultDesc
            );
        }

        await client.query("COMMIT");

    } catch (error) {
        await client.query("ROLLBACK").catch(console.error);
        console.error("M-Pesa callback processing error:", error);

    } finally {
        client.release();
    }
});

// TEST DATABASE CONNECTION
app.get("/test-db", async (req, res) => {
    try {
        const result = await pool.query("SELECT NOW()");

        res.send(
            "PostgreSQL connected successfully! " + result.rows[0].now
        );

    } catch (error) {
        console.error(error);
        res.status(500).send("Database connection failed.");
    }
});

// LOGOUT
app.get("/logout", (req, res) => {
    req.session.destroy(() => {
        res.redirect("/index.html");
    });
});

// START SERVER
app.listen(process.env.PORT || 3000, () => {
    console.log("Server running on http://localhost:3000");
});
