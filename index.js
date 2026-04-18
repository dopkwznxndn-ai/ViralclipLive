require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const ffmpegBin = require('ffmpeg-static');
const ffmpeg = require('fluent-ffmpeg');
const multer = require('multer');
const admin = require('firebase-admin');
const { getFaceTrackFractions, buildCropXExpression } = require('./facetrack');

ffmpeg.setFfmpegPath(ffmpegBin);

// ─── Firebase Admin init (only once, guarded) ──────────────────────────────
if (!admin.apps.length) {
  const serviceAccountRaw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (serviceAccountRaw) {
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(serviceAccountRaw)),
    });
  } else {
    console.warn('⚠️  FIREBASE_SERVICE_ACCOUNT env var not set — Firestore tier checks will default to free_permanent');
  }
}

// ─── Multer: accept a single video field "video", store in /tmp ─────────────
const upload = multer({
  dest: '/tmp/',
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB cap
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('video/')) return cb(null, true);
    cb(new Error('Only video files are accepted'));
  },
});

const execAsync = promisify(exec);
const ytDlpBin  = path.join(__dirname, 'yt-dlp');
const app = express();

// ─── Crash guards (top-level, registered before anything else) ─────────────
process.on('uncaughtException',  err => console.error('⚠️  Uncaught exception (server stays alive):', err.message));
process.on('unhandledRejection', err => console.error('⚠️  Unhandled rejection (server stays alive):', err));

app.use(cors());
app.use(express.static('public'));
app.use('/outputs', express.static(path.join(__dirname, 'outputs')));
app.use(express.json());

app.get('/', (req, res) => res.redirect('/dashboard.html'));

// ─── Helpers ───────────────────────────────────────────────────────────────

async function waitForTranscript(transcriptId) {
  const url = `https://api.assemblyai.com/v2/transcript/${transcriptId}`;
  const headers = { authorization: process.env.ASSEMBLY_API_KEY };
  while (true) {
    const { data } = await axios.get(url, { headers });
    if (data.status === 'completed') return {
      text: data.text,
      words: data.words,
      auto_highlights_result: data.auto_highlights_result,
    };
    if (data.status === 'error') throw new Error(`AssemblyAI error: ${data.error}`);
    console.log(`  ⏳ Status: ${data.status} — waiting 5s...`);
    await new Promise(r => setTimeout(r, 5000));
  }
}

// Strip any non-ASCII / non-Latin characters from caption text.
// Safety net in case AssemblyAI returns unexpected script despite language_code:'en'.
// Keeps letters, digits, punctuation, spaces. Collapses multiple spaces. Returns null if nothing left.
function sanitizeCaptionText(raw) {
  if (!raw) return null;
  // Remove anything that isn't a basic printable ASCII character (0x20–0x7E)
  const cleaned = raw.replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, ' ').trim();
  return cleaned.length > 0 ? cleaned : null;
}

// ASS timestamp: H:MM:SS.cs (centiseconds)
function ms2ass(ms) {
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  const h  = Math.floor(ms / 3600000);
  const m  = Math.floor((ms % 3600000) / 60000);
  const s  = Math.floor((ms % 60000) / 1000);
  const cs = Math.floor((ms % 1000) / 10);
  return `${h}:${pad(m)}:${pad(s)}.${pad(cs)}`;
}

const ASS_HEADER = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,BebasNeue,80,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,4,0,2,10,10,60,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

// One word per ASS dialogue block — Zack D. Films style, bottom-center locked
function generateMicroASS(words) {
  let events = '';
  words.forEach(w => {
    const safe = sanitizeCaptionText(w.text);
    if (!safe) return; // skip words that are entirely non-ASCII
    events += `Dialogue: 0,${ms2ass(w.start)},${ms2ass(w.end)},Default,,0,0,0,,${safe.toUpperCase()}\n`;
  });
  return ASS_HEADER + events;
}

// Generate a one-word-per-block ASS file relative to a clip's start time
function generateClipASS(words, startMs, endMs) {
  const clipWords = words
    .filter(w => w.start >= startMs && w.end <= endMs)
    .map(w => ({ ...w, start: w.start - startMs, end: w.end - startMs }));
  return generateMicroASS(clipWords);
}

