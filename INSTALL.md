# Install rai (~5 minutes)

rai filters your X feed and YouTube homepage with a small AI model that runs
**entirely on your machine**. No account, no cloud, no data leaves your laptop.

- **X**: hides engagement bait and noise, keeps tech/AI/startup signal
- **YouTube**: blurs everything except music (and optionally motivational videos),
  plus a gentle Shorts doom-scroll nudge

## What you need

- A Mac (Apple Silicon is fastest; Intel works with a smaller model)
- Google Chrome
- ~2 GB of disk for the AI model

## Steps

**1. Get the code**

```bash
git clone https://github.com/phuaky/xrai.git && cd xrai
```

(or Download ZIP from GitHub and unzip)

**2. Run setup**

```bash
bash scripts/setup.sh
```

This installs/starts [Ollama](https://ollama.com) (the local AI runtime),
downloads the model, fixes the one permission Chrome extensions need, and runs
a real classification to prove everything works. Re-run it any time something
seems broken — it only fixes what's missing.

**3. Load the extension in Chrome**

1. Open `chrome://extensions`
2. Turn ON **Developer mode** (top-right toggle)
3. Click **Load unpacked** → select the `extension/` folder from step 1

**4. Open [x.com](https://x.com)**

A small **rai pill** appears bottom-right showing shown/hidden counts.

- Blurred cards = filtered noise. **👁 Show** peeks under the blur.
- **✗** on any card = "you got this one wrong" — it flips the card *and*
  records the correction so the filter can be improved from real mistakes.
- **⚙** on the pill = settings (model, confidence threshold, hide style).

**5. Optional: open [youtube.com](https://youtube.com)**

Home grid blurs everything that isn't music. Same pill, same ⚙, plus Shorts
limits.

## If something's off

- **Pill is red / says offline** → Ollama isn't running or is blocking the
  extension. Run `bash scripts/setup.sh` again.
- **Broke after a reboot** → the known Ollama 403 issue;
  [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) (setup offers the
  permanent fix).
- **Everything gets blurred / feels wrong on non-Apple-Silicon** → click ⚙ and
  make sure the model is one you actually have (setup prints the right one).

## Privacy / ToS

Everything is local: the model runs on your machine, classifications are stored
in your browser, nothing is sent anywhere. The extension never posts, likes,
follows, or calls X/YouTube APIs — it only reads what's already on your screen
and hides/blurs with CSS.
