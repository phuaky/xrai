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
    <string>launchctl setenv OLLAMA_ORIGINS "chrome-extension://*"; launchctl setenv OLLAMA_HOST "127.0.0.1:11434"; launchctl setenv OLLAMA_MAX_LOADED_MODELS "2"; sleep 2; OLLAMA_MAX_LOADED_MODELS=2 open -a Ollama --env OLLAMA_MAX_LOADED_MODELS=2</string>
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


## Ollama responds, but classification times out

rai uses a text model and an embedding model. With
`OLLAMA_MAX_LOADED_MODELS=1`, embedding requests can unload the text model.
The 30-minute keep-alive does not prevent this eviction.

Set the limit to two. On macOS:

```bash
launchctl setenv OLLAMA_MAX_LOADED_MODELS 2
```

Quit Ollama from its menu-bar menu, then relaunch it with an explicit override.
This also handles terminals that inherited the old value:

```bash
OLLAMA_MAX_LOADED_MODELS=2 open -a Ollama --env OLLAMA_MAX_LOADED_MODELS=2
```

For persistence, update `OLLAMA_MAX_LOADED_MODELS` to `2` in your existing
`~/Library/LaunchAgents/com.ollama.env.plist`. If it has no model-limit setting,
add it before the launch command using the template above. Reload the agent
when convenient, after quitting Ollama:

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.ollama.env.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.ollama.env.plist
```

On other systems, set `OLLAMA_MAX_LOADED_MODELS=2` in the service environment
that starts Ollama, then restart that service.

Verify the running server, not just the shell setting. After rai has made both
text and embedding requests, `ollama ps` should list both models. The latest
`server config` entry in `~/.ollama/logs/server.log` should show
`OLLAMA_MAX_LOADED_MODELS:2`.

On September 27, 2026, a 64 GB Mac with Ollama 0.34.4 passed alternating text,
embedding, and text probes in 0.472s, 0.264s, and 0.040s. Both
`dhiltgen/gemma4:e2b-mlx-bf16` and `all-minilm:latest` stayed loaded after the
embedding request and final text request. Before the restart, a direct text
probe timed out after 30 seconds. The restart and limit change were applied
together; this check does not isolate their individual effects.

The limit is global. It permits any two models, not only rai's pair. Two large
models can use substantially more memory than a classifier plus embeddings.