// ─── Watermark helper + Main Route ─────────────────────────────────────────
const FREE_PLANS    = new Set(['free', 'free_permanent']);
const WMARK_PNG     = path.join(__dirname, 'public', 'watermark.png');

function needsWatermark(plan) {
  return FREE_PLANS.has(plan);
}

// Resolution → FFmpeg scale dimensions (9:16 portrait)
const RESOLUTION_SCALE = {
  '360p':  '360:640',
  '720p':  '720:1280',
  '1080p': '1080:1920',
  '1440p': '1440:2560',
  '4k':    '2160:3840',
};

// Per-plan encoding quality settings
// Lower CRF = higher quality (visually lossless at 16)
// Preset: medium gives far better compression than superfast at same CRF
const ENCODE_QUALITY = {
  'free':             { crf: 26, preset: 'fast',   videoBitrate: '2000k',  audioBitrate: '128k' },
  'free_permanent':   { crf: 26, preset: 'fast',   videoBitrate: '2000k',  audioBitrate: '128k' },
  'creator':          { crf: 20, preset: 'medium', videoBitrate: '5000k',  audioBitrate: '192k' },
  '99rs_permanent':   { crf: 20, preset: 'medium', videoBitrate: '5000k',  audioBitrate: '192k' },
  'pro_studio':       { crf: 17, preset: 'medium', videoBitrate: '10000k', audioBitrate: '256k' },
  '199rs_permanent':  { crf: 17, preset: 'medium', videoBitrate: '10000k', audioBitrate: '256k' },
  'agency_elite':     { crf: 15, preset: 'slow',   videoBitrate: '20000k', audioBitrate: '320k' },
};

// Path to bundled fonts directory (fixes "tofu" caption rendering)
const FONT_DIR = path.join(__dirname, 'fonts');

