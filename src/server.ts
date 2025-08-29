import dotenv from "dotenv";
import express from "express";
import { Pool } from "pg";
import { z } from "zod";
import { parsePhoneNumberFromString } from "libphonenumber-js";
import cors from "cors";
import { sendReservationEmail } from "./mailer";
// import path from "path"; // (δεν χρησιμοποιείται)

dotenv.config();

const ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "https://reservations.lappasproductions.gr",
  "https://lappas-tickets.netlify.app",
];

const app = express();
app.use(express.json());

// CORS (πριν από τα routes)
app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true); // επιτρέπουμε curl/uptime
      return cb(null, ALLOWED_ORIGINS.includes(origin));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: false,
  })
);

// Schemas
const UserSchema = z.object({
  name: z.string().trim().min(1).max(80),
  surname: z.string().trim().min(1).max(80),
  email: z.string().trim().email("Invalid email"), // κάν' το required αφού το χρειάζεσαι για email
  phone: z.string().trim(),
});

const baseDb = process.env.DB_URL
  ? { connectionString: process.env.DB_URL }
  : {
      user: process.env.DB_USER,
      host: process.env.DB_HOST,
      database: process.env.DB_NAME,
      password: process.env.DB_PASSWORD,
      port: Number(process.env.DB_PORT || 5432),
    };

const pool = new Pool({ ...baseDb, ssl: { rejectUnauthorized: false } });

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
      [JSON.stringify(payload)] // ✅ stringify
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
});

// Cancel pending
app.get("/d/:id", async (req, res) => {
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
});

// Upcoming list
app.get("/getUpcomingProductions", async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT public.get_upcoming_productions() as result`
  );
  const result = rows[0]?.result ?? { ok: false, status: "SERVER_ERROR" };
  return res.status(200).json(result);
});

app.post("/getProductionAvailability/:id", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT public.get_production_availability($1::bigint) as result`,
    [req.params.id]
  );
  const result = rows[0]?.result ?? { ok: false, status: "SERVER_ERROR" };
  return res.status(200).json(result);
});

app.get("/health", (_req, res) => res.status(200).send("ok"));

// ✅ Render: χρησιμοποίησε process.env.PORT
const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log(`Server running on :${PORT}`);
});
