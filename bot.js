require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { joinVoiceChannel, EndBehaviorType } = require('@discordjs/voice');
const prism = require('prism-media');
const ffmpeg = require('ffmpeg-static');
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

// FFmpeg encoding
const ffmpegProcess = spawn(ffmpeg, [
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

mixer.pipe(ffmpegProcess.stdin);

// Send MP3 audio over WebSocket in binary
ffmpegProcess.stdout.on('data', (chunk) => {
  for (const ws of wsClients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(chunk);
    }
  }
});

// Get speaker's username
async function getUsername(userId) {
  try {
    const user = await client.users.fetch(userId);
    return user.username;
  } catch {
    return 'Unknown';
  }
}

// Send metadata
function broadcastMetadata(obj) {
  const json = JSON.stringify(obj);
  for (const ws of wsClients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(json);
    }
  }
}

// Connect to Discord
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
    if (speakingStreams.has(userId)) return;

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

    // Audio inactivity timeout logic
    let audioTimeout;

    function resetAudioTimeout() {
      if (audioTimeout) clearTimeout(audioTimeout);
      audioTimeout = setTimeout(() => {
        console.log(`⚠️ No audio data from ${username} for 3 seconds, restarting audio stream...`);

        cleanup();

        // Destroy and remove any existing streams
        if (speakingStreams.has(userId)) {
          const streams = speakingStreams.get(userId);
          try {
            streams.opusStream.destroy();
          } catch (e) {}
          speakingStreams.delete(userId);
        }

        // Note: Discord will re-emit 'start' if user is still speaking,
        // so no need to manually resubscribe here.
      }, 3000); // 3 seconds no data triggers restart
    }

    pcmStream.on('data', () => {
      resetAudioTimeout();
    });

    resetAudioTimeout();

    const cleanup = () => {
      console.log(`🛑 ${username} stopped speaking`);
      currentSpeaker = null;
      broadcastMetadata({ type: 'speaker', speaker: null });

      if (audioTimeout) clearTimeout(audioTimeout);
      audioTimeout = null;

      try {
        mixer.removeInput(mixerInput);
      } catch (e) {}

      pcmStream.unpipe(mixerInput);
      pcmStream.destroy();
      if (typeof mixerInput.destroy === 'function') mixerInput.destroy();
      if (typeof mixerInput.stop === 'function') mixerInput.stop();
      opusStream.destroy();

      speakingStreams.delete(userId);
    };

    opusStream.on('end', cleanup);
    opusStream.on('error', console.error);
    pcmStream.on('error', console.error);

    speakingStreams.set(userId, { opusStream, pcmStream, mixerInput });
  });

  receiver.speaking.on('end', (userId) => {
    const stream = speakingStreams.get(userId);
    if (stream) {
      stream.opusStream.emit('end');
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
});

server.listen(PORT, () => {
  console.log(`🚀 Server running: http://localhost:${PORT}`);
});
