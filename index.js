require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { exec, execSync } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const ffmpegBin = require('ffmpeg-static');
const ffmpeg = require('fluent-ffmpeg');
const multer = require('multer');
const admin = require('firebase-admin');

ffmpeg.setFfmpegPath(ffmpegBin);

if (!admin.apps.length) {
  const serviceAccountRaw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (serviceAccountRaw) {
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(serviceAccountRaw)),
    });
  }
}

const upload = multer({
  dest: '/tmp/',
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('video/')) return cb(null, true);
    cb(new Error('Only video files are accepted'));
  },
});

const execAsync = promisify(exec);
const ytDlpBin  = path.join(__dirname, 'yt-dlp');
const COOKIE_FILE = path.join(__dirname, 'cookies.txt');

try {
  console.log('🔄 Force-downloading the absolute latest yt-dlp binary from GitHub...');
  execSync(`curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o "${ytDlpBin}"`);
  fs.chmodSync(ytDlpBin, '755');
  console.log('✅ yt-dlp updated and permissions granted!');
} catch (e) {
  console.error('⚠️ Failed to setup yt-dlp:', e.message);
}

const app = express();

process.on('uncaughtException',  err => console.error('⚠️ Uncaught exception:', err.message));
process.on('unhandledRejection', err => console.error('⚠️ Unhandled rejection:', err));

app.use(cors());
app.use(express.static('public'));
app.use('/outputs', express.static(path.join(__dirname, 'outputs')));
app.use(express.json());

app.get('/', (req, res) => res.redirect('/dashboard.html'));

async function waitForTranscript(transcriptId) {
  const url = `https://api.assemblyai.com/v2/transcript/${transcriptId}`;
  const headers = { authorization: process.env.ASSEMBLY_AI_API_KEY };
  while (true) {
    const { data } = await axios.get(url, { headers });
    if (data.status === 'completed') return { text: data.text, words: data.words, auto_highlights_result: data.auto_highlights_result };
    if (data.status === 'error') throw new Error(`AssemblyAI error: ${data.error}`);
    await new Promise(r => setTimeout(r, 5000));
  }
}

function sanitizeCaptionText(raw) {
  if (!raw) return null;
  const cleaned = raw.replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, ' ').trim();
  return cleaned.length > 0 ? cleaned : null;
}

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
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;

function generateMicroASS(words) {
  let events = '';
  words.forEach(w => {
    const safe = sanitizeCaptionText(w.text);
    if (!safe) return;
    events += `Dialogue: 0,${ms2ass(w.start)},${ms2ass(w.end)},Default,,0,0,0,,${safe.toUpperCase()}\n`;
  });
  return ASS_HEADER + events;
}

function generateClipASS(words, startMs, endMs) {
  const clipWords = words.filter(w => w.start >= startMs && w.end <= endMs).map(w => ({ ...w, start: w.start - startMs, end: w.end - startMs }));
  return generateMicroASS(clipWords);
}

const FREE_PLANS = new Set(['free', 'free_permanent']);
const WMARK_PNG  = path.join(__dirname, 'public', 'watermark.png');

function needsWatermark(plan) { return FREE_PLANS.has(plan); }

const RESOLUTION_SCALE = {
  '360p': '360:640', '720p': '720:1280', '1080p': '1080:1920', '1440p': '1440:2560', '4k': '2160:3840',
};

const ENCODE_QUALITY = {
  'free':             { crf: 26, preset: 'fast',   videoBitrate: '2000k',  audioBitrate: '128k' },
  'free_permanent':   { crf: 26, preset: 'fast',   videoBitrate: '2000k',  audioBitrate: '128k' },
  'creator':          { crf: 20, preset: 'medium', videoBitrate: '5000k',  audioBitrate: '192k' },
  '99rs_permanent':   { crf: 20, preset: 'medium', videoBitrate: '5000k',  audioBitrate: '192k' },
  'pro_studio':       { crf: 17, preset: 'medium', videoBitrate: '10000k', audioBitrate: '256k' },
  '199rs_permanent':  { crf: 17, preset: 'medium', videoBitrate: '10000k', audioBitrate: '256k' },
  'agency_elite':     { crf: 15, preset: 'slow',   videoBitrate: '20000k', audioBitrate: '320k' },
};

const FONT_DIR = path.join(__dirname, 'fonts');

