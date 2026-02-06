const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const { Connectors } = require('shoukaku');
const { Kazagumo } = require('kazagumo');
const express = require('express');
require('dotenv').config();

// ============ BOT INFO ============
const BOT_INFO = {
    name: 'Melodify',
    version: '1.0.0',
    description: 'Bot musik Discord berkualitas tinggi.',
    owner: {
        id: '1307489983359357019',
        username: 'demisz_dc',
        display: 'Demisz'
    },
    color: '#5865F2'
};

// ============ EXPRESS SERVER ============
const app = express();
const PORT = process.env.PORT || 8080;

app.get('/', (req, res) => res.status(200).send('Bot is running!'));
app.get('/health', (req, res) => res.status(200).json({ status: 'ok', uptime: process.uptime() }));

app.listen(PORT, () => console.log(`🌐 Server running on port ${PORT}`));

// ============ DISCORD CLIENT ============
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// ============ LAVALINK NODES ============
const Nodes = [
    {
        name: 'Node1',
        url: 'node1.kartadharta.xyz:443',
        auth: 'kdlavalink',
        secure: true
    },
    {
        name: 'Node2', 
        url: 'lava-v3.ajieblogs.eu.org:443',
        auth: 'https://dsc.gg/ajidevserver',
        secure: true
    },
    {
        name: 'Node3',
        url: 'lavalink.techpoint.world:80',
        auth: 'techpoint',
        secure: false
    }
];

// ============ HELPER FUNCTIONS ============
function formatDuration(ms) {
    if (!ms || ms === 0) return '🔴 Live';
    const s = Math.floor((ms / 1000) % 60);
    const m = Math.floor((ms / (1000 * 60)) % 60);
    const h = Math.floor(ms / (1000 * 60 * 60));
    return h > 0 ? `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}` : `${m}:${s.toString().padStart(2, '0')}`;
}

function errorEmbed(message) {
    return new EmbedBuilder().setColor('#ff6b6b').setDescription(`❌ ${message}`);
}

function successEmbed(message) {
    return new EmbedBuilder().setColor(BOT_INFO.color).setDescription(message);
}

// ============ KAZAGUMO VARIABLE ============
let kazagumo = null;

// ============ BOT READY ============
client.once('ready', () => {
    console.log('═══════════════════════════════════════');
    console.log(`✅ ${client.user.tag} is online!`);
    console.log(`📊 Serving ${client.guilds.cache.size} servers`);
    console.log(`👥 ${client.users.cache.size} users`);
    console.log('═══════════════════════════════════════');
    
    client.user.setActivity('!help • Music Bot', { type: 2 });
    
    // ============ INITIALIZE KAZAGUMO AFTER CLIENT READY ============
    kazagumo = new Kazagumo(
        {
            defaultSearchEngine: 'youtube',
            send: (guildId, payload) => {
                const guild = client.guilds.cache.get(guildId);
                if (guild) guild.shard.send(payload);
            }
        },
        new Connectors.DiscordJS(client),
        Nodes,
        { 
            moveOnDisconnect: false, 
            resumable: false, 
            reconnectTries: 3, 
            restTimeout: 15000,
            voiceConnectionTimeout: 15000
        }
    );
    
    // ============ LAVALINK EVENTS ============
    kazagumo.shoukaku.on('ready', (name) => console.log(`✅ Lavalink ${name} connected!`));
    kazagumo.shoukaku.on('error', (name, error) => console.error(`❌ Lavalink ${name} error:`, error));
    kazagumo.shoukaku.on('close', (name, code, reason) => console.warn(`⚠️ Lavalink ${name} closed: ${code} - ${reason}`));
    
    // ============ PLAYER EVENTS ============
    kazagumo.on('playerStart', (player, track) => {
        const channel = client.channels.cache.get(player.textId);
        if (!channel) return;

        const embed = new EmbedBuilder()
            .setColor(BOT_INFO.color)
            .setAuthor({ name: 'Now Playing 🎵', iconURL: client.user.displayAvatarURL() })
            .setTitle(track.title)
            .setURL(track.uri)
            .setThumbnail(track.thumbnail || null)
            .addFields(
                { name: 'Duration', value: formatDuration(track.length), inline: true },
                { name: 'Author', value: track.author || 'Unknown', inline: true },
                { name: 'Requested by', value: `${track.requester}`, inline: true }
            )
            .setFooter({ text: `Volume: ${player.volume}%  •  ${BOT_INFO.name} v${BOT_INFO.version}` })
            .setTimestamp();

        channel.send({ embeds: [embed] });
    });

    kazagumo.on('playerEmpty', (player) => {
        const channel = client.channels.cache.get(player.textId);
        if (channel) {
            const embed = new EmbedBuilder()
                .setColor('#ff6b6b')
                .setDescription('⏹️ Queue finished. Disconnecting...')
                .setTimestamp();
            channel.send({ embeds: [embed] });
        }
        setTimeout(() => {
            player.destroy();
        }, 1000); // Delay destroy untuk menghindari error
    });

    kazagumo.on('playerError', (player, error) => {
        console.error('Player error:', error);
        const channel = client.channels.cache.get(player.textId);
        if (channel) {
            channel.send({ embeds: [errorEmbed('Failed to play track. Skipping...')] });
        }
    });

    kazagumo.on('playerException', (player, reason) => {
        console.error('Player exception:', reason);
        const channel = client.channels.cache.get(player.textId);
        if (channel) {
            channel.send({ embeds: [errorEmbed('An error occurred with the player.')] });
        }
    });
});

