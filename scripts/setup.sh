#!/usr/bin/env bash
# rai setup — gets a fresh machine from zero to a working local AI feed filter.
# Safe to re-run any time; it only fixes what's broken.
#
#   bash scripts/setup.sh
#
# What it does:
#   1. Checks Ollama is installed (offers Homebrew install if not)
#   2. Checks the Ollama server is running (helps you start it)
#   3. Fixes the Chrome-extension CORS block (OLLAMA_ORIGINS), incl. a
#      persistent fix that survives reboots (see docs/TROUBLESHOOTING.md)
#   4. Downloads the right AI model for your machine
#   5. Runs one real classification end-to-end to prove it works

set -u

OLLAMA_URL="http://localhost:11434"
ORIGIN_HEADER="Origin: chrome-extension://rai-setup-check"
X_MODEL_APPLE="dhiltgen/gemma4:e2b-mlx-bf16"   # extension default (Apple Silicon, MLX)
X_MODEL_FALLBACK="gemma2:2b"                    # small, runs anywhere
YT_MODEL="gemma2:2b"
PLIST="$HOME/Library/LaunchAgents/com.ollama.env.plist"

BOLD=$(tput bold 2>/dev/null || true); RESET=$(tput sgr0 2>/dev/null || true)
ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; }
fail() { printf "  \033[31m✗\033[0m %s\n" "$1"; }
warn() { printf "  \033[33m!\033[0m %s\n" "$1"; }
step() { printf "\n%s%s%s\n" "$BOLD" "$1" "$RESET"; }

confirm() { # confirm "question" -> 0 yes / 1 no
  printf "  %s [y/N] " "$1"
  read -r reply
  [ "$reply" = "y" ] || [ "$reply" = "Y" ]
}

server_up() { curl -s --max-time 3 "$OLLAMA_URL/api/tags" >/dev/null 2>&1; }

origin_status() { # HTTP code Ollama gives a chrome-extension origin
  curl -s -o /dev/null -w "%{http_code}" --max-time 5 -H "$ORIGIN_HEADER" "$OLLAMA_URL/api/tags" 2>/dev/null
}

echo "${BOLD}rai setup — local AI feed filter for X + YouTube${RESET}"
echo "Everything runs on this machine. No data ever leaves it."

# ── 1. Ollama installed ─────────────────────────────────────────────
step "1/5 Ollama installed"
if command -v ollama >/dev/null 2>&1 || [ -d "/Applications/Ollama.app" ]; then
  ok "Ollama found"
else
  fail "Ollama is not installed"
  if command -v brew >/dev/null 2>&1 && confirm "Install it now with Homebrew (brew install --cask ollama)?"; then
    brew install --cask ollama || { fail "Homebrew install failed"; exit 1; }
    ok "Ollama installed"
  else
    echo "  Install it from https://ollama.com/download then re-run this script."
    exit 1
  fi
fi

# ── 2. Server running ───────────────────────────────────────────────
step "2/5 Ollama server running"
if server_up; then
  ok "Server responding on $OLLAMA_URL"
else
  warn "Server not responding — trying to start it"
  if [ -d "/Applications/Ollama.app" ]; then
    open -a Ollama
  elif command -v ollama >/dev/null 2>&1; then
    nohup ollama serve >/tmp/ollama-serve.log 2>&1 &
  fi
  for _ in $(seq 1 15); do server_up && break; sleep 2; done
  if server_up; then
    ok "Server started"
  else
    fail "Could not start the Ollama server. Start it manually (open the Ollama app or run 'ollama serve'), then re-run this script."
    exit 1
  fi
fi

# ── 3. Chrome extension access (CORS / OLLAMA_ORIGINS) ──────────────
step "3/5 Chrome extension access"
code=$(origin_status)
if [ "$code" = "200" ]; then
  ok "Ollama accepts chrome-extension origins"
