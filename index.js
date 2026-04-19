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

function extractVideoId(url) {
  const match = url.match(/(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=|shorts\/)|youtu\.be\/)([^"&?\/\s]{11})/);
  return match ? match[1] : null;
}

// ─── THE PIPED API STREAM NETWORK ───────────────────────────────────────
async function getPipedStreams(videoId) {
  const instances = [
    'https://pipedapi.kavin.rocks',
    'https://api.piped.projectsegfau.lt',
    'https://pipedapi.adminforge.de',
    'https://pipedapi.smnz.de'
  ];

  for (const instance of instances) {
    try {
      console.log(`  ▶️ Connecting to Master Node: ${instance}...`);
      const res = await axios.get(`${instance}/streams/${videoId}`, { timeout: 15000 });
      
      if (res.data && res.data.audioStreams && res.data.videoStreams) {
        // Grab best audio
        const audio = res.data.audioStreams.find(s => s.mimeType.includes('mp4a')) || res.data.audioStreams[0];
        // Grab 1080p video (or fallback to 720p)
        const video = res.data.videoStreams.find(s => s.quality === '1080p' && s.videoOnly === true && s.mimeType.includes('mp4')) 
                   || res.data.videoStreams.find(s => s.quality === '720p' && s.videoOnly === true) 
                   || res.data.videoStreams[0];
        
        console.log(`  ✅ Successfully secured Piped Stream URLs!`);
        return { audioUrl: audio.url, videoUrl: video.url };
      }
    } catch (e) { 
      console.log(`  ⚠️ Node busy, jumping to next...`);
    }
  }
  throw new Error("All Piped network APIs are down. Please check if the video is age-restricted or private.");
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
  
  const videoId = extractVideoId(originalUrl);
  if (!videoId) return res.status(400).json({ status: 'error', message: 'Invalid YouTube link.' });

  const id = Date.now();
  const audioPath = `/tmp/a_${id}.mp3`, outputDir = path.join(__dirname, 'outputs');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  try {
    console.log('⬇️ Bypassing YouTube via Piped API...');
    const streams = await getPipedStreams(videoId);

    console.log('⬇️ Downloading lightweight audio track for AI...');
    await downloadToDisk(streams.audioUrl, audioPath);
    
    console.log('🎙️ AI Analyzing Viral Moments...');
    const { data: up } = await axios.post('https://api.assemblyai.com/v2/upload', fs.readFileSync(audioPath), {
      headers: { authorization: process.env.ASSEMBLY_AI_API_KEY, 'Content-Type': 'application/octet-stream' }
    });
    const { data: tr } = await axios.post('https://api.assemblyai.com/v2/transcript', { 
        audio_url: up.upload_url, 
        auto_highlights: true 
    }, { headers: { authorization: process.env.ASSEMBLY_AI_API_KEY } });
    
    const transcript = await waitForTranscript(tr.id);
    const highlights = (transcript.auto_highlights_result?.results || []).slice(0, 3);
    const clips = [];

    console.log('🎬 Snipping 1080p clips directly from the network stream...');
    for (let i = 0; i < highlights.length; i++) {
      const h = highlights[i];
      const start = Math.max(0, h.timestamps[0].start / 1000);
      const outName = `clip_${id}_${i}.mp4`;
      const outPath = path.join(outputDir, outName);
      
      const ass = `/tmp/c_${id}_${i}.ass`;
      fs.writeFileSync(ass, generateClipASS(transcript.words || [], start * 1000, (start + 30) * 1000));

      // Dual-Stream Network Sniper: Downloads only 30s of Video AND 30s of Audio directly from the URLs
      const vf = `crop=ih*9/16:ih,scale=1080:1920,subtitles='${ass}':fontsdir='${path.join(__dirname, 'fonts')}'`;
      await execAsync(`"${ffmpegBin}" -ss ${start} -i "${streams.videoUrl}" -ss ${start} -i "${streams.audioUrl}" -t 30 -vf "${vf}" -c:v libx264 -preset veryfast -crf 24 -c:a aac -y "${outPath}"`, { timeout: 300000 });
      
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

app.listen(process.env.PORT || 5000, () => console.log('ViralClip Pure Stream Engine Ready'));
