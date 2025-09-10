// src/server.ts
import dotenv from "dotenv";
import express from "express";
import { Pool } from "pg";
import { z } from "zod";
import { parsePhoneNumberFromString } from "libphonenumber-js";
import cors from "cors";
import fs from "fs";
import { sendReservationEmail } from "./mailer";
import { verifyRecaptchaV3 } from "./recaptcha";
import bcrypt from "bcryptjs";

dotenv.config();

const ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "https://reservations.lappasproductions.gr",
  "https://lappas-tickets.netlify.app",
];

const salt = "$2a$10$CwTycUXWue0Thq9StjUM0u";

// προσάρμοσε ανάλογα το path του cert αν χρειαστεί
const ca = fs.existsSync("./certs/prod-ca-2021.crt")
  ? fs.readFileSync("./certs/prod-ca-2021.crt").toString()
  : undefined;

const app = express();
app.set("trust proxy", true); // για σωστό req.ip πίσω από proxy (Render/Netlify)
app.use(express.json());

// CORS
app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true); // επιτρέπουμε curl/uptime κ.λπ.
      return cb(null, ALLOWED_ORIGINS.includes(origin));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: false,
  })
);

// ===== Schemas =====
const UserSchema = z.object({
  name: z.string().trim().min(1).max(80),
  surname: z.string().trim().min(1).max(80),
  email: z.string().trim().email("Invalid email"),
  phone: z.string().trim(),
});

// ===== DB =====
const baseDb = process.env.DB_URL
  ? { connectionString: process.env.DB_URL }
  : {
      user: process.env.DB_USER,
      host: process.env.DB_HOST,
      database: process.env.DB_NAME,
      password: process.env.DB_PASSWORD,
      port: Number(process.env.DB_PORT || 5432),
    };

// Αν υπάρχει CA, ενεργοποιούμε SSL με proper verification.
// Αν όχι (π.χ. τοπικά), αφήνουμε το SSL undefined ώστε να μην σκάει.
const pool = new Pool({
  ...baseDb,
  ssl: ca
    ? {
        ca,
        rejectUnauthorized: true,
        servername: "aws-1-eu-central-2.pooler.supabase.com",
      }
    : undefined,
});

// ===== Routes =====