app.post('/api/process-video', async (req, res) => {
  const originalUrl  = req.body.url;
  const userPlan     = (req.body.plan || 'free').trim();
  const rawRes       = (req.body.resolution || '360p').trim().toLowerCase();
  const scaleTarget  = RESOLUTION_SCALE[rawRes] || RESOLUTION_SCALE['360p'];
  const encQ         = ENCODE_QUALITY[userPlan] || ENCODE_QUALITY['free'];

  const id        = Date.now();
  const audioPath = `/tmp/audio_${id}.mp3`;
  const videoRaw  = `/tmp/video_raw_${id}.mp4`;
  const outputDir = path.join(__dirname, 'outputs');

  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const tmpFiles = [audioPath, videoRaw];
  const cleanup  = () => tmpFiles.forEach(f => { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {} });

  try {
    const cookieArg = fs.existsSync(COOKIE_FILE) ? `--cookies "${COOKIE_FILE}"` : '';
    if (!cookieArg) console.log("⚠️ WARNING: cookies.txt not found! Downloads will likely be blocked by YouTube.");

    // Using Pure Web Client matching the Kiwi Browser cookies exactly
    console.log('⬇️ Executing Pure Cookie Audio Fetch...');
    await execAsync(`"${ytDlpBin}" --ffmpeg-location "${ffmpegBin}" ${cookieArg} --extractor-args "youtube:player_client=web" -f "bestaudio/best" -x --audio-format mp3 --no-check-certificate --no-playlist -o "/tmp/audio_${id}.%(ext)s" "${originalUrl}"`, { timeout: 120000 });
    
    console.log('⬆️ Uploading to AssemblyAI...');
    const audioData = fs.readFileSync(audioPath);
    const { data: uploadData } = await axios.post('https://api.assemblyai.com/v2/upload', audioData, {
      headers: { authorization: process.env.ASSEMBLY_AI_API_KEY, 'Content-Type': 'application/octet-stream' }, maxBodyLength: Infinity,
    });

    console.log('🎙️ Transcribing...');
    const { data: transcriptData } = await axios.post('https://api.assemblyai.com/v2/transcript', {
      audio_url: uploadData.upload_url, speech_models: ['universal-2'], language_code: 'en', auto_highlights: true,
    }, { headers: { authorization: process.env.ASSEMBLY_AI_API_KEY } });

    const { words, auto_highlights_result } = await waitForTranscript(transcriptData.id);
    const top5 = [];

    try {
      let rawResult = auto_highlights_result;
      if (typeof rawResult === 'string') rawResult = JSON.parse(rawResult.replace(/```json|```/g, '').trim());
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
    } catch (e) {}

    if (top5.length === 0 && words && words.length > 0) {
      const segmentMs = words[words.length - 1].end / 5;
      for (let i = 0; i < 5; i++) {
        const startMs = i * segmentMs;
        top5.push({ text: `Segment ${i + 1}`, rank: 0, start: startMs, end: startMs + 1000, paddedStart: Math.max(0, startMs / 1000 - 15) });
      }
    }

    if (top5.length === 0) top5.push({ text: 'Highlight', rank: 0, start: 0, end: 30000, paddedStart: 0 });

    console.log('⬇️ Executing Pure Cookie Video Fetch...');
    await execAsync(`"${ytDlpBin}" --ffmpeg-location "${ffmpegBin}" ${cookieArg} --extractor-args "youtube:player_client=web" -f "bestvideo[height<=4320][ext=mp4]+bestaudio[ext=m4a]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best" --format-sort "res,fps,vcodec:vp9.2,vcodec:vp9,vcodec:h265,vcodec:h264,filesize" --no-check-certificate --no-playlist --merge-output-format mp4 -o "${videoRaw}" "${originalUrl}"`, { timeout: 300000 });

    const clips = [];
    console.log('🎬 Rendering clips...');
    for (let i = 0; i < top5.length; i++) {
      const hl = top5[i];
      const clipAssPath = `/tmp/captions_${id}_${i}.ass`;
      const clipOutPath = path.join(outputDir, `clip_${id}_${i}.mp4`);
      const fallbackOutPath = path.join(outputDir, `clip_${id}_${i}_fallback.mp4`);
      tmpFiles.push(clipAssPath);

      const start = hl.paddedStart, duration = 30;
      const clipAss = generateClipASS(words || [], start * 1000, (start + duration) * 1000);
      fs.writeFileSync(clipAssPath, clipAss);

      const assHasDialogue = clipAss.includes('Dialogue:');
      const applyWmark = needsWatermark(userPlan);
      let mainCmd;

      if (applyWmark) {
        const captionStep = assHasDialogue ? `[base]subtitles='${clipAssPath.replace(/\\/g, '/')}':fontsdir='${FONT_DIR.replace(/\\/g, '/')}'[capped];[capped]` : `[base]`;
        const filterComplex = `[0:v]crop=ih*9/16:ih,scale=${scaleTarget}:flags=lanczos[base];${captionStep}[1:v]overlay=20:(H/2)-h-20[out]`;
        mainCmd = `"${ffmpegBin}" -ss ${start} -i "${videoRaw}" -i "${WMARK_PNG}" -t ${duration} -filter_complex "${filterComplex}" -map "[out]" -map 0:a? -c:v libx264 -preset ${encQ.preset} -crf ${encQ.crf} -b:v ${encQ.videoBitrate} -maxrate ${encQ.videoBitrate} -bufsize ${parseInt(encQ.videoBitrate) * 2}k -pix_fmt yuv420p -c:a aac -b:a ${encQ.audioBitrate} -movflags +faststart -y "${clipOutPath}"`;
      } else {
        let vfParts = [`crop=ih*9/16:ih,scale=${scaleTarget}:flags=lanczos`];
        if (assHasDialogue) vfParts.push(`subtitles='${clipAssPath.replace(/\\/g, '/')}':fontsdir='${FONT_DIR.replace(/\\/g, '/')}'`);
        mainCmd = `"${ffmpegBin}" -ss ${start} -i "${videoRaw}" -t ${duration} -vf "${vfParts.join(',')}" -map 0:v -map 0:a? -c:v libx264 -preset ${encQ.preset} -crf ${encQ.crf} -b:v ${encQ.videoBitrate} -maxrate ${encQ.videoBitrate} -bufsize ${parseInt(encQ.videoBitrate) * 2}k -pix_fmt yuv420p -c:a aac -b:a ${encQ.audioBitrate} -movflags +faststart -y "${clipOutPath}"`;
      }

      let usedPath = clipOutPath;
      try {
        await execAsync(mainCmd, { timeout: 600000 });
      } catch (ffErr) {
        console.log(`Fallback triggered for clip ${i}`);
        const fallbackVf = assHasDialogue ? `crop=ih*9/16:ih,scale=${scaleTarget}:flags=lanczos,subtitles='${clipAssPath.replace(/\\/g, '/')}':fontsdir='${FONT_DIR.replace(/\\/g, '/')}'` : `crop=ih*9/16:ih,scale=${scaleTarget}:flags=lanczos`;
        try {
          await execAsync(`"${ffmpegBin}" -ss ${start} -i "${videoRaw}" -t ${duration} -vf "${fallbackVf}" -map 0:v -map 0:a? -c:v libx264 -preset fast -crf ${encQ.crf + 3} -b:v ${encQ.videoBitrate} -pix_fmt yuv420p -c:a aac -b:a ${encQ.audioBitrate} -y "${fallbackOutPath}"`, { timeout: 300000 });
          usedPath = fallbackOutPath;
        } catch (err) { continue; }
      }

      if (fs.existsSync(usedPath) && fs.statSync(usedPath).size > 0) {
        clips.push({ clipUrl: `/outputs/${path.basename(usedPath)}`, text: hl.text, rank: hl.rank, start: hl.start, end: hl.end, fileSize: fs.statSync(usedPath).size, resolution: usedPath === fallbackOutPath ? 'Fallback' : rawRes === '4k' ? '4K Ultra HD' : rawRes.toUpperCase() });
      }
    }

    cleanup();
    if (clips.length === 0) return res.status(500).json({ status: 'error', message: 'No clips generated.' });
    res.json({ status: 'success', transcriptId: transcriptData.id, clips });
  } catch (err) {
    cleanup();
    res.status(500).json({ status: 'error', message: err.message, error: err.message });
  }
});

