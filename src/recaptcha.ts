// src/recaptcha.ts
import dotenv from "dotenv";
dotenv.config();

/** Προαιρετικά opts για verify */
export type VerifyOptions = Partial<{
  remoteip: string;
  expectedAction: string;
}>;

/** Αποτέλεσμα verify — προσοχή: χωρίς undefined στα optional (exactOptionalPropertyTypes) */
export type RecaptchaVerifyResult =
  | ({ ok: true } & Partial<{
      score: number;
      action: string;
      hostname: string;
    }>)
  | ({
      ok: false;
      reasons: string[];
    } & Partial<{ score: number; action: string; hostname: string }>);

const RECAPTCHA_SECRET = process.env.RECAPTCHA_SECRET_KEY || "";
const RECAPTCHA_MIN_SCORE = Number(process.env.RECAPTCHA_MIN_SCORE ?? "0.5");
const RECAPTCHA_EXPECTED_ACTION = (
  process.env.RECAPTCHA_EXPECTED_ACTION || ""
).trim();
const RECAPTCHA_ALLOWED_HOSTNAMES = (
  process.env.RECAPTCHA_ALLOWED_HOSTNAMES || ""
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/** reCAPTCHA v3 verification helper */
export async function verifyRecaptchaV3(
  token?: string | null,
  opts?: VerifyOptions
): Promise<RecaptchaVerifyResult> {
  if (!RECAPTCHA_SECRET) {
    return { ok: false, reasons: ["secret_missing"] };
  }
  if (!token) {
    return { ok: false, reasons: ["token_missing"] };
  }

  const params = new URLSearchParams();
  params.set("secret", RECAPTCHA_SECRET);
  params.set("response", token);
  if (opts?.remoteip) params.set("remoteip", opts.remoteip);

  let json: any;
  try {
    const resp = await fetch(
      "https://www.google.com/recaptcha/api/siteverify",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
      }
    );
    json = await resp.json();
  } catch {
    return { ok: false, reasons: ["verify_request_failed"] };
  }

  const success = !!json?.success;
  const score: number | undefined =
    typeof json?.score === "number" ? json.score : undefined;
  const action: string | undefined =
    typeof json?.action === "string" ? json.action : undefined;
  const hostname: string | undefined =
    typeof json?.hostname === "string" ? json.hostname : undefined;
  const errorCodes: string[] = Array.isArray(json?.["error-codes"])
    ? json["error-codes"]
    : [];

  const maybeScore = typeof score === "number" ? { score } : {};
  const maybeAction = action ? { action } : {};
  const maybeHostname = hostname ? { hostname } : {};

  if (!success) {
    return {
      ok: false,
      reasons: errorCodes.length ? errorCodes : ["not_success"],
      ...maybeScore,
      ...maybeAction,
      ...maybeHostname,
    };
  }

  const expected = (
    opts?.expectedAction ||
    RECAPTCHA_EXPECTED_ACTION ||
    ""
  ).trim();
  if (expected && action !== expected) {
    return {
      ok: false,
      reasons: ["unexpected_action"],
      ...maybeScore,
      ...maybeAction,
      ...maybeHostname,
    };
  }

  if (typeof score === "number" && score < RECAPTCHA_MIN_SCORE) {
    // εδώ το score είναι σίγουρα number, οπότε μπορούμε να το περάσουμε
    return {
      ok: false,
      reasons: ["low_score"],
      score,
      ...maybeAction,
      ...maybeHostname,
    };
  }

  if (
    RECAPTCHA_ALLOWED_HOSTNAMES.length &&
    hostname &&
    !RECAPTCHA_ALLOWED_HOSTNAMES.includes(hostname)
  ) {
    return {
      ok: false,
      reasons: ["hostname_not_allowed"],
      ...maybeScore,
      ...maybeAction,
      hostname,
    };
  }

  return { ok: true, ...maybeScore, ...maybeAction, ...maybeHostname };
}
