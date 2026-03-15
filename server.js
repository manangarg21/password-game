const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const { getNextWord } = require('./words');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── In-Memory Store ───────────────────────────────────────────────────────────
const ROOMS   = new Map(); // roomId → room obj
const PLAYERS = new Map(); // playerId → player obj
const TEAMS   = new Map(); // teamId → team obj
const GAME_STATES = new Map(); // roomId → gameState

// ── Helpers ───────────────────────────────────────────────────────────────────
function genCode() {
  const c='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s=''; for(let i=0;i<6;i++) s+=c[Math.floor(Math.random()*c.length)]; return s;
}
function getRoomByCode(code) {
  for(const r of ROOMS.values()) if(r.code===code.toUpperCase()&&r.status!=='ended') return r;
  return null;
}
function getRoom(id)  { return ROOMS.get(id)||null; }
function getPlayer(id){ return PLAYERS.get(id)||null; }
function getPlayersInRoom(rid){ return [...PLAYERS.values()].filter(p=>p.roomId===rid).sort((a,b)=>a.joinOrder-b.joinOrder); }
function getTeamsInRoom(rid)  { return [...TEAMS.values()].filter(t=>t.roomId===rid); }
function lobbyState(rid){ return { room:getRoom(rid), players:getPlayersInRoom(rid), teams:getTeamsInRoom(rid) }; }

const TCOLORS=['#7c3aed','#db2777','#d97706','#059669','#2563eb','#dc2626','#0891b2','#8b5cf6'];
const TNAMES =['Team Violet','Team Pink','Team Amber','Team Green','Team Blue','Team Red','Team Cyan','Team Purple'];

function autoAssign(rid) {
  for(const[id,t] of TEAMS.entries()) if(t.roomId===rid) TEAMS.delete(id);
  for(const p of PLAYERS.values()) if(p.roomId===rid) p.teamId=null;
  const players=getPlayersInRoom(rid).filter(p=>p.isConnected);
  const n=Math.floor(players.length/2); if(n<1) return;
  const sh=[...players].sort(()=>Math.random()-.5);
  const tids=[];
  for(let i=0;i<n;i++){
    const tid=uuidv4();
    TEAMS.set(tid,{id:tid,roomId:rid,name:TNAMES[i],color:TCOLORS[i],hinterIdx:0,score:0,correctGuesses:0});
    tids.push(tid);
  }
  for(let i=0;i<n*2;i++) sh[i].teamId=tids[i%n];
}

// ── Game Engine ───────────────────────────────────────────────────────────────
function buildHinterMap(rid) {
  const map={};
  for(const team of getTeamsInRoom(rid)){
    const tp=getPlayersInRoom(rid).filter(p=>p.teamId===team.id);
    map[team.id]={players:tp.map(p=>p.id),names:tp.map(p=>p.name),hinterIdx:team.hinterIdx||0};
  }
  return map;
}

function initGame(rid) {
  const room=getRoom(rid), settings=room.settings||{}, teams=getTeamsInRoom(rid);
  const teamOrder=teams.map(t=>t.id);
  const hm=buildHinterMap(rid);
  const used=room.usedWordIds||[];
  const w=getNextWord(used,settings.categories||null);
  if(w&&!used.includes(w.id)) room.usedWordIds=[...used,w.id];
  const gs={
    roomId:rid,phase:'hint',
    currentWord:w?w.word:'Unknown',currentWordId:w?w.id:null,currentBannedWords:w?w.banned:[],
    currentHint:null,roundNumber:1,turnIdx:0,teamOrder,currentTeamId:teamOrder[0],
    attempts:[],wordNumber:1,settings,hintersByTeam:hm,resultData:null
  };
  GAME_STATES.set(rid,gs); return gs;
}

function curRoles(gs){
  const info=gs.hintersByTeam[gs.currentTeamId];
  if(!info||info.players.length<2) return {hinterId:null,guesserId:null};
  return {hinterId:info.players[info.hinterIdx],guesserId:info.players[1-info.hinterIdx]};
}

function pubState(gs,rid){
  const teams=getTeamsInRoom(rid),players=getPlayersInRoom(rid);
  const ts={};for(const t of teams) ts[t.id]={score:t.score,correct:t.correctGuesses,name:t.name,color:t.color};
  const tr={};
  for(const[tid,info] of Object.entries(gs.hintersByTeam)){
    tr[tid]={hinterId:info.players[info.hinterIdx],guesserId:info.players[1-info.hinterIdx],
             hinterName:info.names[info.hinterIdx],guesserName:info.names[1-info.hinterIdx]};
  }
  const {hinterId,guesserId}=curRoles(gs);
  return {phase:gs.phase,currentHint:gs.currentHint,roundNumber:gs.roundNumber,
    currentTeamId:gs.currentTeamId,teamOrder:gs.teamOrder,attempts:gs.attempts,
    wordNumber:gs.wordNumber,teamScores:ts,players,teams,teamRoles:tr,
    activeHinterId:hinterId,activeGuesserId:guesserId,resultData:gs.resultData};
}

