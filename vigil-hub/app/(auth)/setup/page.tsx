"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Shield, ArrowRight, ArrowLeft, Check, TestTube } from "lucide-react";
import { cn } from "@/lib/utils";

export default function SetupPage() {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [smtpTesting, setSmtpTesting] = useState(false);
  const [smtpTestResult, setSmtpTestResult] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);

  // Step 1: Admin account
  const [adminEmail, setAdminEmail] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [adminConfirm, setAdminConfirm] = useState("");

  // Step 2: SMTP
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState("587");
  const [smtpUser, setSmtpUser] = useState("");
  const [smtpPass, setSmtpPass] = useState("");
  const [smtpFrom, setSmtpFrom] = useState("");

  // Step 3: Branding
  const [companyName, setCompanyName] = useState("Vigil");
  const [primaryColor, setPrimaryColor] = useState("#10b981");

  const inputClass =
    "w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-sm text-gray-900 placeholder-gray-400 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white dark:placeholder-gray-500";
  const labelClass =
    "block text-sm font-medium text-gray-700 dark:text-gray-300";

  const validateStep = () => {
    setError("");
    if (step === 1) {
      if (!adminEmail || !adminPassword) {
        setError("Email and password are required.");
        return false;
      }
      if (adminPassword.length < 8) {
        setError("Password must be at least 8 characters.");
        return false;
      }
      if (adminPassword !== adminConfirm) {
        setError("Passwords do not match.");
        return false;
      }
    }
    return true;
  };

  const handleNext = () => {
    if (validateStep()) {
      setStep((s) => Math.min(s + 1, 3));
    }
  };

  const handleBack = () => {
    setError("");
    setStep((s) => Math.max(s - 1, 1));
  };

  const handleTestSmtp = async () => {
    setSmtpTesting(true);
    setSmtpTestResult(null);
    try {
      const res = await fetch("/api/settings/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "smtp",
          smtp_host: smtpHost,
          smtp_port: parseInt(smtpPort, 10),
          smtp_user: smtpUser,
          smtp_pass: smtpPass,
          smtp_from: smtpFrom,
        }),
      });
      const data = await res.json();
      setSmtpTestResult({
        ok: res.ok,
        message: data.message || (res.ok ? "Connection successful" : "Failed"),
      });
    } catch {
      setSmtpTestResult({ ok: false, message: "Connection failed" });
    } finally {
      setSmtpTesting(false);
    }
  };

  const handleFinish = async () => {
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          admin_email: adminEmail,
          admin_password: adminPassword,
          smtp_host: smtpHost,
          smtp_port: parseInt(smtpPort, 10) || 587,
          smtp_user: smtpUser,
          smtp_pass: smtpPass,
          smtp_from: smtpFrom,
          company_name: companyName,
          primary_color: primaryColor,
        }),
      });

      if (res.ok) {
        router.push("/dashboard");
      } else {
        const data = await res.json();
        setError(data.error || "Setup failed. Please try again.");
      }
    } catch {
      setError("Setup failed. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4 dark:bg-gray-950">
      <div className="w-full max-w-lg">
        {/* Logo */}
        <div className="mb-8 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-xl bg-emerald-600">
            <Shield className="h-8 w-8 text-white" />
          </div>
          <h1 className="mt-4 text-2xl font-bold text-gray-900 dark:text-white">
            Welcome to Vigil
          </h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Let&apos;s get your monitoring platform set up.
          </p>
        </div>

        {/* Step Indicator */}
        <div className="mb-6 flex items-center justify-center gap-2">
          {[1, 2, 3].map((s) => (
            <div key={s} className="flex items-center gap-2">
              <div
                className={cn(
                  "flex h-8 w-8 items-center justify-center rounded-full text-sm font-medium transition-colors",
                  step > s
                    ? "bg-emerald-600 text-white"
                    : step === s
                    ? "bg-emerald-600 text-white"
                    : "bg-gray-200 text-gray-500 dark:bg-gray-700 dark:text-gray-400"
                )}
              >
                {step > s ? <Check className="h-4 w-4" /> : s}
              </div>
              {s < 3 && (
                <div
                  className={cn(
                    "h-0.5 w-12",
                    step > s
                      ? "bg-emerald-600"
                      : "bg-gray-200 dark:bg-gray-700"
                  )}
                />
              )}
            </div>
          ))}
        </div>
        <p className="mb-6 text-center text-sm text-gray-500 dark:text-gray-400">
          Step {step} of 3 &mdash;{" "}
          {step === 1
            ? "Create Admin Account"
            : step === 2
            ? "SMTP Configuration"
            : "Branding"}
        </p>

        {/* Card */}
        <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-800 dark:bg-gray-900">
          {error && (
            <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-400">
              {error}
            </div>
          )}

          {/* Step 1: Admin Account */}
          {step === 1 && (
            <div className="space-y-4">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
                Create Admin Account
              </h2>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                This will be your primary administrator account.
              </p>
              <div>
                <label className={labelClass}>Email</label>
                <input
                  type="email"
                  value={adminEmail}
                  onChange={(e) => setAdminEmail(e.target.value)}
                  placeholder="admin@example.com"
                  required
                  className={cn(inputClass, "mt-1")}
                />
              </div>
              <div>
                <label className={labelClass}>Password</label>
                <input
                  type="password"
                  value={adminPassword}
                  onChange={(e) => setAdminPassword(e.target.value)}
                  placeholder="Minimum 8 characters"
                  required
                  className={cn(inputClass, "mt-1")}
                />
              </div>
              <div>
                <label className={labelClass}>Confirm Password</label>
                <input
                  type="password"
                  value={adminConfirm}
                  onChange={(e) => setAdminConfirm(e.target.value)}
                  placeholder="Re-enter your password"
                  required
                  className={cn(inputClass, "mt-1")}
                />
              </div>
            </div>
          )}

          {/* Step 2: SMTP */}
          {step === 2 && (
            <div className="space-y-4">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
                SMTP Configuration
              </h2>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Configure email for alert notifications. You can skip this and
                set it up later.
              </p>
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
              <div>
                <label className={labelClass}>From Address</label>
                <input
                  type="email"
                  value={smtpFrom}
                  onChange={(e) => setSmtpFrom(e.target.value)}
                  placeholder="alerts@example.com"
                  className={cn(inputClass, "mt-1")}
                />
              </div>
              {smtpHost && (
                <div>
                  <button
                    onClick={handleTestSmtp}
                    disabled={smtpTesting}
                    className="inline-flex items-center gap-2 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
                  >
                    <TestTube className="h-4 w-4" />
                    {smtpTesting ? "Testing..." : "Test Connection"}
                  </button>
                  {smtpTestResult && (
                    <p
                      className={cn(
                        "mt-2 text-sm",
                        smtpTestResult.ok
                          ? "text-green-600 dark:text-green-400"
                          : "text-red-600 dark:text-red-400"
                      )}
                    >
                      {smtpTestResult.message}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Step 3: Branding */}
          {step === 3 && (
            <div className="space-y-4">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
                Branding
              </h2>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Customize the look and feel of your monitoring dashboard.
              </p>
              <div>
                <label className={labelClass}>Company Name</label>
                <input
                  type="text"
                  value={companyName}
                  onChange={(e) => setCompanyName(e.target.value)}
                  className={cn(inputClass, "mt-1")}
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
              {/* Preview */}
              <div className="mt-4 rounded-lg border border-gray-200 p-4 dark:border-gray-700">
                <p className="mb-3 text-xs font-medium text-gray-500 dark:text-gray-400">
                  Preview
                </p>
                <div className="flex items-center gap-3">
                  <div
                    className="flex h-10 w-10 items-center justify-center rounded-lg"
                    style={{ backgroundColor: primaryColor }}
                  >
                    <span className="text-lg font-bold text-white">
                      {companyName[0] || "V"}
                    </span>
                  </div>
                  <span className="text-xl font-bold text-gray-900 dark:text-white">
                    {companyName || "Vigil"}
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* Navigation */}
          <div className="mt-6 flex items-center justify-between">
            {step > 1 ? (
              <button
                onClick={handleBack}
                className="inline-flex items-center gap-2 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
              >
                <ArrowLeft className="h-4 w-4" />
                Back
              </button>
            ) : (
              <div />
            )}
            {step < 3 ? (
              <button
                onClick={handleNext}
                className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700"
              >
                Next
                <ArrowRight className="h-4 w-4" />
              </button>
            ) : (
              <button
                onClick={handleFinish}
                disabled={loading}
                className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                {loading ? "Setting up..." : "Complete Setup"}
                <Check className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