else
  warn "Ollama rejects extension requests (HTTP $code) — fixing OLLAMA_ORIGINS"
  if [ "$(uname -s)" = "Darwin" ]; then
    launchctl setenv OLLAMA_ORIGINS "chrome-extension://*"
    if [ -d "/Applications/Ollama.app" ]; then
      osascript -e 'quit app "Ollama"' >/dev/null 2>&1
      sleep 2
      open -a Ollama
      for _ in $(seq 1 15); do server_up && break; sleep 2; done
    else
      warn "You run 'ollama serve' yourself — restart it with the env var:"
      echo "      OLLAMA_ORIGINS=\"chrome-extension://*\" ollama serve"
      printf "  Press enter once you've restarted it..."
      read -r _
    fi
    code=$(origin_status)
    if [ "$code" = "200" ]; then
      ok "Fixed for this session"
      # Persistent fix — survives reboots (docs/TROUBLESHOOTING.md)
      if [ -d "/Applications/Ollama.app" ] && [ ! -f "$PLIST" ]; then
        if confirm "Make this permanent (a LaunchAgent so it survives reboots)?"; then
          cat > "$PLIST" <<'EOF'
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
EOF
          launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || true
          ok "LaunchAgent installed ($PLIST)"
          warn "One manual step: System Settings → Login Items → remove Ollama (the LaunchAgent starts it instead)"
        else
          warn "Skipped — after a reboot you may hit HTTP 403 again (fix: docs/TROUBLESHOOTING.md)"
        fi
      fi
    else
      fail "Still blocked (HTTP $code). See docs/TROUBLESHOOTING.md, then re-run."
      exit 1
    fi
  else
    fail "Non-macOS: set OLLAMA_ORIGINS=\"chrome-extension://*\" in the environment that starts Ollama, then re-run."
    exit 1
  fi
fi

# ── 4. Models ───────────────────────────────────────────────────────
step "4/5 AI models"
have_model() { curl -s "$OLLAMA_URL/api/tags" | grep -q "\"$1\""; }

if [ "$(uname -s)" = "Darwin" ] && [ "$(uname -m)" = "arm64" ]; then
  X_MODEL="$X_MODEL_APPLE"
else
  X_MODEL="$X_MODEL_FALLBACK"
  warn "Not Apple Silicon — using $X_MODEL for X too."
  warn "After install: on x.com click the ⚙ on the rai pill and select $X_MODEL as the model."
fi

for m in "$X_MODEL" "$YT_MODEL"; do
  if have_model "$m"; then
    ok "$m already downloaded"
  else
    echo "  Downloading $m (one-time, ~1-2 GB)..."
    if ollama pull "$m"; then ok "$m ready"; else fail "Pull failed for $m"; exit 1; fi
  fi
done

# ── 5. End-to-end proof ─────────────────────────────────────────────
step "5/5 Live classification test"
resp=$(curl -s --max-time 60 -H "$ORIGIN_HEADER" "$OLLAMA_URL/api/chat" -d "{
  \"model\": \"$X_MODEL\",
  \"messages\": [
    {\"role\":\"system\",\"content\":\"You classify tweets as signal or noise. Output ONLY valid JSON: {\\\"prediction\\\":\\\"signal\\\"|\\\"noise\\\",\\\"confidence\\\":0.6-0.95}\"},
    {\"role\":\"user\",\"content\":\"Tweet: \\\"You won't believe what happened next 🤯\\\"\"}
  ],
  \"stream\": false, \"think\": false, \"options\": {\"temperature\": 0.1, \"num_predict\": 60}
}" 2>/dev/null)

if echo "$resp" | grep -q '"prediction"'; then
  verdict=$(echo "$resp" | python3 -c "import json,sys,re; m=re.search(r'\{[^{}]*\"prediction\"[^{}]*\}', json.load(sys.stdin)['message']['content']); print(m.group(0) if m else 'parsed')" 2>/dev/null || echo "classified")
  ok "Model classified a test tweet: $verdict"
else
  fail "Classification test failed. Response: $(echo "$resp" | head -c 200)"
  exit 1
fi

echo ""
echo "${BOLD}✓ All good. Last step — load the extension in Chrome:${RESET}"
echo "   1. Open chrome://extensions"
echo "   2. Turn ON 'Developer mode' (top right)"
echo "   3. Click 'Load unpacked' and select the ${BOLD}extension/${RESET} folder in this repo"
echo "   4. Open https://x.com — the rai pill appears bottom-right"
echo ""
echo "Blurred cards = filtered noise. 👁 to peek, ✗ to tell it it was wrong."
