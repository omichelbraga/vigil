# OAuth Configuration

Vigil supports Google and Microsoft/Azure AD OAuth as optional login methods. When enabled, login buttons appear on the sign-in page.

## Google OAuth

### 1. Create Google OAuth App

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or select existing)
3. APIs & Services → Credentials → Create Credentials → OAuth Client ID
4. Application type: **Web application**
5. Authorized redirect URIs: `http://YOUR_HUB_URL:3000/api/auth/callback/google`
6. Copy **Client ID** and **Client Secret**

### 2. Configure in Vigil

1. Vigil Hub → Settings → OAuth Providers
2. Toggle **Google OAuth** on
3. Enter Client ID and Client Secret
4. Save

Google login button will appear on the login page immediately.

---

## Microsoft / Azure AD OAuth

### 1. Register App in Azure AD

1. Azure Portal → Azure Active Directory → App Registrations → New Registration
2. Name: `Vigil Hub`
3. Supported account types: **Accounts in this organizational directory only** (single tenant)
4. Redirect URI: Web → `http://YOUR_HUB_URL:3000/api/auth/callback/microsoft`
5. Register

### 2. Create Client Secret

1. App Registration → Certificates & Secrets → New Client Secret
2. Set expiry (recommend 24 months)
3. **Copy the secret value immediately** (only shown once)
4. Also note the expiry date — add it to **Expiry Monitors** to get alerted before it expires

### 3. Collect Required Values

From the App Registration **Overview** page:
- **Client ID** = Application (client) ID
- **Tenant ID** = Directory (tenant) ID

From **Certificates & Secrets**:
- **Client Secret** = the value you copied in step 2

### 4. Configure in Vigil

1. Vigil Hub → Settings → OAuth Providers
2. Toggle **Microsoft OAuth** on
3. Enter Client ID, Client Secret, and Tenant ID
4. Save

Microsoft login button will appear on the login page.

---

## Notes

- OAuth login creates a new user account on first login if the email doesn't exist
- Existing email/password accounts can also log in with OAuth if the email matches
- OAuth is **additive** — disabling a provider hides the button but doesn't affect existing sessions
- Better Auth handles the OAuth flow; Vigil stores only the enable/disable toggle and credentials in settings
