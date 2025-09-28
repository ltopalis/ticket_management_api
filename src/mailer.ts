// mailer.ts
import nodemailer from "nodemailer";
import dotenv from "dotenv";
import QRCode from "qrcode";
import path from "path";
import fs from "fs";
import Handlebars from "handlebars";

dotenv.config();

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST!, // π.χ. "smtp.zoho.eu"
  port: Number(process.env.SMTP_PORT || 587), // 465 => secure true
  secure: process.env.SMTP_SECURE === "true",
  auth: {
    user: process.env.SMTP_USER!, // info@lappasproductions.gr
    pass: process.env.SMTP_PASS!, // app password
  },
});

type ReservationEmailType = "CREATED_ACTIVE" | "CREATED_ANAMONI";

function renderTemplate(file: string, vars: Record<string, any>) {
  //const tplPath = path.join(__dirname, "email_templates", file);
  const tpl = fs.readFileSync(file, "utf8");
  return Handlebars.compile(tpl)(vars); // -> string
}

async function makeQrPng(data: string): Promise<Buffer> {
  return QRCode.toBuffer(data, { type: "png", width: 300, margin: 1 });
}

function resolveTemplatePath(file: string) {
  const candidates = [
    path.join(process.cwd(), "email_templates", file),
    path.join(process.cwd(), "src", "email_templates", file),
    path.join(__dirname, "email_templates", file),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error(
    `Template not found. Searched: \n${candidates
      .map((p) => " - " + p)
      .join("\n")}`
  );
}

export async function sendReservationEmail(payload: unknown) {
  type Resv = {
    code: string;
    date: string;
    time: string;
    seats: number;
    id: string;
  };

  type Person = {
    name: string;
    email: string;
    phone: string;
    surname: string;
  };

  type Performance = {
    city: string;
    name: string;
    address: string;
    theater: string;
  };

  type Result = {
    ok: boolean;
    code: "CREATED_ACTIVE" | "CREATED_PENDING" | "CREATED_CANCELED";
    info: string;
    person: Person;
    performance: Performance;
    reservation: Resv;
    ["existing reservation"]?: Resv;
  };

  type Envelope = { result: Result };

  const BASE_URL = process.env.BASE_URL;

  const data = { result: payload };

  const { result } = (data as Envelope) || {};
  if (!result) throw new Error("Missing payload");

  const { code: statusCode, person, performance, reservation } = result;

  const existing = result["existing reservation"];

  const public_code = reservation.code;
  const id = reservation.id;
  const name = person.name;
  const surname = person.surname;
  const production_name = performance.name;
  const theater_name = performance.theater;
  const city = performance.city;
  const address = performance.address;
  const date = reservation.date;
  const time = reservation.time;
  const num_seats = String(reservation.seats);

  const manage_url = `${BASE_URL}/r/${id}`;

  const qrBuffer = await makeQrPng(id);

  const commonVars = {
    public_code,
    name,
    address,
    surname,
    production_name,
    theater_name,
    city,
    date,
    time,
    num_seats,
    manage_url,
  };

  let templateNameHtml: string;
  let templateNameTxt: string;
  let htmlVars: Record<string, any> = { ...commonVars };
  let textVars: Record<string, any> = { ...commonVars };

  console.log("FINE");

  if (statusCode === "CREATED_ACTIVE") {
    templateNameHtml = resolveTemplatePath("created_active.html");
    templateNameTxt = resolveTemplatePath("created_active.txt");
  } else if (statusCode === "CREATED_CANCELED") {
    templateNameHtml = resolveTemplatePath("created_canceled.html");
    templateNameTxt = resolveTemplatePath("created_canceled.txt");
  } else if (statusCode === "CREATED_PENDING") {
    templateNameHtml = resolveTemplatePath("created_pending.html");
    templateNameTxt = resolveTemplatePath("created_pending.txt");
    htmlVars = {
      ...commonVars,
      existing_code: existing?.code ?? "",
      existing_date: existing?.date ?? "",
      existing_time: existing?.time ?? "",
      existing_num_seats: existing ? String(existing.seats) : "",
    };
    textVars = htmlVars;
  } else {
    throw new Error(`Unknown result.code: ${statusCode}`);
  }

  let Emailsubject;
  switch (statusCode) {
    case "CREATED_ACTIVE": {
      Emailsubject = `Επιβεβαίωση κράτησης #${public_code}`;
      break;
    }
    case "CREATED_PENDING": {
      Emailsubject = `Κράτηση σε αναμονή #${public_code}`;
      break;
    }
    case "CREATED_CANCELED": {
      Emailsubject = `Ακύρωση κράτησης #${public_code}`;
      break;
    }
  }

  const html = renderTemplate(templateNameHtml, htmlVars);
  const text = renderTemplate(templateNameTxt, textVars);

  await transporter.sendMail({
    from: '"Lappas Productions Tickets" <tickets@lappasproductions.gr>',
    to: person.email,
    replyTo: "tickets@lappasproductions.gr",
    subject: Emailsubject,
    html,
    text,
    attachments:
      statusCode === "CREATED_ACTIVE"
        ? [{ filename: "qr.png", content: qrBuffer, cid: "qr-code" }]
        : [],
  });
}