// ============ ERROR HANDLERS ============
client.on('error', (error) => console.error('Client error:', error));
client.on('shardError', (error) => console.error('Shard error:', error));

// ============ MESSAGE COMMANDS ============
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (!message.content.startsWith('!')) return;

    const args = message.content.slice(1).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    const validCommands = ['play', 'p', 'skip', 's', 'stop', 'pause', 'resume', 'queue', 'q', 'nowplaying', 'np', 'loop', 'volume', 'vol', 'seek', '8d', 'help', 'info', 'ping'];
    if (!validCommands.includes(command)) return;

    // Check if kazagumo is initialized for music commands
    if (['play', 'p', 'skip', 's', 'stop', 'pause', 'resume', 'queue', 'q', 'nowplaying', 'np', 'loop', 'volume', 'vol', 'seek', '8d'].includes(command)) {
        if (!kazagumo) {
            return message.reply({ embeds: [errorEmbed('Bot is still initializing. Please wait a moment...')] });
        }
    }

    // ==================== PLAY (FIXED) ====================
    if (command === 'play' || command === 'p') {
        if (!message.member.voice.channel) {
            return message.reply({ embeds: [errorEmbed('Join a voice channel first!')] });
        }

        const query = args.join(' ');
        if (!query) {
            return message.reply({ embeds: [errorEmbed('Please provide a song name or URL!\n`!play <song name/url>`')] });
        }

        try {
            let player = kazagumo.players.get(message.guild.id);

            if (!player) {
                player = await kazagumo.createPlayer({
                    guildId: message.guild.id,
                    textId: message.channel.id,
                    voiceId: message.member.voice.channel.id,
                    volume: 70,
                    deaf: true,
                    shardId: message.guild.shardId || 0
                });
            }

            // React with loading emoji
            await message.react('🔍');

            const result = await kazagumo.search(query, { requester: message.author });

            if (!result || !result.tracks.length) {
                await message.reactions.removeAll();
                return message.reply({ embeds: [errorEmbed('No results found!')] });
            }

            // Clear loading reaction
            await message.reactions.removeAll();

            if (result.type === 'PLAYLIST') {
                for (const track of result.tracks) {
                    player.queue.add(track);
                }
                const embed = new EmbedBuilder()
                    .setColor(BOT_INFO.color)
                    .setDescription(`📃 Added **${result.tracks.length}** tracks from **${result.playlistName}**`);
                await message.channel.send({ embeds: [embed] });
            } else {
                const track = result.tracks[0];
                player.queue.add(track);
                
                // Check if player is currently playing
                if (player.playing || player.paused) {
                    const embed = new EmbedBuilder()
                        .setColor(BOT_INFO.color)
                        .setDescription(`➕ Added to queue: **[${track.title}](${track.uri})**`)
                        .setThumbnail(track.thumbnail || null)
                        .addFields(
                            { name: 'Duration', value: formatDuration(track.length), inline: true },
                            { name: 'Position in queue', value: `#${player.queue.size}`, inline: true }
                        );
                    await message.channel.send({ embeds: [embed] });
                } else {
                    // If not playing, just send confirmation (playerStart event will handle the "Now Playing" message)
                    await message.react('▶️');
                }
            }

            // IMPORTANT FIX: Always try to play if not playing
            if (!player.playing && !player.paused) {
                await player.play();
            }

        } catch (error) {
            console.error('Play error:', error);
            await message.reactions.removeAll();
            message.reply({ embeds: [errorEmbed('An error occurred! Check if Lavalink is online.')] });
        }
    }

    // ==================== SKIP ====================
    if (command === 'skip' || command === 's') {
        const player = kazagumo.players.get(message.guild.id);
        if (!player?.queue.current) return message.reply({ embeds: [errorEmbed('Nothing to skip!')] });
        
        const skipped = player.queue.current;
        player.skip();
        
        const embed = new EmbedBuilder()
            .setColor(BOT_INFO.color)
            .setDescription(`⏭️ Skipped: **${skipped.title}**`);
        message.channel.send({ embeds: [embed] });
    }

    // ==================== STOP (FIXED) ====================
    if (command === 'stop') {
        const player = kazagumo.players.get(message.guild.id);
        if (!player) return message.reply({ embeds: [errorEmbed('Nothing is playing!')] });
        
        try {
            player.queue.clear();
            player.stop();
            setTimeout(() => {
                player.destroy();
            }, 500); // Small delay to prevent error
            
            message.react('⏹️');
            const embed = new EmbedBuilder()
                .setColor('#ff6b6b')
                .setDescription('⏹️ Stopped playback and cleared queue.');
            message.channel.send({ embeds: [embed] });
        } catch (error) {
            console.error('Stop error:', error);
            message.reply({ embeds: [errorEmbed('Error stopping player.')] });
        }
    }

    // ==================== PAUSE ====================
    if (command === 'pause') {
        const player = kazagumo.players.get(message.guild.id);
        if (!player) return message.reply({ embeds: [errorEmbed('Nothing is playing!')] });
        
        if (player.paused) {
            return message.reply({ embeds: [errorEmbed('Already paused!')] });
        }
        
        player.pause(true);
        message.react('⏸️');
        
        const embed = new EmbedBuilder()
            .setColor(BOT_INFO.color)
            .setDescription('⏸️ Paused playback.');
        message.channel.send({ embeds: [embed] });
    }

    // ==================== RESUME ====================
    if (command === 'resume') {
        const player = kazagumo.players.get(message.guild.id);
        if (!player) return message.reply({ embeds: [errorEmbed('Nothing is playing!')] });
        
        if (!player.paused) {
            return message.reply({ embeds: [errorEmbed('Not paused!')] });
        }
        
        player.pause(false);
        message.react('▶️');
        
        const embed = new EmbedBuilder()
            .setColor(BOT_INFO.color)
            .setDescription('▶️ Resumed playback.');
        message.channel.send({ embeds: [embed] });
    }

    // ==================== QUEUE ====================
    if (command === 'queue' || command === 'q') {
        const player = kazagumo.players.get(message.guild.id);
        if (!player?.queue.current) return message.reply({ embeds: [errorEmbed('Queue is empty!')] });

        const current = player.queue.current;
        const queue = player.queue;

        let description = `**Now Playing:**\n[${current.title}](${current.uri}) • \`${formatDuration(current.length)}\`\n\n`;

        if (queue.size > 0) {
            description += `**Up Next:**\n`;
            const tracks = Array.from(queue);
            tracks.slice(0, 10).forEach((track, i) => {
                description += `\`${i + 1}.\` [${track.title}](${track.uri}) • \`${formatDuration(track.length)}\`\n`;
            });
            if (queue.size > 10) description += `\n*...and ${queue.size - 10} more*`;
        }

        const embed = new EmbedBuilder()
            .setColor(BOT_INFO.color)
            .setAuthor({ name: `Queue • ${message.guild.name}`, iconURL: message.guild.iconURL() })
            .setDescription(description)
            .setFooter({ text: `${queue.size + 1} tracks • Volume: ${player.volume}%` });

        message.channel.send({ embeds: [embed] });
    }

    // ==================== NOW PLAYING ====================
    if (command === 'nowplaying' || command === 'np') {
        const player = kazagumo.players.get(message.guild.id);
        if (!player?.queue.current) return message.reply({ embeds: [errorEmbed('Nothing is playing!')] });

        const current = player.queue.current;
        const position = player.position;
        const duration = current.length;

        const progress = duration ? Math.round((position / duration) * 15) : 0;
        const bar = '▬'.repeat(progress) + '🔘' + '▬'.repeat(15 - progress);

        const embed = new EmbedBuilder()
            .setColor(BOT_INFO.color)
            .setAuthor({ name: 'Now Playing', iconURL: client.user.displayAvatarURL() })
            .setTitle(current.title)
            .setURL(current.uri)
            .setThumbnail(current.thumbnail)
            .addFields(
                { name: 'Author', value: current.author || 'Unknown', inline: true },
                { name: 'Requested by', value: `${current.requester}`, inline: true },
                { name: 'Volume', value: `${player.volume}%`, inline: true }
            )
            .setDescription(`\`${formatDuration(position)}\` ${bar} \`${formatDuration(duration)}\``)
            .setFooter({ text: `Loop: ${player.loop || 'Off'} • Queue: ${player.queue.size} songs` });

        message.channel.send({ embeds: [embed] });
    }

    // ==================== LOOP ====================
    if (command === 'loop') {
        const player = kazagumo.players.get(message.guild.id);
        if (!player) return message.reply({ embeds: [errorEmbed('Nothing is playing!')] });

        const mode = args[0]?.toLowerCase();
        if (!mode || !['track', 'queue', 'off'].includes(mode)) {
            return message.reply({ embeds: [errorEmbed('Usage: `!loop <track/queue/off>`')] });
        }

        player.setLoop(mode === 'off' ? 'none' : mode);
        
        const icons = { track: '🔂', queue: '🔁', off: '➡️' };
        message.channel.send({ embeds: [successEmbed(`${icons[mode]} Loop: **${mode.charAt(0).toUpperCase() + mode.slice(1)}**`)] });
    }

    // ==================== VOLUME ====================
    if (command === 'volume' || command === 'vol') {
        const player = kazagumo.players.get(message.guild.id);
        if (!player) return message.reply({ embeds: [errorEmbed('Nothing is playing!')] });

        if (!args[0]) {
            return message.channel.send({ embeds: [successEmbed(`🔊 Current volume: **${player.volume}%**`)] });
        }

        const volume = parseInt(args[0]);
        if (isNaN(volume) || volume < 0 || volume > 100) {
            return message.reply({ embeds: [errorEmbed('Volume must be between 0-100')] });
        }

        player.setVolume(volume);
        const icon = volume === 0 ? '🔇' : volume < 50 ? '🔉' : '🔊';
        message.channel.send({ embeds: [successEmbed(`${icon} Volume set to **${volume}%**`)] });
    }

    // ==================== SEEK ====================
    if (command === 'seek') {
        const player = kazagumo.players.get(message.guild.id);
        if (!player?.queue.current) return message.reply({ embeds: [errorEmbed('Nothing is playing!')] });

        const time = args[0];
        if (!time) return message.reply({ embeds: [errorEmbed('Usage: `!seek <1:30>` or `!seek <90>`')] });

        let ms;
        if (time.includes(':')) {
            const parts = time.split(':').map(Number);
            ms = parts.length === 2 ? (parts[0] * 60 + parts[1]) * 1000 : (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
        } else {
            ms = parseInt(time) * 1000;
        }

        if (isNaN(ms) || ms < 0 || ms > player.queue.current.length) {
            return message.reply({ embeds: [errorEmbed('Invalid time!')] });
        }

        player.seek(ms);
        message.channel.send({ embeds: [successEmbed(`⏩ Seeked to **${formatDuration(ms)}**`)] });
    }

    // ==================== 8D ====================
    if (command === '8d') {
        const player = kazagumo.players.get(message.guild.id);
        if (!player) return message.reply({ embeds: [errorEmbed('Nothing is playing!')] });

        const isEnabled = player.rotation?.rotationHz;
        if (isEnabled) {
            player.setRotation({ rotationHz: 0 });
            message.channel.send({ embeds: [successEmbed('🎧 8D Audio: **Off**')] });
        } else {
            player.setRotation({ rotationHz: 0.2 });
            message.channel.send({ embeds: [successEmbed('🎧 8D Audio: **On** (Use headphones for best experience!)')] });
        }
    }

    // ==================== HELP ====================
    if (command === 'help') {
        const embed = new EmbedBuilder()
            .setColor(BOT_INFO.color)
            .setAuthor({ name: BOT_INFO.name, iconURL: client.user.displayAvatarURL() })
            .setDescription(BOT_INFO.description)
            .addFields(
                {
                    name: '🎵 Music Commands',
                    value: '```\n!play <song/URL>  - Play a song\n!skip             - Skip current song\n!stop             - Stop & disconnect\n!pause            - Pause playback\n!resume           - Resume playback\n```',
                    inline: false
                },
                {
                    name: '📋 Queue Commands',
                    value: '```\n!queue            - Show queue\n!nowplaying       - Current song info\n!loop <mode>      - Loop track/queue/off\n```',
                    inline: false
                },
                {
                    name: '🎛️ Control Commands',
                    value: '```\n!volume <0-100>   - Set volume\n!seek <time>      - Seek to time\n!8d               - Toggle 8D audio\n```',
                    inline: false
                },
                {
                    name: '📌 Aliases',
                    value: '`!p` = play | `!s` = skip | `!q` = queue | `!np` = nowplaying | `!vol` = volume',
                    inline: false
                }
            )
            .setFooter({ text: `Made by ${BOT_INFO.owner.display} • v${BOT_INFO.version}` })
            .setTimestamp();

        message.channel.send({ embeds: [embed] });
    }

    // ==================== INFO ====================
    if (command === 'info') {
        const uptime = process.uptime();
        const hours = Math.floor(uptime / 3600);
        const minutes = Math.floor((uptime % 3600) / 60);
        const seconds = Math.floor(uptime % 60);

        const embed = new EmbedBuilder()
            .setColor(BOT_INFO.color)
            .setAuthor({ name: BOT_INFO.name, iconURL: client.user.displayAvatarURL() })
            .setDescription(BOT_INFO.description)
            .addFields(
                { name: '👨‍💻 Developer', value: `<@${BOT_INFO.owner.id}>`, inline: true },
                { name: '📊 Servers', value: `${client.guilds.cache.size}`, inline: true },
                { name: '⏱️ Uptime', value: `${hours}h ${minutes}m ${seconds}s`, inline: true },
                { name: '🏷️ Version', value: BOT_INFO.version, inline: true },
                { name: '📚 Library', value: 'Discord.js v14', inline: true },
                { name: '🎵 Audio', value: kazagumo ? `${kazagumo.shoukaku.nodes.size} Lavalink nodes` : 'Initializing...', inline: true },
                { name: '📝 Prefix', value: '`!`', inline: true },
                { name: '💾 Memory', value: `${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)} MB`, inline: true },
                { name: '🏓 Ping', value: `${client.ws.ping}ms`, inline: true }
            )
            .setFooter({ text: `Requested by ${message.author.tag}` })
            .setTimestamp();

        message.channel.send({ embeds: [embed] });
    }

    // ==================== PING ====================
    if (command === 'ping') {
        const msg = await message.channel.send('🏓 Pinging...');
        const latency = msg.createdTimestamp - message.createdTimestamp;
        
        const embed = new EmbedBuilder()
            .setColor(BOT_INFO.color)
            .setTitle('🏓 Pong!')
            .addFields(
                { name: '📡 Bot Latency', value: `\`${latency}ms\``, inline: true },
                { name: '💓 API Latency', value: `\`${Math.round(client.ws.ping)}ms\``, inline: true }
            );
        
        msg.edit({ content: null, embeds: [embed] });
    }
});

// ============ GLOBAL ERROR HANDLERS ============
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
});

// ============ LOGIN ============
const token = process.env.DISCORD_TOKEN;

if (!token) {
    console.error('❌ DISCORD_TOKEN not found in environment!');
    console.error('Please set DISCORD_TOKEN in your environment variables');
    process.exit(1);
}

console.log('🔄 Logging in to Discord...');

client.login(token)
    .then(() => console.log('✅ Login successful!'))
    .catch((error) => {
        console.error('❌ Login failed:', error.message);
        process.exit(1);
    });
