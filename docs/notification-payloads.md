# Vigil — Notification Payload Reference

Each notification channel supports a **Custom Payload** template. Leave it blank to use the built-in default, or paste one of the templates below and customize to your needs.

---

## Template Variables

| Variable | Description | Example |
|---|---|---|
| `{{title}}` | Alert title | `🚨 service:Spooler is CRITICAL` |
| `{{body}}` | Alert message | `Service Spooler is stopped` |
| `{{checkName}}` | Check identifier | `service:Spooler` |
| `{{agentName}}` | Agent name | `MIKE-TEST` |
| `{{status}}` | Current status | `critical` / `ok` |
| `{{type}}` | Event type | `alert` / `recovery` |
| `{{emoji}}` | Auto emoji | 🚨 (alert) / ✅ (recovery) |
| `{{statusEmoji}}` | Status dot | 🔴 (down) / 🟢 (up) |
| `{{color}}` | Discord integer color | `16729344` / `5763719` |
| `{{colorHex}}` | Hex color | `#FF6B00` / `#57F287` |
| `{{timestamp}}` | ISO timestamp | `2026-03-05T01:23:35.586Z` |

> **Tip:** `{{emoji}}`, `{{color}}`, and `{{colorHex}}` automatically switch between alert (red/orange) and recovery (green) values — one template handles both directions.

---

## Slack