app.post('/api/download-history', (req, res) => {
  const { clipUrl } = req.body;
  if (!clipUrl) return res.status(400).json({ error: 'Missing clipUrl' });
  const filename = path.basename(clipUrl);
  const filePath = path.join(__dirname, 'outputs', filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Video not found.' });
  res.download(filePath, filename);
});

const nodemailer = require('nodemailer');
app.post('/api/notify-payment', async (req, res) => {
  const { email, plan, amount, utr } = req.body;
  const gmailUser = process.env.GMAIL_USER || 'viralclipaistudio@gmail.com';
  const gmailPass = process.env.GMAIL_APP_PASS;
  if (!gmailPass) return res.json({ status: 'skipped' });

  try {
    const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: gmailUser, pass: gmailPass } });
    await transporter.sendMail({
      from: `"ViralClip Payments" <${gmailUser}>`, to: gmailUser, subject: `💳 Payment: ${plan} (₹${amount})`,
      html: `<p>User: ${email}<br>Plan: ${plan}<br>Amount: ₹${amount}<br>UTR: ${utr}</p>`
    });
    res.json({ status: 'sent' });
  } catch (err) { res.json({ status: 'error' }); }
});

app.post('/api/add-credits', (req, res) => res.json({ status: 'success' }));

const WATERMARK_PATH = path.join(__dirname, 'public', 'watermark.png');
async function getUserPlanFromFirestore(userId) {
  if (!userId || !admin.apps.length) return 'free_permanent';
  try {
    const doc = await admin.firestore().collection('users').doc(userId).get();
    return doc.exists ? (doc.data().plan || 'free_permanent').trim() : 'free_permanent';
  } catch (err) { return 'free_permanent'; }
}