function advance(rid){
  const gs=GAME_STATES.get(rid); if(!gs) return;
  const info=gs.hintersByTeam[gs.currentTeamId];
  if(info){
    info.hinterIdx=1-info.hinterIdx;
    const t=TEAMS.get(gs.currentTeamId); if(t) t.hinterIdx=info.hinterIdx;
  }
  gs.turnIdx++; gs.currentHint=null;
  if(gs.turnIdx>=gs.teamOrder.length){
    gs.roundNumber++; gs.turnIdx=0;
    if(gs.roundNumber>3){
      gs.phase='word_end';
      gs.resultData={word:gs.currentWord,correct:false,noOneGotIt:true,attempts:[...gs.attempts]};
      return 'word_end';
    }
  }
  gs.currentTeamId=gs.teamOrder[gs.turnIdx]; gs.phase='hint'; return 'next_turn';
}

function nextWord(rid){
  const gs=GAME_STATES.get(rid),room=getRoom(rid); if(!gs||!room) return;
  const used=room.usedWordIds||[];
  const w=getNextWord(used,gs.settings.categories||null);
  if(w&&!used.includes(w.id)) room.usedWordIds=[...used,w.id];
  gs.currentWord=w?w.word:'Unknown'; gs.currentWordId=w?w.id:null;
  gs.currentBannedWords=w?w.banned:[]; gs.currentHint=null;
  gs.roundNumber=1; gs.turnIdx=0; gs.currentTeamId=gs.teamOrder[0];
  gs.attempts=[]; gs.phase='hint'; gs.resultData=null; gs.wordNumber++;
}

function sendWordToHinter(gs,hinterId){
  const hp=getPlayer(hinterId);
  if(hp?.socketId) io.to(hp.socketId).emit('private_word_data',
    {word:gs.currentWord,bannedWords:gs.currentBannedWords,roundNumber:gs.roundNumber});
}