app.post('/api/process-video', async (req, res) => {
  const originalUrl  = req.body.url;
  const userPlan     = (req.body.plan || 'free').trim();
  const rawRes       = (req.body.resolution || '360p').trim().toLowerCase();
  const scaleTarget  = RESOLUTION_SCALE[rawRes] || RESOLUTION_SCALE['360p'];
  const encQ         = ENCODE_QUALITY[userPlan] || ENCODE_QUALITY['free'];
  console.log(`🚀 Link received: ${originalUrl}  |  plan: ${userPlan}  |  resolution: ${rawRes} → scale ${scaleTarget}  |  crf: ${encQ.crf}  preset: ${encQ.preset}`);

  const id        = Date.now();
  const audioPath = `/tmp/audio_${id}.mp3`;
  const videoRaw  = `/tmp/video_raw_${id}.mp4`;
  const outputDir = path.join(__dirname, 'outputs');

  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const tmpFiles = [audioPath, videoRaw];
  const cleanup  = () => tmpFiles.forEach(f => {
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
  });

  try {
    // 1. Download audio only
    console.log('⬇️  Downloading audio...');
    await execAsync(
      `"${ytDlpBin}" -f "bestaudio/best" -x --audio-format mp3 --extractor-args "youtube:player_client=android,web" --no-check-certificate --no-playlist -o "/tmp/audio_${id}.%(ext)s" "${originalUrl}"`,
      { timeout: 120000 }
    );

    // 2. Upload audio to AssemblyAI
    console.log('⬆️  Uploading audio to AssemblyAI...');
    const audioData = fs.readFileSync(audioPath);
    const { data: uploadData } = await axios.post(
      'https://api.assemblyai.com/v2/upload',
      audioData,
      {
        headers: {
          authorization: process.env.ASSEMBLY_API_KEY,
          'Content-Type': 'application/octet-stream',
        },
        maxBodyLength: Infinity,
      }
    );

    // 3. Submit transcription job with auto_highlights
    // Force language_code:'en' so AssemblyAI always outputs Latin-alphabet text.
    // For non-English audio this gives phonetic English — still readable, no tofu boxes.
    console.log('🎙️  Submitting transcription job (forced English alphabet output)...');
    const { data: transcriptData } = await axios.post(
      'https://api.assemblyai.com/v2/transcript',
      {
        audio_url:       uploadData.upload_url,
        speech_models:   ['universal-2'],
        language_code:   'en',
        auto_highlights: true,
      },
      { headers: { authorization: process.env.ASSEMBLY_API_KEY } }
    );
    console.log('📝 Transcript ID:', transcriptData.id);

    // 4. Poll until complete
    console.log('⏳ Waiting for transcription...');
    const { words, auto_highlights_result } = await waitForTranscript(transcriptData.id);
    console.log(`✅ Transcription done — ${(words || []).length} words`);

    // 5. Pick top 5 unique highlights (sorted by rank, deduplicated within 30s)
    console.log('Raw AI Response:', JSON.stringify(auto_highlights_result));

    const top5 = [];

    try {
      let rawResult = auto_highlights_result;
      if (typeof rawResult === 'string') {
        rawResult = rawResult.replace(/```json|```/g, '').trim();
        rawResult = JSON.parse(rawResult);
      }

      const allHighlights = (rawResult && rawResult.results) || [];
      allHighlights.sort((a, b) => b.rank - a.rank);

      for (const h of allHighlights) {
        const rawStartSec = h.timestamps[0].start / 1000;
        const paddedStart = Math.max(0, rawStartSec - 15);
        const tooClose = top5.some(s => Math.abs(s.paddedStart - paddedStart) < 30);
        if (tooClose) continue;
        top5.push({ text: sanitizeCaptionText(h.text) || h.text, rank: h.rank, start: h.timestamps[0].start, end: h.timestamps[0].end, paddedStart });
        if (top5.length === 5) break;
      }
    } catch (parseErr) {
      console.warn('⚠️  Failed to parse highlights JSON:', parseErr.message);
    }

    // Fallback 1: if no highlights, slice video into evenly-spaced segments using word timestamps
    if (top5.length === 0 && words && words.length > 0) {
      console.log('⚠️  No highlights — falling back to evenly-spaced clips');
      const totalMs   = words[words.length - 1].end;
      const segmentMs = totalMs / 5;
      for (let i = 0; i < 5; i++) {
        const startMs     = i * segmentMs;
        const paddedStart = Math.max(0, startMs / 1000 - 15);
        top5.push({ text: `Segment ${i + 1}`, rank: 0, start: startMs, end: startMs + 1000, paddedStart });
      }
    }

    // Fallback 2 (bulletproof): if everything above failed, generate one clip at 0–30s
    if (top5.length === 0) {
      console.warn('⚠️  All highlight methods failed — using default 0–30s fallback clip');
      top5.push({ text: 'Highlight', rank: 0, start: 0, end: 30000, paddedStart: 0 });
    }

    console.log(`🏆 ${top5.length} clips selected`);

    // 6. Download the full video once
    console.log('⬇️  Downloading video...');
    await execAsync(
      `"${ytDlpBin}" -f "bestvideo[height<=4320][ext=mp4]+bestaudio[ext=m4a]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best" --format-sort "res,fps,vcodec:vp9.2,vcodec:vp9,vcodec:h265,vcodec:h264,filesize" --extractor-args "youtube:player_client=android,web" --no-check-certificate --no-playlist --merge-output-format mp4 -o "${videoRaw}" "${originalUrl}"`,
      { timeout: 300000 }
    );

    // Verify source video actually downloaded
    if (!fs.existsSync(videoRaw) || fs.statSync(videoRaw).size === 0) {
      throw new Error('Source video missing! yt-dlp failed.');
    }
    console.log(`✅ Source video confirmed: ${videoRaw} (${fs.statSync(videoRaw).size} bytes)`);

    // 7. Render one face-tracked 30-second clip per highlight
    const clips       = [];
    const CLIP_DURATION = 30;

    for (let i = 0; i < top5.length; i++) {
      const hl          = top5[i];
      const clipAssPath = `/tmp/captions_${id}_${i}.ass`;
      const clipOutPath = path.join(outputDir, `clip_${id}_${i}.mp4`);
      const fallbackOutPath = path.join(outputDir, `clip_${id}_${i}_fallback.mp4`);

      tmpFiles.push(clipAssPath);

      const start    = hl.paddedStart;
      const end      = start + CLIP_DURATION;
      const duration = CLIP_DURATION;

      // Generate one-word-per-block ASS captions for this clip window
      const clipAss = generateClipASS(words || [], start * 1000, (start + duration) * 1000);
      fs.writeFileSync(clipAssPath, clipAss);

      const assHasDialogue = clipAss.includes('Dialogue:');
      const applyWmark     = needsWatermark(userPlan);

      if (!assHasDialogue) console.warn(`  ⚠️  No words for clip ${i + 1} — rendering without captions`);
      if (applyWmark)      console.log(`  🔒 Watermark overlay will be burned in (plan: ${userPlan})`);

      // ── Build FFmpeg command ────────────────────────────────────────────────
      // The ffmpeg-static binary does NOT support the drawtext filter.
      // Watermark is applied via -filter_complex with the PNG as a 2nd input.
      // Captions use the subtitles (libass) filter — always works in this build.

      let mainCmd;

      if (applyWmark) {
        // Two video inputs: [0] the raw clip, [1] watermark.png
        // filter_complex chains:
        //   Step 1 — crop to 9:16 + scale   → [base]
        //   Step 2 — burn captions (if any)  → [capped]
        //   Step 3 — overlay watermark PNG   → [out]
        const captionStep = assHasDialogue
          ? `[base]subtitles='${clipAssPath.replace(/\\/g, '/')}':fontsdir='${FONT_DIR.replace(/\\/g, '/')}'[capped];[capped]`
          : `[base]`;
        const filterComplex =
          `[0:v]crop=ih*9/16:ih,scale=${scaleTarget}:flags=lanczos[base];` +
          `${captionStep}[1:v]overlay=20:(H/2)-h-20[out]`;

        mainCmd = `"${ffmpegBin}" -ss ${start} -i "${videoRaw}" -i "${WMARK_PNG}" -t ${duration}` +
          ` -filter_complex "${filterComplex}"` +
          ` -map "[out]" -map 0:a?` +
          ` -c:v libx264 -preset ${encQ.preset} -crf ${encQ.crf} -b:v ${encQ.videoBitrate} -maxrate ${encQ.videoBitrate} -bufsize ${parseInt(encQ.videoBitrate) * 2}k -pix_fmt yuv420p -c:a aac -b:a ${encQ.audioBitrate} -movflags +faststart -y "${clipOutPath}"`;
      } else {
        // Paid user — simple -vf chain, no second input needed
        let vfParts = [`crop=ih*9/16:ih,scale=${scaleTarget}:flags=lanczos`];
        if (assHasDialogue) vfParts.push(`subtitles='${clipAssPath.replace(/\\/g, '/')}':fontsdir='${FONT_DIR.replace(/\\/g, '/')}'`);
        const vf = vfParts.join(',');

        mainCmd = `"${ffmpegBin}" -ss ${start} -i "${videoRaw}" -t ${duration}` +
          ` -vf "${vf}"` +
          ` -map 0:v -map 0:a?` +
          ` -c:v libx264 -preset ${encQ.preset} -crf ${encQ.crf} -b:v ${encQ.videoBitrate} -maxrate ${encQ.videoBitrate} -bufsize ${parseInt(encQ.videoBitrate) * 2}k -pix_fmt yuv420p -c:a aac -b:a ${encQ.audioBitrate} -movflags +faststart -y "${clipOutPath}"`;
      }

      console.log(`🎬 Rendering clip ${i + 1}/${top5.length} — start: ${start}s, duration: ${duration}s`);
      console.log('EXECUTING FFMPEG:', mainCmd);

      let usedPath = clipOutPath;
      try {
        await execAsync(mainCmd, { timeout: 600000 });
      } catch (ffErr) {
        console.error(`  ❌ FFmpeg error on clip ${i + 1}:`, ffErr.message);
        // Fallback: at minimum give them a cropped+scaled clip with no watermark/captions
        console.log(`  🔄 Triggering Plan B — crop-only fallback...`);
        const fallbackVf  = assHasDialogue
          ? `crop=ih*9/16:ih,scale=${scaleTarget}:flags=lanczos,subtitles='${clipAssPath.replace(/\\/g, '/')}':fontsdir='${FONT_DIR.replace(/\\/g, '/')}'`
          : `crop=ih*9/16:ih,scale=${scaleTarget}:flags=lanczos`;
        const fallbackCmd = `"${ffmpegBin}" -ss ${start} -i "${videoRaw}" -t ${duration}` +
          ` -vf "${fallbackVf}" -map 0:v -map 0:a?` +
          ` -c:v libx264 -preset fast -crf ${encQ.crf + 3} -b:v ${encQ.videoBitrate} -pix_fmt yuv420p -c:a aac -b:a ${encQ.audioBitrate} -y "${fallbackOutPath}"`;
        console.log('EXECUTING FFMPEG (FALLBACK):', fallbackCmd);
        try {
          await execAsync(fallbackCmd, { timeout: 300000 });
          usedPath = fallbackOutPath;
        } catch (fallbackErr) {
          console.error(`  ❌ Fallback FFmpeg also failed on clip ${i + 1}:`, fallbackErr.message, '— skipping this clip');
          continue;
        }
      }

      // Only include this clip if the file was actually written
      if (fs.existsSync(usedPath) && fs.statSync(usedPath).size > 0) {
        const fileSizeBytes = fs.statSync(usedPath).size;
        const isFallback = usedPath === fallbackOutPath;
        const clipFilename = isFallback ? `clip_${id}_${i}_fallback.mp4` : `clip_${id}_${i}.mp4`;
        if (isFallback) console.log(`  ✅ Fallback clip saved: ${clipFilename}`);
        const resLabel = isFallback ? 'Fallback' : rawRes === '4k' ? '4K Ultra HD' : rawRes.toUpperCase();
        clips.push({
          clipUrl:    `/outputs/${clipFilename}`,
          text:       hl.text,
          rank:       hl.rank,
          start:      hl.start,
          end:        hl.end,
          fileSize:   fileSizeBytes,
          resolution: resLabel,
        });
      } else {
        console.warn(`  ⚠️  Clip ${i + 1} file missing or empty — skipping`);
      }
    }

    cleanup();

    if (clips.length === 0) {
      return res.status(500).json({ status: 'error', message: 'Processing completed but no clip files were generated. Please try again.' });
    }

    console.log(`✅ ${clips.length} clips ready!`);
    res.json({
      status:       'success',
      transcriptId: transcriptData.id,
      clips,
      message:      `Your top ${clips.length} viral clips are ready!`,
    });

  } catch (err) {
    const msg = err.response ? JSON.stringify(err.response.data) : err.message;
    console.error('❌ Error:', msg);
    cleanup();
    res.status(500).json({ error: err.message });
  }
});

