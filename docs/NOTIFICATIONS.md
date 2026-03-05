# Notifications Reference

Vigil supports 6 notification channels. Configure them in **Settings → Notifications**.

## Channels

### Microsoft Teams

Uses the Teams Incoming Webhook connector.

**Setup:**
1. In Teams: channel → `...` → Connectors → Incoming Webhook → Configure
2. Copy the webhook URL → paste into Vigil

**Config fields:** Webhook URL, Custom Payload (optional)

---

### Slack

Uses Slack Incoming Webhooks.

**Setup:**
1. Slack API → Create App → Incoming Webhooks → Activate → Add to Workspace
2. Copy webhook URL → paste into Vigil

**Config fields:** Webhook URL, Custom Payload (optional)

---

### Discord

Uses Discord webhook URLs.

**Setup:**
1. Discord Server Settings → Integrations → Webhooks → New Webhook
2. Copy webhook URL → paste into Vigil

**Config fields:** Webhook URL, Custom Payload (optional)

---

### Telegram

Uses Telegram Bot API.

**Setup:**
1. Message `@BotFather` → `/newbot` → get Bot Token
2. Get your Chat ID: message your bot, then visit `https://api.telegram.org/bot<TOKEN>/getUpdates`

**Config fields:** Bot Token, Chat ID, Custom Payload (optional)

---

### Email (SMTP)

Sends HTML email alerts via any SMTP relay.

**Config fields:**
- SMTP Host / Port
- From address
- To address(es) — comma separated
- Auth (optional): username / password
- TLS enabled toggle

**For City of San Marcos internal relay:** Host `10.1.3.66`, Port `25`, no auth, no TLS.

---

### Generic Webhook

Sends a POST request with JSON payload to any URL.

**Config fields:** URL, Custom Payload (optional)

---

## Alert Types

| Type | When fired |
|------|-----------|
| `alert` | Check goes to Warning or Critical (first occurrence only) |
| `resolved` | Check returns to OK after being in alert state |
| `agent-offline` | Agent WebSocket disconnects |
| `agent-online` | Agent reconnects after being offline (>90 seconds gap) |

---

## Template Variables

All custom payload templates support these variables:

| Variable | Example Value | Description |
|----------|--------------|-------------|
| `{{title}}` | `Spooler is Critical` | Alert title (no emoji) |
| `{{body}}` | `Spooler on agent MIKE-PC-HOST is critical` | Alert description |
| `{{agentName}}` | `MIKE-PC-HOST` | Agent display name |
| `{{checkName}}` | `Spooler` | Check display name |
| `{{status}}` | `critical` | Status string (lowercase) |
| `{{emoji}}` | `🚨` or `✅` | 🚨 for alerts, ✅ for resolved |
| `{{statusEmoji}}` | `🔴` or `🟢` | 🔴 for alert, 🟢 for resolved |
| `{{color}}` | `14177041` | Decimal color (red/amber/green) |
| `{{colorHex}}` | `#D93025` | Hex color for Slack attachments |
| `{{timestamp}}` | `2026-03-05T08:00:00.000Z` | ISO 8601 timestamp |
| `{{type}}` | `alert` or `resolved` | Notification type |

---

## Example: Teams Adaptive Card

```json
{
  "type": "message",
  "attachments": [{
    "contentType": "application/vnd.microsoft.card.adaptive",
    "content": {
      "type": "AdaptiveCard",
      "version": "1.4",
      "body": [
        {
          "type": "ColumnSet",
          "columns": [
            {
              "type": "Column",
              "width": "auto",
              "items": [{ "type": "TextBlock", "text": "{{emoji}}", "size": "ExtraLarge" }]
            },
            {
              "type": "Column",
              "width": "stretch",
              "items": [
                { "type": "TextBlock", "text": "{{title}}", "weight": "Bolder", "size": "Medium" },
                { "type": "TextBlock", "text": "{{body}}", "isSubtle": true, "wrap": true }
              ]
            }
          ]
        },
        {
          "type": "FactSet",
          "facts": [
            { "title": "🖥️ Agent", "value": "{{agentName}}" },
            { "title": "🔍 Check", "value": "{{checkName}}" },
            { "title": "{{statusEmoji}} Status", "value": "{{status}}" },
            { "title": "🕐 Time", "value": "{{timestamp}}" }
          ]
        }
      ],
      "actions": [{
        "type": "Action.OpenUrl",
        "title": "Open Vigil Dashboard →",
        "url": "http://192.168.9.113:3000"
      }]
    }
  }]
}
```

## Example: Slack

```json
{
  "attachments": [{
    "color": "{{colorHex}}",
    "blocks": [
      {
        "type": "section",
        "text": { "type": "mrkdwn", "text": "{{emoji}} *{{title}}*\n{{body}}" }
      },
      {
        "type": "section",
        "fields": [
          { "type": "mrkdwn", "text": "🖥️ *Agent*\n`{{agentName}}`" },
          { "type": "mrkdwn", "text": "🔍 *Check*\n`{{checkName}}`" },
          { "type": "mrkdwn", "text": "{{statusEmoji}} *Status*\n`{{status}}`" },
          { "type": "mrkdwn", "text": "🕐 *Time*\n`{{timestamp}}`" }
        ]
      }
    ]
  }]
}
```

## Example: Telegram (HTML parse mode)

```
{{emoji}} <b>{{title}}</b>

{{body}}

🖥 <b>Agent:</b> {{agentName}}
🔍 <b>Check:</b> {{checkName}}
{{statusEmoji}} <b>Status:</b> {{status}}
🕐 <b>Time:</b> {{timestamp}}

<a href="http://192.168.9.113:3000">🔗 Open Vigil Dashboard</a>
```
