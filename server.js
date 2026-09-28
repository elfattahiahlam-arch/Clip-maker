const express = require("express");
const { execFile } = require("child_process");
const { promisify } = require("util");
const fs = require("fs/promises");
const path = require("path");
const os = require("os");

const run = promisify(execFile);
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const MAX_SECONDS = 180;
let busy = false;

function isYouTube(value) {
  try {
    const host = new URL(value).hostname.replace(/^(www|m)\./, "");
    return host === "youtube.com" || host === "youtu.be";
  } catch {
    return false;
  }
}

function hms(total) {
  const t = Math.floor(total);
  const h = String(Math.floor(t / 3600)).padStart(2, "0");
  const m = String(Math.floor((t % 3600) / 60)).padStart(2, "0");
  const s = String(t % 60).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

app.post("/api/clip", async (req, res) => {
  const { url, start, end, vertical } = req.body || {};
  const s = Number(start);
  const e = Number(end);

  if (!isYouTube(url)) {
    return res.status(400).json({ error: "Paste a YouTube link." });
  }
  if (!Number.isFinite(s) || !Number.isFinite(e) || s < 0 || e <= s) {
    return res.status(400).json({ error: "The end time must be after the start time." });
  }
  if (e - s > MAX_SECONDS) {
    return res.status(400).json({ error: `Clips can be up to ${MAX_SECONDS} seconds.` });
  }
  if (busy) {
    return res.status(429).json({ error: "Another clip is being made. Try again in a minute." });
  }

  busy = true;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clip-"));

  try {
    const raw = path.join(dir, "raw.mp4");

    await run(
      "yt-dlp",
      [
        "--no-playlist",
        "--js-runtimes", "node",
        "--download-sections", `*${hms(s)}-${hms(e)}`,
        "--force-keyframes-at-cuts",
        "-f", "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b",
        "--merge-output-format", "mp4",
        "-o", raw,
        url,
      ],
      { timeout: 180000 }
    );

    let output = raw;
    if (vertical) {
      output = path.join(dir, "vertical.mp4");
      await run(
        "ffmpeg",
        ["-y", "-i", raw, "-vf", "crop=ih*9/16:ih,scale=1080:1920", "-c:a", "copy", output],
        { timeout: 180000 }
      );
    }

    const file = await fs.readFile(output);
    res.set({
      "Content-Type": "video/mp4",
      "Content-Disposition": 'attachment; filename="clip.mp4"',
    });
    res.send(file);
  } catch (err) {
    console.error(err.stderr || err.message);
    res.status(500).json({
      error: "Couldn't make this clip. The link may be private, or YouTube may be blocking this server.",
    });
  } finally {
    busy = false;
    fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

const port = process.env.PORT || 3000;
app.listen(port, "0.0.0.0", () => console.log(`Listening on ${port}`));
