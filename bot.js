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

const wsClients = new Set();
let currentSpeaker = null;
let lastAudioReceived = Date.now();
let connection;

const mixer = new AudioMixer.Mixer({
  channels: 1,
  bitDepth: 16,
  sampleRate: 48000,
  clearInterval: 250,
  maxStreams: 20,
});

let ffmpegProcess;
let noDataTimeout;
let restarting = false;   // To avoid multiple restarts

const speakingStreams = new Map();  // Moved here, globally accessible

async function fullRestart() {
  if (restarting) return; // Prevent overlap
  restarting = true;

  console.warn('Full restart: cleaning up streams and restarting ffmpeg & voice connection');

  // Destroy and remove all mixer inputs individually
  mixer.inputs.forEach(input => {
    try {
      input.destroy();
      mixer.removeInput(input);
    } catch (e) {
      console.error('Error removing mixer input:', e);
    }
  });

  // Destroy all speakingStreams
  speakingStreams.forEach(({ opusStream, pcmStream, mixerInput }) => {
    try { opusStream.destroy(); } catch { }
    try { pcmStream.destroy(); } catch { }
    try { mixerInput.destroy(); } catch { }
  });
  speakingStreams.clear();

  // Kill ffmpeg process if exists
  if (ffmpegProcess) {
    try {
      ffmpegProcess.kill('SIGKILL');
    } catch { }
    ffmpegProcess = null;
  }

  // Destroy Discord voice connection if exists
  if (connection) {
    try {
      connection.destroy();
    } catch { }
    connection = null;
  }

  // Wait a little before restarting
  await new Promise(r => setTimeout(r, 500));

  // Restart ffmpeg and voice connection
  startFfmpeg();
  await reconnectVoice();

  restarting = false;
}

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

  mixer.pipe(ffmpegProcess.stdin);
  console.log('ffmpeg process started');

  function resetNoDataTimeout() {
    if (noDataTimeout) clearTimeout(noDataTimeout);
    noDataTimeout = setTimeout(() => {
      console.warn('⚠️ No ffmpeg stdout data for 5 seconds. Reconnecting voice...');
      fullRestart();
    }, 5000);
  }

  ffmpegProcess.stdout.on('data', (chunk) => {
    if (!chunk || chunk.length <= 0) {
      console.error('Received empty audio chunk');
      fullRestart();
      return;
    }

    resetNoDataTimeout();

    console.log(`Opus stream data from  ${chunk.length} bytes`);
    console.log(`🔊 Sending audio chunk to ${wsClients.size} clients`);

    for (const ws of wsClients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(chunk);
      }
    }
  });

  resetNoDataTimeout();

  ffmpegProcess.stdin.on('error', (err) => console.error('ffmpeg stdin error:', err));
  ffmpegProcess.stdout.on('error', (err) => console.error('ffmpeg stdout error:', err));
  ffmpegProcess.on('error', (err) => console.error('ffmpeg process error:', err));

  ffmpegProcess.on('close', (code, signal) => {
    console.warn(`ffmpeg process closed (code: ${code}, signal: ${signal}). Restarting...`);
    mixer.unpipe(ffmpegProcess.stdin);
    if (noDataTimeout) clearTimeout(noDataTimeout);
    fullRestart();
  });
}

function checkSilenceAndReconnect() {
  if (Date.now() - lastAudioReceived > 5000) {
    console.warn('🔇 No audio received for 5s. Reconnecting bot...');
    fullRestart();
  }
}
setInterval(checkSilenceAndReconnect, 5000);

async function getUsername(userId) {
  try {
    const user = await client.users.fetch(userId);
    return user.username;
  } catch {
    return 'Unknown';
  }
}

function broadcastMetadata(obj) {
  const json = JSON.stringify(obj);
  for (const ws of wsClients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(json);
    }
  }
}

function setupReceiver(receiver) {
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

    pcmStream.on('data', () => {
      lastAudioReceived = Date.now();
    });

    let audioTimeout;
    function resetAudioTimeout() {
      if (audioTimeout) clearTimeout(audioTimeout);
      audioTimeout = setTimeout(() => {
        cleanup();
        if (speakingStreams.has(userId)) {
          try { speakingStreams.get(userId).opusStream.destroy(); } catch { }
          speakingStreams.delete(userId);
        }
      }, 3000);
    }

    const cleanup = () => {
      console.log(`🛑 ${username} stopped speaking`);
      currentSpeaker = null;
      broadcastMetadata({ type: 'speaker', speaker: null });
      clearTimeout(audioTimeout);
      try { mixer.removeInput(mixerInput); } catch { }
      pcmStream.unpipe(mixerInput);
      pcmStream.destroy();
      if (typeof mixerInput.destroy === 'function') mixerInput.destroy();
      try { opusStream.destroy(); } catch { }
      speakingStreams.delete(userId);
    };

    opusStream.on('end', cleanup);
    opusStream.on('error', (e) => { console.error(`Opus error ${username}:`, e); cleanup(); });
    pcmStream.on('error', (e) => { console.error(`PCM error ${username}:`, e); cleanup(); });

    speakingStreams.set(userId, { opusStream, pcmStream, mixerInput });
  });

  receiver.speaking.on('end', (userId) => {
    const streams = speakingStreams.get(userId);
    if (streams) {
      streams.opusStream.emit('end');
    }
  });
}

function broadcastUserCount() {
  const count = wsClients.size;
  const msg = JSON.stringify({ type: 'user_count', count });
  for (const ws of wsClients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

async function reconnectVoice() {
  try {
    if (connection) {
      try { connection.destroy(); } catch { }
      connection = null;
    }
    const guild = client.guilds.cache.get(GUILD_ID);
    if (!guild) return console.error('Guild not found');

    connection = joinVoiceChannel({
      channelId: VOICE_CHANNEL_ID,
      guildId: GUILD_ID,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
    });

    setupReceiver(connection.receiver);
    console.log('🔁 Voice connection re-established');
  } catch (e) {
    console.error('Reconnect error:', e);
  }
}

client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  startFfmpeg();
  await reconnectVoice();
});

// WebSocket and Express setup remains the same

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);

const wss = new WebSocket.Server({ server });



wss.on('connection', (ws) => {
  wsClients.add(ws);
  console.log(`🌐 WS client connected. Total: ${wsClients.size}`);
  ws.send(JSON.stringify({ type: 'status', speaker: currentSpeaker }));
  broadcastUserCount();

  ws.on('close', () => {
    wsClients.delete(ws);
    console.log(`🔌 WS client disconnected. Total: ${wsClients.size}`);
    broadcastUserCount();
  });

  ws.on('error', (err) => console.error('WebSocket error:', err));
});


server.listen(3000, () => console.log('🌐 Server running on port 3000'));

client.login(process.env.DISCORD_BOT_TOKEN);
