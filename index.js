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

ffmpeg.setFfmpegPath(ffmpegBin);
const execAsync = promisify(exec);
const ytDlpBin = path.join(__dirname, 'yt-dlp');

// ─── THE DIRECT PIPELINE SETUP ──────────────────────────────────────────
try {
  console.log('🔄 Installing High-Speed Downloader...');
  execSync(`curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o "${ytDlpBin}"`);
  fs.chmodSync(ytDlpBin, '755');
} catch (e) { console.error('Setup Error:', e.message); }

const app = express();
app.use(cors());
app.use(express.static('public'));
app.use('/outputs', express.static(path.join(__dirname, 'outputs')));
app.use(express.json());

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

function ms2ass(ms) {
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), s = Math.floor((ms % 60000) / 1000), cs = Math.floor((ms % 1000) / 10);
  return `${h}:${pad(m)}:${pad(s)}.${pad(cs)}`;
}

app.post('/api/process-video', async (req, res) => {
  const { url: originalUrl } = req.body;
  const id = Date.now();
  const audioPath = `/tmp/a_${id}.mp3`, videoRaw = `/tmp/v_${id}.mp4`, outputDir = path.join(__dirname, 'outputs');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  try {
    // Phase 1: High-Speed Audio Extraction
    console.log('⬇️ Extracting Audio Pipeline...');
    await execAsync(`"${ytDlpBin}" --force-ipv6 --extractor-args "youtube:player_client=android_vr" -f "bestaudio" -x --audio-format mp3 -o "${audioPath}" "${originalUrl}"`);

    // Phase 2: AI Transcription
    console.log('🎙️ AI Transcription Started...');
    const { data: up } = await axios.post('https://api.assemblyai.com/v2/upload', fs.readFileSync(audioPath), {
      headers: { authorization: process.env.ASSEMBLY_AI_API_KEY, 'Content-Type': 'application/octet-stream' }, maxBodyLength: Infinity
    });
    const { data: tr } = await axios.post('https://api.assemblyai.com/v2/transcript', { audio_url: up.upload_url, auto_highlights: true }, { headers: { authorization: process.env.ASSEMBLY_AI_API_KEY } });
    const transcript = await waitForTranscript(tr.id);

    // Phase 3: High-Quality 1080p Video Fetch
    console.log('⬇️ Fetching High-Quality 1080p Source...');
    // This command targets 1080p specifically but allows fallbacks if 1080p isn't available
    await execAsync(`"${ytDlpBin}" --force-ipv6 --extractor-args "youtube:player_client=android_vr" -f "bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best" --merge-output-format mp4 -o "${videoRaw}" "${originalUrl}"`);

    const highlights = (transcript.auto_highlights_result?.results || []).slice(0, 3);
    const clips = [];

    // Phase 4: Pro-Grade Rendering
    console.log('🎬 Rendering Pro-Quality Clips...');
    for (let i = 0; i < highlights.length; i++) {
      const h = highlights[i];
      const start = Math.max(0, h.timestamps[0].start / 1000);
      const outName = `clip_${id}_${i}.mp4`;
      const outPath = path.join(outputDir, outName);

      // High-Quality Encode Settings (CRF 20 is "near lossless")
      await execAsync(`"${ffmpegBin}" -ss ${start} -i "${videoRaw}" -t 30 -vf "crop=ih*9/16:ih,scale=1080:1920" -c:v libx264 -preset medium -crf 20 -c:a aac -b:a 192k -y "${outPath}"`);
      
      clips.push({ clipUrl: `/outputs/${outName}`, text: h.text });
    }

    res.json({ status: 'success', clips });
  } catch (err) {
    console.error(err);
    res.status(500).json({ status: 'error', message: "Download blocked or video too heavy for current server limits." });
  }
});

app.listen(process.env.PORT || 5000, () => console.log('ViralClip Pro Engine Live'));
