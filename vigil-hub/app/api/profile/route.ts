import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSession } from "@/lib/session";

const VALID_LOCALES = new Set(["en", "es", "pt-BR", "fr", "de"]);

function isValidTimezone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz.length === 0 || tz.length > 64) return false;
  try {
    // Validate the timezone identifier via the runtime's own tz database
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    const u = new URL(value);
    return u.protocol === "https:";
  } catch {
    return false;
  }
}

export async function GET(req: NextRequest) {
  const session = await getSession(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      avatarUrl: true,
      timezone: true,
      locale: true,
      notificationPrefs: true,
      twoFactorEnabled: true,
      createdAt: true,
      lastSignInAt: true,
    },
  });

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  return NextResponse.json(user);
}

export async function PATCH(req: NextRequest) {
  const session = await getSession(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const data: Record<string, unknown> = {};
  const errors: Record<string, string> = {};

  if ("name" in body) {
    const name = body.name;
    if (typeof name !== "string" || name.trim().length === 0) {
      errors.name = "Name must be a non-empty string";
    } else if (name.length > 120) {
      errors.name = "Name is too long (max 120)";
    } else {
      data.name = name.trim();
    }
  }

  if ("avatarUrl" in body) {
    const v = body.avatarUrl;
    if (v === null || v === "") {
      data.avatarUrl = null;
    } else if (!isHttpsUrl(v)) {
      errors.avatarUrl = "Avatar URL must start with https://";
    } else {
      data.avatarUrl = v;
    }
  }

  if ("timezone" in body) {
    const tz = body.timezone;
    if (!isValidTimezone(tz)) {
      errors.timezone = "Invalid IANA timezone";
    } else {
      data.timezone = tz;
    }
  }

  if ("locale" in body) {
    const locale = body.locale;
    if (typeof locale !== "string" || !VALID_LOCALES.has(locale)) {
      errors.locale = "Invalid locale";
    } else {
      data.locale = locale;
    }
  }

  if ("notificationPrefs" in body) {
    const prefs = body.notificationPrefs;
    if (prefs !== null && (typeof prefs !== "object" || Array.isArray(prefs))) {
      errors.notificationPrefs = "notificationPrefs must be an object or null";
    } else {
      data.notificationPrefs = prefs ?? undefined;
    }
  }

  if (Object.keys(errors).length > 0) {
    return NextResponse.json({ error: "Validation failed", fieldErrors: errors }, { status: 400 });
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "No updatable fields supplied" }, { status: 400 });
  }

  const user = await db.user.update({
    where: { id: session.user.id },
    data,
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      avatarUrl: true,
      timezone: true,
      locale: true,
      notificationPrefs: true,
      twoFactorEnabled: true,
    },
  });

  return NextResponse.json(user);
}
