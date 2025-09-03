// src/recaptcha.ts
import dotenv from "dotenv";
dotenv.config();

/** Optional verify options (μην περνάς undefined αν έχεις enabled exactOptionalPropertyTypes) */
export type VerifyOptions = {
  remoteip?: string;
  expectedAction?: string;
  timeoutMs?: number; // default 10000ms
};

/** Αποτέλεσμα verify — χωρίς undefined σε optional keys */
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

/** Google verify response (χωρίς any) */
interface GoogleVerifyResponse {
  success: boolean;
  score?: number;
  action?: string;
  hostname?: string;
  challenge_ts?: string;
  "error-codes"?: string[];
}

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

  // Timeout-aware fetch
  const timeoutMs =
    typeof opts?.timeoutMs === "number" ? opts!.timeoutMs : 10000;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);

  let json: GoogleVerifyResponse | undefined;
  try {
    const resp = await fetch(
      "https://www.google.com/recaptcha/api/siteverify",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
        signal: ac.signal,
      }
    );
    json = (await resp.json()) as GoogleVerifyResponse;
  } catch (e: any) {
    clearTimeout(t);
    if (e?.name === "AbortError") {
      return { ok: false, reasons: ["verify_timeout"] };
    }
    return { ok: false, reasons: ["verify_request_failed"] };
  } finally {
    clearTimeout(t);
  }

  const success = !!json?.success;
  const score = typeof json?.score === "number" ? json.score : undefined;
  const action = typeof json?.action === "string" ? json.action : undefined;
  const hostname =
    typeof json?.hostname === "string" ? json.hostname : undefined;
  const errorCodes: string[] = Array.isArray(json?.["error-codes"])
    ? json!["error-codes"]!
    : [];

  // Βοηθητικά spreads για να ΜΗΝ στείλουμε undefined keys
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

  // Action check (env έχει προτεραιότητα, μετά ό,τι μας έδωσε ο caller)
  const expected = (
    RECAPTCHA_EXPECTED_ACTION ||
    opts?.expectedAction ||
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
    return {
      ok: false,
      reasons: ["low_score"],
      score, // γνωρίζουμε ότι είναι number εδώ
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
