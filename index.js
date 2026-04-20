require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const ffmpegBin = require('ffmpeg-static');

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
    if (data.status === 'completed') return data;
    if (data.status === 'error') throw new Error(`Transcription failed`);
    await new Promise(r => setTimeout(r, 4000));
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

// ─── THE BULLETPROOF NETWORK STREAMER ───────────────────────────────
async function getBulletproofStream(videoUrl, isAudio) {
  const payload = isAudio ? 
    { url: videoUrl, downloadMode: "audio", audioFormat: "mp3" } : 
    { url: videoUrl, videoQuality: "1080" };

  // Fixed instances with the CORRECT /api/json endpoint
  const instances = [
    'https://api.cobalt.tools/api/json',
    'https://co.wuk.sh/api/json',
    'https://cobalt.owo.network/api/json'
  ];

  for (const instance of instances) {
    try {
      console.log(`  ▶️ Pinging API: ${instance}...`);
      const res = await axios.post(instance, payload, {
        headers: { 
          'Accept': 'application/json', 
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
        },
        timeout: 15000
      });
      if (res.data && res.data.url) {
        console.log(`  ✅ Successfully linked to ${instance}`);
        return res.data.url;
      }
    } catch (e) {
      // Un-masking the error so we see exactly what went wrong if it fails
      const errMsg = e.response ? `HTTP ${e.response.status}` : e.message;
      console.log(`  ⚠️ Proxy Failed (${instance}): ${errMsg}`);
    }
  }
  throw new Error("All proxy servers rejected the request. Please check Render logs for exact HTTP status codes.");
}

async function downloadToDisk(url, dest) {
  const writer = fs.createWriteStream(dest);
  const response = await axios({ url, method: 'GET', responseType: 'stream', timeout: 60000 });
  response.data.pipe(writer);
  return new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

app.post('/api/process-video', async (req, res) => {
  const { url: originalUrl } = req.body;
  const id = Date.now();
  const audioPath = `/tmp/a_${id}.mp3`, outputDir = path.join(__dirname, 'outputs');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  try {
    console.log('⬇️ Fetching Audio Stream...');
    const aUrl = await getBulletproofStream(originalUrl, true);
    await downloadToDisk(aUrl, audioPath);
    
    console.log('🎙️ AI Analyzing Transcript...');
    const { data: up } = await axios.post('https://api.assemblyai.com/v2/upload', fs.readFileSync(audioPath), {
      headers: { authorization: process.env.ASSEMBLY_AI_API_KEY, 'Content-Type': 'application/octet-stream' }
    });
    const { data: tr } = await axios.post('https://api.assemblyai.com/v2/transcript', { 
        audio_url: up.upload_url, 
        auto_highlights: true 
    }, { headers: { authorization: process.env.ASSEMBLY_AI_API_KEY } });
    
    const transcript = await waitForTranscript(tr.id);
    
    console.log('⬇️ Securing 1080p Video Stream...');
    const vUrl = await getBulletproofStream(originalUrl, false);

    const highlights = (transcript.auto_highlights_result?.results || []).slice(0, 3);
    const clips = [];

    console.log('🎬 Snipping directly from 1080p network stream...');
    for (let i = 0; i < highlights.length; i++) {
      const h = highlights[i];
      const start = Math.max(0, h.timestamps[0].start / 1000);
      const outName = `clip_${id}_${i}.mp4`;
      const outPath = path.join(outputDir, outName);
      
      const ass = `/tmp/c_${id}_${i}.ass`;
      fs.writeFileSync(ass, generateClipASS(transcript.words || [], start * 1000, (start + 30) * 1000));

      // Snipping over the network
      const vf = `crop=ih*9/16:ih,scale=1080:1920,subtitles='${ass}':fontsdir='${path.join(__dirname, 'fonts')}'`;
      await execAsync(`"${ffmpegBin}" -ss ${start} -i "${vUrl}" -ss ${start} -i "${aUrl}" -t 30 -vf "${vf}" -c:v libx264 -preset veryfast -crf 24 -c:a aac -y "${outPath}"`, { timeout: 300000 });
      
      clips.push({ clipUrl: `/outputs/${outName}`, text: h.text });
    }

    if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
    res.json({ status: 'success', clips });
  } catch (err) {
    console.error(err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.post('/api/download-history', (req, res) => {
  const file = path.join(__dirname, 'outputs', path.basename(req.body.clipUrl));
  if (fs.existsSync(file)) res.download(file);
  else res.status(404).send('Not found');
});

app.listen(process.env.PORT || 5000, () => console.log('ViralClip Master Engine Ready'));
