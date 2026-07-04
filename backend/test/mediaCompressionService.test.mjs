import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'child_process'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { compressMediaBuffer } from '../src/services/mediaCompressionService.js'

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg'

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, args)
    let stderr = ''
    child.stderr.on('data', chunk => {
      stderr += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) resolve()
      else reject(new Error(stderr.trim().slice(-500) || `ffmpeg salió con código ${code}`))
    })
  })
}

function readFfmpegOutput(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, args)
    let output = ''
    child.stdout.on('data', chunk => {
      output += chunk.toString()
    })
    child.stderr.on('data', chunk => {
      output += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) resolve(output)
      else reject(new Error(output.trim().slice(-500) || `ffmpeg salió con código ${code}`))
    })
  })
}

async function hasFfmpeg() {
  try {
    await runFfmpeg(['-version'])
    return true
  } catch {
    return false
  }
}

async function hasFfmpegEncoder(encoder) {
  try {
    const encoders = await readFfmpegOutput(['-hide_banner', '-encoders'])
    return encoders.includes(encoder)
  } catch {
    return false
  }
}

const ffmpegAvailable = await hasFfmpeg()
const webpEncoderAvailable = ffmpegAvailable ? await hasFfmpegEncoder('libwebp') : false

test('compressMediaBuffer reduce imagen, audio y video cuando ffmpeg está disponible', {
  skip: ffmpegAvailable ? false : 'ffmpeg no está instalado en este entorno'
}, async () => {
  const folder = await fs.mkdtemp(join(tmpdir(), 'ristak-compress-test-'))

  try {
    const imagePath = join(folder, 'image.png')
    const audioPath = join(folder, 'audio.wav')
    const videoPath = join(folder, 'video.mp4')

    await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'testsrc=size=2400x1600:rate=1', '-frames:v', '1', imagePath])
    await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=8', '-c:a', 'pcm_s16le', audioPath])
    await runFfmpeg([
      '-y',
      '-f', 'lavfi',
      '-i', 'testsrc=size=1920x1080:rate=30',
      '-f', 'lavfi',
      '-i', 'sine=frequency=440:duration=6',
      '-t', '6',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-crf', '12',
      '-c:a', 'aac',
      '-b:a', '192k',
      videoPath
    ])

    const image = await fs.readFile(imagePath)
    const audio = await fs.readFile(audioPath)
    const video = await fs.readFile(videoPath)

    const compressedImage = await compressMediaBuffer({ buffer: image, contentType: 'image/png' })
    const compressedAudio = await compressMediaBuffer({ buffer: audio, contentType: 'audio/wav' })
    const compressedVideo = await compressMediaBuffer({ buffer: video, contentType: 'video/mp4' })

    if (webpEncoderAvailable) {
      assert.equal(compressedImage.contentType, 'image/webp')
      assert.ok(compressedImage.buffer.length < image.length)
    } else {
      assert.equal(compressedImage.contentType, 'image/png')
      assert.equal(compressedImage.note, 'original')
    }

    assert.equal(compressedAudio.contentType, 'audio/ogg; codecs=opus')
    assert.ok(compressedAudio.buffer.length < audio.length * 0.5)

    assert.equal(compressedVideo.contentType, 'video/mp4')
    assert.ok(compressedVideo.buffer.length < video.length * 0.75)
  } finally {
    await fs.rm(folder, { recursive: true, force: true })
  }
})