app.post('/api/upload-and-convert', upload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No video.' });
  const outputPath = path.join(__dirname, 'outputs', `converted_${Date.now()}.mp4`);
  if (!fs.existsSync(path.dirname(outputPath))) fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const cleanup = () => { try { fs.unlinkSync(req.file.path); fs.unlinkSync(outputPath); } catch {} };

  try {
    const plan = await getUserPlanFromFirestore(req.body.userId);
    const applyWmark = needsWatermark(plan);
    const ucEncQ = ENCODE_QUALITY[plan] || ENCODE_QUALITY['free'];

    await new Promise((resolve, reject) => {
      let cmd = ffmpeg(req.file.path);
      if (applyWmark) {
        cmd = cmd.input(WATERMARK_PATH).complexFilter([{ filter: 'crop', options: { w: 'ih*9/16', h: 'ih', x: '(iw-ih*9/16)/2', y: '0' }, inputs: ['0:v'], outputs: ['cropped'] }, { filter: 'overlay', options: { x: '20', y: '(H/2)-h-20' }, inputs: ['cropped', '1:v'], outputs: ['out'] }], 'out');
      } else {
        cmd.complexFilter([{ filter: 'crop', options: { w: 'ih*9/16', h: 'ih', x: '(iw-ih*9/16)/2', y: '0' }, inputs: ['0:v'], outputs: ['out'] }], 'out');
      }
      cmd.outputOptions([ '-map [out]', '-map 0:a?', '-c:v libx264', `-preset ${ucEncQ.preset}`, `-crf ${ucEncQ.crf}`, `-b:v ${ucEncQ.videoBitrate}`, `-maxrate ${ucEncQ.videoBitrate}`, `-bufsize ${parseInt(ucEncQ.videoBitrate) * 2}k`, '-pix_fmt yuv420p', '-c:a aac', `-b:a ${ucEncQ.audioBitrate}`, '-movflags +faststart' ]).output(outputPath).on('end', resolve).on('error', reject).run();
    });

    if (!fs.existsSync(outputPath)) return res.status(500).json({ error: 'FFmpeg failed.' });
    const stream = fs.createReadStream(outputPath);
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(outputPath)}"`);
    res.setHeader('Content-Type', 'video/mp4');
    stream.pipe(res).on('close', cleanup).on('error', cleanup);
  } catch (err) { cleanup(); if (!res.headersSent) res.status(500).json({ error: err.message }); }
});

const { execSync: processExecSync } = require('child_process');
const PORT = process.env.PORT || 5000;

function startServer(attempt = 1) {
  if (attempt > 3) process.exit(1);
  const server = app.listen(PORT, '0.0.0.0', () => console.log('ViralClip AI Master Server is LIVE! Port:', PORT));
  server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      try { processExecSync('pkill -f "node index.js" || true'); } catch (_) {}
      setTimeout(() => startServer(attempt + 1), 1500);
    }
  });
}
startServer();
                         
