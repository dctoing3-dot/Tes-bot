const{Client,GatewayIntentBits,EmbedBuilder}=require('discord.js');
const{Connectors}=require('shoukaku');
const{Kazagumo}=require('kazagumo');
const express=require('express');
const Redis=require('ioredis');
require('dotenv').config();
const BOT_INFO={name:'Melodify',version:'1.3.0',description:'High quality Discord music bot with persistent data.',owner:{id:'1307489983359357019',username:'demisz_dc',display:'Demisz'},color:'#5865F2'};
const redis=new Redis(process.env.REDIS_URL,{maxRetriesPerRequest:3,retryDelayOnFailover:1000,retryStrategy(times){if(times>5){console.error('❌ Redis: Max retries reached');return null;}return Math.min(times*500,3000);},reconnectOnError(err){console.error('Redis reconnect error:',err.message);return true;}});
redis.on('connect',()=>console.log('✅ Redis connected!'));
redis.on('error',(err)=>console.error('❌ Redis error:',err.message));
redis.on('reconnecting',()=>console.log('🔄 Redis reconnecting...'));
const db={
async getGuildSettings(guildId){try{const data=await redis.get(`guild:${guildId}:settings`);return data?JSON.parse(data):{volume:70,defaultSearch:'youtube',djRole:null,announceNowPlaying:true,autoLeaveTimeout:120000,maxQueueSize:500,allowDuplicates:true};}catch(err){console.error('Redis getGuildSettings error:',err.message);return{volume:70,defaultSearch:'youtube',djRole:null,announceNowPlaying:true,autoLeaveTimeout:120000,maxQueueSize:500,allowDuplicates:true};}},
async setGuildSettings(guildId,settings){try{await redis.set(`guild:${guildId}:settings`,JSON.stringify(settings));}catch(err){console.error('Redis setGuildSettings error:',err.message);}},
async updateGuildSetting(guildId,key,value){try{const settings=await this.getGuildSettings(guildId);settings[key]=value;await this.setGuildSettings(guildId,settings);return settings;}catch(err){console.error('Redis updateGuildSetting error:',err.message);}},
async savePlaylist(userId,name,tracks){try{const playlists=await this.getUserPlaylists(userId);playlists[name]={tracks:tracks.map(t=>({title:t.title,uri:t.uri,author:t.author,length:t.length,thumbnail:t.thumbnail,source:t.sourceName||'youtube'})),createdAt:Date.now(),trackCount:tracks.length};await redis.set(`user:${userId}:playlists`,JSON.stringify(playlists));await redis.expire(`user:${userId}:playlists`,7776000);return true;}catch(err){console.error('Redis savePlaylist error:',err.message);return false;}},
async getUserPlaylists(userId){try{const data=await redis.get(`user:${userId}:playlists`);return data?JSON.parse(data):{};}catch(err){console.error('Redis getUserPlaylists error:',err.message);return{};}},
async deletePlaylist(userId,name){try{const playlists=await this.getUserPlaylists(userId);if(!playlists[name])return false;delete playlists[name];await redis.set(`user:${userId}:playlists`,JSON.stringify(playlists));return true;}catch(err){console.error('Redis deletePlaylist error:',err.message);return false;}},
async saveCurrentQueue(guildId,playerData){try{await redis.set(`guild:${guildId}:savedqueue`,JSON.stringify(playerData));await redis.expire(`guild:${guildId}:savedqueue`,86400);}catch(err){console.error('Redis saveCurrentQueue error:',err.message);}},
async getSavedQueue(guildId){try{const data=await redis.get(`guild:${guildId}:savedqueue`);return data?JSON.parse(data):null;}catch(err){console.error('Redis getSavedQueue error:',err.message);return null;}},
async deleteSavedQueue(guildId){try{await redis.del(`guild:${guildId}:savedqueue`);}catch(err){console.error('Redis deleteSavedQueue error:',err.message);}},
async addToHistory(guildId,track){try{const entry=JSON.stringify({title:track.title,uri:track.uri,author:track.author,length:track.length,requestedBy:track.requester?.tag||'Unknown',playedAt:Date.now()});await redis.lpush(`guild:${guildId}:history`,entry);await redis.ltrim(`guild:${guildId}:history`,0,49);await redis.expire(`guild:${guildId}:history`,2592000);}catch(err){console.error('Redis addToHistory error:',err.message);}},
async getHistory(guildId,limit=10){try{const data=await redis.lrange(`guild:${guildId}:history`,0,limit-1);return data.map(d=>JSON.parse(d));}catch(err){console.error('Redis getHistory error:',err.message);return[];}},
async addFavorite(userId,track){try{const favorites=await this.getFavorites(userId);if(favorites.find(f=>f.uri===track.uri))return false;favorites.push({title:track.title,uri:track.uri,author:track.author,length:track.length,addedAt:Date.now()});if(favorites.length>100)favorites.shift();await redis.set(`user:${userId}:favorites`,JSON.stringify(favorites));await redis.expire(`user:${userId}:favorites`,7776000);return true;}catch(err){console.error('Redis addFavorite error:',err.message);return false;}},
async addMultipleFavorites(userId,tracks){try{const favorites=await this.getFavorites(userId);let added=0;let skipped=0;for(const track of tracks){if(favorites.find(f=>f.uri===track.uri)){skipped++;continue;}favorites.push({title:track.title,uri:track.uri,author:track.author,length:track.length,addedAt:Date.now()});added++;}while(favorites.length>100)favorites.shift();await redis.set(`user:${userId}:favorites`,JSON.stringify(favorites));await redis.expire(`user:${userId}:favorites`,7776000);return{added,skipped};}catch(err){console.error('Redis addMultipleFavorites error:',err.message);return{added:0,skipped:0};}},
async getFavorites(userId){try{const data=await redis.get(`user:${userId}:favorites`);return data?JSON.parse(data):[];}catch(err){console.error('Redis getFavorites error:',err.message);return[];}},
async removeFavorite(userId,index){try{const favorites=await this.getFavorites(userId);if(index<0||index>=favorites.length)return false;favorites.splice(index,1);await redis.set(`user:${userId}:favorites`,JSON.stringify(favorites));return true;}catch(err){console.error('Redis removeFavorite error:',err.message);return false;}},
async removeMultipleFavorites(userId,indices){try{const favorites=await this.getFavorites(userId);const sorted=[...indices].sort((a,b)=>b-a);let removed=0;for(const idx of sorted){if(idx>=0&&idx<favorites.length){favorites.splice(idx,1);removed++;}}await redis.set(`user:${userId}:favorites`,JSON.stringify(favorites));await redis.expire(`user:${userId}:favorites`,7776000);return removed;}catch(err){console.error('Redis removeMultipleFavorites error:',err.message);return 0;}},
async clearFavorites(userId){try{await redis.del(`user:${userId}:favorites`);return true;}catch(err){console.error('Redis clearFavorites error:',err.message);return false;}},
async incrementStat(key){try{await redis.incr(`stats:${key}`);}catch(err){console.error('Redis incrementStat error:',err.message);}},
async getStats(){try{const songsPlayed=await redis.get('stats:songs_played')||'0';const commandsUsed=await redis.get('stats:commands_used')||'0';return{songsPlayed:parseInt(songsPlayed),commandsUsed:parseInt(commandsUsed)};}catch(err){console.error('Redis getStats error:',err.message);return{songsPlayed:0,commandsUsed:0};}}
};
const app=express();const PORT=process.env.PORT||3000;
app.get('/',(req,res)=>res.status(200).send('Bot is running'));
app.get('/health',(req,res)=>res.status(200).json({status:'ok',uptime:process.uptime(),redis:redis.status}));
app.listen(PORT,()=>console.log(`🌐 Server running on port ${PORT}`));
const client=new Client({intents:[GatewayIntentBits.Guilds,GatewayIntentBits.GuildVoiceStates,GatewayIntentBits.GuildMessages,GatewayIntentBits.MessageContent]});
const Nodes=[{name:'Serenetia',url:'lavalinkv3.serenetia.com:443',auth:'https://dsc.gg/ajidevserver',secure:true}];
const kazagumo=new Kazagumo({defaultSearchEngine:'youtube',send:(guildId,payload)=>{const guild=client.guilds.cache.get(guildId);if(guild)guild.shard.send(payload);}},new Connectors.DiscordJS(client),Nodes,{moveOnDisconnect:false,resumable:false,reconnectTries:3,restTimeout:15000});
kazagumo.shoukaku.on('ready',(name)=>console.log(`✅ Lavalink ${name} connected!`));
kazagumo.shoukaku.on('error',(name,error)=>console.error(`❌ Lavalink ${name} error:`,error.message));
kazagumo.shoukaku.on('close',(name,code,reason)=>console.warn(`⚠️ Lavalink ${name} closed: ${code} - ${reason}`));
kazagumo.shoukaku.on('disconnect',(name)=>console.warn(`🔌 Lavalink ${name} disconnected`));
const disconnectTimers=new Map();
kazagumo.on('playerStart',async(player,track)=>{
if(disconnectTimers.has(player.guildId)){clearTimeout(disconnectTimers.get(player.guildId));disconnectTimers.delete(player.guildId);}
await db.addToHistory(player.guildId,track);await db.incrementStat('songs_played');await autoSaveQueue(player);
const settings=await db.getGuildSettings(player.guildId);if(!settings.announceNowPlaying)return;
const channel=client.channels.cache.get(player.textId);if(!channel)return;
const embed=new EmbedBuilder().setColor(BOT_INFO.color).setAuthor({name:'Now Playing 🎵',iconURL:client.user.displayAvatarURL()}).setTitle(track.title).setURL(track.uri).setThumbnail(track.thumbnail||null).addFields({name:'Duration',value:formatDuration(track.length),inline:true},{name:'Author',value:track.author||'Unknown',inline:true},{name:'Requested by',value:`${track.requester}`,inline:true}).setFooter({text:`Volume: ${player.volume}% • Queue: ${player.queue.length} tracks`}).setTimestamp();
channel.send({embeds:[embed]});
});
kazagumo.on('playerEmpty',(player)=>{
const channel=client.channels.cache.get(player.textId);
if(channel){channel.send({embeds:[new EmbedBuilder().setColor('#FFA500').setDescription('⏸️ Queue finished. Add more songs with `!play`\n*Leaving in 2 minutes if no songs added.*').setTimestamp()]});}
const timer=setTimeout(async()=>{if(player&&!player.queue.current&&player.queue.length===0){if(channel){channel.send({embeds:[new EmbedBuilder().setColor('#ff6b6b').setDescription('⏹️ Left due to inactivity.').setTimestamp()]});}await db.deleteSavedQueue(player.guildId);player.destroy();}disconnectTimers.delete(player.guildId);},120000);
disconnectTimers.set(player.guildId,timer);
});
kazagumo.on('playerError',(player,error,track)=>{console.error('Player error:',error);const channel=client.channels.cache.get(player.textId);if(channel)channel.send({embeds:[errorEmbed(`Failed to play: ${track?.title||'Unknown'}\nSkipping...`)]});if(player.queue.length>0)setTimeout(()=>player.skip(),1000);});
kazagumo.on('playerDestroy',async(player)=>{if(disconnectTimers.has(player.guildId)){clearTimeout(disconnectTimers.get(player.guildId));disconnectTimers.delete(player.guildId);}});
async function autoSaveQueue(player){try{if(!player?.queue?.current)return;const queueData={guildId:player.guildId,textId:player.textId,voiceId:player.voiceId,volume:player.volume,loop:player.loop||'none',current:{title:player.queue.current.title,uri:player.queue.current.uri,author:player.queue.current.author,length:player.queue.current.length,thumbnail:player.queue.current.thumbnail},queue:player.queue.map(t=>({title:t.title,uri:t.uri,author:t.author,length:t.length,thumbnail:t.thumbnail})),savedAt:Date.now()};await db.saveCurrentQueue(player.guildId,queueData);}catch(err){console.error('Auto-save error:',err.message);}}
client.once('ready',async()=>{console.log('═══════════════════════════════════════');console.log(`✅ ${client.user.tag} is online!`);console.log(`📊 Serving ${client.guilds.cache.size} servers`);console.log(`💾 Redis: ${redis.status}`);console.log('═══════════════════════════════════════');client.user.setActivity('!help • Music Bot',{type:2});});
function formatDuration(ms){if(!ms||ms===0)return'🔴 Live';const s=Math.floor((ms/1000)%60);const m=Math.floor((ms/(1000*60))%60);const h=Math.floor(ms/(1000*60*60));return h>0?`${h}:${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}`:`${m}:${s.toString().padStart(2,'0')}`;}
function errorEmbed(msg){return new EmbedBuilder().setColor('#ff6b6b').setDescription(`❌ ${msg}`);}
function successEmbed(msg){return new EmbedBuilder().setColor(BOT_INFO.color).setDescription(msg);}
function isURL(string){const p=[/^https?:\/\//i,/^(www\.)?youtube\.com/i,/^youtu\.be\//i,/^music\.youtube\.com/i,/^(www\.)?spotify\.com/i,/^open\.spotify\.com/i,/^(www\.)?soundcloud\.com/i,/^(www\.)?bandcamp\.com/i,/^(www\.)?twitch\.tv/i,/^(www\.)?vimeo\.com/i];return p.some(pattern=>pattern.test(string));}
// PARSE SELECTION MODE: all, current, 1-5, 3,5,7, top10
function parseTrackSelection(modeStr,allTracks){
let selected=[];let desc='';
if(!modeStr||modeStr==='all'){selected=[...allTracks];desc=`All tracks (${selected.length})`;}
else if(modeStr==='current'){selected=[allTracks[0]];desc='Current track only';}
else if(modeStr.startsWith('top')){const n=parseInt(modeStr.replace('top',''));if(isNaN(n)||n<1)return{error:'Invalid! Example: `top10`'};selected=allTracks.slice(0,n);desc=`Top ${selected.length} tracks`;}
else if(modeStr.includes('-')){const parts=modeStr.split('-').map(Number);if(isNaN(parts[0])||isNaN(parts[1])||parts[0]<0||parts[1]<parts[0])return{error:'Invalid range! Example: `1-5`'};if(parts[1]>=allTracks.length)return{error:`Max index: ${allTracks.length-1}`};selected=allTracks.slice(parts[0],parts[1]+1);desc=`Track ${parts[0]}-${parts[1]} (${selected.length} tracks)`;}
else if(modeStr.includes(',')){const indices=modeStr.split(',').map(n=>parseInt(n.trim()));for(const idx of indices){if(isNaN(idx)||idx<0||idx>=allTracks.length)return{error:`Invalid number: ${idx}. Range: 0-${allTracks.length-1}`};}selected=indices.map(i=>allTracks[i]);desc=`Selected: ${indices.join(',')} (${selected.length} tracks)`;}
else return{error:'Invalid mode! Use: `all`, `current`, `1-5`, `3,5,7`, `top10`'};
return{tracks:selected,description:desc};
}
async function addMultipleTracks(kazagumo,player,queries,requester,channel){
let added=0;let failed=0;const failedTracks=[];const addedTracks=[];
const statusMsg=await channel.send({embeds:[new EmbedBuilder().setColor('#FFA500').setDescription(`⏳ Processing **${queries.length}** songs...`)]});
for(let i=0;i<queries.length;i++){const query=queries[i].trim();if(!query||query.length===0)continue;
try{let searchQuery;if(isURL(query)){searchQuery=query;}else if(query.startsWith('ytsearch:')||query.startsWith('scsearch:')){searchQuery=query;}else{searchQuery=`ytsearch:${query}`;}
const result=await kazagumo.search(searchQuery,{requester});
if(!result||!result.tracks||result.tracks.length===0){failed++;failedTracks.push(query);continue;}
if(result.type==='PLAYLIST'){for(const track of result.tracks){player.queue.add(track);added++;}addedTracks.push(`📃 ${result.playlistName} (${result.tracks.length})`);}else{const track=result.tracks[0];player.queue.add(track);added++;addedTracks.push(`🎵 ${track.title}`);}
if((i+1)%5===0||i===queries.length-1){await statusMsg.edit({embeds:[new EmbedBuilder().setColor('#FFA500').setDescription(`⏳ **${i+1}/${queries.length}**\n✅ ${added} | ❌ ${failed}`)]}).catch(()=>{});}
await new Promise(r=>setTimeout(r,300));
}catch(error){console.error(`[MULTI] Error "${query}":`,error.message);failed++;failedTracks.push(query);}}
let desc=`✅ Added **${added}** tracks!\n`;if(failed>0)desc+=`❌ Failed: **${failed}**\n`;
if(addedTracks.length>0){desc+='\n**Added:**\n';addedTracks.slice(0,15).forEach((t,i)=>{desc+=`\`${i+1}.\` ${t}\n`;});if(addedTracks.length>15)desc+=`*...+${addedTracks.length-15} more*\n`;}
if(failedTracks.length>0){desc+='\n**Failed:**\n';failedTracks.slice(0,5).forEach(t=>{desc+=`• ${t}\n`;});if(failedTracks.length>5)desc+=`*...+${failedTracks.length-5} more*\n`;}
await statusMsg.edit({embeds:[new EmbedBuilder().setColor(failed===0?BOT_INFO.color:'#FFA500').setAuthor({name:'Bulk Queue Add',iconURL:client.user.displayAvatarURL()}).setDescription(desc).setFooter({text:`Queue: ${player.queue.length} tracks`}).setTimestamp()]});
return{added,failed};
}
async function getOrCreatePlayer(kazagumo,message){let player=kazagumo.players.get(message.guild.id);if(!player){const settings=await db.getGuildSettings(message.guild.id);player=await kazagumo.createPlayer({guildId:message.guild.id,textId:message.channel.id,voiceId:message.member.voice.channel.id,volume:settings.volume,deaf:true,shardId:message.guild.shardId});}return player;}
const ALIASES={
play:['play','p'],playmulti:['playmulti','pm','multi','bulkadd','ba'],playfile:['playfile','pf','filplay','fp'],playlist:['playlist','pl','plist'],
skip:['skip','s','sk','next','n'],stop:['stop','st','dc','disconnect','leave'],pause:['pause','ps'],resume:['resume','rs','unpause','up'],
queue:['queue','q','list','songlist'],nowplaying:['nowplaying','np','now','playing','current'],loop:['loop','lp','repeat','rp'],
volume:['volume','vol','v'],seek:['seek','jumpto','jt'],'8d':['8d','eightd'],
remove:['remove','rm','delete','del'],clear:['clear','cls','empty'],shuffle:['shuffle','shuf','sf','mix','random'],
save:['save','sv','savequeue','sq'],load:['load','ld','loadqueue','lq'],loadshuf:['loadshuf','ls','loadshuffle'],
saved:['saved','mylist','playlists','lists','myplaylist','mpl'],addto:['addto','at','addtolist','atl'],
deletelist:['deletelist','dl','dellist','rmlist','removelist'],renamelist:['renamelist','rl','rename'],
fav:['fav','favorite','love','heart','like'],favlist:['favlist','fl','favorites','favs','liked'],
unfav:['unfav','uf','unlike','unlove','unheart'],playfav:['playfav','pfav','playlike'],
history:['history','hist','recent','lastplayed'],restore:['restore','res','recovery','recover'],
settings:['settings','set','config','cfg'],help:['help','h','commands','cmd','cmds'],
info:['info','about','botinfo','bi'],ping:['ping','latency','ms','lag']
};
function resolveCommand(input){for(const[cmd,aliases]of Object.entries(ALIASES)){if(aliases.includes(input))return cmd;}return null;}
client.on('messageCreate',async(message)=>{
if(message.author.bot)return;if(!message.content.startsWith('!'))return;
const args=message.content.slice(1).trim().split(/ +/);const rawCommand=args.shift().toLowerCase();const command=resolveCommand(rawCommand);if(!command)return;
await db.incrementStat('commands_used');
// PLAY
if(command==='play'){
if(!message.member.voice.channel)return message.reply({embeds:[errorEmbed('Join a voice channel first!')]});
const query=args.join(' ');if(!query)return message.reply({embeds:[errorEmbed('`!play <song>` - Single\n`!pm <s1>, <s2>` - Multiple\n`!pf` - From file\n`!load <name>` - Saved')]});
try{const player=await getOrCreatePlayer(kazagumo,message);
let sq;if(isURL(query))sq=query;else if(query.startsWith('ytsearch:')||query.startsWith('scsearch:'))sq=query;else sq=`ytsearch:${query}`;
const result=await kazagumo.search(sq,{requester:message.author});
if(!result?.tracks?.length)return message.reply({embeds:[errorEmbed('No results found!')]});
if(result.type==='PLAYLIST'){for(const t of result.tracks)player.queue.add(t);message.channel.send({embeds:[new EmbedBuilder().setColor(BOT_INFO.color).setDescription(`📃 Added **${result.tracks.length}** from **${result.playlistName}**`)]});}
else{const t=result.tracks[0];player.queue.add(t);if(player.playing||player.paused)message.channel.send({embeds:[new EmbedBuilder().setColor(BOT_INFO.color).setDescription(`➕ **${t.title}**`).setFooter({text:`${formatDuration(t.length)} • ${t.author}`})]});}
if(!player.playing&&!player.paused)await player.play();
}catch(e){console.error('[PLAY]',e);message.reply({embeds:[errorEmbed(e.message)]});}
}
// PLAYMULTI
if(command==='playmulti'){
if(!message.member.voice.channel)return message.reply({embeds:[errorEmbed('Join a voice channel first!')]});
const fq=args.join(' ');if(!fq)return message.reply({embeds:[errorEmbed('`!pm <song1>, <song2>, <song3>`\nSeparator: `,` `;` `|`')]});
let sep;if(fq.includes(','))sep=',';else if(fq.includes(';'))sep=';';else if(fq.includes('|'))sep='|';else return message.reply({embeds:[errorEmbed('Separate with `,`\n`!pm Song One, Song Two`')]});
const queries=fq.split(sep).map(q=>q.trim()).filter(q=>q.length>0);
if(queries.length<=1)return message.reply({embeds:[errorEmbed('Use `!play` for single. Separate with `,`')]});
if(queries.length>50)return message.reply({embeds:[errorEmbed('Max 50! Use `!pf` for more.')]});
try{const player=await getOrCreatePlayer(kazagumo,message);await addMultipleTracks(kazagumo,player,queries,message.author,message.channel);if(!player.playing&&!player.paused&&player.queue.length>0)await player.play();}catch(e){message.reply({embeds:[errorEmbed(e.message)]});}
}
// PLAYFILE
if(command==='playfile'){
if(!message.member.voice.channel)return message.reply({embeds:[errorEmbed('Join a voice channel first!')]});
const att=message.attachments.first();if(!att)return message.reply({embeds:[errorEmbed('Upload `.txt` file with `!pf`\nOne song per line')]});
if(!att.name.endsWith('.txt'))return message.reply({embeds:[errorEmbed('Only `.txt`!')]});
if(att.size>50000)return message.reply({embeds:[errorEmbed('Max 50KB!')]});
try{const res=await fetch(att.url);const text=await res.text();const queries=text.split('\n').map(l=>l.trim()).filter(l=>l.length>0&&!l.startsWith('#')&&!l.startsWith('//'));
if(!queries.length)return message.reply({embeds:[errorEmbed('File empty!')]});
if(queries.length>100)return message.reply({embeds:[errorEmbed(`${queries.length} songs. Max 100!`)]});
const player=await getOrCreatePlayer(kazagumo,message);await addMultipleTracks(kazagumo,player,queries,message.author,message.channel);if(!player.playing&&!player.paused&&player.queue.length>0)await player.play();
}catch(e){message.reply({embeds:[errorEmbed(e.message)]});}
}
// PLAYLIST URL
if(command==='playlist'){
if(!message.member.voice.channel)return message.reply({embeds:[errorEmbed('Join a voice channel first!')]});
const query=args.join(' ');if(!query||!isURL(query))return message.reply({embeds:[errorEmbed('`!pl <playlist URL>`')]});
try{const player=await getOrCreatePlayer(kazagumo,message);const sm=await message.channel.send({embeds:[new EmbedBuilder().setColor('#FFA500').setDescription('⏳ Loading playlist...')]});
const result=await kazagumo.search(query,{requester:message.author});if(!result?.tracks?.length)return sm.edit({embeds:[errorEmbed('Playlist empty!')]});
for(const t of result.tracks)player.queue.add(t);
await sm.edit({embeds:[new EmbedBuilder().setColor(BOT_INFO.color).setDescription(`📃 **${result.playlistName||'Playlist'}**\n✅ **${result.tracks.length}** tracks`).setTimestamp()]});
if(!player.playing&&!player.paused)await player.play();
}catch(e){message.reply({embeds:[errorEmbed(e.message)]});}
}
// SKIP
if(command==='skip'){const p=kazagumo.players.get(message.guild.id);if(!p?.queue.current)return message.reply({embeds:[errorEmbed('Nothing to skip!')]});p.skip();message.react('⏭️');}
// STOP
if(command==='stop'){const p=kazagumo.players.get(message.guild.id);if(!p)return message.reply({embeds:[errorEmbed('Nothing playing!')]});await db.deleteSavedQueue(message.guild.id);p.destroy();message.react('⏹️');}
// PAUSE
if(command==='pause'){const p=kazagumo.players.get(message.guild.id);if(!p)return message.reply({embeds:[errorEmbed('Nothing playing!')]});p.pause(true);message.react('⏸️');}
// RESUME
if(command==='resume'){const p=kazagumo.players.get(message.guild.id);if(!p)return message.reply({embeds:[errorEmbed('Nothing playing!')]});p.pause(false);message.react('▶️');}
// QUEUE
if(command==='queue'){
const p=kazagumo.players.get(message.guild.id);if(!p?.queue.current)return message.reply({embeds:[errorEmbed('Queue empty!')]});
const cur=p.queue.current;const q=p.queue;const pg=parseInt(args[0])||1;const ipp=10;const tp=Math.ceil(q.length/ipp)||1;const cp=Math.min(pg,tp);
let d=`**Now Playing:**\n[${cur.title}](${cur.uri}) • \`${formatDuration(cur.length)}\`\n\n`;
if(q.length>0){d+='**Up Next:**\n';const st=(cp-1)*ipp;const en=Math.min(st+ipp,q.length);for(let i=st;i<en;i++)d+=`\`${i+1}.\` [${q[i].title}](${q[i].uri}) • \`${formatDuration(q[i].length)}\`\n`;if(tp>1)d+=`\n📄 **${cp}/${tp}** • \`!q <page>\``;}
let td=cur.length||0;for(const t of q)td+=t.length||0;
message.channel.send({embeds:[new EmbedBuilder().setColor(BOT_INFO.color).setAuthor({name:`Queue • ${message.guild.name}`,iconURL:message.guild.iconURL()}).setDescription(d).setFooter({text:`${q.length+1} tracks • ${formatDuration(td)} • Vol: ${p.volume}%`})]});
}
// NOWPLAYING
if(command==='nowplaying'){
const p=kazagumo.players.get(message.guild.id);if(!p?.queue.current)return message.reply({embeds:[errorEmbed('Nothing playing!')]});
const c=p.queue.current;const pos=p.position;const dur=c.length;const prog=dur?Math.round((pos/dur)*15):0;const bar='▬'.repeat(prog)+'🔘'+'▬'.repeat(15-prog);
message.channel.send({embeds:[new EmbedBuilder().setColor(BOT_INFO.color).setAuthor({name:'Now Playing',iconURL:client.user.displayAvatarURL()}).setTitle(c.title).setURL(c.uri).setThumbnail(c.thumbnail).addFields({name:'Author',value:c.author||'Unknown',inline:true},{name:'Requested by',value:`${c.requester}`,inline:true},{name:'Volume',value:`${p.volume}%`,inline:true}).setDescription(`\`${formatDuration(pos)}\` ${bar} \`${formatDuration(dur)}\``).setFooter({text:`Loop: ${p.loop||'Off'} • Queue: ${p.queue.length}`})]});
}
// LOOP
if(command==='loop'){const p=kazagumo.players.get(message.guild.id);if(!p)return message.reply({embeds:[errorEmbed('Nothing playing!')]});const m=args[0]?.toLowerCase();if(!m||!['track','queue','off'].includes(m))return message.reply({embeds:[errorEmbed('`!loop <track/queue/off>`')]});p.setLoop(m==='off'?'none':m);message.channel.send({embeds:[successEmbed(`${{track:'🔂',queue:'🔁',off:'➡️'}[m]} Loop: **${m}**`)]});}
// VOLUME
if(command==='volume'){const p=kazagumo.players.get(message.guild.id);if(!p)return message.reply({embeds:[errorEmbed('Nothing playing!')]});if(!args[0])return message.channel.send({embeds:[successEmbed(`🔊 Volume: **${p.volume}%**`)]});const vol=parseInt(args[0]);if(isNaN(vol)||vol<0||vol>100)return message.reply({embeds:[errorEmbed('0-100')]});p.setVolume(vol);await db.updateGuildSetting(message.guild.id,'volume',vol);message.channel.send({embeds:[successEmbed(`${vol===0?'🔇':vol<50?'🔉':'🔊'} Volume: **${vol}%** (saved)`)]});}
// SEEK
if(command==='seek'){const p=kazagumo.players.get(message.guild.id);if(!p?.queue.current)return message.reply({embeds:[errorEmbed('Nothing playing!')]});const t=args[0];if(!t)return message.reply({embeds:[errorEmbed('`!seek <1:30>` or `!seek <90>`')]});let ms;if(t.includes(':')){const pts=t.split(':').map(Number);ms=pts.length===2?(pts[0]*60+pts[1])*1000:(pts[0]*3600+pts[1]*60+pts[2])*1000;}else ms=parseInt(t)*1000;if(isNaN(ms)||ms<0||ms>p.queue.current.length)return message.reply({embeds:[errorEmbed('Invalid time!')]});p.seek(ms);message.channel.send({embeds:[successEmbed(`⏩ Seeked to **${formatDuration(ms)}**`)]});}
// 8D
if(command==='8d'){const p=kazagumo.players.get(message.guild.id);if(!p)return message.reply({embeds:[errorEmbed('Nothing playing!')]});if(p.data.get('8d')){await p.setRotation();p.data.set('8d',false);message.channel.send({embeds:[successEmbed('🎧 8D: **Off**')]});}else{await p.setRotation({rotationHz:0.2});p.data.set('8d',true);message.channel.send({embeds:[successEmbed('🎧 8D: **On** 🎧')]});}}
// REMOVE
if(command==='remove'){const p=kazagumo.players.get(message.guild.id);if(!p)return message.reply({embeds:[errorEmbed('Nothing playing!')]});const idx=parseInt(args[0]);if(!args[0]||isNaN(idx)||idx<1||idx>p.queue.length)return message.reply({embeds:[errorEmbed(`\`!rm <1-${p.queue.length||'?'}>\``)]});const rm=p.queue.splice(idx-1,1);if(rm?.[0])message.channel.send({embeds:[successEmbed(`🗑️ Removed: **${rm[0].title}**`)]});}
// CLEAR
if(command==='clear'){const p=kazagumo.players.get(message.guild.id);if(!p)return message.reply({embeds:[errorEmbed('Nothing playing!')]});const c=p.queue.length;if(c===0)return message.reply({embeds:[errorEmbed('Queue empty!')]});p.queue.clear();message.channel.send({embeds:[successEmbed(`🗑️ Cleared **${c}** tracks.`)]});}
// SHUFFLE
if(command==='shuffle'){const p=kazagumo.players.get(message.guild.id);if(!p)return message.reply({embeds:[errorEmbed('Nothing playing!')]});if(p.queue.length<2)return message.reply({embeds:[errorEmbed('Need 2+ songs!')]});p.queue.shuffle();message.channel.send({embeds:[successEmbed(`🔀 Shuffled **${p.queue.length}** tracks!`)]});}
// SAVE (MULTI MODE)
if(command==='save'){
const p=kazagumo.players.get(message.guild.id);if(!p?.queue.current)return message.reply({embeds:[errorEmbed('Nothing to save!')]});
if(!args[0])return message.reply({embeds:[new EmbedBuilder().setColor(BOT_INFO.color).setAuthor({name:'Save Playlist',iconURL:client.user.displayAvatarURL()}).setDescription('**Usage:**\n`!save <name>` → All queue\n`!save <name> current` → Current only\n`!save <name> 1-5` → Track 1-5\n`!save <name> 3,5,7` → Specific\n`!save <name> top10` → Top 10\n\n**Example:**\n```\n!save Rock Playlist\n!save Favs current\n!save Chill 1-10\n!save Best 2,4,6\n```')]});
const allArgs=args.join(' ');let name,mode;
const rm=allArgs.match(/^(.+?)\s+(current|\d+-\d+|\d+(?:,\d+)+|top\d+)$/i);
if(rm){name=rm[1].trim();mode=rm[2].toLowerCase();}else{name=allArgs.trim();mode='all';}
if(name.length>50)return message.reply({embeds:[errorEmbed('Max 50 chars!')]});
const allTracks=[p.queue.current,...p.queue];
const selection=parseTrackSelection(mode,allTracks);
if(selection.error)return message.reply({embeds:[errorEmbed(selection.error)]});
if(selection.tracks.length===0)return message.reply({embeds:[errorEmbed('No tracks!')]});
const existing=await db.getUserPlaylists(message.author.id);const pc=Object.keys(existing).length;
if(pc>=25&&!existing[name])return message.reply({embeds:[errorEmbed(`**${pc}/25** playlists! Delete one first.`)]});
const success=await db.savePlaylist(message.author.id,name,selection.tracks);
if(success){let preview='';selection.tracks.slice(0,8).forEach((t,i)=>{preview+=`\`${i+1}.\` ${t.title}\n`;});if(selection.tracks.length>8)preview+=`*...+${selection.tracks.length-8} more*\n`;
message.channel.send({embeds:[new EmbedBuilder().setColor(BOT_INFO.color).setAuthor({name:'💾 Saved!',iconURL:message.author.displayAvatarURL()}).setDescription(`**Name:** ${name}\n**Mode:** ${selection.description}\n**Tracks:** ${selection.tracks.length}\n\n${preview}\n\`!load ${name}\` to load.`).setFooter({text:`${Math.min(pc+1,25)}/25 playlists`}).setTimestamp()]});}
else message.reply({embeds:[errorEmbed('Failed to save!')]});
}
// SAVED
if(command==='saved'){
const pls=await db.getUserPlaylists(message.author.id);const names=Object.keys(pls);
if(args.length>0){const name=args.join(' ');const pl=pls[name];if(!pl)return message.reply({embeds:[errorEmbed(`**${name}** not found!`)]});
let d='';pl.tracks.slice(0,15).forEach((t,i)=>{d+=`\`${i+1}.\` **${t.title}** • ${t.author||'Unknown'}\n     ⏱️ ${formatDuration(t.length)}\n`;});if(pl.tracks.length>15)d+=`\n*...+${pl.tracks.length-15} more*`;
let td=0;pl.tracks.forEach(t=>{td+=t.length||0;});
return message.channel.send({embeds:[new EmbedBuilder().setColor(BOT_INFO.color).setAuthor({name:`📃 ${name}`,iconURL:message.author.displayAvatarURL()}).setDescription(d).addFields({name:'Tracks',value:`${pl.trackCount}`,inline:true},{name:'Duration',value:formatDuration(td),inline:true},{name:'Created',value:new Date(pl.createdAt).toLocaleDateString(),inline:true}).setFooter({text:`!load ${name} • !ls ${name} • !dl ${name}`})]});}
if(names.length===0)return message.reply({embeds:[errorEmbed('No playlists!\n`!save <name>` to create')]});
let d='';names.forEach((n,i)=>{const pl=pls[n];d+=`\`${i+1}.\` **${n}**\n     🎵 ${pl.trackCount} tracks • 📅 ${new Date(pl.createdAt).toLocaleDateString()}\n\n`;});
message.channel.send({embeds:[new EmbedBuilder().setColor(BOT_INFO.color).setAuthor({name:`${message.author.username}'s Playlists`,iconURL:message.author.displayAvatarURL()}).setDescription(d).addFields({name:'Commands',value:'`!saved <name>` Detail\n`!load <name>` Load\n`!ls <name>` Load+Shuffle\n`!addto <name>` Add current\n`!rl <old> > <new>` Rename\n`!dl <name>` Delete'}).setFooter({text:`${names.length}/25`})]});
}
// LOAD
if(command==='load'){
if(!message.member.voice.channel)return message.reply({embeds:[errorEmbed('Join VC first!')]});
const name=args.join(' ');if(!name)return message.reply({embeds:[errorEmbed('`!load <name>` • `!saved` to see')]});
const pls=await db.getUserPlaylists(message.author.id);const pl=pls[name];
if(!pl){const av=Object.keys(pls);let d=`**${name}** not found!\n`;if(av.length>0){d+='**Your playlists:**\n';av.forEach(p=>{d+=`• ${p} (${pls[p].trackCount})\n`;});}return message.reply({embeds:[errorEmbed(d)]});}
try{const player=await getOrCreatePlayer(kazagumo,message);const queries=pl.tracks.map(t=>t.uri);await addMultipleTracks(kazagumo,player,queries,message.author,message.channel);if(!player.playing&&!player.paused&&player.queue.length>0)await player.play();}catch(e){message.reply({embeds:[errorEmbed(e.message)]});}
}
// LOADSHUF
if(command==='loadshuf'){
if(!message.member.voice.channel)return message.reply({embeds:[errorEmbed('Join VC first!')]});
const name=args.join(' ');if(!name)return message.reply({embeds:[errorEmbed('`!ls <name>`')]});
const pls=await db.getUserPlaylists(message.author.id);const pl=pls[name];if(!pl)return message.reply({embeds:[errorEmbed(`**${name}** not found!`)]});
try{const player=await getOrCreatePlayer(kazagumo,message);const shuffled=[...pl.tracks].sort(()=>Math.random()-0.5);
message.channel.send({embeds:[new EmbedBuilder().setColor(BOT_INFO.color).setDescription(`🔀 Loading **${name}** shuffled...`)]});
await addMultipleTracks(kazagumo,player,shuffled.map(t=>t.uri),message.author,message.channel);if(!player.playing&&!player.paused&&player.queue.length>0)await player.play();}catch(e){message.reply({embeds:[errorEmbed(e.message)]});}
}
// ADDTO (MULTI MODE)
if(command==='addto'){
const p=kazagumo.players.get(message.guild.id);if(!p?.queue.current)return message.reply({embeds:[errorEmbed('Nothing playing!')]});
if(!args[0])return message.reply({embeds:[errorEmbed('**Usage:**\n`!addto <name>` → Add current\n`!addto <name> all` → Add all queue\n`!addto <name> 1-5` → Add track 1-5\n`!addto <name> 2,4,6` → Add specific\n`!addto <name> top10` → Add top 10')]});
const allArgs=args.join(' ');let name,mode;
const rm2=allArgs.match(/^(.+?)\s+(all|current|\d+-\d+|\d+(?:,\d+)+|top\d+)$/i);
if(rm2){name=rm2[1].trim();mode=rm2[2].toLowerCase();}else{name=allArgs.trim();mode='current';}
const pls=await db.getUserPlaylists(message.author.id);const pl=pls[name];
if(!pl)return message.reply({embeds:[errorEmbed(`**${name}** not found!\n\`!save ${name}\` to create`)]});
const allTracks=[p.queue.current,...p.queue];
const selection=parseTrackSelection(mode,allTracks);
if(selection.error)return message.reply({embeds:[errorEmbed(selection.error)]});
if(selection.tracks.length===0)return message.reply({embeds:[errorEmbed('No tracks!')]});
if(pl.tracks.length+selection.tracks.length>200)return message.reply({embeds:[errorEmbed(`Playlist full! ${pl.tracks.length}/200. Can add max ${200-pl.tracks.length} more.`)]});
let added=0;let skipped=0;
for(const t of selection.tracks){if(pl.tracks.some(pt=>pt.uri===t.uri)){skipped++;continue;}
pl.tracks.push({title:t.title,uri:t.uri,author:t.author,length:t.length,thumbnail:t.thumbnail,source:t.sourceName||'youtube'});added++;}
pl.trackCount=pl.tracks.length;pls[name]=pl;
await redis.set(`user:${message.author.id}:playlists`,JSON.stringify(pls));await redis.expire(`user:${message.author.id}:playlists`,7776000);
let desc=`➕ Added **${added}** tracks to **${name}**`;if(skipped>0)desc+=`\n⏭️ Skipped **${skipped}** duplicates`;desc+=`\n📊 Total: **${pl.trackCount}** tracks`;
message.channel.send({embeds:[successEmbed(desc)]});
}
// DELETELIST
if(command==='deletelist'){const name=args.join(' ');if(!name)return message.reply({embeds:[errorEmbed('`!dl <name>`')]});const ok=await db.deletePlaylist(message.author.id,name);if(ok)message.channel.send({embeds:[successEmbed(`🗑️ Deleted **${name}**`)]});else message.reply({embeds:[errorEmbed(`**${name}** not found!`)]});}
// RENAMELIST
if(command==='renamelist'){const fa=args.join(' ');if(!fa||!fa.includes('>'))return message.reply({embeds:[errorEmbed('`!rl <old> > <new>`')]});const pts=fa.split('>').map(p=>p.trim());if(!pts[0]||!pts[1])return message.reply({embeds:[errorEmbed('`!rl <old> > <new>`')]});if(pts[1].length>50)return message.reply({embeds:[errorEmbed('Max 50 chars!')]});const pls=await db.getUserPlaylists(message.author.id);if(!pls[pts[0]])return message.reply({embeds:[errorEmbed(`**${pts[0]}** not found!`)]});if(pls[pts[1]])return message.reply({embeds:[errorEmbed(`**${pts[1]}** exists!`)]});pls[pts[1]]=pls[pts[0]];delete pls[pts[0]];await redis.set(`user:${message.author.id}:playlists`,JSON.stringify(pls));await redis.expire(`user:${message.author.id}:playlists`,7776000);message.channel.send({embeds:[successEmbed(`✏️ **${pts[0]}** → **${pts[1]}**`)]});}
// FAV (MULTI MODE)
if(command==='fav'){
const p=kazagumo.players.get(message.guild.id);if(!p?.queue.current)return message.reply({embeds:[errorEmbed('Nothing playing!')]});
const mode=args[0]?.toLowerCase();
// Single fav (no args)
if(!mode){const ok=await db.addFavorite(message.author.id,p.queue.current);if(ok)message.channel.send({embeds:[successEmbed(`❤️ **${p.queue.current.title}** added to favorites!`)]});else message.reply({embeds:[errorEmbed('Already in favorites!')]});return;}
// Multi fav
const allTracks=[p.queue.current,...p.queue];
const selection=parseTrackSelection(mode,allTracks);
if(selection.error)return message.reply({embeds:[errorEmbed(selection.error)]});
if(selection.tracks.length===0)return message.reply({embeds:[errorEmbed('No tracks!')]});
const result=await db.addMultipleFavorites(message.author.id,selection.tracks);
let desc=`❤️ Added **${result.added}** to favorites!`;if(result.skipped>0)desc+=`\n⏭️ Skipped **${result.skipped}** (already favorited)`;
message.channel.send({embeds:[successEmbed(desc)]});
}
// FAVLIST
if(command==='favlist'){
const favs=await db.getFavorites(message.author.id);if(favs.length===0)return message.reply({embeds:[errorEmbed('No favorites! `!fav` while playing')]});
const pg=parseInt(args[0])||1;const pp=10;const tp=Math.ceil(favs.length/pp);const cp=Math.min(pg,tp);const st=(cp-1)*pp;
let d='';favs.slice(st,st+pp).forEach((t,i)=>{d+=`\`${st+i+1}.\` [${t.title}](${t.uri}) • \`${formatDuration(t.length)}\`\n`;});
if(tp>1)d+=`\n📄 **${cp}/${tp}** • \`!fl <page>\``;
message.channel.send({embeds:[new EmbedBuilder().setColor(BOT_INFO.color).setAuthor({name:`${message.author.username}'s Favorites ❤️`,iconURL:message.author.displayAvatarURL()}).setDescription(d).addFields({name:'Commands',value:'`!playfav` Play all\n`!fav` Add current\n`!fav all` Add all queue\n`!fav 1-5` Add range\n`!unfav <num>` Remove one\n`!unfav 1,3,5` Remove multi\n`!unfav all` Clear all'}).setFooter({text:`${favs.length}/100 favorites`})]});
}
// UNFAV (MULTI MODE)
if(command==='unfav'){
if(!args[0])return message.reply({embeds:[errorEmbed('`!unfav <number>`\n`!unfav 1,3,5` multi\n`!unfav all` clear all')]});
const mode=args[0].toLowerCase();
// Clear all
if(mode==='all'){const ok=await db.clearFavorites(message.author.id);if(ok)message.channel.send({embeds:[successEmbed('💔 Cleared all favorites!')]});else message.reply({embeds:[errorEmbed('Failed!')]});return;}
// Multi unfav: !unfav 1,3,5
if(mode.includes(',')){const indices=mode.split(',').map(n=>parseInt(n.trim())-1);const favs=await db.getFavorites(message.author.id);for(const idx of indices){if(isNaN(idx)||idx<0||idx>=favs.length)return message.reply({embeds:[errorEmbed(`Invalid number! Range: 1-${favs.length}`)]});}
const removed=await db.removeMultipleFavorites(message.author.id,indices);message.channel.send({embeds:[successEmbed(`💔 Removed **${removed}** favorites`)]});return;}
// Single unfav
const idx=parseInt(args[0]);if(isNaN(idx))return message.reply({embeds:[errorEmbed('`!unfav <number>`')]});
const ok=await db.removeFavorite(message.author.id,idx-1);if(ok)message.channel.send({embeds:[successEmbed(`💔 Removed #${idx}`)]});else message.reply({embeds:[errorEmbed('Invalid number!')]});
}
// PLAYFAV
if(command==='playfav'){
if(!message.member.voice.channel)return message.reply({embeds:[errorEmbed('Join VC first!')]});
const favs=await db.getFavorites(message.author.id);if(!favs.length)return message.reply({embeds:[errorEmbed('No favorites!')]});
try{const player=await getOrCreatePlayer(kazagumo,message);await addMultipleTracks(kazagumo,player,favs.map(f=>f.uri),message.author,message.channel);if(!player.playing&&!player.paused&&player.queue.length>0)await player.play();}catch(e){message.reply({embeds:[errorEmbed(e.message)]});}
}
// HISTORY
if(command==='history'){
const lim=parseInt(args[0])||10;const hist=await db.getHistory(message.guild.id,Math.min(lim,25));
if(!hist.length)return message.reply({embeds:[errorEmbed('No history!')]});
let d='';hist.forEach((e,i)=>{d+=`\`${i+1}.\` **${e.title}** • ${e.author}\n     ⏱️ ${formatDuration(e.length)} • 👤 ${e.requestedBy}\n\n`;});
message.channel.send({embeds:[new EmbedBuilder().setColor(BOT_INFO.color).setAuthor({name:`History • ${message.guild.name}`,iconURL:message.guild.iconURL()}).setDescription(d).setFooter({text:`Last ${hist.length} • !hist <number>`})]});
}
// RESTORE
if(command==='restore'){
if(!message.member.voice.channel)return message.reply({embeds:[errorEmbed('Join VC first!')]});
const sq=await db.getSavedQueue(message.guild.id);if(!sq)return message.reply({embeds:[errorEmbed('No saved queue!')]});
try{const player=await getOrCreatePlayer(kazagumo,message);const sm=await message.channel.send({embeds:[new EmbedBuilder().setColor('#FFA500').setDescription(`🔄 Restoring **${1+sq.queue.length}** tracks...`)]});
const all=[sq.current,...sq.queue];let loaded=0;let failed=0;
for(const td of all){try{const r=await kazagumo.search(td.uri,{requester:message.author});if(r?.tracks?.[0]){player.queue.add(r.tracks[0]);loaded++;}else{const fb=await kazagumo.search(`ytsearch:${td.title}`,{requester:message.author});if(fb?.tracks?.[0]){player.queue.add(fb.tracks[0]);loaded++;}else failed++;}}catch{failed++;}await new Promise(r=>setTimeout(r,300));}
player.setVolume(sq.volume||70);
await sm.edit({embeds:[new EmbedBuilder().setColor(BOT_INFO.color).setDescription(`✅ Restored!\n🎵 **${loaded}** loaded${failed>0?`\n❌ **${failed}** failed`:''}\n🔊 Vol: **${sq.volume||70}%**`).setTimestamp()]});
await db.deleteSavedQueue(message.guild.id);if(!player.playing&&!player.paused&&player.queue.length>0)await player.play();
}catch(e){message.reply({embeds:[errorEmbed(e.message)]});}
}
// SETTINGS
if(command==='settings'){
const sub=args[0]?.toLowerCase();const s=await db.getGuildSettings(message.guild.id);
if(!sub)return message.channel.send({embeds:[new EmbedBuilder().setColor(BOT_INFO.color).setAuthor({name:`Settings • ${message.guild.name}`,iconURL:message.guild.iconURL()}).setDescription(`🔊 **Volume:** ${s.volume}%\n📢 **Announce:** ${s.announceNowPlaying?'On ✅':'Off ❌'}\n⏱️ **Timeout:** ${s.autoLeaveTimeout/1000}s\n📊 **Max Queue:** ${s.maxQueueSize}\n🔄 **Duplicates:** ${s.allowDuplicates?'Yes':'No'}`).addFields({name:'Edit',value:'`!set volume <0-100>`\n`!set announce <on/off>`\n`!set timeout <10-600>`\n`!set maxqueue <10-1000>`\n`!set duplicates <on/off>`'})]});
if(!message.member.permissions.has('ManageGuild'))return message.reply({embeds:[errorEmbed('Need **Manage Server**!')]});
const val=args[1];
if(sub==='volume'){const v=parseInt(val);if(isNaN(v)||v<0||v>100)return message.reply({embeds:[errorEmbed('0-100')]});await db.updateGuildSetting(message.guild.id,'volume',v);message.channel.send({embeds:[successEmbed(`🔊 Default vol: **${v}%**`)]});}
else if(sub==='announce'){const on=val?.toLowerCase()==='on';await db.updateGuildSetting(message.guild.id,'announceNowPlaying',on);message.channel.send({embeds:[successEmbed(`📢 Announce: **${on?'On':'Off'}**`)]});}
else if(sub==='timeout'){const sec=parseInt(val);if(isNaN(sec)||sec<10||sec>600)return message.reply({embeds:[errorEmbed('10-600')]});await db.updateGuildSetting(message.guild.id,'autoLeaveTimeout',sec*1000);message.channel.send({embeds:[successEmbed(`⏱️ Timeout: **${sec}s**`)]});}
else if(sub==='maxqueue'){const mx=parseInt(val);if(isNaN(mx)||mx<10||mx>1000)return message.reply({embeds:[errorEmbed('10-1000')]});await db.updateGuildSetting(message.guild.id,'maxQueueSize',mx);message.channel.send({embeds:[successEmbed(`📊 Max queue: **${mx}**`)]});}
else if(sub==='duplicates'){const on=val?.toLowerCase()==='on';await db.updateGuildSetting(message.guild.id,'allowDuplicates',on);message.channel.send({embeds:[successEmbed(`🔄 Duplicates: **${on?'Yes':'No'}**`)]});}
else message.reply({embeds:[errorEmbed('Unknown! `!settings`')]});
}
// HELP
if(command==='help'){
message.channel.send({embeds:[new EmbedBuilder().setColor(BOT_INFO.color).setAuthor({name:BOT_INFO.name,iconURL:client.user.displayAvatarURL()}).setDescription(BOT_INFO.description).addFields(
{name:'🎵 Music',value:'```\n!play (!p)         - Play song\n!pm (!multi !ba)   - Multi add (,)\n!pf                - From .txt file\n!pl                - Playlist URL\n!skip (!s !n)      - Skip\n!stop (!dc !leave) - Stop & leave\n!pause (!ps)       - Pause\n!resume (!rs !up)  - Resume\n```'},
{name:'📋 Queue',value:'```\n!queue (!q)        - View queue\n!np (!now)         - Now playing\n!loop (!lp !rp)    - track/queue/off\n!rm (!del)         - Remove track\n!clear (!cls)      - Clear queue\n!shuffle (!sf)     - Shuffle\n!restore (!res)    - Restore queue\n```'},
{name:'💾 Save & Load',value:'```\n!save (!sv)        - Save queue\n  + current/1-5/3,5,7/top10\n!saved (!mylist)   - View playlists\n!load (!ld)        - Load playlist\n!ls                - Load + shuffle\n!addto (!at)       - Add to playlist\n  + all/1-5/3,5,7/top10\n!rl <old>><new>    - Rename\n!dl                - Delete\n```'},
{name:'❤️ Favorites',value:'```\n!fav (!love !like) - Fav current\n  + all/1-5/3,5,7/top10\n!favlist (!fl)     - View favorites\n!playfav (!pfav)   - Play all favs\n!unfav (!uf)       - Remove one\n  + 1,3,5 (multi) / all (clear)\n```'},
{name:'🎛️ Control & Info',value:'```\n!vol (!v)          - Volume (saved)\n!seek (!jt)        - Seek to time\n!8d                - Toggle 8D\n!history (!hist)   - Play history\n!settings (!set)   - Server config\n!info (!about)     - Bot info\n!ping (!ms)        - Latency\n```'}
).setFooter({text:`Made by ${BOT_INFO.owner.display} • v${BOT_INFO.version}`}).setTimestamp()]});
}
// INFO
if(command==='info'){const up=process.uptime();const h=Math.floor(up/3600);const m=Math.floor((up%3600)/60);const st=await db.getStats();message.channel.send({embeds:[new EmbedBuilder().setColor(BOT_INFO.color).setAuthor({name:BOT_INFO.name,iconURL:client.user.displayAvatarURL()}).setDescription(BOT_INFO.description).addFields({name:'👨‍💻 Developer',value:`<@${BOT_INFO.owner.id}>`,inline:true},{name:'📊 Servers',value:`${client.guilds.cache.size}`,inline:true},{name:'⏱️ Uptime',value:`${h}h ${m}m`,inline:true},{name:'🎵 Played',value:`${st.songsPlayed.toLocaleString()}`,inline:true},{name:'📝 Commands',value:`${st.commandsUsed.toLocaleString()}`,inline:true},{name:'💾 DB',value:redis.status==='ready'?'🟢 Online':'🔴 Offline',inline:true}).setFooter({text:`v${BOT_INFO.version} • Discord.js v14 • Lavalink v4`}).setTimestamp()]});}
// PING
if(command==='ping'){const lat=Date.now()-message.createdTimestamp;const nd=kazagumo.shoukaku.nodes.get('Serenetia');let rp='N/A';try{const s=Date.now();await redis.ping();rp=`${Date.now()-s}ms`;}catch{rp='Error';}message.channel.send({embeds:[new EmbedBuilder().setColor(BOT_INFO.color).setDescription(`🏓 **Pong!**\n📡 Bot: \`${lat}ms\`\n💓 API: \`${Math.round(client.ws.ping)}ms\`\n🎵 Lavalink: \`${nd?.stats?.ping||'N/A'}ms\`\n💾 Redis: \`${rp}\``)]});}
});
async function gracefulShutdown(sig){console.log(`\n⚠️ ${sig}. Saving...`);try{for(const[gid,p]of kazagumo.players){if(p.queue.current){await autoSaveQueue(p);console.log(`💾 Saved ${gid}`);}}console.log('✅ Saved!');}catch(e){console.error('Save error:',e);}await redis.quit();process.exit(0);}
process.on('SIGTERM',()=>gracefulShutdown('SIGTERM'));
process.on('SIGINT',()=>gracefulShutdown('SIGINT'));
process.on('unhandledRejection',(r)=>{console.error('Unhandled:',r);});
process.on('uncaughtException',(e)=>{console.error('Uncaught:',e);});
const token=process.env.DISCORD_TOKEN;if(!token){console.error('❌ No token!');process.exit(1);}
client.login(token).catch(e=>{console.error('❌ Login:',e);process.exit(1);});
