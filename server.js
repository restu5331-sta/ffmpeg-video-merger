const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');

const app = express();
app.use(express.json({ limit: '50mb' }));

const PUBLIC_DIR = path.join(__dirname, 'public');
if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });
app.use('/videos', express.static(PUBLIC_DIR));

// Helper download file
async function downloadFile(url, outputPath) {
  const writer = fs.createWriteStream(outputPath);
  const response = await axios({ url, method: 'GET', responseType: 'stream' });
  response.data.pipe(writer);
  return new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

// Endpoint Merge
app.post('/merge', async (req, res) => {
  const { job_id = `job_${Date.now()}`, scene_clips = [], scene_audio = [] } = req.body;
  const tempDir = path.join(__dirname, 'temp', job_id);
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  try {
    const listFile = path.join(tempDir, 'concat_list.txt');
    const segmentFiles = [];

    // Download & gabungkan per scene jika ada
    for (let i = 0; i < Math.max(scene_clips.length, scene_audio.length); i++) {
      const clipUrl = scene_clips[i]?.clip_url || scene_clips[i]?.url || scene_clips[i];
      const audioUrl = scene_audio[i]?.audio_url || scene_audio[i]?.url || scene_audio[i];

      const clipPath = path.join(tempDir, `clip_${i}.mp4`);
      const audioPath = path.join(tempDir, `audio_${i}.mp3`);
      const mergedScene = path.join(tempDir, `scene_${i}.mp4`);

      if (clipUrl && typeof clipUrl === 'string') await downloadFile(clipUrl, clipPath);
      if (audioUrl && typeof audioUrl === 'string') await downloadFile(audioUrl, audioPath);

      // Render scene
      await new Promise((resolve, reject) => {
        let cmd = ffmpeg();
        if (fs.existsSync(clipPath)) cmd.input(clipPath).inputOptions(['-stream_loop -1']);
        if (fs.existsSync(audioPath)) cmd.input(audioPath);
        
        cmd.outputOptions(['-c:v libx264', '-c:a aac', '-shortest', '-pix_fmt yuv420p'])
          .output(mergedScene)
          .on('end', resolve)
          .on('error', reject)
          .run();
      });

      segmentFiles.push(mergedScene);
    }

    // Buat file list untuk concat
    const concatContent = segmentFiles.map(f => `file '${f}'`).join('\n');
    fs.writeFileSync(listFile, concatContent);

    const finalFilename = `${job_id}_final.mp4`;
    const finalOutputPath = path.join(PUBLIC_DIR, finalFilename);

    // Concat semua scene
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(listFile)
        .inputOptions(['-f concat', '-safe 0'])
        .outputOptions(['-c copy'])
        .output(finalOutputPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    // Ambil durasi
    ffmpeg.ffprobe(finalOutputPath, (err, metadata) => {
      const duration = metadata ? Math.round(metadata.format.duration) : 600;
      const host = req.get('host');
      const protocol = req.protocol === 'https' || req.get('x-forwarded-proto') === 'https' ? 'https' : 'http';
      const final_video_url = `${protocol}://${host}/videos/${finalFilename}`;

      res.json({
        job_id,
        final_video_url,
        total_duration_seconds: duration,
        status: 'success'
      });
    });

  } catch (error) {
    console.error('Merge error:', error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
