export interface ProfileUser {
  id: string;
  email: string;
  name: string;
  role: string | null;
  avatarUrl: string | null;
  timezone: string | null;
  locale: string | null;
  notificationPrefs: NotificationPrefs | null;
  twoFactorEnabled: boolean;
  createdAt: string;
  lastSignInAt: string | null;
}

export interface NotificationPrefs {
  incidentAssigned?: boolean;
  ownedCheckFailing?: boolean;
  digest?: "off" | "morning" | "evening";
}

export interface ProfileSession {
  id: string;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  isCurrent: boolean;
}

export interface ApiKey {
  id: string;
  name: string;
  tokenPrefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface ApiKeyCreateResponse extends ApiKey {
  plaintext: string;
}

export interface TwoFactorStatus {
  enabled: boolean;
  backupCodesRemaining: number;
}

export const LOCALES: Array<{ value: string; label: string }> = [
  { value: "en", label: "English" },
  { value: "es", label: "Español" },
  { value: "pt-BR", label: "Português (Brasil)" },
  { value: "fr", label: "Français" },
  { value: "de", label: "Deutsch" },
];

export const COMMON_TIMEZONES: string[] = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Anchorage",
  "America/Phoenix",
  "America/Toronto",
  "America/Mexico_City",
  "America/Sao_Paulo",
  "America/Argentina/Buenos_Aires",
  "Europe/London",
  "Europe/Dublin",
  "Europe/Lisbon",
  "Europe/Madrid",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Rome",
  "Europe/Amsterdam",
  "Europe/Stockholm",
  "Europe/Helsinki",
  "Europe/Athens",
  "Europe/Istanbul",
  "Europe/Moscow",
  "Africa/Cairo",
  "Africa/Johannesburg",
  "Asia/Jerusalem",
  "Asia/Dubai",
  "Asia/Karachi",
  "Asia/Kolkata",
  "Asia/Bangkok",
  "Asia/Singapore",
  "Asia/Shanghai",
  "Asia/Hong_Kong",
  "Asia/Tokyo",
  "Asia/Seoul",
  "Australia/Perth",
  "Australia/Sydney",
  "Pacific/Auckland",
];