// Create reservation
app.post("/createReservation", async (req, res) => {
  try {
    const parsed = UserSchema.safeParse({
      name: req.body.name,
      surname: req.body.surname,
      email: req.body.email,
      phone: req.body.phone,
    });
    if (!parsed.success) {
      return res.status(400).json({
        ok: false,
        status: "VALIDATION_ERROR",
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const phoneParsed = parsePhoneNumberFromString(parsed.data.phone, "GR");
    if (!phoneParsed || !phoneParsed.isValid()) {
      return res.status(400).json({
        ok: false,
        status: "INVALID_PHONE",
        info: "Μη έγκυρο τηλέφωνο",
      });
    }

    // reCAPTCHA v3 verify (optional αλλά συνιστάται)
    const recaptchaToken: string | undefined =
      (req.body?.recaptcha as string | undefined) ?? undefined;
    const recaptchaActionFromBody: string | undefined =
      (req.body?.recaptcha_action as string | undefined) ?? undefined;

    if (recaptchaToken) {
      const expectedAction =
        process.env.RECAPTCHA_EXPECTED_ACTION || recaptchaActionFromBody;
      const verify = await verifyRecaptchaV3(recaptchaToken, {
        ...(req.ip ? { remoteip: req.ip } : {}),
        ...(expectedAction ? { expectedAction } : {}),
      });

      if (!verify.ok) {
        return res.status(200).json({
          ok: false,
          code: "RECAPTCHA_FAILED",
          info: "Η επαλήθευση ασφαλείας δεν ολοκληρώθηκε.",
          meta: verify,
        });
      }
    }

    const payload = {
      user: {
        name: parsed.data.name,
        surname: parsed.data.surname,
        phone: phoneParsed.number, // E.164
        email: parsed.data.email,
      },
      performance: {
        date: String(req.body.date), // "DD/MM/YY"
        time: String(req.body.time), // "HH:mm"
        production_id: String(req.body.production),
        theater_id: String(req.body.theater),
        num_seats: String(req.body.num_seats),
      },
      known_from: req.body.known_from || null,
      referer: req.body.referer || null,
      reserved_by: req.body.reserved_by || null,
    };

    const { rows } = await pool.query(
      `select public.create_reservation_from_json($1::jsonb) as result`,
      [JSON.stringify(payload)]
    );
    const result = rows[0]?.result ?? { ok: false, status: "SERVER_ERROR" };

    const code = result.code;
    if (code === "CREATED_ACTIVE" || code === "CREATED_PENDING") {
      await sendReservationEmail(result);
      return res.status(200).json(result);
    }
    if (code === "DUPLICATE_SAME_DATETIME") return res.status(409).json(result);
    if (
      code === "PERFORMANCE_THEATER_NOT_FOUND" ||
      code === "PERFORMANCE_DATETIME_NOT_FOUND"
    )
      return res.status(404).json(result);
    if (
      code === "MISSING_FIELDS" ||
      code === "INVALID_NUM_SEATS" ||
      code === "INVALID_DATE_TIME_FORMAT" ||
      code === "INVALID_PHONE"
    )
      return res.status(400).json(result);

    return res.status(400).json(result);
  } catch (err) {
    return res.status(500).json({
      ok: false,
      status: "SERVER_ERROR",
      info: "Αποτυχία δημιουργίας κράτησης",
    });
  }
});

// Confirm pending
app.get("/c/:id", async (req, res) => {
  try {
    const reservation_id = req.params.id;
    const { rows } = await pool.query(
      `select public.confirm_reservation($1::text, $2::boolean) as result`,
      [reservation_id, false]
    );
    const result = rows[0]?.result ?? { ok: false, status: "SERVER_ERROR" };
    if (result.code === "CREATED_ACTIVE") {
      await sendReservationEmail(result);
      return res.status(200).json(result);
    }
    return res.status(200).json(result);
  } catch {
    return res.status(500).json({
      ok: false,
      status: "SERVER_ERROR",
      info: "Αποτυχία επιβεβαίωσης κράτησης",
    });
  }
});

// Cancel pending
app.get("/d/:id", async (req, res) => {
  try {
    const reservation_id = req.params.id;
    const { rows } = await pool.query(
      `select public.cancel_reservation($1::text, $2::boolean) as result`,
      [reservation_id, false]
    );
    const result = rows[0]?.result ?? { ok: false, status: "SERVER_ERROR" };

    if (result.code === "CREATED_CANCELED") {
      await sendReservationEmail(result);
      return res.status(200).json(result);
    }
    if (result.code === "NO_RESERVATION") {
      return res.status(404).json(result);
    }
    if (result.code === "NO_PERMISSION") {
      return res.status(403).json(result);
    }
    return res.status(400).json(result);
  } catch {
    return res.status(500).json({
      ok: false,
      status: "SERVER_ERROR",
      info: "Αποτυχία ακύρωσης κράτησης",
    });
  }
});

// Upcoming list
app.get("/getUpcomingProductions", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT public.get_upcoming_productions() as result`
    );
    const result = rows[0]?.result ?? { ok: false, status: "SERVER_ERROR" };
    return res.status(200).json(result);
  } catch {
    return res.status(500).json({
      ok: false,
      status: "SERVER_ERROR",
      info: "Αποτυχία φόρτωσης λίστας",
    });
  }
});

// Availability για production
app.post("/getProductionAvailability/:id", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT public.get_production_availability($1::bigint) as result`,
      [req.params.id]
    );
    const result = rows[0]?.result ?? { ok: false, status: "SERVER_ERROR" };
    return res.status(200).json(result);
  } catch {
    return res.status(500).json({
      ok: false,
      status: "SERVER_ERROR",
      info: "Αποτυχία φόρτωσης διαθεσιμότητας",
    });
  }
});

// Μία κράτηση
app.post("/getReservation/:id", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT public.getReservation($1::uuid) as result`,
      [req.params.id]
    );
    const result = rows[0]?.result ?? { ok: false, status: "SERVER_ERROR" };
    return res.status(200).json(result);
  } catch {
    return res.status(500).json({
      ok: false,
      status: "SERVER_ERROR",
      info: "Αποτυχία φόρτωσης κράτησης",
    });
  }
});

app.post("/login", async (req, res) => {
  try {
    const phoneParsed = parsePhoneNumberFromString(req.body.username, "GR");
    if (!phoneParsed || !phoneParsed.isValid()) {
      return res.status(400).json({
        ok: false,
        status: "INVALID_PHONE",
        info: "Μη έγκυρη μορφή τηλεφώνου",
      });
    }

    const password = bcrypt.hashSync(req.body.password, salt);

    return res.send({ password, phoneParsed });

    const { rows } = await pool.query(
      `SELECT public.api_login_by_phone($1::TEXT, $2::TEXT)`,
      [phoneParsed, password]
    );

    const result = rows[0]?.result ?? { ok: false, statsu: "SERVER_ERROR" };
    return res.status(200).send(result);
  } catch {
    return res.status(500).json({
      ok: false,
      status: "SERVER_ERROR",
      info: "Αποτυχία φόρτωσης κράτησης",
    });
  }
});

// Uptime/health
app.get("/health", (_req, res) => res.status(200).send("ok"));

// κάθε 10 λεπτά (600.000 ms) θα στέλνει request
setInterval(() => {
  fetch("https://api.reservations.lappasproductions.gr/health", {
    method: "GET",
  })
    .then(() => {
      console.log("Ping OK:", new Date().toLocaleTimeString());
    })
    .catch((err) => {
      console.error("Ping failed:", err);
    });
}, 10 * 60 * 1000);

// ✅ Render: process.env.PORT
const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log(`Server running on :${PORT}`);
});