// ─── Download History Route ─────────────────────────────────────────────────

app.post('/api/download-history', (req, res) => {
  const { clipUrl } = req.body;
  if (!clipUrl) return res.status(400).json({ error: 'Missing clipUrl' });

  // Extract filename only — prevents any path traversal attempt
  const filename = path.basename(clipUrl);
  const filePath = path.join(__dirname, 'outputs', filename);

  if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) {
    return res.status(404).json({ error: 'Video file not found on server. It may have expired.' });
  }

  console.log(`⬇️  History download served: ${filename}`);
  res.download(filePath, filename);
});

// ─── Payment Notification Email ─────────────────────────────────────────────
const nodemailer = require('nodemailer');

app.post('/api/notify-payment', async (req, res) => {
  const { email, plan, amount, utr } = req.body;
  const gmailUser = process.env.GMAIL_USER || 'viralclipaistudio@gmail.com';
  const gmailPass = process.env.GMAIL_APP_PASS;

  if (!gmailPass) {
    console.warn('⚠️  GMAIL_APP_PASS not set — payment email notification skipped');
    return res.json({ status: 'skipped', message: 'Email not configured' });
  }

  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: gmailUser, pass: gmailPass },
    });

    await transporter.sendMail({
      from: `"ViralClip AI Payments" <${gmailUser}>`,
      to: gmailUser,
      subject: `💳 New Payment Request — ${plan} (₹${amount})`,
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;background:#0f0f18;color:#fff;border-radius:12px;overflow:hidden;">
          <div style="background:linear-gradient(135deg,#6366f1,#a855f7);padding:24px;text-align:center;">
            <h1 style="margin:0;font-size:22px;">💳 New Payment Request</h1>
          </div>
          <div style="padding:24px;">
            <table style="width:100%;border-collapse:collapse;">
              <tr><td style="padding:8px 0;color:#9ca3af;font-size:13px;">User Email</td><td style="padding:8px 0;font-weight:700;">${email}</td></tr>
              <tr><td style="padding:8px 0;color:#9ca3af;font-size:13px;">Plan</td><td style="padding:8px 0;font-weight:700;">${plan}</td></tr>
              <tr><td style="padding:8px 0;color:#9ca3af;font-size:13px;">Amount</td><td style="padding:8px 0;font-weight:700;color:#4ade80;">₹${amount}</td></tr>
              <tr><td style="padding:8px 0;color:#9ca3af;font-size:13px;">UTR / Txn ID</td><td style="padding:8px 0;font-family:monospace;color:#a5b4fc;">${utr}</td></tr>
            </table>
            <a href="https://${req.headers.host}/admin.html" style="display:block;margin-top:20px;background:linear-gradient(135deg,#6366f1,#a855f7);color:#fff;text-align:center;padding:12px;border-radius:8px;text-decoration:none;font-weight:700;">
              Open Admin Panel →
            </a>
          </div>
          <div style="padding:12px 24px;font-size:11px;color:#6b7280;text-align:center;">ViralClip AI · Auto-notification</div>
        </div>`,
    });

    console.log(`📧 Payment notification sent for ${email} — ${plan} ₹${amount}`);
    res.json({ status: 'sent' });
  } catch (err) {
    console.error('❌ Email send failed:', err.message);
    res.json({ status: 'error', message: err.message });
  }
});

// ─── Mock Payment Route (Testing Credits) ──────────────────────────────────

app.post('/api/add-credits', (req, res) => {
  const { amount = 10 } = req.body;
  console.log(`💳 Mock payment: adding ${amount} credits`);
  res.json({ status: 'success', creditsAdded: amount, message: `${amount} test credits granted!` });
});

// ─── Upload & Convert Route ─────────────────────────────────────────────────
// POST /api/upload-and-convert
// Form fields:
//   video  (file)   — the MP4 to process
//   userId (string) — Firestore document ID used to look up the user's plan
//
// Steps:
//   1. Receive uploaded MP4 via multer
//   2. Look up the user's plan in Firestore (users/{userId})
//   3. Build a single FFmpeg complex_filter:
//        - Crop to 9:16 portrait (cuts the sides, keeps centre)
//        - If plan === 'free_permanent': overlay watermark.png on top
//   4. Run the filter with fluent-ffmpeg, output a rendered MP4
//   5. Stream the file back to the client as a download, then clean up

const WATERMARK_PATH = path.join(__dirname, 'public', 'watermark.png');

async function getUserPlanFromFirestore(userId) {
  if (!userId) return 'free_permanent';
  try {
    if (!admin.apps.length) return 'free_permanent';
    const db  = admin.firestore();
    const doc = await db.collection('users').doc(userId).get();
    if (!doc.exists) {
      console.warn(`  ⚠️  Firestore: no user doc for "${userId}" — defaulting to free_permanent`);
      return 'free_permanent';
    }
    const plan = (doc.data().plan || 'free_permanent').trim();
    console.log(`  ✅ Firestore plan for ${userId}: ${plan}`);
    return plan;
  } catch (err) {
    console.error('  ❌ Firestore lookup failed:', err.message, '— defaulting to free_permanent');
    return 'free_permanent';
  }
}

app.post('/api/upload-and-convert', upload.single('video'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No video file received. Send a multipart/form-data POST with field "video".' });
  }

  const { userId } = req.body;
  const inputPath  = req.file.path;
  const outputPath = path.join(__dirname, 'outputs', `converted_${Date.now()}.mp4`);

  const outputDir = path.join(__dirname, 'outputs');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const cleanup = () => {
    try { if (fs.existsSync(inputPath))  fs.unlinkSync(inputPath);  } catch {}
    try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch {}
  };

  try {
    const plan        = await getUserPlanFromFirestore(userId);
    const applyWmark  = needsWatermark(plan);
    const ucEncQ      = ENCODE_QUALITY[plan] || ENCODE_QUALITY['free'];
    console.log(`🎬 upload-and-convert | userId: ${userId || '(none)'} | plan: ${plan} | watermark: ${applyWmark} | crf: ${ucEncQ.crf} preset: ${ucEncQ.preset}`);

    await new Promise((resolve, reject) => {
      let cmd = ffmpeg(inputPath);

      if (applyWmark) {
        // Two inputs: [0] uploaded video, [1] watermark PNG
        cmd = cmd.input(WATERMARK_PATH);

        // complex_filter:
        //   [0:v] crop to 9:16 portrait → [cropped]
        //   [cropped][1:v] overlay watermark centred at 15% from top → [out]
        cmd.complexFilter([
          {
            filter: 'crop',
            options: { w: 'ih*9/16', h: 'ih', x: '(iw-ih*9/16)/2', y: '0' },
            inputs:  ['0:v'],
            outputs: ['cropped'],
          },
          {
            filter: 'overlay',
            options: { x: '20', y: '(H/2)-h-20' },
            inputs:  ['cropped', '1:v'],
            outputs: ['out'],
          },
        ], 'out');
      } else {
        // Paid user — single-input complex_filter, crop only
        cmd.complexFilter([
          {
            filter: 'crop',
            options: { w: 'ih*9/16', h: 'ih', x: '(iw-ih*9/16)/2', y: '0' },
            inputs:  ['0:v'],
            outputs: ['out'],
          },
        ], 'out');
      }

      cmd
        .outputOptions([
          '-map [out]',
          '-map 0:a?',
          '-c:v libx264',
          `-preset ${ucEncQ.preset}`,
          `-crf ${ucEncQ.crf}`,
          `-b:v ${ucEncQ.videoBitrate}`,
          `-maxrate ${ucEncQ.videoBitrate}`,
          `-bufsize ${parseInt(ucEncQ.videoBitrate) * 2}k`,
          '-pix_fmt yuv420p',
          '-c:a aac',
          `-b:a ${ucEncQ.audioBitrate}`,
          '-movflags +faststart',
        ])
        .output(outputPath)
        .on('start', cmdLine => console.log('  FFmpeg cmd:', cmdLine))
        .on('stderr', line   => console.log('  [ffmpeg]', line))
        .on('end',    ()     => {
          console.log('  ✅ FFmpeg finished');
          resolve();
        })
        .on('error',  err    => {
          console.error('  ❌ FFmpeg error:', err.message);
          reject(err);
        })
        .run();
    });

    if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
      cleanup();
      return res.status(500).json({ error: 'FFmpeg produced no output. Check server logs.' });
    }

    const filename = path.basename(outputPath);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'video/mp4');

    const stream = fs.createReadStream(outputPath);
    stream.pipe(res);
    stream.on('close', () => {
      console.log(`  📦 Download complete: ${filename}`);
      cleanup();
    });
    stream.on('error', err => {
      console.error('  ❌ Stream error:', err.message);
      cleanup();
    });

  } catch (err) {
    console.error('❌ upload-and-convert failed:', err.message);
    cleanup();
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
});

// ─── Start ─────────────────────────────────────────────────────────────────
const { execSync } = require('child_process');
const PORT = process.env.PORT || 5000;

function startServer(attempt = 1) {
  if (attempt > 3) {
    console.error('❌ Could not bind port after 3 attempts — exiting.');
    process.exit(1);
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log('ViralClip AI Master Server is LIVE! Port:', PORT);
  });

  server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`⚠️  Port ${PORT} in use (attempt ${attempt}) — killing stale node and retrying...`);
      try { execSync('pkill -f "node index.js" || true'); } catch (_) {}
      setTimeout(() => startServer(attempt + 1), 1500);
    } else {
      console.error('Server error:', err);
    }
  });
}

startServer();
