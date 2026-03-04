"use client";

import { useEffect, useState } from "react";
import {
  Settings,
  Mail,
  Bell,
  Palette,
  Users,
  KeyRound,
  Save,
  TestTube,
  Plus,
  Trash2,
  Activity,
} from "lucide-react";
import * as Tabs from "@radix-ui/react-tabs";
import { cn } from "@/lib/utils";

interface UserRecord {
  id: string;
  name?: string;
  email: string;
  role?: string;
  created_at?: string;
}

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState("general");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{
    key: string;
    ok: boolean;
    message: string;
  } | null>(null);

  // General
  const [cooldownMinutes, setCooldownMinutes] = useState("5");
  const [checkInterval, setCheckInterval] = useState("60");

  // SMTP
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState("587");
  const [smtpAuth, setSmtpAuth] = useState(true);
  const [smtpUser, setSmtpUser] = useState("");
  const [smtpPass, setSmtpPass] = useState("");
  const [smtpFrom, setSmtpFrom] = useState("");

  // Notifications
  const [slackWebhook, setSlackWebhook] = useState("");
  const [teamsWebhook, setTeamsWebhook] = useState("");
  const [discordWebhook, setDiscordWebhook] = useState("");
  const [telegramToken, setTelegramToken] = useState("");
  const [telegramChatId, setTelegramChatId] = useState("");
  const [twilioSid, setTwilioSid] = useState("");
  const [twilioToken, setTwilioToken] = useState("");
  const [twilioFrom, setTwilioFrom] = useState("");
  const [twilioTo, setTwilioTo] = useState("");
  const [genericWebhook, setGenericWebhook] = useState("");

  // Branding
  const [companyName, setCompanyName] = useState("Vigil");
  const [logoUrl, setLogoUrl] = useState("");
  const [primaryColor, setPrimaryColor] = useState("#10b981");

  // Users
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviting, setInviting] = useState(false);

  // Azure KV
  const [azureTenantId, setAzureTenantId] = useState("");
  const [azureClientId, setAzureClientId] = useState("");
  const [azureClientSecret, setAzureClientSecret] = useState("");
  const [azureVaultUrl, setAzureVaultUrl] = useState("");

  useEffect(() => {
    async function loadSettings() {
      try {
        const res = await fetch("/api/settings");
        if (res.ok) {
          const data = await res.json();
          if (data.cooldown_minutes)
            setCooldownMinutes(String(data.cooldown_minutes));
          if (data.check_interval)
            setCheckInterval(String(data.check_interval));
          if (data.smtp_host) setSmtpHost(data.smtp_host);
          if (data.smtp_port) setSmtpPort(String(data.smtp_port));
          if (data.smtp_auth !== undefined) setSmtpAuth(data.smtp_auth);
          if (data.smtp_user) setSmtpUser(data.smtp_user);
          if (data.smtp_from) setSmtpFrom(data.smtp_from);
          if (data.slack_webhook) setSlackWebhook(data.slack_webhook);
          if (data.teams_webhook) setTeamsWebhook(data.teams_webhook);
          if (data.discord_webhook) setDiscordWebhook(data.discord_webhook);
          if (data.telegram_token) setTelegramToken(data.telegram_token);
          if (data.telegram_chat_id) setTelegramChatId(data.telegram_chat_id);
          if (data.twilio_sid) setTwilioSid(data.twilio_sid);
          if (data.twilio_from) setTwilioFrom(data.twilio_from);
          if (data.twilio_to) setTwilioTo(data.twilio_to);
          if (data.generic_webhook) setGenericWebhook(data.generic_webhook);
          if (data.company_name) setCompanyName(data.company_name);
          if (data.logo_url) setLogoUrl(data.logo_url);
          if (data.primary_color) setPrimaryColor(data.primary_color);
          if (data.azure_tenant_id) setAzureTenantId(data.azure_tenant_id);
          if (data.azure_client_id) setAzureClientId(data.azure_client_id);
          if (data.azure_vault_url) setAzureVaultUrl(data.azure_vault_url);
        }
      } catch {
        // ignore
      }

      try {
        const res = await fetch("/api/users");
        if (res.ok) {
          const data = await res.json();
          setUsers(Array.isArray(data) ? data : []);
        }
      } catch {
        // ignore
      }
    }
    loadSettings();
  }, []);

  const saveSettings = async (section: string, payload: Record<string, unknown>) => {
    setSaving(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ section, ...payload }),
      });
      if (!res.ok) {
        const data = await res.json();
        alert(data.error || "Failed to save settings");
      }
    } catch {
      alert("Failed to save settings");
    } finally {
      setSaving(false);
    }
  };

  const testConnection = async (type: string, payload: Record<string, unknown>) => {
    setTesting(type);
    setTestResult(null);
    try {
      const res = await fetch("/api/settings/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, ...payload }),
      });
      const data = await res.json();
      setTestResult({
        key: type,
        ok: res.ok,
        message: data.message || (res.ok ? "Connection successful" : "Connection failed"),
      });
    } catch {
      setTestResult({ key: type, ok: false, message: "Connection failed" });
    } finally {
      setTesting(null);
    }
  };

  const handleInvite = async () => {
    if (!inviteEmail.trim()) return;
    setInviting(true);
    try {
      const res = await fetch("/api/users/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: inviteEmail.trim() }),
      });
      if (res.ok) {
        setInviteEmail("");
        const usersRes = await fetch("/api/users");
        if (usersRes.ok) {
          const data = await usersRes.json();
          setUsers(Array.isArray(data) ? data : []);
        }
      } else {
        const data = await res.json();
        alert(data.error || "Failed to invite user");
      }
    } catch {
      alert("Failed to invite user");
    } finally {
      setInviting(false);
    }
  };

  const inputClass =
    "w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white dark:placeholder-gray-500";
  const labelClass =
    "block text-sm font-medium text-gray-700 dark:text-gray-300";
  const sectionClass = "space-y-4";
  const cardClass =
    "rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-gray-900";

  const tabs = [
    { value: "general", label: "General", icon: Settings },
    { value: "smtp", label: "SMTP", icon: Mail },
    { value: "notifications", label: "Notifications", icon: Bell },
    { value: "branding", label: "Branding", icon: Palette },
    { value: "users", label: "Users", icon: Users },
    { value: "azure", label: "Azure KV", icon: KeyRound },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
          Settings
        </h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Configure your Vigil monitoring platform
        </p>
      </div>

      <Tabs.Root value={activeTab} onValueChange={setActiveTab}>
        <Tabs.List className="flex gap-1 overflow-x-auto rounded-lg bg-gray-100 p-1 dark:bg-gray-800">
          {tabs.map((tab) => (
            <Tabs.Trigger
              key={tab.value}
              value={tab.value}
              className={cn(
                "inline-flex items-center gap-2 whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                activeTab === tab.value
                  ? "bg-white text-gray-900 shadow-sm dark:bg-gray-700 dark:text-white"
                  : "text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300"
              )}
            >
              <tab.icon className="h-4 w-4" />
              {tab.label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>

        {/* General Tab */}
        <Tabs.Content value="general" className="mt-6">
          <div className={cardClass}>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
              General Settings
            </h2>
            <div className={cn(sectionClass, "mt-4")}>
              <div>
                <label className={labelClass}>
                  Alert Cooldown (minutes)
                </label>
                <input
                  type="number"
                  value={cooldownMinutes}
                  onChange={(e) => setCooldownMinutes(e.target.value)}
                  min="1"
                  className={cn(inputClass, "mt-1 max-w-xs")}
                />
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  Minimum time between repeated alerts for the same check.
                </p>
              </div>
              <div>
                <label className={labelClass}>
                  Default Check Interval (seconds)
                </label>
                <input
                  type="number"
                  value={checkInterval}
                  onChange={(e) => setCheckInterval(e.target.value)}
                  min="10"
                  className={cn(inputClass, "mt-1 max-w-xs")}
                />
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  Default interval for new health checks.
                </p>
              </div>
              <div className="pt-2">
                <button
                  onClick={() =>
                    saveSettings("general", {
                      cooldown_minutes: parseInt(cooldownMinutes, 10),
                      check_interval: parseInt(checkInterval, 10),
                    })
                  }
                  disabled={saving}
                  className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                >
                  <Save className="h-4 w-4" />
                  {saving ? "Saving..." : "Save"}
                </button>
              </div>
            </div>
          </div>
        </Tabs.Content>

        {/* SMTP Tab */}
        <Tabs.Content value="smtp" className="mt-6">
          <div className={cardClass}>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
              SMTP Configuration
            </h2>
            <div className={cn(sectionClass, "mt-4")}>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className={labelClass}>Host</label>
                  <input
                    type="text"
                    value={smtpHost}
                    onChange={(e) => setSmtpHost(e.target.value)}
                    placeholder="smtp.example.com"
                    className={cn(inputClass, "mt-1")}
                  />
                </div>
                <div>
                  <label className={labelClass}>Port</label>
                  <input
                    type="number"
                    value={smtpPort}
                    onChange={(e) => setSmtpPort(e.target.value)}
                    className={cn(inputClass, "mt-1")}
                  />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="smtp-auth"
                  checked={smtpAuth}
                  onChange={(e) => setSmtpAuth(e.target.checked)}
                  className="h-4 w-4 rounded border-gray-300 text-emerald-600 focus:ring-emerald-500"
                />
                <label
                  htmlFor="smtp-auth"
                  className="text-sm font-medium text-gray-700 dark:text-gray-300"
                >
                  Require Authentication
                </label>
              </div>
              {smtpAuth && (
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <label className={labelClass}>Username</label>
                    <input
                      type="text"
                      value={smtpUser}
                      onChange={(e) => setSmtpUser(e.target.value)}
                      className={cn(inputClass, "mt-1")}
                    />
                  </div>
                  <div>
                    <label className={labelClass}>Password</label>
                    <input
                      type="password"
                      value={smtpPass}
                      onChange={(e) => setSmtpPass(e.target.value)}
                      className={cn(inputClass, "mt-1")}
                    />
                  </div>
                </div>
              )}
              <div>
                <label className={labelClass}>From Address</label>
                <input
                  type="email"
                  value={smtpFrom}
                  onChange={(e) => setSmtpFrom(e.target.value)}
                  placeholder="alerts@example.com"
                  className={cn(inputClass, "mt-1 max-w-md")}
                />
              </div>
              <div className="flex gap-3 pt-2">
                <button
                  onClick={() =>
                    saveSettings("smtp", {
                      smtp_host: smtpHost,
                      smtp_port: parseInt(smtpPort, 10),
                      smtp_auth: smtpAuth,
                      smtp_user: smtpUser,
                      smtp_pass: smtpPass,
                      smtp_from: smtpFrom,
                    })
                  }
                  disabled={saving}
                  className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                >
                  <Save className="h-4 w-4" />
                  {saving ? "Saving..." : "Save"}
                </button>
                <button
                  onClick={() =>
                    testConnection("smtp", {
                      smtp_host: smtpHost,
                      smtp_port: parseInt(smtpPort, 10),
                      smtp_auth: smtpAuth,
                      smtp_user: smtpUser,
                      smtp_pass: smtpPass,
                      smtp_from: smtpFrom,
                    })
                  }
                  disabled={testing === "smtp"}
                  className="inline-flex items-center gap-2 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
                >
                  <TestTube className="h-4 w-4" />
                  {testing === "smtp" ? "Testing..." : "Test Connection"}
                </button>
              </div>
              {testResult?.key === "smtp" && (
                <p
                  className={cn(
                    "text-sm",
                    testResult.ok
                      ? "text-green-600 dark:text-green-400"
                      : "text-red-600 dark:text-red-400"
                  )}
                >
                  {testResult.message}
                </p>
              )}
            </div>
          </div>
        </Tabs.Content>

        {/* Notifications Tab */}
        <Tabs.Content value="notifications" className="mt-6 space-y-6">
          {/* Slack */}
          <div className={cardClass}>
            <h3 className="text-base font-semibold text-gray-900 dark:text-white">
              Slack
            </h3>
            <div className="mt-3">
              <label className={labelClass}>Webhook URL</label>
              <input
                type="url"
                value={slackWebhook}
                onChange={(e) => setSlackWebhook(e.target.value)}
                placeholder="https://hooks.slack.com/services/..."
                className={cn(inputClass, "mt-1")}
              />
            </div>
            <div className="mt-4 flex gap-3">
              <button
                onClick={() =>
                  saveSettings("notifications", { slack_webhook: slackWebhook })
                }
                disabled={saving}
                className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                <Save className="h-4 w-4" />
                Save
              </button>
              <button
                onClick={() =>
                  testConnection("slack", { webhook_url: slackWebhook })
                }
                disabled={testing === "slack" || !slackWebhook}
                className="inline-flex items-center gap-2 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
              >
                <TestTube className="h-4 w-4" />
                Test
              </button>
            </div>
            {testResult?.key === "slack" && (
              <p
                className={cn(
                  "mt-2 text-sm",
                  testResult.ok
                    ? "text-green-600 dark:text-green-400"
                    : "text-red-600 dark:text-red-400"
                )}
              >
                {testResult.message}
              </p>
            )}
          </div>

          {/* Teams */}
          <div className={cardClass}>
            <h3 className="text-base font-semibold text-gray-900 dark:text-white">
              Microsoft Teams
            </h3>
            <div className="mt-3">
              <label className={labelClass}>Webhook URL</label>
              <input
                type="url"
                value={teamsWebhook}
                onChange={(e) => setTeamsWebhook(e.target.value)}
                placeholder="https://outlook.office.com/webhook/..."
                className={cn(inputClass, "mt-1")}
              />
            </div>
            <div className="mt-4 flex gap-3">
              <button
                onClick={() =>
                  saveSettings("notifications", { teams_webhook: teamsWebhook })
                }
                disabled={saving}
                className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                <Save className="h-4 w-4" />
                Save
              </button>
              <button
                onClick={() =>
                  testConnection("teams", { webhook_url: teamsWebhook })
                }
                disabled={testing === "teams" || !teamsWebhook}
                className="inline-flex items-center gap-2 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
              >
                <TestTube className="h-4 w-4" />
                Test
              </button>
            </div>
            {testResult?.key === "teams" && (
              <p
                className={cn(
                  "mt-2 text-sm",
                  testResult.ok
                    ? "text-green-600 dark:text-green-400"
                    : "text-red-600 dark:text-red-400"
                )}
              >
                {testResult.message}
              </p>
            )}
          </div>

          {/* Discord */}
          <div className={cardClass}>
            <h3 className="text-base font-semibold text-gray-900 dark:text-white">
              Discord
            </h3>
            <div className="mt-3">
              <label className={labelClass}>Webhook URL</label>
              <input
                type="url"
                value={discordWebhook}
                onChange={(e) => setDiscordWebhook(e.target.value)}
                placeholder="https://discord.com/api/webhooks/..."
                className={cn(inputClass, "mt-1")}
              />
            </div>
            <div className="mt-4 flex gap-3">
              <button
                onClick={() =>
                  saveSettings("notifications", {
                    discord_webhook: discordWebhook,
                  })
                }
                disabled={saving}
                className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                <Save className="h-4 w-4" />
                Save
              </button>
              <button
                onClick={() =>
                  testConnection("discord", { webhook_url: discordWebhook })
                }
                disabled={testing === "discord" || !discordWebhook}
                className="inline-flex items-center gap-2 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
              >
                <TestTube className="h-4 w-4" />
                Test
              </button>
            </div>
            {testResult?.key === "discord" && (
              <p
                className={cn(
                  "mt-2 text-sm",
                  testResult.ok
                    ? "text-green-600 dark:text-green-400"
                    : "text-red-600 dark:text-red-400"
                )}
              >
                {testResult.message}
              </p>
            )}
          </div>

          {/* Telegram */}
          <div className={cardClass}>
            <h3 className="text-base font-semibold text-gray-900 dark:text-white">
              Telegram
            </h3>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <div>
                <label className={labelClass}>Bot Token</label>
                <input
                  type="text"
                  value={telegramToken}
                  onChange={(e) => setTelegramToken(e.target.value)}
                  placeholder="123456:ABC-DEF..."
                  className={cn(inputClass, "mt-1")}
                />
              </div>
              <div>
                <label className={labelClass}>Chat ID</label>
                <input
                  type="text"
                  value={telegramChatId}
                  onChange={(e) => setTelegramChatId(e.target.value)}
                  placeholder="-1001234567890"
                  className={cn(inputClass, "mt-1")}
                />
              </div>
            </div>
            <div className="mt-4 flex gap-3">
              <button
                onClick={() =>
                  saveSettings("notifications", {
                    telegram_token: telegramToken,
                    telegram_chat_id: telegramChatId,
                  })
                }
                disabled={saving}
                className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                <Save className="h-4 w-4" />
                Save
              </button>
              <button
                onClick={() =>
                  testConnection("telegram", {
                    token: telegramToken,
                    chat_id: telegramChatId,
                  })
                }
                disabled={testing === "telegram" || !telegramToken}
                className="inline-flex items-center gap-2 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
              >
                <TestTube className="h-4 w-4" />
                Test
              </button>
            </div>
            {testResult?.key === "telegram" && (
              <p
                className={cn(
                  "mt-2 text-sm",
                  testResult.ok
                    ? "text-green-600 dark:text-green-400"
                    : "text-red-600 dark:text-red-400"
                )}
              >
                {testResult.message}
              </p>
            )}
          </div>

          {/* Twilio */}
          <div className={cardClass}>
            <h3 className="text-base font-semibold text-gray-900 dark:text-white">
              Twilio (SMS)
            </h3>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <div>
                <label className={labelClass}>Account SID</label>
                <input
                  type="text"
                  value={twilioSid}
                  onChange={(e) => setTwilioSid(e.target.value)}
                  className={cn(inputClass, "mt-1")}
                />
              </div>
              <div>
                <label className={labelClass}>Auth Token</label>
                <input
                  type="password"
                  value={twilioToken}
                  onChange={(e) => setTwilioToken(e.target.value)}
                  className={cn(inputClass, "mt-1")}
                />
              </div>
              <div>
                <label className={labelClass}>From Number</label>
                <input
                  type="text"
                  value={twilioFrom}
                  onChange={(e) => setTwilioFrom(e.target.value)}
                  placeholder="+1234567890"
                  className={cn(inputClass, "mt-1")}
                />
              </div>
              <div>
                <label className={labelClass}>To Number</label>
                <input
                  type="text"
                  value={twilioTo}
                  onChange={(e) => setTwilioTo(e.target.value)}
                  placeholder="+1234567890"
                  className={cn(inputClass, "mt-1")}
                />
              </div>
            </div>
            <div className="mt-4 flex gap-3">
              <button
                onClick={() =>
                  saveSettings("notifications", {
                    twilio_sid: twilioSid,
                    twilio_token: twilioToken,
                    twilio_from: twilioFrom,
                    twilio_to: twilioTo,
                  })
                }
                disabled={saving}
                className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                <Save className="h-4 w-4" />
                Save
              </button>
              <button
                onClick={() =>
                  testConnection("twilio", {
                    sid: twilioSid,
                    token: twilioToken,
                    from: twilioFrom,
                    to: twilioTo,
                  })
                }
                disabled={testing === "twilio" || !twilioSid}
                className="inline-flex items-center gap-2 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
              >
                <TestTube className="h-4 w-4" />
                Test
              </button>
            </div>
            {testResult?.key === "twilio" && (
              <p
                className={cn(
                  "mt-2 text-sm",
                  testResult.ok
                    ? "text-green-600 dark:text-green-400"
                    : "text-red-600 dark:text-red-400"
                )}
              >
                {testResult.message}
              </p>
            )}
          </div>

          {/* Generic Webhook */}
          <div className={cardClass}>
            <h3 className="text-base font-semibold text-gray-900 dark:text-white">
              Generic Webhook
            </h3>
            <div className="mt-3">
              <label className={labelClass}>Webhook URL</label>
              <input
                type="url"
                value={genericWebhook}
                onChange={(e) => setGenericWebhook(e.target.value)}
                placeholder="https://..."
                className={cn(inputClass, "mt-1")}
              />
            </div>
            <div className="mt-4 flex gap-3">
              <button
                onClick={() =>
                  saveSettings("notifications", {
                    generic_webhook: genericWebhook,
                  })
                }
                disabled={saving}
                className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                <Save className="h-4 w-4" />
                Save
              </button>
              <button
                onClick={() =>
                  testConnection("webhook", { webhook_url: genericWebhook })
                }
                disabled={testing === "webhook" || !genericWebhook}
                className="inline-flex items-center gap-2 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
              >
                <TestTube className="h-4 w-4" />
                Test
              </button>
            </div>
            {testResult?.key === "webhook" && (
              <p
                className={cn(
                  "mt-2 text-sm",
                  testResult.ok
                    ? "text-green-600 dark:text-green-400"
                    : "text-red-600 dark:text-red-400"
                )}
              >
                {testResult.message}
              </p>
            )}
          </div>
        </Tabs.Content>

        {/* Branding Tab */}
        <Tabs.Content value="branding" className="mt-6">
          <div className={cardClass}>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
              Branding
            </h2>
            <div className={cn(sectionClass, "mt-4")}>
              <div>
                <label className={labelClass}>Company Name</label>
                <input
                  type="text"
                  value={companyName}
                  onChange={(e) => setCompanyName(e.target.value)}
                  className={cn(inputClass, "mt-1 max-w-md")}
                />
              </div>
              <div>
                <label className={labelClass}>Logo URL</label>
                <input
                  type="url"
                  value={logoUrl}
                  onChange={(e) => setLogoUrl(e.target.value)}
                  placeholder="https://example.com/logo.png"
                  className={cn(inputClass, "mt-1 max-w-md")}
                />
              </div>
              <div>
                <label className={labelClass}>Primary Color</label>
                <div className="mt-1 flex items-center gap-3">
                  <input
                    type="color"
                    value={primaryColor}
                    onChange={(e) => setPrimaryColor(e.target.value)}
                    className="h-10 w-14 cursor-pointer rounded-lg border border-gray-300 dark:border-gray-600"
                  />
                  <input
                    type="text"
                    value={primaryColor}
                    onChange={(e) => setPrimaryColor(e.target.value)}
                    className={cn(inputClass, "max-w-[8rem]")}
                  />
                </div>
              </div>

              {/* Live Preview */}
              <div className="mt-6 rounded-xl border border-gray-200 p-6 dark:border-gray-700">
                <h3 className="mb-4 text-sm font-medium text-gray-500 dark:text-gray-400">
                  Live Preview
                </h3>
                <div className="flex items-center gap-3">
                  {logoUrl ? (
                    <img
                      src={logoUrl}
                      alt="Logo preview"
                      className="h-10 w-10 rounded-lg object-contain"
                      onError={(e) => {
                        (e.target as HTMLImageElement).style.display = "none";
                      }}
                    />
                  ) : (
                    <div
                      className="flex h-10 w-10 items-center justify-center rounded-lg"
                      style={{ backgroundColor: primaryColor }}
                    >
                      <span className="text-lg font-bold text-white">
                        {companyName[0] || "V"}
                      </span>
                    </div>
                  )}
                  <span className="text-xl font-bold text-gray-900 dark:text-white">
                    {companyName || "Vigil"}
                  </span>
                </div>
                <div className="mt-4 flex gap-2">
                  <button
                    className="rounded-lg px-4 py-2 text-sm font-medium text-white"
                    style={{ backgroundColor: primaryColor }}
                  >
                    Primary Button
                  </button>
                  <button
                    className="rounded-lg border-2 px-4 py-2 text-sm font-medium"
                    style={{
                      borderColor: primaryColor,
                      color: primaryColor,
                    }}
                  >
                    Secondary Button
                  </button>
                </div>
              </div>

              <div className="pt-2">
                <button
                  onClick={() =>
                    saveSettings("branding", {
                      company_name: companyName,
                      logo_url: logoUrl,
                      primary_color: primaryColor,
                    })
                  }
                  disabled={saving}
                  className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                >
                  <Save className="h-4 w-4" />
                  {saving ? "Saving..." : "Save"}
                </button>
              </div>
            </div>
          </div>
        </Tabs.Content>

        {/* Users Tab */}
        <Tabs.Content value="users" className="mt-6">
          <div className={cardClass}>
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
                Users
              </h2>
              <div className="flex items-center gap-2">
                <input
                  type="email"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="user@example.com"
                  className={cn(inputClass, "w-64")}
                  onKeyDown={(e) => e.key === "Enter" && handleInvite()}
                />
                <button
                  onClick={handleInvite}
                  disabled={inviting || !inviteEmail.trim()}
                  className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                >
                  <Plus className="h-4 w-4" />
                  {inviting ? "Inviting..." : "Invite User"}
                </button>
              </div>
            </div>
            <div className="mt-4">
              {users.length > 0 ? (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-200 dark:border-gray-700">
                      <th className="pb-3 text-left font-medium text-gray-500 dark:text-gray-400">
                        Name
                      </th>
                      <th className="pb-3 text-left font-medium text-gray-500 dark:text-gray-400">
                        Email
                      </th>
                      <th className="pb-3 text-left font-medium text-gray-500 dark:text-gray-400">
                        Role
                      </th>
                      <th className="pb-3 text-right font-medium text-gray-500 dark:text-gray-400">
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                    {users.map((user) => (
                      <tr key={user.id}>
                        <td className="py-3 text-gray-900 dark:text-white">
                          {user.name || "—"}
                        </td>
                        <td className="py-3 text-gray-500 dark:text-gray-400">
                          {user.email}
                        </td>
                        <td className="py-3">
                          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700 dark:bg-gray-800 dark:text-gray-400">
                            {user.role || "user"}
                          </span>
                        </td>
                        <td className="py-3 text-right">
                          <button
                            onClick={async () => {
                              if (
                                !confirm(
                                  `Remove user ${user.email}?`
                                )
                              )
                                return;
                              await fetch(`/api/users/${user.id}`, {
                                method: "DELETE",
                              });
                              setUsers((prev) =>
                                prev.filter((u) => u.id !== user.id)
                              );
                            }}
                            className="rounded-lg p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950 dark:hover:text-red-400"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="py-8 text-center text-sm text-gray-500 dark:text-gray-400">
                  No users found.
                </p>
              )}
            </div>
          </div>
        </Tabs.Content>

        {/* Azure KV Tab */}
        <Tabs.Content value="azure" className="mt-6">
          <div className={cardClass}>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
              Azure Key Vault
            </h2>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              Connect to Azure Key Vault to monitor certificate expiration.
            </p>
            <div className={cn(sectionClass, "mt-4")}>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className={labelClass}>Tenant ID</label>
                  <input
                    type="text"
                    value={azureTenantId}
                    onChange={(e) => setAzureTenantId(e.target.value)}
                    className={cn(inputClass, "mt-1")}
                  />
                </div>
                <div>
                  <label className={labelClass}>Client ID</label>
                  <input
                    type="text"
                    value={azureClientId}
                    onChange={(e) => setAzureClientId(e.target.value)}
                    className={cn(inputClass, "mt-1")}
                  />
                </div>
              </div>
              <div>
                <label className={labelClass}>Client Secret</label>
                <input
                  type="password"
                  value={azureClientSecret}
                  onChange={(e) => setAzureClientSecret(e.target.value)}
                  className={cn(inputClass, "mt-1 max-w-md")}
                />
              </div>
              <div>
                <label className={labelClass}>Vault URL</label>
                <input
                  type="url"
                  value={azureVaultUrl}
                  onChange={(e) => setAzureVaultUrl(e.target.value)}
                  placeholder="https://my-vault.vault.azure.net/"
                  className={cn(inputClass, "mt-1 max-w-md")}
                />
              </div>
              <div className="flex gap-3 pt-2">
                <button
                  onClick={() =>
                    saveSettings("azure_kv", {
                      azure_tenant_id: azureTenantId,
                      azure_client_id: azureClientId,
                      azure_client_secret: azureClientSecret,
                      azure_vault_url: azureVaultUrl,
                    })
                  }
                  disabled={saving}
                  className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                >
                  <Save className="h-4 w-4" />
                  {saving ? "Saving..." : "Save"}
                </button>
                <button
                  onClick={() =>
                    testConnection("azure_kv", {
                      tenant_id: azureTenantId,
                      client_id: azureClientId,
                      client_secret: azureClientSecret,
                      vault_url: azureVaultUrl,
                    })
                  }
                  disabled={
                    testing === "azure_kv" || !azureTenantId || !azureVaultUrl
                  }
                  className="inline-flex items-center gap-2 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
                >
                  <TestTube className="h-4 w-4" />
                  {testing === "azure_kv"
                    ? "Testing..."
                    : "Test Connection"}
                </button>
              </div>
              {testResult?.key === "azure_kv" && (
                <p
                  className={cn(
                    "text-sm",
                    testResult.ok
                      ? "text-green-600 dark:text-green-400"
                      : "text-red-600 dark:text-red-400"
                  )}
                >
                  {testResult.message}
                </p>
              )}
            </div>
          </div>
        </Tabs.Content>
      </Tabs.Root>
    </div>
  );
}
