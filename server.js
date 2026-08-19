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
  try {
    if (!url || typeof url !== 'string' || !url.startsWith('http')) return false;
    const writer = fs.createWriteStream(outputPath);
    const response = await axios({ url, method: 'GET', responseType: 'stream', timeout: 30000 });
    response.data.pipe(writer);
    return new Promise((resolve) => {
      writer.on('finish', () => resolve(true));
      writer.on('error', () => resolve(false));
    });
  } catch (err) {
    return false;
  }
}

// Endpoint Merge (support / dan /merge)
const handleMerge = async (req, res) => {
  const { job_id = `job_${Date.now()}`, scene_clips = [], scene_audio = [] } = req.body;
  const tempDir = path.join(__dirname, 'temp', job_id);
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  try {
    const listFile = path.join(tempDir, 'concat_list.txt');
    const segmentFiles = [];
    const count = Math.max(scene_clips.length, scene_audio.length, 1);

    for (let i = 0; i < count; i++) {
      const clipUrl = scene_clips[i]?.clip_url || scene_clips[i]?.url || (typeof scene_clips[i] === 'string' ? scene_clips[i] : null);
      const audioUrl = scene_audio[i]?.audio_url || scene_audio[i]?.url || (typeof scene_audio[i] === 'string' ? scene_audio[i] : null);

      const clipPath = path.join(tempDir, `clip_${i}.mp4`);
      const audioPath = path.join(tempDir, `audio_${i}.mp3`);
      const mergedScene = path.join(tempDir, `scene_${i}.mp4`);

      const hasClip = clipUrl ? await downloadFile(clipUrl, clipPath) : false;
      const hasAudio = audioUrl ? await downloadFile(audioUrl, audioPath) : false;

      // Render scene dengan fallback jika video/audio kosong
      await new Promise((resolve, reject) => {
        let cmd = ffmpeg();

        if (hasClip && hasAudio) {
          cmd.input(clipPath).inputOptions(['-stream_loop -1'])
             .input(audioPath)
             .outputOptions(['-c:v libx264', '-c:a aac', '-shortest', '-pix_fmt yuv420p']);
        } else if (hasAudio) {
          // Buat background warna jika belum ada video klip
          cmd.input('color=c=navy:s=1280x720:d=5').inputOptions(['-f lavfi'])
             .input(audioPath)
             .outputOptions(['-c:v libx264', '-c:a aac', '-shortest', '-pix_fmt yuv420p']);
        } else if (hasClip) {
          cmd.input(clipPath).outputOptions(['-c:v libx264', '-pix_fmt yuv420p']);
        } else {
          // Dummy 3 detik jika keduanya belum ada
          cmd.input('color=c=blue:s=1280x720:d=3').inputOptions(['-f lavfi'])
             .input('anullsrc=r=44100:cl=stereo').inputOptions(['-f lavfi', '-t 3'])
             .outputOptions(['-c:v libx264', '-c:a aac', '-pix_fmt yuv420p']);
        }

        cmd.output(mergedScene)
           .on('end', resolve)
           .on('error', reject)
           .run();
      });

      segmentFiles.push(mergedScene);
    }

    // Buat concat list
    const concatContent = segmentFiles.map(f => `file '${f.replace(/'/g, "'\\''")}'`).join('\n');
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
      const duration = metadata ? Math.round(metadata.format.duration) : 60;
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
};

app.post('/merge', handleMerge);
app.post('/', handleMerge);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