// ── Socket.io ─────────────────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log(`[+] ${socket.id}`);

  socket.on('create_room', ({playerName}, cb) => {
    try{
      if(!playerName?.trim()) return cb({error:'Name required'});
      let code; let tries=0;
      do{code=genCode();tries++;}while(getRoomByCode(code)&&tries<20);
      const rid=uuidv4(), pid=uuidv4();
      ROOMS.set(rid,{id:rid,code,ownerId:pid,status:'lobby',settings:{categories:null},usedWordIds:[]});
      PLAYERS.set(pid,{id:pid,roomId:rid,name:playerName.trim(),socketId:socket.id,teamId:null,isConnected:true,joinOrder:0});
      socket.join(rid); socket.data={playerId:pid,roomId:rid,playerName:playerName.trim()};
      cb({roomId:rid,roomCode:code,playerId:pid,playerName:playerName.trim(),isOwner:true});
      io.to(rid).emit('room_state',lobbyState(rid));
    }catch(e){console.error(e);cb({error:'Server error'});}
  });

  socket.on('join_room', ({roomCode,playerName,playerId:eid}, cb) => {
    try{
      if(!playerName?.trim()) return cb({error:'Name required'});
      const room=getRoomByCode(roomCode);
      if(!room) return cb({error:'Room not found or game ended'});
      if(room.status==='playing'&&!eid) return cb({error:'Game already started'});

      if(eid){
        const ex=getPlayer(eid);
        if(ex&&ex.roomId===room.id){
          ex.socketId=socket.id; ex.isConnected=true;
          socket.join(room.id); socket.data={playerId:eid,roomId:room.id,playerName:ex.name};
          cb({roomId:room.id,roomCode:room.code,playerId:eid,playerName:ex.name,isOwner:room.ownerId===eid,reconnect:true});
          if(room.status==='playing'){
            const gs=GAME_STATES.get(room.id);
            if(gs){
              io.to(room.id).emit('game_state',pubState(gs,room.id));
              const {hinterId}=curRoles(gs);
              if(hinterId===eid&&gs.phase==='hint') sendWordToHinter(gs,eid);
            }
          } else io.to(room.id).emit('room_state',lobbyState(room.id));
          return;
        }
      }

      const active=getPlayersInRoom(room.id).filter(p=>p.isConnected);
      if(active.length>=8) return cb({error:'Room is full (max 8)'});
      const pid=uuidv4(), jo=getPlayersInRoom(room.id).length;
      PLAYERS.set(pid,{id:pid,roomId:room.id,name:playerName.trim(),socketId:socket.id,teamId:null,isConnected:true,joinOrder:jo});
      socket.join(room.id); socket.data={playerId:pid,roomId:room.id,playerName:playerName.trim()};
      cb({roomId:room.id,roomCode:room.code,playerId:pid,playerName:playerName.trim(),isOwner:false});
      io.to(room.id).emit('room_state',lobbyState(room.id));
      io.to(room.id).emit('player_joined',{playerName:playerName.trim()});
    }catch(e){console.error(e);cb({error:'Server error'});}
  });

  socket.on('auto_assign_teams', ({roomId}, cb) => {
    const room=getRoom(roomId);
    if(!room||room.ownerId!==socket.data?.playerId) return cb?.({error:'Not authorized'});
    const players=getPlayersInRoom(roomId).filter(p=>p.isConnected);
    if(players.length<2) return cb?.({error:'Need at least 2 players'});
    autoAssign(roomId);
    io.to(roomId).emit('room_state',lobbyState(roomId));
    cb?.({ok:true});
  });

  socket.on('update_teams', ({roomId,teams}, cb) => {
    const room=getRoom(roomId);
    if(!room||room.ownerId!==socket.data?.playerId) return cb?.({error:'Not authorized'});
    for(const[id,t] of TEAMS.entries()) if(t.roomId===roomId) TEAMS.delete(id);
    for(const p of PLAYERS.values()) if(p.roomId===roomId) p.teamId=null;
    for(const team of teams){
      const tid=team.id||uuidv4();
      TEAMS.set(tid,{id:tid,roomId,name:team.name,color:team.color||'#7c3aed',hinterIdx:0,score:0,correctGuesses:0});
      for(const pid of (team.playerIds||[])){const p=getPlayer(pid);if(p) p.teamId=tid;}
    }
    io.to(roomId).emit('room_state',lobbyState(roomId));
    cb?.({ok:true});
  });

  socket.on('update_settings', ({roomId,settings}, cb) => {
    const room=getRoom(roomId);
    if(!room||room.ownerId!==socket.data?.playerId) return cb?.({error:'Not authorized'});
    room.settings=settings;
    io.to(roomId).emit('settings_updated',settings);
    cb?.({ok:true});
  });

  socket.on('start_game', ({roomId}, cb) => {
    const room=getRoom(roomId);
    if(!room) return cb?.({error:'Room not found'});
    if(room.ownerId!==socket.data?.playerId) return cb?.({error:'Not authorized'});
    const teams=getTeamsInRoom(roomId);
    if(teams.length<1) return cb?.({error:'Assign teams first'});
    for(const t of teams){
      const tp=getPlayersInRoom(roomId).filter(p=>p.teamId===t.id);
      if(tp.length<2) return cb?.({error:`${t.name} needs 2 players`});
    }
    room.status='playing';
    const gs=initGame(roomId);
    const {hinterId}=curRoles(gs);
    io.to(roomId).emit('game_started',{});
    setTimeout(()=>{
      io.to(roomId).emit('game_state',pubState(gs,roomId));
      sendWordToHinter(gs,hinterId);
    },800);
    cb?.({ok:true});
  });

  socket.on('submit_hint', ({hint}, cb) => {
    const {playerId,roomId}=socket.data||{};
    if(!playerId||!roomId) return cb?.({error:'Not in a room'});
    const gs=GAME_STATES.get(roomId);
    if(!gs||gs.phase!=='hint') return cb?.({error:'Not hint phase'});
    const {hinterId}=curRoles(gs);
    if(hinterId!==playerId) return cb?.({error:'Not your turn to hint'});
    const ht=(hint||'').trim();
    if(!ht) return cb?.({error:'Hint cannot be empty'});
    // Enforce one-word rule
    if(ht.split(/\s+/).length>1) return cb?.({error:'Hint must be a single word — no spaces!'});
    const low=ht.toLowerCase();
    if(low.includes(gs.currentWord.toLowerCase())) return cb?.({error:`Cannot use the password "${gs.currentWord}" in hint!`});
    for(const b of gs.currentBannedWords) if(low.includes(b.toLowerCase())) return cb?.({error:`"${b}" is banned!`});
    gs.currentHint=ht; gs.phase='guess';
    io.to(roomId).emit('hint_submitted',{hint:ht,teamId:gs.currentTeamId});
    io.to(roomId).emit('game_state',pubState(gs,roomId));
    const {guesserId}=curRoles(gs);
    const gp=getPlayer(guesserId);
    if(gp?.socketId) io.to(gp.socketId).emit('your_turn_to_guess',{hint:ht});
    cb?.({ok:true});
  });

  socket.on('submit_guess', ({guess}, cb) => {
    const {playerId,roomId}=socket.data||{};
    if(!playerId||!roomId) return cb?.({error:'Not in a room'});
    const gs=GAME_STATES.get(roomId);
    if(!gs||gs.phase!=='guess') return cb?.({error:'Not guess phase'});
    const {guesserId}=curRoles(gs);
    if(guesserId!==playerId) return cb?.({error:'Not your turn to guess'});
    const gt=(guess||'').trim();
    if(!gt) return cb?.({error:'Guess cannot be empty'});
    const correct=gt.toLowerCase()===gs.currentWord.toLowerCase();
    const points=correct?(gs.roundNumber===3?0.5:1):0;
    gs.attempts.push({teamId:gs.currentTeamId,hint:gs.currentHint,guess:gt,correct,points,roundNumber:gs.roundNumber});

    if(correct){
      const team=TEAMS.get(gs.currentTeamId);
      if(team){team.score+=points;team.correctGuesses+=1;}
      gs.phase='word_end';
      gs.resultData={word:gs.currentWord,correct:true,winnerTeamId:gs.currentTeamId,
        points,guess:gt,hint:gs.currentHint,roundNumber:gs.roundNumber,attempts:[...gs.attempts]};
      io.to(roomId).emit('game_state',pubState(gs,roomId));
      cb?.({ok:true,correct:true,points});
    } else {
      gs.phase='result';
      io.to(roomId).emit('wrong_guess',{guess:gt,teamId:gs.currentTeamId,hint:gs.currentHint});
      io.to(roomId).emit('game_state',pubState(gs,roomId));
      cb?.({ok:true,correct:false});
      setTimeout(()=>{
        const res=advance(roomId);
        const ugs=GAME_STATES.get(roomId); if(!ugs) return;
        io.to(roomId).emit('game_state',pubState(ugs,roomId));
        if(res!=='word_end'){const {hinterId:nh}=curRoles(ugs);sendWordToHinter(ugs,nh);}
      },2000);
    }
  });

  socket.on('next_word', ({roomId}, cb) => {
    const room=getRoom(roomId);
    if(!room||room.ownerId!==socket.data?.playerId) return cb?.({error:'Not authorized'});
    const gs=GAME_STATES.get(roomId);
    if(!gs||gs.phase!=='word_end') return cb?.({error:'Not word_end phase'});
    nextWord(roomId);
    const {hinterId}=curRoles(gs);
    io.to(roomId).emit('game_state',pubState(gs,roomId));
    sendWordToHinter(gs,hinterId);
    cb?.({ok:true});
  });

  socket.on('end_game', ({roomId}, cb) => {
    const room=getRoom(roomId);
    if(!room||room.ownerId!==socket.data?.playerId) return cb?.({error:'Not authorized'});
    room.status='ended';
    const teams=getTeamsInRoom(roomId);
    const ts={}; for(const t of teams) ts[t.id]={score:t.score,correct:t.correctGuesses,name:t.name,color:t.color};
    let winner=null,max=-1;
    for(const t of teams) if(t.score>max){max=t.score;winner=t;}
    const gs=GAME_STATES.get(roomId);
    io.to(roomId).emit('game_ended',{
      teams,teamScores:ts,winner,
      totalWordsPlayed:gs?gs.wordNumber-1:0,
      players:getPlayersInRoom(roomId)
    });
    cb?.({ok:true});
  });

  socket.on('disconnect', () => {
    const {playerId,roomId}=socket.data||{};
    if(!playerId) return;
    const p=getPlayer(playerId); if(p) p.isConnected=false;
    if(roomId){
      io.to(roomId).emit('room_state',lobbyState(roomId));
      io.to(roomId).emit('player_disconnected',{playerId});
    }
    console.log(`[-] ${playerId}`);
  });
});

app.get('/api/room/:code', (req,res)=>{
  const room=getRoomByCode(req.params.code);
  if(!room) return res.json({exists:false});
  res.json({exists:true,playerCount:getPlayersInRoom(room.id).filter(p=>p.isConnected).length,status:room.status});
});

app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));

const PORT=process.env.PORT||3000;
server.listen(PORT,()=>console.log(`\n🎮  Password Game  →  http://localhost:${PORT}\n`));
