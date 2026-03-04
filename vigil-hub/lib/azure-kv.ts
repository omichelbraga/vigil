import { decrypt } from "./encryption";

interface AzureKVConfig {
  vaultUrl: string;
  tenantId: string;
  clientId: string;
  clientSecret: string; // encrypted
}

interface KVItem {
  name: string;
  type: "secret" | "certificate";
  expiresOn: Date | null;
  daysUntilExpiry: number | null;
  enabled: boolean;
}

/** Azure Key Vault monitor using REST API (avoids heavy Azure SDK dependency) */
export class AzureKeyVaultMonitor {
  private config: AzureKVConfig;
  private accessToken: string | null = null;
  private tokenExpiry: number = 0;

  constructor(config: AzureKVConfig) {
    this.config = config;
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiry - 60000) {
      return this.accessToken;
    }

    const clientSecret = decrypt(this.config.clientSecret);
    const tokenUrl = `https://login.microsoftonline.com/${this.config.tenantId}/oauth2/v2.0/token`;

    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.config.clientId,
      client_secret: clientSecret,
      scope: "https://vault.azure.net/.default",
    });

    const resp = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!resp.ok) {
      throw new Error(
        `Azure AD token request failed: ${resp.status} ${await resp.text()}`
      );
    }

    const data = await resp.json();
    this.accessToken = data.access_token;
    this.tokenExpiry = Date.now() + data.expires_in * 1000;
    return this.accessToken!;
  }

  async listAll(): Promise<KVItem[]> {
    const token = await this.getAccessToken();
    const items: KVItem[] = [];
    const now = new Date();

    // List secrets
    const secretsResp = await fetch(
      `${this.config.vaultUrl}/secrets?api-version=7.4`,
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    if (secretsResp.ok) {
      const secretsData = await secretsResp.json();
      for (const s of secretsData.value || []) {
        const name = s.id.split("/").pop() || s.id;
        const expiresOn = s.attributes?.exp
          ? new Date(s.attributes.exp * 1000)
          : null;
        const daysUntilExpiry = expiresOn
          ? Math.floor(
              (expiresOn.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
            )
          : null;

        items.push({
          name,
          type: "secret",
          expiresOn,
          daysUntilExpiry,
          enabled: s.attributes?.enabled ?? true,
        });
      }
    }

    // List certificates
    const certsResp = await fetch(
      `${this.config.vaultUrl}/certificates?api-version=7.4`,
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    if (certsResp.ok) {
      const certsData = await certsResp.json();
      for (const c of certsData.value || []) {
        const name = c.id.split("/").pop() || c.id;
        const expiresOn = c.attributes?.exp
          ? new Date(c.attributes.exp * 1000)
          : null;
        const daysUntilExpiry = expiresOn
          ? Math.floor(
              (expiresOn.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
            )
          : null;

        items.push({
          name,
          type: "certificate",
          expiresOn,
          daysUntilExpiry,
          enabled: c.attributes?.enabled ?? true,
        });
      }
    }

    return items;
  }

  /** Test connection by listing secrets (limited to 1) */
  async testConnection(): Promise<{ ok: boolean; message: string }> {
    try {
      const token = await this.getAccessToken();
      const resp = await fetch(
        `${this.config.vaultUrl}/secrets?maxresults=1&api-version=7.4`,
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );

      if (resp.ok) {
        return { ok: true, message: "Connection successful" };
      }
      return {
        ok: false,
        message: `Azure KV returned ${resp.status}: ${await resp.text()}`,
      };
    } catch (err) {
      return {
        ok: false,
        message: `Connection failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}
