const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const { Connectors } = require('shoukaku');
const { Kazagumo } = require('kazagumo');
const express = require('express');
const Redis = require('ioredis');
require('dotenv').config();

// ============ BOT INFO ============
const BOT_INFO = {
    name: 'Melodify',
    version: '1.2.0',
    description: 'High quality Discord music bot with persistent data.',
    owner: {
        id: '1307489983359357019',
        username: 'demisz_dc',
        display: 'Demisz'
    },
    color: '#5865F2'
};

// ============ REDIS SETUP ============
const redis = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: 3,
    retryDelayOnFailover: 1000,
    retryStrategy(times) {
        if (times > 5) {
            console.error('❌ Redis: Max retries reached');
            return null;
        }
        return Math.min(times * 500, 3000);
    },
    reconnectOnError(err) {
        console.error('Redis reconnect error:', err.message);
        return true;
    }
});

redis.on('connect', () => console.log('✅ Redis connected!'));
redis.on('error', (err) => console.error('❌ Redis error:', err.message));
redis.on('reconnecting', () => console.log('🔄 Redis reconnecting...'));

// ============ DATABASE MANAGER ============
// Semua fungsi untuk simpan/ambil data dari Redis
const db = {
    // ====== GUILD SETTINGS ======
    // Volume, DJ role, default search engine, dll per server
    async getGuildSettings(guildId) {
        try {
            const data = await redis.get(`guild:${guildId}:settings`);
            return data ? JSON.parse(data) : {
                volume: 70,
                defaultSearch: 'youtube',
                djRole: null,
                announceNowPlaying: true,
                autoLeaveTimeout: 120000,   // 2 menit
                maxQueueSize: 500,
                allowDuplicates: true
            };
        } catch (err) {
            console.error('Redis getGuildSettings error:', err.message);
            return { volume: 70, defaultSearch: 'youtube', djRole: null, announceNowPlaying: true, autoLeaveTimeout: 120000, maxQueueSize: 500, allowDuplicates: true };
        }
    },

    async setGuildSettings(guildId, settings) {
        try {
            await redis.set(`guild:${guildId}:settings`, JSON.stringify(settings));
        } catch (err) {
            console.error('Redis setGuildSettings error:', err.message);
        }
    },

    async updateGuildSetting(guildId, key, value) {
        try {
            const settings = await this.getGuildSettings(guildId);
            settings[key] = value;
            await this.setGuildSettings(guildId, settings);
            return settings;
        } catch (err) {
            console.error('Redis updateGuildSetting error:', err.message);
        }
    },

    // ====== SAVED QUEUES / PLAYLISTS ======
    // User bisa simpan queue dan load lagi nanti
    async savePlaylist(userId, name, tracks) {
        try {
            const playlists = await this.getUserPlaylists(userId);
            playlists[name] = {
                tracks: tracks.map(t => ({
                    title: t.title,
                    uri: t.uri,
                    author: t.author,
                    length: t.length,
                    thumbnail: t.thumbnail,
                    source: t.sourceName || 'youtube'
                })),
                createdAt: Date.now(),
                trackCount: tracks.length
            };
            await redis.set(`user:${userId}:playlists`, JSON.stringify(playlists));
            // Expire setelah 90 hari jika tidak diakses
            await redis.expire(`user:${userId}:playlists`, 7776000);
            return true;
        } catch (err) {
            console.error('Redis savePlaylist error:', err.message);
            return false;
        }
    },

    async getUserPlaylists(userId) {
        try {
            const data = await redis.get(`user:${userId}:playlists`);
            return data ? JSON.parse(data) : {};
        } catch (err) {
            console.error('Redis getUserPlaylists error:', err.message);
            return {};
        }
    },

    async deletePlaylist(userId, name) {
        try {
            const playlists = await this.getUserPlaylists(userId);
            if (!playlists[name]) return false;
            delete playlists[name];
            await redis.set(`user:${userId}:playlists`, JSON.stringify(playlists));
            return true;
        } catch (err) {
            console.error('Redis deletePlaylist error:', err.message);
            return false;
        }
    },

    // ====== SAVED QUEUE (auto-save saat bot restart) ======
    // Simpan queue yang sedang playing supaya bisa di-restore
    async saveCurrentQueue(guildId, playerData) {
        try {
            await redis.set(`guild:${guildId}:savedqueue`, JSON.stringify(playerData));
            await redis.expire(`guild:${guildId}:savedqueue`, 86400); // 24 jam
        } catch (err) {
            console.error('Redis saveCurrentQueue error:', err.message);
        }
    },

    async getSavedQueue(guildId) {
        try {
            const data = await redis.get(`guild:${guildId}:savedqueue`);
            return data ? JSON.parse(data) : null;
        } catch (err) {
            console.error('Redis getSavedQueue error:', err.message);
            return null;
        }
    },

    async deleteSavedQueue(guildId) {
        try {
            await redis.del(`guild:${guildId}:savedqueue`);
        } catch (err) {
            console.error('Redis deleteSavedQueue error:', err.message);
        }
    },

    // ====== PLAY HISTORY ======
    // Track lagu yang pernah diputar per server
    async addToHistory(guildId, track) {
        try {
            const entry = JSON.stringify({
                title: track.title,
                uri: track.uri,
                author: track.author,
                length: track.length,
                requestedBy: track.requester?.tag || 'Unknown',
                playedAt: Date.now()
            });
            // Simpan max 50 lagu terakhir
            await redis.lpush(`guild:${guildId}:history`, entry);
            await redis.ltrim(`guild:${guildId}:history`, 0, 49);
            await redis.expire(`guild:${guildId}:history`, 2592000); // 30 hari
        } catch (err) {
            console.error('Redis addToHistory error:', err.message);
        }
    },

    async getHistory(guildId, limit = 10) {
        try {
            const data = await redis.lrange(`guild:${guildId}:history`, 0, limit - 1);
            return data.map(d => JSON.parse(d));
        } catch (err) {
            console.error('Redis getHistory error:', err.message);
            return [];
        }
    },

    // ====== FAVORITE TRACKS (per user) ======
    async addFavorite(userId, track) {
        try {
            const favorites = await this.getFavorites(userId);
            // Cek duplikat
            if (favorites.find(f => f.uri === track.uri)) return false;
            favorites.push({
                title: track.title,
                uri: track.uri,
                author: track.author,
                length: track.length,
                addedAt: Date.now()
            });
            // Max 100 favorites
            if (favorites.length > 100) favorites.shift();
            await redis.set(`user:${userId}:favorites`, JSON.stringify(favorites));
            await redis.expire(`user:${userId}:favorites`, 7776000); // 90 hari
            return true;
        } catch (err) {
            console.error('Redis addFavorite error:', err.message);
            return false;
        }
    },

    async getFavorites(userId) {
        try {
            const data = await redis.get(`user:${userId}:favorites`);
            return data ? JSON.parse(data) : [];
        } catch (err) {
            console.error('Redis getFavorites error:', err.message);
            return [];
        }
    },

    async removeFavorite(userId, index) {
        try {
            const favorites = await this.getFavorites(userId);
            if (index < 0 || index >= favorites.length) return false;
            favorites.splice(index, 1);
            await redis.set(`user:${userId}:favorites`, JSON.stringify(favorites));
            return true;
        } catch (err) {
            console.error('Redis removeFavorite error:', err.message);
            return false;
        }
    },

    // ====== STATS ======
    async incrementStat(key) {
        try {
            await redis.incr(`stats:${key}`);
        } catch (err) {
            console.error('Redis incrementStat error:', err.message);
        }
    },

    async getStats() {
        try {
            const songsPlayed = await redis.get('stats:songs_played') || '0';
            const commandsUsed = await redis.get('stats:commands_used') || '0';
            return {
                songsPlayed: parseInt(songsPlayed),
                commandsUsed: parseInt(commandsUsed)
            };
        } catch (err) {
            console.error('Redis getStats error:', err.message);
            return { songsPlayed: 0, commandsUsed: 0 };
        }
    }
};

