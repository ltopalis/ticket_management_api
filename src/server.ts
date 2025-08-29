import dotenv from "dotenv";
import express from "express";
import path from "path";
import { Pool } from "pg";
import { z } from "zod";
import { parsePhoneNumberFromString } from "libphonenumber-js";
import { sendReservationEmail } from "./mailer";

dotenv.config();

const app = express();
app.use(express.json());

const UserSchema = z.object({
  name: z.string().trim().min(1).max(80),
  surname: z.string().trim().min(1).max(80),
  email: z
    .string()
    .trim()
    .email("Invalid email")
    .optional()
    .or(z.literal(""))
    .transform((v) => v || null),
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

app.post("/createReservation", async (req, res) => {
  try {
    // 1) Validate user fields
    const userCheck = UserSchema.safeParse({
      name: req.body.name,
      surname: req.body.surname,
      email: req.body.email,
      phone: req.body.phone,
    });
    if (!userCheck.success) {
      return res.status(400).json({
        ok: false,
        status: "VALIDATION_ERROR",
        errors: userCheck.error.flatten().fieldErrors,
      });
    }
    if (!userCheck.data.email)
      return res
        .status(400)
        .json({ ok: false, status: "INVALID_EMAIL", info: "Μη έγκυρο email" });

    // 2) Normalize phone → E.164 (+30…)
    const phoneParsed = parsePhoneNumberFromString(userCheck.data.phone, "GR");
    if (!phoneParsed || !phoneParsed.isValid()) {
      return res.status(400).json({
        ok: false,
        status: "INVALID_PHONE",
        info: "Μη έγκυρο τηλέφωνο",
      });
    }

    const payload = {
      user: {
        name: userCheck.data.name,
        surname: userCheck.data.surname,
        phone: phoneParsed.number, // "+3069…"
        email: userCheck.data.email,
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

    // 4) Κλήση DB function — επιστρέφει JSON (ok/code/status/reservation_id/info)
    const { rows } = await pool.query(
      `select public.create_reservation_from_json($1::jsonb) as result`,
      [payload]
    );
    const result = rows[0]?.result ?? { ok: false, status: "SERVER_ERROR" };

    // 5) Προαιρετικό mapping σε HTTP status (για καθαρά responses)
    const code = result.code;
    if (code === "CREATED_ACTIVE" || code === "CREATED_PENDING") {
      sendReservationEmail(result);
      return res.status(200).json(result);
    }
    if (code === "DUPLICATE_SAME_DATETIME") {
      return res.status(409).json(result);
    }
    if (
      code === "PERFORMANCE_THEATER_NOT_FOUND" ||
      code === "PERFORMANCE_DATETIME_NOT_FOUND"
    ) {
      return res.status(404).json(result);
    }
    if (
      code === "MISSING_FIELDS" ||
      code === "INVALID_NUM_SEATS" ||
      code === "INVALID_DATE_TIME_FORMAT" ||
      code === "INVALID_PHONE"
    ) {
      return res.status(400).json(result);
    }
    // default
    return res.status(400).json(result);
  } catch (err) {
    //console.error(err);
    return res.status(500).json({
      ok: false,
      status: "SERVER_ERROR",
      info: "Αποτυχία δημιουργίας κράτησης",
      error: err,
    });
  }
});

// confirm a pending reservation
app.get("/c/:id", async (req, res) => {
  const reservation_id = req.params.id;

  const { rows } = await pool.query(
    `select public.confirm_reservation($1::text, $2::boolean) as result`,
    [reservation_id, false]
  );
  const result = rows[0]?.result ?? { ok: false, status: "SERVER_ERROR" };

  const code = result.code;
  if (code === "CREATED_ACTIVE") {
    sendReservationEmail(result);
    return res.status(200).json(result);
  }

  res.send(result);
});

// cancel a pending reservation
app.get("/d/:id", async (req, res) => {
  const reservation_id = req.params.id;

  const { rows } = await pool.query(
    `select public.cancel_reservation($1::text, $2::boolean) as result`,
    [reservation_id, false]
  );
  const result = rows[0]?.result ?? { ok: false, status: "SERVER_ERROR" };

  const code = result.code;
  if (code === "CREATED_CANCELED") {
    sendReservationEmail(result);
    return res.send(result);
  } else if (code === "NO_RESERVATION") {
  } else if (code === "NO_PERMISSION") {
  }
});

app.get("/getUpcomingProductions", async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT public.get_upcoming_productions() as result`
  );
  const result = rows[0]?.result ?? { ok: false, status: "SERVER_ERROR" };

  res.send(result);
});

app.get("/health", (_req, res) => res.status(200).send("ok"));

const PORT = Number(process.env.SERVER_PORT || 3000);
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