Uses [Slack Block Kit](https://api.slack.com/block-kit) with a colored sidebar via `attachments`.

```json
{
  "attachments": [{
    "color": "{{colorHex}}",
    "blocks": [
      {
        "type": "section",
        "text": {
          "type": "mrkdwn",
          "text": "{{emoji}} *{{title}}*\n{{body}}"
        }
      },
      { "type": "divider" },
      {
        "type": "section",
        "fields": [
          { "type": "mrkdwn", "text": "🖥️ *Agent*\n`{{agentName}}`" },
          { "type": "mrkdwn", "text": "🔍 *Check*\n`{{checkName}}`" },
          { "type": "mrkdwn", "text": "{{statusEmoji}} *Status*\n`{{status}}`" },
          { "type": "mrkdwn", "text": "🕐 *Time*\n`{{timestamp}}`" }
        ]
      },
      {
        "type": "context",
        "elements": [
          { "type": "mrkdwn", "text": "⚡ *Vigil Monitor* — automated alert" }
        ]
      }
    ]
  }]
}
```

---

## Microsoft Teams

Uses [Adaptive Cards v1.4](https://adaptivecards.io) with a two-column layout and an action button.

```json
{
  "type": "message",
  "attachments": [{
    "contentType": "application/vnd.microsoft.card.adaptive",
    "content": {
      "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
      "type": "AdaptiveCard",
      "version": "1.4",
      "body": [
        {
          "type": "ColumnSet",
          "columns": [
            {
              "type": "Column",
              "width": "auto",
              "style": "emphasis",
              "bleed": true,
              "items": [{
                "type": "TextBlock",
                "text": "{{emoji}}",
                "size": "ExtraLarge",
                "horizontalAlignment": "Center"
              }]
            },
            {
              "type": "Column",
              "width": "stretch",
              "items": [
                {
                  "type": "TextBlock",
                  "text": "{{title}}",
                  "weight": "Bolder",
                  "size": "Medium",
                  "wrap": true
                },
                {
                  "type": "TextBlock",
                  "text": "{{body}}",
                  "isSubtle": true,
                  "wrap": true,
                  "spacing": "Small"
                }
              ]
            }
          ]
        },
        {
          "type": "FactSet",
          "separator": true,
          "spacing": "Medium",
          "facts": [
            { "title": "🖥️  Agent", "value": "{{agentName}}" },
            { "title": "🔍  Check", "value": "{{checkName}}" },
            { "title": "{{statusEmoji}}  Status", "value": "{{status}}" },
            { "title": "🕐  Time", "value": "{{timestamp}}" }
          ]
        }
      ],
      "actions": [{
        "type": "Action.OpenUrl",
        "title": "Open Vigil Dashboard →",
        "url": "http://192.168.9.113:3000",
        "style": "positive"
      }]
    }
  }]
}
```

---

## Discord

Uses Discord [Embeds](https://discord.com/developers/docs/resources/message#embed-object) with author, thumbnail, color stripe, and timestamp.

> **Note:** `{{color}}` is substituted as a plain integer (e.g. `16729344`) — do not wrap it in quotes in the JSON.

```json
{
  "username": "Vigil Monitor",
  "avatar_url": "https://cdn-icons-png.flaticon.com/512/2913/2913465.png",
  "embeds": [{
    "author": {
      "name": "⚡ Vigil Monitor",
      "url": "http://192.168.9.113:3000",
      "icon_url": "https://cdn-icons-png.flaticon.com/512/2913/2913465.png"
    },
    "title": "{{emoji}}  {{title}}",
    "description": "```{{body}}```",
    "color": {{color}},
    "fields": [
      { "name": "🖥️  Agent",  "value": "`{{agentName}}`",  "inline": true },
      { "name": "🔍  Check",  "value": "`{{checkName}}`",  "inline": true },
      { "name": "{{statusEmoji}}  Status", "value": "`{{status}}`", "inline": true }
    ],
    "thumbnail": {
      "url": "https://cdn-icons-png.flaticon.com/512/1828/1828884.png"
    },
    "footer": {
      "text": "⚡ Vigil Monitor  •  Automated Alert",
      "icon_url": "https://cdn-icons-png.flaticon.com/512/2913/2913465.png"
    },
    "timestamp": "{{timestamp}}"
  }]
}
```

---

## Telegram

Telegram uses **plain text** (not JSON) with [HTML formatting](https://core.telegram.org/bots/api#html-style). Supported tags: `<b>`, `<i>`, `<a href>`, `<code>`, `<pre>`.

> **Note:** Vigil automatically HTML-escapes variable values (`&`, `<`, `>`) before rendering — safe to use HTML tags in the template.

```
{{emoji}} <b>{{title}}</b>

{{body}}

🖥 <b>Agent:</b> {{agentName}}
🔍 <b>Check:</b> {{checkName}}
{{statusEmoji}} <b>Status:</b> {{status}}
🕐 <b>Time:</b> {{timestamp}}

<a href="http://192.168.9.113:3000">🔗 Open Vigil Dashboard</a>

⚡ <i>Vigil Monitor</i>
```

---

## Generic Webhook

Sends a structured JSON payload. Compatible with Zapier, n8n, Power Automate, and any custom webhook receiver.

```json
{
  "source": "vigil-monitor",
  "version": "1.0",
  "event": {
    "type": "{{type}}",
    "emoji": "{{emoji}}",
    "title": "{{title}}",
    "message": "{{body}}"
  },
  "target": {
    "agent": "{{agentName}}",
    "check": "{{checkName}}",
    "status": "{{status}}",
    "statusEmoji": "{{statusEmoji}}"
  },
  "meta": {
    "timestamp": "{{timestamp}}",
    "color": "{{colorHex}}",
    "dashboard": "http://192.168.9.113:3000"
  }
}
```

---

## Email (SMTP)

Email uses a **built-in HTML template** — no custom payload needed. It automatically renders a color-coded email (🔴 red for down, 🟢 green for recovery) with a details table and **Open Vigil Dashboard** button.

To enable:
1. Go to **Settings → SMTP**
2. Fill in Host, Port, From Address
3. Set **Alert Recipients** (comma-separated)
4. Check **Enable email alerts**
5. Click **Save**

---

## How Custom Payloads Work

1. Template string is stored in the channel's config
2. On alert fire or recovery, Vigil substitutes all `{{variable}}` tokens
3. For JSON channels (Slack, Teams, Discord, Webhook): result is parsed as JSON and sent as the request body
4. For Telegram: result is sent as the message text with `parse_mode: HTML`
5. If the template is blank → built-in default payload is used
6. If the template contains invalid JSON after substitution → falls back to default and logs a warning