// ============ EXPRESS SERVER ============
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => res.status(200).send('Bot is running'));
app.get('/health', (req, res) => res.status(200).json({
    status: 'ok',
    uptime: process.uptime(),
    redis: redis.status
}));

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
        name: 'Serenetia',
        url: 'lavalinkv4.serenetia.com:443',
        auth: 'https://dsc.gg/ajidevserver',
        secure: true
    }
];

// ============ KAZAGUMO SETUP ============
const kazagumo = new Kazagumo(
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
        restTimeout: 15000
    }
);

// ============ LAVALINK EVENTS ============
kazagumo.shoukaku.on('ready', (name) => console.log(`✅ Lavalink ${name} connected!`));
kazagumo.shoukaku.on('error', (name, error) => console.error(`❌ Lavalink ${name} error:`, error.message));
kazagumo.shoukaku.on('close', (name, code, reason) => console.warn(`⚠️ Lavalink ${name} closed: ${code} - ${reason}`));
kazagumo.shoukaku.on('disconnect', (name) => console.warn(`🔌 Lavalink ${name} disconnected`));

// ============ PLAYER EVENTS ============
const disconnectTimers = new Map();

kazagumo.on('playerStart', async (player, track) => {
    if (disconnectTimers.has(player.guildId)) {
        clearTimeout(disconnectTimers.get(player.guildId));
        disconnectTimers.delete(player.guildId);
    }

    // Simpan ke history & increment stats
    await db.addToHistory(player.guildId, track);
    await db.incrementStat('songs_played');

    // Auto-save queue setiap lagu mulai
    await autoSaveQueue(player);

    const settings = await db.getGuildSettings(player.guildId);
    if (!settings.announceNowPlaying) return;

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
        .setFooter({ text: `Volume: ${player.volume}%  •  Queue: ${player.queue.length} tracks` })
        .setTimestamp();

    channel.send({ embeds: [embed] });
});

kazagumo.on('playerEmpty', (player) => {
    const channel = client.channels.cache.get(player.textId);
    if (channel) {
        const embed = new EmbedBuilder()
            .setColor('#FFA500')
            .setDescription('⏸️ Queue finished. Add more songs with `!play`\n*Leaving in 2 minutes if no songs added.*')
            .setTimestamp();
        channel.send({ embeds: [embed] });
    }

    const timer = setTimeout(async () => {
        if (player && !player.queue.current && player.queue.length === 0) {
            if (channel) {
                const embed = new EmbedBuilder()
                    .setColor('#ff6b6b')
                    .setDescription('⏹️ Left due to inactivity.')
                    .setTimestamp();
                channel.send({ embeds: [embed] });
            }
            await db.deleteSavedQueue(player.guildId);
            player.destroy();
        }
        disconnectTimers.delete(player.guildId);
    }, 120000);

    disconnectTimers.set(player.guildId, timer);
});

kazagumo.on('playerError', (player, error, track) => {
    console.error('Player error:', error);
    const channel = client.channels.cache.get(player.textId);
    if (channel) {
        channel.send({ embeds: [errorEmbed(`Failed to play: ${track?.title || 'Unknown track'}\nSkipping...`)] });
    }
    if (player.queue.length > 0) {
        setTimeout(() => player.skip(), 1000);
    }
});

kazagumo.on('playerDestroy', async (player) => {
    if (disconnectTimers.has(player.guildId)) {
        clearTimeout(disconnectTimers.get(player.guildId));
        disconnectTimers.delete(player.guildId);
    }
});

// ============ AUTO SAVE QUEUE ============
async function autoSaveQueue(player) {
    try {
        if (!player?.queue?.current) return;

        const queueData = {
            guildId: player.guildId,
            textId: player.textId,
            voiceId: player.voiceId,
            volume: player.volume,
            loop: player.loop || 'none',
            current: {
                title: player.queue.current.title,
                uri: player.queue.current.uri,
                author: player.queue.current.author,
                length: player.queue.current.length,
                thumbnail: player.queue.current.thumbnail
            },
            queue: player.queue.map(t => ({
                title: t.title,
                uri: t.uri,
                author: t.author,
                length: t.length,
                thumbnail: t.thumbnail
            })),
            savedAt: Date.now()
        };

        await db.saveCurrentQueue(player.guildId, queueData);
    } catch (err) {
        console.error('Auto-save queue error:', err.message);
    }
}

// ============ BOT READY ============
client.once('ready', async () => {
    console.log('═══════════════════════════════════════');
    console.log(`✅ ${client.user.tag} is online!`);
    console.log(`📊 Serving ${client.guilds.cache.size} servers`);
    console.log(`💾 Redis: ${redis.status}`);
    console.log('═══════════════════════════════════════');

    client.user.setActivity('!help • Music Bot', { type: 2 });
});

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

function isURL(string) {
    const urlPatterns = [
        /^https?:\/\//i, /^(www\.)?youtube\.com/i, /^youtu\.be\//i,
        /^music\.youtube\.com/i, /^(www\.)?spotify\.com/i, /^open\.spotify\.com/i,
        /^(www\.)?soundcloud\.com/i, /^(www\.)?bandcamp\.com/i,
        /^(www\.)?twitch\.tv/i, /^(www\.)?vimeo\.com/i
    ];
    return urlPatterns.some(pattern => pattern.test(string));
}

