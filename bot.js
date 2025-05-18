require('dotenv').config();
const express = require('express');
const { Client, GatewayIntentBits } = require('discord.js');
const path = require('path');

const app = express();
const port = 3000;

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'public')));

// Discord bot setup
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once('ready', () => {
  console.log(`🤖 Bot is logged in as ${client.user.tag}`);
});

// Endpoint to send message with custom username
// Example usage: /send-message?msg=hello&user=Mehedi
app.get('/send-message', async (req, res) => {
  const msg = req.query.msg || '📢 Default message from website';
  const user = req.query.user || 'Anonymous';

  try {
    const channel = await client.channels.fetch(process.env.CHANNEL_ID);
    // Send message with custom username prefix in content
    await channel.send(`[${user}]: ${msg}`);
    res.send(`✅ Message sent as [${user}]: ${msg}`);
  } catch (error) {
    console.error(error);
    res.status(500).send('❌ Error sending message to Discord');
  }
});

// Endpoint to get last 20 messages with parsed usernames
app.get('/get-messages', async (req, res) => {
  try {
    const channel = await client.channels.fetch(process.env.CHANNEL_ID);
    const messages = await channel.messages.fetch({ limit: 20 });

    const simplified = messages
      .map(m => {
        // Regex to parse messages of format: [username]: message
        const match = m.content.match(/^\[(.+?)\]:\s*(.*)$/);
        if (match) {
          return {
            author: match[1],
            content: match[2],
            createdAt: m.createdAt,
          };
        } else {
          // fallback to Discord author if no match
          return {
            author: m.author.username,
            content: m.content,
            createdAt: m.createdAt,
          };
        }
      })
      .sort((a, b) => a.createdAt - b.createdAt);

    res.json(simplified);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// Start web server
app.listen(port, () => {
  console.log(`🌐 Web server running: http://localhost:${port}`);
});

// Login Discord bot
client.login(process.env.DISCORD_TOKEN);
