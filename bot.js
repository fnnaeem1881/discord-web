require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { joinVoiceChannel, EndBehaviorType } = require('@discordjs/voice');
const prism = require('prism-media');
const ffmpegStatic = require('ffmpeg-static');
const { spawn } = require('child_process');
const express = require('express');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const AudioMixer = require('audio-mixer');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

const GUILD_ID = process.env.GUILD_ID;
const VOICE_CHANNEL_ID = process.env.VOICE_CHANNEL_ID;

const wsClients = new Set(); // WebSocket clients for metadata + audio
let currentSpeaker = null;

// Audio mixer
const mixer = new AudioMixer.Mixer({
  channels: 1,
  bitDepth: 16,
  sampleRate: 48000,
  clearInterval: 250,
  maxStreams: 20,
});

let ffmpegProcess;
function startFfmpeg() {
  console.log('Starting ffmpeg process...');
  ffmpegProcess = spawn(ffmpegStatic, [
    '-f', 's16le',
    '-ar', '48000',
    '-ac', '1',
    '-i', 'pipe:0',
    '-af', 'afftdn',
    '-f', 'mp3',
    '-b:a', '128k',
    '-ac', '2',
    'pipe:1',
  ]);

  // Pipe mixer output to ffmpeg stdin
  mixer.pipe(ffmpegProcess.stdin);

  ffmpegProcess.stdout.on('data', (chunk) => {
    for (const ws of wsClients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(chunk);
      }
    }
  });

  ffmpegProcess.stdin.on('error', (err) => {
    console.error('ffmpeg stdin error:', err);
  });
  ffmpegProcess.stdout.on('error', (err) => {
    console.error('ffmpeg stdout error:', err);
  });
  ffmpegProcess.on('error', (err) => {
    console.error('ffmpeg process error:', err);
  });

  ffmpegProcess.on('close', (code, signal) => {
    console.warn(`ffmpeg process closed with code ${code} and signal ${signal}. Restarting...`);
    // Unpipe old ffmpeg stdin safely
    mixer.unpipe(ffmpegProcess.stdin);
    setTimeout(startFfmpeg, 1000);
  });
}

// Start ffmpeg process initially
startFfmpeg();

// Helper: get Discord username from userId
async function getUsername(userId) {
  try {
    const user = await client.users.fetch(userId);
    return user.username;
  } catch {
    return 'Unknown';
  }
}

// Broadcast metadata to all WebSocket clients
function broadcastMetadata(obj) {
  const json = JSON.stringify(obj);
  for (const ws of wsClients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(json);
    }
  }
}

client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) return console.error('Guild not found');

  const connection = joinVoiceChannel({
    channelId: VOICE_CHANNEL_ID,
    guildId: GUILD_ID,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,
  });

  const receiver = connection.receiver;
  const speakingStreams = new Map();

  receiver.speaking.on('start', async (userId) => {
    if (speakingStreams.has(userId)) {
      // Already tracking this user
      return;
    }

    const username = await getUsername(userId);
    currentSpeaker = username;
    console.log(`🎙️ ${username} started speaking`);
    broadcastMetadata({ type: 'speaker', speaker: currentSpeaker });

    const opusStream = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 500 },
    });

    const pcmStream = new prism.opus.Decoder({
      rate: 48000,
      channels: 1,
      frameSize: 960,
    });

    opusStream.pipe(pcmStream);

    const mixerInput = new AudioMixer.Input({
      channels: 1,
      bitDepth: 16,
      sampleRate: 48000,
      volume: 100,
    });

    pcmStream.pipe(mixerInput);
    mixer.addInput(mixerInput);

    // Audio inactivity timeout logic (restart on 3 seconds silence)
    let audioTimeout;

    function resetAudioTimeout() {
      if (audioTimeout) clearTimeout(audioTimeout);
      audioTimeout = setTimeout(() => {
        console.log(`⚠️ No audio data from ${username} for 3 seconds, cleaning up...`);

        cleanup();

        // Destroy and remove any existing streams safely
        if (speakingStreams.has(userId)) {
          const streams = speakingStreams.get(userId);
          try {
            streams.opusStream.destroy();
          } catch (e) {
            console.warn('Error destroying opusStream:', e);
          }
          speakingStreams.delete(userId);
        }

        // Discord may re-emit 'start' event if user still speaking,
        // so no manual resubscribe needed here.
      }, 3000);
    }

    pcmStream.on('data', () => {
      resetAudioTimeout();
    });

    resetAudioTimeout();

    const cleanup = () => {
      console.log(`🛑 ${username} stopped speaking`);
      currentSpeaker = null;
      broadcastMetadata({ type: 'speaker', speaker: null });

      if (audioTimeout) {
        clearTimeout(audioTimeout);
        audioTimeout = null;
      }

      try {
        mixer.removeInput(mixerInput);
      } catch (e) {
        console.warn('Error removing mixer input:', e);
      }

      pcmStream.unpipe(mixerInput);
      pcmStream.destroy();
      if (typeof mixerInput.destroy === 'function') mixerInput.destroy();
      if (typeof mixerInput.stop === 'function') mixerInput.stop();
      try {
        opusStream.destroy();
      } catch (e) {
        console.warn('Error destroying opusStream:', e);
      }

      speakingStreams.delete(userId);
    };

    opusStream.on('end', cleanup);
    opusStream.on('error', (e) => {
      console.error(`OpusStream error for ${username}:`, e);
      cleanup();
    });
    pcmStream.on('error', (e) => {
      console.error(`PCMStream error for ${username}:`, e);
      cleanup();
    });

    speakingStreams.set(userId, { opusStream, pcmStream, mixerInput });
  });

  receiver.speaking.on('end', (userId) => {
    const streams = speakingStreams.get(userId);
    if (streams) {
      // Trigger cleanup by ending opus stream
      streams.opusStream.emit('end');
    }
  });
});

client.login(process.env.DISCORD_TOKEN);

// Server setup
const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

const wss = new WebSocket.Server({ server, path: '/ws' });

function broadcastUserCount() {
  const count = wsClients.size;
  const msg = JSON.stringify({ type: 'user_count', count });
  for (const ws of wsClients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  }
}

wss.on('connection', (ws) => {
  wsClients.add(ws);
  console.log(`🌐 WS client connected. Total WS: ${wsClients.size}`);

  // Send current speaker info on new connection
  ws.send(JSON.stringify({
    type: 'status',
    speaker: currentSpeaker,
  }));

  broadcastUserCount();

  ws.on('close', () => {
    wsClients.delete(ws);
    console.log(`🔌 WS client disconnected. Total WS: ${wsClients.size}`);
    broadcastUserCount();
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err);
  });
});

// Ping clients periodically to keep WebSocket alive
setInterval(() => {
  for (const ws of wsClients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
    }
  }
}, 30000);

server.listen(PORT, () => {
  console.log(`🚀 Server running: http://localhost:${PORT}`);
});