// ============ BULK ADD HELPER ============
async function addMultipleTracks(kazagumo, player, queries, requester, channel) {
    let added = 0;
    let failed = 0;
    const failedTracks = [];
    const addedTracks = [];

    const statusMsg = await channel.send({
        embeds: [
            new EmbedBuilder()
                .setColor('#FFA500')
                .setDescription(`⏳ Processing **${queries.length}** songs... Please wait.`)
        ]
    });

    for (let i = 0; i < queries.length; i++) {
        const query = queries[i].trim();
        if (!query || query.length === 0) continue;

        try {
            let searchQuery;
            if (isURL(query)) {
                searchQuery = query;
            } else if (query.startsWith('ytsearch:') || query.startsWith('scsearch:')) {
                searchQuery = query;
            } else {
                searchQuery = `ytsearch:${query}`;
            }

            const result = await kazagumo.search(searchQuery, { requester });

            if (!result || !result.tracks || result.tracks.length === 0) {
                failed++;
                failedTracks.push(query);
                continue;
            }

            if (result.type === 'PLAYLIST') {
                for (const track of result.tracks) {
                    player.queue.add(track);
                    added++;
                }
                addedTracks.push(`📃 ${result.playlistName} (${result.tracks.length} tracks)`);
            } else {
                const track = result.tracks[0];
                player.queue.add(track);
                added++;
                addedTracks.push(`🎵 ${track.title}`);
            }

            if ((i + 1) % 5 === 0 || i === queries.length - 1) {
                await statusMsg.edit({
                    embeds: [
                        new EmbedBuilder()
                            .setColor('#FFA500')
                            .setDescription(
                                `⏳ Processing... **${i + 1}/${queries.length}**\n` +
                                `✅ Added: **${added}** | ❌ Failed: **${failed}**`
                            )
                    ]
                }).catch(() => {});
            }

            await new Promise(resolve => setTimeout(resolve, 300));

        } catch (error) {
            console.error(`[MULTI] Error loading "${query}":`, error.message);
            failed++;
            failedTracks.push(query);
        }
    }

    let description = `✅ Successfully added **${added}** tracks to queue!\n`;
    if (failed > 0) description += `❌ Failed: **${failed}** tracks\n`;

    if (addedTracks.length > 0) {
        description += `\n**Added:**\n`;
        addedTracks.slice(0, 15).forEach((t, i) => {
            description += `\`${i + 1}.\` ${t}\n`;
        });
        if (addedTracks.length > 15) description += `*...and ${addedTracks.length - 15} more*\n`;
    }

    if (failedTracks.length > 0) {
        description += `\n**Failed:**\n`;
        failedTracks.slice(0, 5).forEach(t => { description += `• ${t}\n`; });
        if (failedTracks.length > 5) description += `*...and ${failedTracks.length - 5} more*\n`;
    }

    const resultEmbed = new EmbedBuilder()
        .setColor(failed === 0 ? BOT_INFO.color : '#FFA500')
        .setAuthor({ name: 'Bulk Queue Add', iconURL: client.user.displayAvatarURL() })
        .setDescription(description)
        .setFooter({ text: `Total in queue: ${player.queue.length} tracks` })
        .setTimestamp();

    await statusMsg.edit({ embeds: [resultEmbed] });
    return { added, failed };
}

// ============ GET OR CREATE PLAYER ============
async function getOrCreatePlayer(kazagumo, message) {
    let player = kazagumo.players.get(message.guild.id);

    if (!player) {
        const settings = await db.getGuildSettings(message.guild.id);
        player = await kazagumo.createPlayer({
            guildId: message.guild.id,
            textId: message.channel.id,
            voiceId: message.member.voice.channel.id,
            volume: settings.volume,  // Pakai volume dari Redis!
            deaf: true,
            shardId: message.guild.shardId
        });
    }

    return player;
}

