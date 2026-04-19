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
const app = express();

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
  return raw.replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, ' ').trim() || null;
}

function ms2ass(ms) {
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), s = Math.floor((ms % 60000) / 1000), cs = Math.floor((ms % 1000) / 10);
  return `${h}:${pad(m)}:${pad(s)}.${pad(cs)}`;
}

const ASS_HEADER = `[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,BebasNeue,80,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,4,0,2,10,10,60,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;

function generateClipASS(words, startMs, endMs) {
  let events = '';
  words.filter(w => w.start >= startMs && w.end <= endMs).forEach(w => {
    const safe = sanitizeCaptionText(w.text);
    if (safe) events += `Dialogue: 0,${ms2ass(w.start - startMs)},${ms2ass(w.end - startMs)},Default,,0,0,0,,${safe.toUpperCase()}\n`;
  });
  return ASS_HEADER + events;
}

// ─── STABILIZED MASTER TUNNEL ──────────────────────────────────────────
async function cobaltTunnel(videoUrl, isAudio) {
  const payload = { url: videoUrl, videoQuality: "720", downloadMode: isAudio ? "audio" : "auto" };
  const headers = { 'Accept': 'application/json', 'Content-Type': 'application/json' };
  
  // High-capacity stable nodes
  const instances = ['https://api.cobalt.tools/api/json', 'https://co.wuk.sh/api/json'];

  for (const instance of instances) {
    try {
      const res = await axios.post(instance, payload, { headers, timeout: 30000 });
      if (res.data && res.data.url) return res.data.url;
    } catch (e) { continue; }
  }
  throw new Error("Tunnels busy. This usually means the YouTube video is too long or restricted. Try a different video!");
}

async function downloadToDisk(url, dest) {
  const writer = fs.createWriteStream(dest);
  const res = await axios({ url, method: 'GET', responseType: 'stream', timeout: 300000 });
  res.data.pipe(writer);
  return new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

app.post('/api/process-video', async (req, res) => {
  const { url: originalUrl, plan = 'free', resolution = '360p' } = req.body;
  const id = Date.now(), audioPath = `/tmp/audio_${id}.mp3`, videoRaw = `/tmp/video_raw_${id}.mp4`, outputDir = path.join(__dirname, 'outputs');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  try {
    console.log('⬇️ Tunneling audio...');
    const aUrl = await cobaltTunnel(originalUrl, true);
    await downloadToDisk(aUrl, audioPath);
    
    console.log('⬆️ AssemblyAI Upload...');
    const { data: up } = await axios.post('https://api.assemblyai.com/v2/upload', fs.readFileSync(audioPath), {
      headers: { authorization: process.env.ASSEMBLY_AI_API_KEY, 'Content-Type': 'application/octet-stream' }, maxBodyLength: Infinity
    });

    const { data: tr } = await axios.post('https://api.assemblyai.com/v2/transcript', { audio_url: up.upload_url, speech_models: ['universal-2'], auto_highlights: true }, { headers: { authorization: process.env.ASSEMBLY_AI_API_KEY } });
    const { words, auto_highlights_result } = await waitForTranscript(tr.id);

    console.log('⬇️ Tunneling video...');
    const vUrl = await cobaltTunnel(originalUrl, false);
    await downloadToDisk(vUrl, videoRaw);

    // Pick top 3 highlights
    const highlights = (auto_highlights_result?.results || []).slice(0, 3);
    const clips = [];

    for (let i = 0; i < highlights.length; i++) {
      const h = highlights[i], start = Math.max(0, h.timestamps[0].start / 1000 - 5), out = path.join(outputDir, `clip_${id}_${i}.mp4`), ass = `/tmp/c_${id}_${i}.ass`;
      fs.writeFileSync(ass, generateClipASS(words, start * 1000, (start + 30) * 1000));
      
      const vf = `crop=ih*9/16:ih,scale=720:1280,subtitles='${ass}':fontsdir='${path.join(__dirname, 'fonts')}'`;
      await execAsync(`"${ffmpegBin}" -ss ${start} -i "${videoRaw}" -t 30 -vf "${vf}" -c:v libx264 -preset superfast -crf 28 -c:a aac -y "${out}"`);
      clips.push({ clipUrl: `/outputs/${path.basename(out)}`, text: h.text });
    }

    res.json({ status: 'success', clips });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.post('/api/download-history', (req, res) => {
  const filePath = path.join(__dirname, 'outputs', path.basename(req.body.clipUrl));
  if (fs.existsSync(filePath)) res.download(filePath);
  else res.status(404).send('Not found');
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log('ViralClip Master Online'));
