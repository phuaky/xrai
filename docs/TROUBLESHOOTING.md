# Troubleshooting

## Extension stops working after reboot (HTTP 403 from Ollama)

### Symptom

Console shows:
```
[xrai] Ollama running but classify POST failed (HTTP 403). Pre-filter only.
```

### Cause

Ollama rejects requests from origins it doesn't recognize. Chrome extension
requests come from `chrome-extension://<id>`, so Ollama returns **403** unless
the origin is whitelisted via the `OLLAMA_ORIGINS` environment variable.

When you set the var in a terminal shell, it works — but after a reboot,
macOS launches Ollama via its menu-bar app (a Login Item) which **does not
inherit shell env vars**, so `OLLAMA_ORIGINS` is unset → 403.

### Fix (macOS, persists across reboots)

**Step 1.** Remove Ollama from Login Items
System Settings → General → Login Items & Extensions → remove **Ollama**.

**Step 2.** Install a LaunchAgent that sets the env vars, then launches Ollama.

Create `~/Library/LaunchAgents/com.ollama.env.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.ollama.env</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>launchctl setenv OLLAMA_ORIGINS "chrome-extension://*"; launchctl setenv OLLAMA_HOST "127.0.0.1:11434"; sleep 2; open -a Ollama</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/ollama-env.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/ollama-env.err</string>
</dict>
</plist>
```

**Step 3.** Load it:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.ollama.env.plist
```

### Verify

After reboot (or right away, by quitting Ollama and running
`launchctl kickstart -k gui/$(id -u)/com.ollama.env`):

```bash
# Should print: chrome-extension://*
launchctl getenv OLLAMA_ORIGINS

# Should print: HTTP 200
curl -s -o /dev/null -w "HTTP %{http_code}\n" \
  -H "Origin: chrome-extension://abcdef" \
  http://localhost:11434/api/tags
```

### Uninstall

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.ollama.env.plist
rm ~/Library/LaunchAgents/com.ollama.env.plist
```
Then re-enable Ollama as a Login Item if desired.