// ============ MESSAGE COMMANDS ============
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (!message.content.startsWith('!')) return;

    const args = message.content.slice(1).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    const validCommands = [
        'play', 'p', 'playmulti', 'pm', 'playfile', 'pf', 'playlist', 'pl',
        'skip', 's', 'stop', 'pause', 'resume',
        'queue', 'q', 'nowplaying', 'np', 'loop', 'volume', 'vol', 'seek',
        '8d', 'remove', 'rm', 'clear', 'shuffle',
        'save', 'load', 'saved', 'deletelist',       // BARU: playlist management
        'fav', 'favlist', 'unfav', 'playfav',         // BARU: favorites
        'history',                                     // BARU: history
        'restore',                                     // BARU: restore queue
        'settings',                                    // BARU: server settings
        'help', 'info', 'ping'
    ];

    if (!validCommands.includes(command)) return;

    // Increment command stats
    await db.incrementStat('commands_used');

    // ==================== PLAY ====================
    if (command === 'play' || command === 'p') {
        if (!message.member.voice.channel) {
            return message.reply({ embeds: [errorEmbed('Join a voice channel first!')] });
        }

        const query = args.join(' ');
        if (!query) {
            return message.reply({
                embeds: [errorEmbed(
                    'Please provide a song name or URL!\n\n' +
                    '`!play <song>` - Single song\n' +
                    '`!pm <song1>, <song2>` - Multiple songs\n' +
                    '`!pf` - From text file\n' +
                    '`!load <name>` - Load saved playlist'
                )]
            });
        }

        try {
            const player = await getOrCreatePlayer(kazagumo, message);

            let searchQuery;
            if (isURL(query)) {
                searchQuery = query;
            } else if (query.startsWith('ytsearch:') || query.startsWith('scsearch:')) {
                searchQuery = query;
            } else {
                searchQuery = `ytsearch:${query}`;
            }

            const result = await kazagumo.search(searchQuery, { requester: message.author });

            if (!result || !result.tracks || result.tracks.length === 0) {
                return message.reply({ embeds: [errorEmbed('No results found!')] });
            }

            if (result.type === 'PLAYLIST') {
                for (const track of result.tracks) {
                    player.queue.add(track);
                }
                message.channel.send({
                    embeds: [new EmbedBuilder().setColor(BOT_INFO.color).setDescription(`📃 Added **${result.tracks.length}** tracks from **${result.playlistName}**`)]
                });
            } else {
                const track = result.tracks[0];
                player.queue.add(track);
                if (player.playing || player.paused) {
                    message.channel.send({
                        embeds: [new EmbedBuilder().setColor(BOT_INFO.color)
                            .setDescription(`➕ Added to queue: **${track.title}**`)
                            .setFooter({ text: `Duration: ${formatDuration(track.length)} • By: ${track.author}` })]
                    });
                }
            }

            if (!player.playing && !player.paused) {
                await player.play();
            }

        } catch (error) {
            console.error('[PLAY] Error:', error);
            message.reply({ embeds: [errorEmbed(`Error: ${error.message}`)] });
        }
    }

    // ==================== PLAY MULTI ====================
    if (command === 'playmulti' || command === 'pm') {
        if (!message.member.voice.channel) {
            return message.reply({ embeds: [errorEmbed('Join a voice channel first!')] });
        }

        const fullQuery = args.join(' ');
        if (!fullQuery) {
            return message.reply({
                embeds: [errorEmbed(
                    '**Usage:** `!pm <song1>, <song2>, <song3>`\n\n' +
                    '**Example:**\n' +
                    '```\n!pm Never Gonna Give You Up, Bohemian Rhapsody, Hotel California\n```\n' +
                    '💡 Separator: `,` atau `;` atau `|`\n' +
                    '💡 Max 50 lagu sekaligus'
                )]
            });
        }

        let separator;
        if (fullQuery.includes(',')) separator = ',';
        else if (fullQuery.includes(';')) separator = ';';
        else if (fullQuery.includes('|')) separator = '|';
        else {
            return message.reply({ embeds: [errorEmbed('Separate songs with `,`\nExample: `!pm Song One, Song Two, Song Three`')] });
        }

        const queries = fullQuery.split(separator).map(q => q.trim()).filter(q => q.length > 0);

        if (queries.length <= 1) {
            return message.reply({ embeds: [errorEmbed('Use `!play` for single songs. Separate with `,` for multiple.')] });
        }
        if (queries.length > 50) {
            return message.reply({ embeds: [errorEmbed('Maximum 50 songs! Use `!pf` with a text file for more.')] });
        }

        try {
            const player = await getOrCreatePlayer(kazagumo, message);
            await addMultipleTracks(kazagumo, player, queries, message.author, message.channel);
            if (!player.playing && !player.paused && player.queue.length > 0) await player.play();
        } catch (error) {
            console.error('[PLAYMULTI] Error:', error);
            message.reply({ embeds: [errorEmbed(`Error: ${error.message}`)] });
        }
    }

    // ==================== PLAY FILE ====================
    if (command === 'playfile' || command === 'pf') {
        if (!message.member.voice.channel) {
            return message.reply({ embeds: [errorEmbed('Join a voice channel first!')] });
        }

        const attachment = message.attachments.first();
        if (!attachment) {
            return message.reply({
                embeds: [errorEmbed(
                    '**Upload a `.txt` file with `!pf`**\n\n' +
                    'File format (one song per line):\n```\nSong One\nhttps://youtu.be/xxx\nSong Three\n```'
                )]
            });
        }

        if (!attachment.name.endsWith('.txt')) {
            return message.reply({ embeds: [errorEmbed('Only `.txt` files!')] });
        }
        if (attachment.size > 50000) {
            return message.reply({ embeds: [errorEmbed('File too large! Max 50KB.')] });
        }

        try {
            const response = await fetch(attachment.url);
            const text = await response.text();
            const queries = text.split('\n').map(l => l.trim()).filter(l => l.length > 0 && !l.startsWith('#') && !l.startsWith('//'));

            if (queries.length === 0) return message.reply({ embeds: [errorEmbed('File is empty!')] });
            if (queries.length > 100) return message.reply({ embeds: [errorEmbed(`Too many songs (${queries.length}). Max 100!`)] });

            const player = await getOrCreatePlayer(kazagumo, message);
            await addMultipleTracks(kazagumo, player, queries, message.author, message.channel);
            if (!player.playing && !player.paused && player.queue.length > 0) await player.play();

        } catch (error) {
            console.error('[PLAYFILE] Error:', error);
            message.reply({ embeds: [errorEmbed(`Error: ${error.message}`)] });
        }
    }

    // ==================== PLAYLIST URL ====================
    if (command === 'playlist' || command === 'pl') {
        if (!message.member.voice.channel) {
            return message.reply({ embeds: [errorEmbed('Join a voice channel first!')] });
        }

        const query = args.join(' ');
        if (!query || !isURL(query)) {
            return message.reply({ embeds: [errorEmbed('Usage: `!pl <playlist URL>`')] });
        }

        try {
            const player = await getOrCreatePlayer(kazagumo, message);
            const statusMsg = await message.channel.send({ embeds: [new EmbedBuilder().setColor('#FFA500').setDescription('⏳ Loading playlist...')] });

            const result = await kazagumo.search(query, { requester: message.author });
            if (!result?.tracks?.length) return statusMsg.edit({ embeds: [errorEmbed('Playlist not found or empty!')] });

            for (const track of result.tracks) player.queue.add(track);

            await statusMsg.edit({
                embeds: [new EmbedBuilder().setColor(BOT_INFO.color)
                    .setDescription(`📃 **${result.playlistName || 'Playlist'}**\n✅ Added **${result.tracks.length}** tracks`)
                    .setTimestamp()]
            });

            if (!player.playing && !player.paused) await player.play();
        } catch (error) {
            console.error('[PLAYLIST] Error:', error);
            message.reply({ embeds: [errorEmbed(`Error: ${error.message}`)] });
        }
    }

    // ==================== SKIP ====================
    if (command === 'skip' || command === 's') {
        const player = kazagumo.players.get(message.guild.id);
        if (!player?.queue.current) return message.reply({ embeds: [errorEmbed('Nothing to skip!')] });
        player.skip();
        message.react('⏭️');
    }

    // ==================== STOP ====================
    if (command === 'stop') {
        const player = kazagumo.players.get(message.guild.id);
        if (!player) return message.reply({ embeds: [errorEmbed('Nothing is playing!')] });
        await db.deleteSavedQueue(message.guild.id);
        player.destroy();
        message.react('⏹️');
    }

    // ==================== PAUSE ====================
    if (command === 'pause') {
        const player = kazagumo.players.get(message.guild.id);
        if (!player) return message.reply({ embeds: [errorEmbed('Nothing is playing!')] });
        player.pause(true);
        message.react('⏸️');
    }

    // ==================== RESUME ====================
    if (command === 'resume') {
        const player = kazagumo.players.get(message.guild.id);
        if (!player) return message.reply({ embeds: [errorEmbed('Nothing is playing!')] });
        player.pause(false);
        message.react('▶️');
    }

    // ==================== QUEUE ====================
    if (command === 'queue' || command === 'q') {
        const player = kazagumo.players.get(message.guild.id);
        if (!player?.queue.current) return message.reply({ embeds: [errorEmbed('Queue is empty!')] });

        const current = player.queue.current;
        const queue = player.queue;
        const page = parseInt(args[0]) || 1;
        const itemsPerPage = 10;
        const totalPages = Math.ceil(queue.length / itemsPerPage) || 1;
        const currentPage = Math.min(page, totalPages);

        let description = `**Now Playing:**\n[${current.title}](${current.uri}) • \`${formatDuration(current.length)}\`\n\n`;

        if (queue.length > 0) {
            description += `**Up Next:**\n`;
            const start = (currentPage - 1) * itemsPerPage;
            const end = Math.min(start + itemsPerPage, queue.length);
            for (let i = start; i < end; i++) {
                description += `\`${i + 1}.\` [${queue[i].title}](${queue[i].uri}) • \`${formatDuration(queue[i].length)}\`\n`;
            }
            if (totalPages > 1) description += `\n📄 Page **${currentPage}/${totalPages}** • \`!queue <page>\``;
        }

        let totalDuration = current.length || 0;
        for (const track of queue) totalDuration += track.length || 0;

        const embed = new EmbedBuilder()
            .setColor(BOT_INFO.color)
            .setAuthor({ name: `Queue • ${message.guild.name}`, iconURL: message.guild.iconURL() })
            .setDescription(description)
            .setFooter({ text: `${queue.length + 1} tracks • Total: ${formatDuration(totalDuration)} • Vol: ${player.volume}%` });

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
            .setTitle(current.title).setURL(current.uri).setThumbnail(current.thumbnail)
            .addFields(
                { name: 'Author', value: current.author || 'Unknown', inline: true },
                { name: 'Requested by', value: `${current.requester}`, inline: true },
                { name: 'Volume', value: `${player.volume}%`, inline: true }
            )
            .setDescription(`\`${formatDuration(position)}\` ${bar} \`${formatDuration(duration)}\``)
            .setFooter({ text: `Loop: ${player.loop || 'Off'} • Queue: ${player.queue.length}` });

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
        message.channel.send({ embeds: [successEmbed(`${icons[mode]} Loop: **${mode}**`)] });
    }

    // ==================== VOLUME (SAVED TO REDIS) ====================
    if (command === 'volume' || command === 'vol') {
        const player = kazagumo.players.get(message.guild.id);
        if (!player) return message.reply({ embeds: [errorEmbed('Nothing is playing!')] });

        if (!args[0]) {
            return message.channel.send({ embeds: [successEmbed(`🔊 Volume: **${player.volume}%**`)] });
        }

        const volume = parseInt(args[0]);
        if (isNaN(volume) || volume < 0 || volume > 100) {
            return message.reply({ embeds: [errorEmbed('Volume must be 0-100')] });
        }

        player.setVolume(volume);
        // Simpan volume ke Redis supaya persist!
        await db.updateGuildSetting(message.guild.id, 'volume', volume);

        const icon = volume === 0 ? '🔇' : volume < 50 ? '🔉' : '🔊';
        message.channel.send({ embeds: [successEmbed(`${icon} Volume: **${volume}%** (saved)`)] });
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
        const isEnabled = player.data.get('8d');
        if (isEnabled) {
            await player.setRotation();
            player.data.set('8d', false);
            message.channel.send({ embeds: [successEmbed('🎧 8D Audio: **Off**')] });
        } else {
            await player.setRotation({ rotationHz: 0.2 });
            player.data.set('8d', true);
            message.channel.send({ embeds: [successEmbed('🎧 8D Audio: **On** 🎧')] });
        }
    }

    // ==================== REMOVE ====================
    if (command === 'remove' || command === 'rm') {
        const player = kazagumo.players.get(message.guild.id);
        if (!player) return message.reply({ embeds: [errorEmbed('Nothing is playing!')] });
        const index = parseInt(args[0]);
        if (!args[0] || isNaN(index) || index < 1 || index > player.queue.length) {
            return message.reply({ embeds: [errorEmbed(`Usage: \`!remove <1-${player.queue.length}>\``)] });
        }
        const removed = player.queue.splice(index - 1, 1);
        if (removed?.[0]) message.channel.send({ embeds: [successEmbed(`🗑️ Removed: **${removed[0].title}**`)] });
    }

    // ==================== CLEAR ====================
    if (command === 'clear') {
        const player = kazagumo.players.get(message.guild.id);
        if (!player) return message.reply({ embeds: [errorEmbed('Nothing is playing!')] });
        const count = player.queue.length;
        if (count === 0) return message.reply({ embeds: [errorEmbed('Queue already empty!')] });
        player.queue.clear();
        message.channel.send({ embeds: [successEmbed(`🗑️ Cleared **${count}** tracks.`)] });
    }

    // ==================== SHUFFLE ====================
    if (command === 'shuffle') {
        const player = kazagumo.players.get(message.guild.id);
        if (!player) return message.reply({ embeds: [errorEmbed('Nothing is playing!')] });
        if (player.queue.length < 2) return message.reply({ embeds: [errorEmbed('Need 2+ songs to shuffle!')] });
        player.queue.shuffle();
        message.channel.send({ embeds: [successEmbed(`🔀 Shuffled **${player.queue.length}** tracks!`)] });
    }

    // ===========================================================
    //  SAVE PLAYLIST - Simpan queue saat ini ke Redis
    // ===========================================================
    if (command === 'save') {
        const player = kazagumo.players.get(message.guild.id);
        if (!player?.queue.current) return message.reply({ embeds: [errorEmbed('Nothing to save!')] });

        const name = args.join(' ');
        if (!name) return message.reply({ embeds: [errorEmbed('Usage: `!save <playlist name>`\nExample: `!save My Rock Playlist`')] });
        if (name.length > 50) return message.reply({ embeds: [errorEmbed('Name too long! Max 50 characters.')] });

        // Kumpulkan current + queue
        const allTracks = [player.queue.current, ...player.queue];

        const success = await db.savePlaylist(message.author.id, name, allTracks);
        if (success) {
            message.channel.send({
                embeds: [successEmbed(
                    `💾 Saved **${name}** with **${allTracks.length}** tracks!\n\n` +
                    `Use \`!load ${name}\` to load it anytime.\n` +
                    `Use \`!saved\` to see all your playlists.`
                )]
            });
        } else {
            message.reply({ embeds: [errorEmbed('Failed to save playlist.')] });
        }
    }

    // ===========================================================
    //  LOAD PLAYLIST - Load playlist dari Redis
    // ===========================================================
    if (command === 'load') {
        if (!message.member.voice.channel) {
            return message.reply({ embeds: [errorEmbed('Join a voice channel first!')] });
        }

        const name = args.join(' ');
        if (!name) return message.reply({ embeds: [errorEmbed('Usage: `!load <playlist name>`\nUse `!saved` to see your playlists.')] });

        const playlists = await db.getUserPlaylists(message.author.id);
        const playlist = playlists[name];

        if (!playlist) {
            const available = Object.keys(playlists);
            let desc = `Playlist **${name}** not found!\n\n`;
            if (available.length > 0) {
                desc += `**Your playlists:**\n`;
                available.forEach(p => { desc += `• ${p} (${playlists[p].trackCount} tracks)\n`; });
            } else {
                desc += `You have no saved playlists. Use \`!save <name>\` while playing.`;
            }
            return message.reply({ embeds: [errorEmbed(desc)] });
        }

        try {
            const player = await getOrCreatePlayer(kazagumo, message);

            const statusMsg = await message.channel.send({
                embeds: [new EmbedBuilder().setColor('#FFA500').setDescription(`⏳ Loading playlist **${name}** (${playlist.tracks.length} tracks)...`)]
            });

            let loaded = 0;
            let failed = 0;

            for (const trackData of playlist.tracks) {
                try {
                    const result = await kazagumo.search(trackData.uri, { requester: message.author });
                    if (result?.tracks?.[0]) {
                        player.queue.add(result.tracks[0]);
                        loaded++;
                    } else {
                        // Fallback: cari berdasarkan judul
                        const fallback = await kazagumo.search(`ytsearch:${trackData.title} ${trackData.author}`, { requester: message.author });
                        if (fallback?.tracks?.[0]) {
                            player.queue.add(fallback.tracks[0]);
                            loaded++;
                        } else {
                            failed++;
                        }
                    }
                } catch {
                    failed++;
                }
                await new Promise(r => setTimeout(r, 300));
            }

            await statusMsg.edit({
                embeds: [new EmbedBuilder()
                    .setColor(BOT_INFO.color)
                    .setDescription(
                        `💾 Loaded **${name}**\n` +
                        `✅ Loaded: **${loaded}** tracks\n` +
                        (failed > 0 ? `❌ Failed: **${failed}** tracks\n` : '') +
                        `📊 Total queue: **${player.queue.length}** tracks`
                    )
                    .setTimestamp()]
            });

            if (!player.playing && !player.paused && player.queue.length > 0) await player.play();

        } catch (error) {
            console.error('[LOAD] Error:', error);
            message.reply({ embeds: [errorEmbed(`Error: ${error.message}`)] });
        }
    }

    // ===========================================================
    //  SAVED - Lihat semua playlist yang tersimpan
    // ===========================================================
    if (command === 'saved') {
        const playlists = await db.getUserPlaylists(message.author.id);
        const names = Object.keys(playlists);

        if (names.length === 0) {
            return message.reply({
                embeds: [errorEmbed('You have no saved playlists!\nUse `!save <name>` while music is playing.')]
            });
        }

        let description = '';
        names.forEach((name, i) => {
            const pl = playlists[name];
            const date = new Date(pl.createdAt).toLocaleDateString();
            description += `\`${i + 1}.\` **${name}** — ${pl.trackCount} tracks (${date})\n`;
        });

        const embed = new EmbedBuilder()
            .setColor(BOT_INFO.color)
            .setAuthor({ name: `${message.author.username}'s Playlists`, iconURL: message.author.displayAvatarURL() })
            .setDescription(description)
            .addFields(
                { name: 'Commands', value: '`!load <name>` — Load playlist\n`!deletelist <name>` — Delete playlist', inline: false }
            )
            .setFooter({ text: `${names.length} playlists saved` });

        message.channel.send({ embeds: [embed] });
    }

    // ==================== DELETE PLAYLIST ====================
    if (command === 'deletelist') {
        const name = args.join(' ');
        if (!name) return message.reply({ embeds: [errorEmbed('Usage: `!deletelist <playlist name>`')] });

        const success = await db.deletePlaylist(message.author.id, name);
        if (success) {
            message.channel.send({ embeds: [successEmbed(`🗑️ Deleted playlist **${name}**`)] });
        } else {
            message.reply({ embeds: [errorEmbed(`Playlist **${name}** not found!`)] });
        }
    }

    // ===========================================================
    //  FAV - Tambah lagu yang sedang playing ke favorites
    // ===========================================================
    if (command === 'fav') {
        const player = kazagumo.players.get(message.guild.id);
        if (!player?.queue.current) return message.reply({ embeds: [errorEmbed('Nothing is playing!')] });

        const success = await db.addFavorite(message.author.id, player.queue.current);
        if (success) {
            message.channel.send({ embeds: [successEmbed(`❤️ Added **${player.queue.current.title}** to favorites!`)] });
        } else {
            message.reply({ embeds: [errorEmbed('Already in favorites!')] });
        }
    }

    // ==================== FAVLIST ====================
    if (command === 'favlist') {
        const favorites = await db.getFavorites(message.author.id);
        if (favorites.length === 0) {
            return message.reply({ embeds: [errorEmbed('No favorites yet! Use `!fav` while a song is playing.')] });
        }

        const page = parseInt(args[0]) || 1;
        const perPage = 10;
        const totalPages = Math.ceil(favorites.length / perPage);
        const currentPage = Math.min(page, totalPages);
        const start = (currentPage - 1) * perPage;

        let description = '';
        favorites.slice(start, start + perPage).forEach((track, i) => {
            description += `\`${start + i + 1}.\` [${track.title}](${track.uri}) • \`${formatDuration(track.length)}\`\n`;
        });

        if (totalPages > 1) description += `\n📄 Page **${currentPage}/${totalPages}** • \`!favlist <page>\``;

        const embed = new EmbedBuilder()
            .setColor(BOT_INFO.color)
            .setAuthor({ name: `${message.author.username}'s Favorites ❤️`, iconURL: message.author.displayAvatarURL() })
            .setDescription(description)
            .addFields({ name: 'Commands', value: '`!playfav` — Play all favorites\n`!unfav <number>` — Remove from favorites' })
            .setFooter({ text: `${favorites.length} favorites` });

        message.channel.send({ embeds: [embed] });
    }

    // ==================== UNFAV ====================
    if (command === 'unfav') {
        const index = parseInt(args[0]);
        if (!args[0] || isNaN(index)) return message.reply({ embeds: [errorEmbed('Usage: `!unfav <number>`')] });

        const success = await db.removeFavorite(message.author.id, index - 1);
        if (success) {
            message.channel.send({ embeds: [successEmbed(`💔 Removed favorite #${index}`)] });
        } else {
            message.reply({ embeds: [errorEmbed('Invalid number!')] });
        }
    }

    // ==================== PLAY FAVORITES ====================
    if (command === 'playfav') {
        if (!message.member.voice.channel) return message.reply({ embeds: [errorEmbed('Join a voice channel first!')] });

        const favorites = await db.getFavorites(message.author.id);
        if (favorites.length === 0) return message.reply({ embeds: [errorEmbed('No favorites!')] });

        try {
            const player = await getOrCreatePlayer(kazagumo, message);
            const queries = favorites.map(f => f.uri);
            await addMultipleTracks(kazagumo, player, queries, message.author, message.channel);
            if (!player.playing && !player.paused && player.queue.length > 0) await player.play();
        } catch (error) {
            message.reply({ embeds: [errorEmbed(`Error: ${error.message}`)] });
        }
    }

    // ===========================================================
    //  HISTORY - Lihat lagu yang pernah diputar di server ini
    // ===========================================================
    if (command === 'history') {
        const limit = parseInt(args[0]) || 10;
        const history = await db.getHistory(message.guild.id, Math.min(limit, 25));

        if (history.length === 0) {
            return message.reply({ embeds: [errorEmbed('No play history yet!')] });
        }

        let description = '';
        history.forEach((entry, i) => {
            const time = new Date(entry.playedAt).toLocaleString();
            description += `\`${i + 1}.\` **${entry.title}** • ${entry.author}\n` +
                `    ⏱️ ${formatDuration(entry.length)} • 👤 ${entry.requestedBy} • 📅 ${time}\n\n`;
        });

        const embed = new EmbedBuilder()
            .setColor(BOT_INFO.color)
            .setAuthor({ name: `Play History • ${message.guild.name}`, iconURL: message.guild.iconURL() })
            .setDescription(description)
            .setFooter({ text: `Showing last ${history.length} tracks • !history <number>` });

        message.channel.send({ embeds: [embed] });
    }

    // ===========================================================
    //  RESTORE - Restore queue dari sebelum bot restart
    // ===========================================================
    if (command === 'restore') {
        if (!message.member.voice.channel) {
            return message.reply({ embeds: [errorEmbed('Join a voice channel first!')] });
        }

        const savedQueue = await db.getSavedQueue(message.guild.id);
        if (!savedQueue) {
            return message.reply({ embeds: [errorEmbed('No saved queue found!\nQueue is auto-saved while playing.')] });
        }

        const savedTime = new Date(savedQueue.savedAt).toLocaleString();
        const totalTracks = 1 + savedQueue.queue.length;

        try {
            const player = await getOrCreatePlayer(kazagumo, message);

            const statusMsg = await message.channel.send({
                embeds: [new EmbedBuilder().setColor('#FFA500').setDescription(
                    `🔄 Restoring queue from **${savedTime}**\n` +
                    `📊 **${totalTracks}** tracks to restore...`
                )]
            });

            // Restore current track dulu
            const allTracks = [savedQueue.current, ...savedQueue.queue];
            let loaded = 0;
            let failed = 0;

            for (const trackData of allTracks) {
                try {
                    const result = await kazagumo.search(trackData.uri, { requester: message.author });
                    if (result?.tracks?.[0]) {
                        player.queue.add(result.tracks[0]);
                        loaded++;
                    } else {
                        const fallback = await kazagumo.search(`ytsearch:${trackData.title}`, { requester: message.author });
                        if (fallback?.tracks?.[0]) {
                            player.queue.add(fallback.tracks[0]);
                            loaded++;
                        } else {
                            failed++;
                        }
                    }
                } catch {
                    failed++;
                }
                await new Promise(r => setTimeout(r, 300));
            }

            // Set volume
            player.setVolume(savedQueue.volume || 70);

            await statusMsg.edit({
                embeds: [new EmbedBuilder().setColor(BOT_INFO.color).setDescription(
                    `✅ Queue restored!\n` +
                    `🎵 Loaded: **${loaded}** tracks\n` +
                    (failed > 0 ? `❌ Failed: **${failed}** tracks\n` : '') +
                    `🔊 Volume: **${savedQueue.volume || 70}%**`
                ).setTimestamp()]
            });

            // Hapus saved queue setelah restore
            await db.deleteSavedQueue(message.guild.id);

            if (!player.playing && !player.paused && player.queue.length > 0) await player.play();

        } catch (error) {
            console.error('[RESTORE] Error:', error);
            message.reply({ embeds: [errorEmbed(`Error: ${error.message}`)] });
        }
    }

    // ===========================================================
    //  SETTINGS - Server settings
    // ===========================================================
    if (command === 'settings') {
        const subcommand = args[0]?.toLowerCase();
        const settings = await db.getGuildSettings(message.guild.id);

        if (!subcommand) {
            const embed = new EmbedBuilder()
                .setColor(BOT_INFO.color)
                .setAuthor({ name: `Settings • ${message.guild.name}`, iconURL: message.guild.iconURL() })
                .setDescription(
                    `🔊 **Default Volume:** ${settings.volume}%\n` +
                    `📢 **Now Playing Announce:** ${settings.announceNowPlaying ? 'On ✅' : 'Off ❌'}\n` +
                    `⏱️ **Auto-leave Timeout:** ${settings.autoLeaveTimeout / 1000}s\n` +
                    `📊 **Max Queue Size:** ${settings.maxQueueSize}\n` +
                    `🔄 **Allow Duplicates:** ${settings.allowDuplicates ? 'Yes' : 'No'}`
                )
                .addFields({
                    name: 'Edit Settings',
                    value:
                        '`!settings volume <0-100>`\n' +
                        '`!settings announce <on/off>`\n' +
                        '`!settings timeout <seconds>`\n' +
                        '`!settings maxqueue <number>`\n' +
                        '`!settings duplicates <on/off>`'
                });

            return message.channel.send({ embeds: [embed] });
        }

        // Check admin permission
        if (!message.member.permissions.has('ManageGuild')) {
            return message.reply({ embeds: [errorEmbed('You need **Manage Server** permission!')] });
        }

        const value = args[1];

        if (subcommand === 'volume') {
            const vol = parseInt(value);
            if (isNaN(vol) || vol < 0 || vol > 100) return message.reply({ embeds: [errorEmbed('Volume: 0-100')] });
            await db.updateGuildSetting(message.guild.id, 'volume', vol);
            message.channel.send({ embeds: [successEmbed(`🔊 Default volume set to **${vol}%**`)] });
        }
        else if (subcommand === 'announce') {
            const on = value?.toLowerCase() === 'on';
            await db.updateGuildSetting(message.guild.id, 'announceNowPlaying', on);
            message.channel.send({ embeds: [successEmbed(`📢 Now Playing announce: **${on ? 'On' : 'Off'}**`)] });
        }
        else if (subcommand === 'timeout') {
            const sec = parseInt(value);
            if (isNaN(sec) || sec < 10 || sec > 600) return message.reply({ embeds: [errorEmbed('Timeout: 10-600 seconds')] });
            await db.updateGuildSetting(message.guild.id, 'autoLeaveTimeout', sec * 1000);
            message.channel.send({ embeds: [successEmbed(`⏱️ Auto-leave timeout: **${sec}s**`)] });
        }
        else if (subcommand === 'maxqueue') {
            const max = parseInt(value);
            if (isNaN(max) || max < 10 || max > 1000) return message.reply({ embeds: [errorEmbed('Max queue: 10-1000')] });
            await db.updateGuildSetting(message.guild.id, 'maxQueueSize', max);
            message.channel.send({ embeds: [successEmbed(`📊 Max queue size: **${max}**`)] });
        }
        else if (subcommand === 'duplicates') {
            const on = value?.toLowerCase() === 'on';
            await db.updateGuildSetting(message.guild.id, 'allowDuplicates', on);
            message.channel.send({ embeds: [successEmbed(`🔄 Allow duplicates: **${on ? 'Yes' : 'No'}**`)] });
        }
        else {
            message.reply({ embeds: [errorEmbed('Unknown setting! Use `!settings` to see options.')] });
        }
    }

    // ==================== HELP (UPDATED) ====================
    if (command === 'help') {
        const embed = new EmbedBuilder()
            .setColor(BOT_INFO.color)
            .setAuthor({ name: BOT_INFO.name, iconURL: client.user.displayAvatarURL() })
            .setDescription(BOT_INFO.description)
            .addFields(
                {
                    name: '🎵 Music',
                    value: '```\n!play <song>     - Play a song\n!pm <s1>, <s2>   - Add multiple songs\n!pf              - Add from .txt file\n!pl <url>        - Load playlist URL\n!skip / !stop    - Skip / Stop\n!pause / !resume - Pause / Resume\n```'
                },
                {
                    name: '📋 Queue',
                    value: '```\n!queue [page]    - View queue\n!np              - Now playing\n!loop <mode>     - track/queue/off\n!remove <num>    - Remove track\n!clear           - Clear queue\n!shuffle         - Shuffle queue\n!restore         - Restore last queue\n```'
                },
                {
                    name: '💾 Save & Load',
                    value: '```\n!save <name>     - Save current queue\n!load <name>     - Load saved playlist\n!saved           - View saved playlists\n!deletelist <n>  - Delete playlist\n```'
                },
                {
                    name: '❤️ Favorites',
                    value: '```\n!fav             - Add current to favs\n!favlist         - View favorites\n!playfav         - Play all favorites\n!unfav <num>     - Remove favorite\n```'
                },
                {
                    name: '🎛️ Control & Info',
                    value: '```\n!vol <0-100>     - Set volume (saved)\n!seek <1:30>     - Seek to time\n!8d              - Toggle 8D audio\n!history         - Play history\n!settings        - Server settings\n!info / !ping    - Bot info\n```'
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
        const stats = await db.getStats();

        const embed = new EmbedBuilder()
            .setColor(BOT_INFO.color)
            .setAuthor({ name: BOT_INFO.name, iconURL: client.user.displayAvatarURL() })
            .setDescription(BOT_INFO.description)
            .addFields(
                { name: '👨‍💻 Developer', value: `<@${BOT_INFO.owner.id}>`, inline: true },
                { name: '📊 Servers', value: `${client.guilds.cache.size}`, inline: true },
                { name: '⏱️ Uptime', value: `${hours}h ${minutes}m`, inline: true },
                { name: '🎵 Songs Played', value: `${stats.songsPlayed.toLocaleString()}`, inline: true },
                { name: '📝 Commands', value: `${stats.commandsUsed.toLocaleString()}`, inline: true },
                { name: '💾 Database', value: redis.status === 'ready' ? '🟢 Online' : '🔴 Offline', inline: true }
            )
            .setFooter({ text: `v${BOT_INFO.version} • Discord.js v14 • Lavalink v4` })
            .setTimestamp();

        message.channel.send({ embeds: [embed] });
    }

    // ==================== PING ====================
    if (command === 'ping') {
        const latency = Date.now() - message.createdTimestamp;
        const node = kazagumo.shoukaku.nodes.get('Serenetia');

        // Test Redis ping
        let redisPing = 'N/A';
        try {
            const start = Date.now();
            await redis.ping();
            redisPing = `${Date.now() - start}ms`;
        } catch { redisPing = 'Error'; }

        const embed = new EmbedBuilder()
            .setColor(BOT_INFO.color)
            .setDescription(
                `🏓 **Pong!**\n` +
                `📡 Bot: \`${latency}ms\`\n` +
                `💓 API: \`${Math.round(client.ws.ping)}ms\`\n` +
                `🎵 Lavalink: \`${node?.stats?.ping || 'N/A'}ms\`\n` +
                `💾 Redis: \`${redisPing}\``
            );

        message.channel.send({ embeds: [embed] });
    }
});

// ============ GRACEFUL SHUTDOWN ============
// Simpan semua queue sebelum bot mati
async function gracefulShutdown(signal) {
    console.log(`\n⚠️ ${signal} received. Saving all queues...`);

    try {
        // Save semua player queue yang aktif
        for (const [guildId, player] of kazagumo.players) {
            if (player.queue.current) {
                await autoSaveQueue(player);
                console.log(`💾 Saved queue for guild ${guildId}`);
            }
        }
        console.log('✅ All queues saved!');
    } catch (err) {
        console.error('Error saving queues:', err);
    }

    // Tutup Redis connection
    await redis.quit();
    process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ============ ERROR HANDLERS ============
process.on('unhandledRejection', (reason) => {
    console.error('Unhandled Rejection:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
});

// ============ LOGIN ============
const token = process.env.DISCORD_TOKEN;
if (!token) {
    console.error('❌ DISCORD_TOKEN not found!');
    process.exit(1);
}

client.login(token).catch(err => {
    console.error('❌ Login failed:', err);
    process.exit(1);
});
