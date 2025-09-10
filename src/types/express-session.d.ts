import "express-session";

// Μίνιμαλ τύποι – προσαρμόσ' τους αν θέλεις πιο αυστηρά
interface User {
  id: number;
  name: string;
  surname: string;
  phone: string;
  email: string | null;
  isAdmin: boolean;
}
interface Communicator {
  name: string;
  surname: string;
  phone: string;
  email: string | null;
  id: number;
}
interface Theater {
  id: number;
  name: string;
  address: string;
  city: string;
  country: string;
  max_seats: number;
  phone: string | null;
  communicator: Communicator;
}
interface DateTimeItem {
  date: string;
  time: string;
  id: number;
  roles?: string[];
}
interface DatesForTheater {
  theater_id: number;
  dateTimes: DateTimeItem[];
}
interface Performance {
  production_id: number;
  name: string;
  dates: DatesForTheater[];
}

export interface LoginPayload {
  ok: boolean;
  msg: string;
  user: User;
  theaters: Theater[];
  performances: Performance[];
}

declare module "express-session" {
  interface SessionData {
    // ολόκληρο το JSON που γυρνάει το api_login_by_phone
    login?: LoginPayload;
  }
}
