// Unified Game Server for John Stick - Handles Both Duels and Co-op
const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 8080;

const server = http.createServer();
const wss = new WebSocket.Server({ server });

// ==================== UNIFIED MATCHMAKING ====================
class UnifiedMatchmaking {
  constructor() {
    // Duels
    this.duelsQueue = [];
    this.duelsMatches = new Map();
    
    // Co-op
    this.coopQueue = [];
    this.coopRooms = new Map();
    
    // Shared
    this.playerSessions = new Map();
    this.matchIdCounter = 0;
    this.roomIdCounter = 0;
  }

  // ==================== DUELS MODE ====================
  
  addDuelsPlayer(ws, playerData) {
    const player = {
      ws,
      id: playerData.playerId,
      name: playerData.playerName || 'Anonymous',
      rating: playerData.rating || 1000,
      joinTime: Date.now(),
      mode: 'duels'
    };

    this.duelsQueue.push(player);
    this.playerSessions.set(ws, player);
    
    console.log(`✅ [DUELS] Player ${player.name} joined queue (Rating: ${player.rating})`);
    
    this.tryDuelsMatchmaking();
  }

  removeDuelsPlayer(ws) {
    const player = this.playerSessions.get(ws);
    if (player && player.mode === 'duels') {
      this.duelsQueue = this.duelsQueue.filter(p => p.ws !== ws);
      console.log(`❌ [DUELS] Player ${player.name} left queue`);
    }
  }

  tryDuelsMatchmaking() {
    while (this.duelsQueue.length >= 2) {
      const [player1, player2] = this.duelsQueue.splice(0, 2);
      this.createDuelsMatch(player1, player2);
    }
  }

  createDuelsMatch(player1, player2) {
    const matchId = `match_${++this.matchIdCounter}`;
    
    const match = {
      id: matchId,
      player1,
      player2,
      startTime: Date.now(),
      state: 'starting',
      countdown: 3
    };

    this.duelsMatches.set(matchId, match);
    
    this.sendToPlayer(player1.ws, {
      type: 'MATCH_FOUND',
      payload: {
        matchId,
        opponent: { name: player2.name, rating: player2.rating }
      }
    });

    this.sendToPlayer(player2.ws, {
      type: 'MATCH_FOUND',
      payload: {
        matchId,
        opponent: { name: player1.name, rating: player1.rating }
      }
    });

    this.playerSessions.get(player1.ws).matchId = matchId;
    this.playerSessions.get(player2.ws).matchId = matchId;

    console.log(`🎮 [DUELS] Match created: ${player1.name} vs ${player2.name}`);

    this.startDuelsCountdown(matchId);
  }

  startDuelsCountdown(matchId) {
    const match = this.duelsMatches.get(matchId);
    if (!match) return;

    const countdownInterval = setInterval(() => {
      match.countdown--;
      
      this.sendToPlayer(match.player1.ws, {
        type: 'COUNTDOWN',
        payload: { count: match.countdown }
      });
      
      this.sendToPlayer(match.player2.ws, {
        type: 'COUNTDOWN',
        payload: { count: match.countdown }
      });

      if (match.countdown <= 0) {
        clearInterval(countdownInterval);
        this.startDuelsMatch(matchId);
      }
    }, 1000);
  }

  startDuelsMatch(matchId) {
    const match = this.duelsMatches.get(matchId);
    if (!match) return;

    match.state = 'active';
    
    this.sendToPlayer(match.player1.ws, { type: 'MATCH_START' });
    this.sendToPlayer(match.player2.ws, { type: 'MATCH_START' });
    
    console.log(`▶️ [DUELS] Match ${matchId} started`);
  }

  handleDuelsEnemySpawn(ws, payload) {
    const player = this.playerSessions.get(ws);
    if (!player || !player.matchId) return;

    const match = this.duelsMatches.get(player.matchId);
    if (!match || match.state !== 'active') return;

    const opponent = match.player1.ws === ws ? match.player2 : match.player1;
    
    this.sendToPlayer(opponent.ws, {
      type: 'SPAWN_ENEMIES',
      payload: payload
    });
  }

  handleDuelsStatsUpdate(ws, payload) {
    const player = this.playerSessions.get(ws);
    if (!player || !player.matchId) return;

    const match = this.duelsMatches.get(player.matchId);
    if (!match) return;

    const opponent = match.player1.ws === ws ? match.player2 : match.player1;
    
    this.sendToPlayer(opponent.ws, {
      type: 'OPPONENT_STATS',
      payload: payload
    });
  }

  handleDuelsPlayerDeath(ws) {
    const player = this.playerSessions.get(ws);
    if (!player || !player.matchId) return;

    const match = this.duelsMatches.get(player.matchId);
    if (!match) return;

    const winner = match.player1.ws === ws ? match.player2 : match.player1;
    const loser = player;

    const winnerRatingChange = this.calculateRatingChange(winner.rating, loser.rating, true);
    const loserRatingChange = this.calculateRatingChange(loser.rating, winner.rating, false);

    this.sendToPlayer(winner.ws, {
      type: 'MATCH_END',
      payload: {
        won: true,
        ratingChange: winnerRatingChange,
        opponentName: loser.name
      }
    });

    this.sendToPlayer(loser.ws, {
      type: 'MATCH_END',
      payload: {
        won: false,
        ratingChange: loserRatingChange,
        opponentName: winner.name
      }
    });

    console.log(`🏆 [DUELS] ${winner.name} defeated ${loser.name}`);

    this.duelsMatches.delete(player.matchId);
    this.playerSessions.get(winner.ws).matchId = null;
    this.playerSessions.get(loser.ws).matchId = null;
  }

  handleDuelsDisconnect(ws) {
    const player = this.playerSessions.get(ws);
    if (!player || !player.matchId) return;

    const match = this.duelsMatches.get(player.matchId);
    if (!match) return;

    const opponent = match.player1.ws === ws ? match.player2 : match.player1;
    
    this.sendToPlayer(opponent.ws, {
      type: 'OPPONENT_DISCONNECTED',
      payload: {
        message: 'Opponent disconnected. You win!'
      }
    });

    this.duelsMatches.delete(player.matchId);
    
    if (this.playerSessions.get(opponent.ws)) {
      this.playerSessions.get(opponent.ws).matchId = null;
    }
  }

  calculateRatingChange(playerRating, opponentRating, won) {
    const K = 32;
    const expectedScore = 1 / (1 + Math.pow(10, (opponentRating - playerRating) / 400));
    const actualScore = won ? 1 : 0;
    return Math.round(K * (actualScore - expectedScore));
  }

  // ==================== CO-OP MODE ====================
  
  addCoopPlayer(ws, playerData) {
    const player = {
      ws,
      id: playerData.playerId || Date.now(),
      name: playerData.playerName || 'Anonymous',
      joinTime: Date.now(),
      mode: 'coop'
    };

    this.coopQueue.push(player);
    this.playerSessions.set(ws, player);
    
    console.log(`✅ [CO-OP] Player ${player.name} joined queue`);
    
    this.sendToPlayer(ws, { type: 'SEARCHING' });
    
    this.tryCoopMatchmaking();
  }

  removeCoopPlayer(ws) {
    const player = this.playerSessions.get(ws);
    if (player && player.mode === 'coop') {
      this.coopQueue = this.coopQueue.filter(p => p.ws !== ws);
      console.log(`❌ [CO-OP] Player ${player.name} left queue`);
    }
  }

  tryCoopMatchmaking() {
    while (this.coopQueue.length >= 2) {
      const [player1, player2] = this.coopQueue.splice(0, 2);
      this.createCoopRoom(player1, player2);
    }
  }

  createCoopRoom(player1, player2) {
    const roomId = `coop_${++this.roomIdCounter}`;
    
    const room = {
      id: roomId,
      players: [player1, player2],
      gameState: {
        wave: 1,
        enemies: [],
        started: false
      }
    };

    this.coopRooms.set(roomId, room);
    
    player1.roomId = roomId;
    player2.roomId = roomId;
    player1.playerId = 1;
    player2.playerId = 2;
    
    this.playerSessions.get(player1.ws).roomId = roomId;
    this.playerSessions.get(player2.ws).roomId = roomId;

    this.sendToPlayer(player1.ws, {
      type: 'MATCH_FOUND',
      payload: {
        roomId: roomId,
        playerId: 1
      }
    });

    this.sendToPlayer(player2.ws, {
      type: 'MATCH_FOUND',
      payload: {
        roomId: roomId,
        playerId: 2
      }
    });

    console.log(`🤝 [CO-OP] Room created: ${player1.name} + ${player2.name}`);
  }

  handleCoopReady(ws, payload) {
    const player = this.playerSessions.get(ws);
    if (!player || !player.roomId) return;

    const room = this.coopRooms.get(player.roomId);
    if (!room) return;

    this.broadcastToRoom(room, {
      type: 'PARTNER_READY',
      payload: { playerId: player.playerId }
    }, ws);
  }

  handleCoopStartGame(ws) {
    const player = this.playerSessions.get(ws);
    if (!player || !player.roomId) return;

    const room = this.coopRooms.get(player.roomId);
    if (!room) return;

    room.gameState.started = true;
    
    this.broadcastToRoom(room, {
      type: 'GAME_START'
    });

    console.log(`▶️ [CO-OP] Game started in room ${room.id}`);
  }

  handleCoopPlayerPosition(ws, payload) {
    const player = this.playerSessions.get(ws);
    if (!player || !player.roomId) return;

    const room = this.coopRooms.get(player.roomId);
    if (!room) return;

    this.broadcastToRoom(room, {
      type: 'PARTNER_POSITION',
      payload: {
        playerId: player.playerId,
        x: payload.x,
        y: payload.y,
        vx: payload.vx,
        vy: payload.vy,
        facingLeft: payload.facingLeft
      }
    }, ws);
  }

  handleCoopPlayerShoot(ws, payload) {
    const player = this.playerSessions.get(ws);
    if (!player || !player.roomId) return;

    const room = this.coopRooms.get(player.roomId);
    if (!room) return;

    this.broadcastToRoom(room, {
      type: 'PARTNER_SHOOT',
      payload: {
        playerId: player.playerId,
        x: payload.x,
        y: payload.y,
        targetX: payload.targetX,
        targetY: payload.targetY
      }
    }, ws);
  }

  handleCoopEnemyKilled(ws, payload) {
    const player = this.playerSessions.get(ws);
    if (!player || !player.roomId) return;

    const room = this.coopRooms.get(player.roomId);
    if (!room) return;

    this.broadcastToRoom(room, {
      type: 'ENEMY_KILLED_SYNC',
      payload: {
        enemyId: payload.enemyId,
        killerId: player.playerId
      }
    }, ws);
  }

  handleCoopStatsUpdate(ws, payload) {
    const player = this.playerSessions.get(ws);
    if (!player || !player.roomId) return;

    const room = this.coopRooms.get(player.roomId);
    if (!room) return;

    this.broadcastToRoom(room, {
      type: 'PARTNER_STATS',
      payload: {
        playerId: player.playerId,
        hp: payload.hp,
        hpMax: payload.hpMax,
        level: payload.level
      }
    }, ws);
  }

  handleCoopPlayerDeath(ws) {
    const player = this.playerSessions.get(ws);
    if (!player || !player.roomId) return;

    const room = this.coopRooms.get(player.roomId);
    if (!room) return;

    this.broadcastToRoom(room, {
      type: 'PARTNER_DIED',
      payload: {
        playerId: player.playerId
      }
    }, ws);
  }

  handleCoopGameOver(ws, payload) {
    const player = this.playerSessions.get(ws);
    if (!player || !player.roomId) return;

    const room = this.coopRooms.get(player.roomId);
    if (!room) return;

    this.broadcastToRoom(room, {
      type: 'GAME_OVER_SYNC',
      payload: payload
    });
  }

  handleCoopDisconnect(ws) {
    const player = this.playerSessions.get(ws);
    if (!player || !player.roomId) return;

    const room = this.coopRooms.get(player.roomId);
    if (!room) return;

    this.broadcastToRoom(room, {
      type: 'PARTNER_DISCONNECTED'
    }, ws);

    const remainingPlayers = room.players.filter(p => p.ws !== ws);
    
    if (remainingPlayers.length === 0) {
      this.coopRooms.delete(player.roomId);
      console.log(`🗑️ [CO-OP] Room ${player.roomId} deleted (empty)`);
    }
  }

  // ==================== UTILITY METHODS ====================
  
  broadcastToRoom(room, message, excludeWs = null) {
    const data = JSON.stringify(message);
    room.players.forEach(player => {
      if (player.ws !== excludeWs && player.ws.readyState === WebSocket.OPEN) {
        player.ws.send(data);
      }
    });
  }

  sendToPlayer(ws, message) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  handleDisconnect(ws) {
    const player = this.playerSessions.get(ws);
    if (!player) return;

    // Remove from queues
    this.duelsQueue = this.duelsQueue.filter(p => p.ws !== ws);
    this.coopQueue = this.coopQueue.filter(p => p.ws !== ws);

    // Handle mode-specific disconnect
    if (player.mode === 'duels' && player.matchId) {
      this.handleDuelsDisconnect(ws);
    } else if (player.mode === 'coop' && player.roomId) {
      this.handleCoopDisconnect(ws);
    }

    this.playerSessions.delete(ws);
    console.log(`🔌 Player ${player.name} disconnected`);
  }

  getStatus() {
    return {
      status: 'online',
      duels: {
        queueLength: this.duelsQueue.length,
        activeMatches: this.duelsMatches.size
      },
      coop: {
        queueLength: this.coopQueue.length,
        activeRooms: this.coopRooms.size
      },
      connectedPlayers: this.playerSessions.size
    };
  }
}

const matchmaking = new UnifiedMatchmaking();

// ==================== WEBSOCKET CONNECTION ====================

wss.on('connection', (ws) => {
  console.log('🔗 New client connected');

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      
      switch (data.type) {
        // ===== DUELS MESSAGES =====
        case 'JOIN_QUEUE':
          matchmaking.addDuelsPlayer(ws, data.payload);
          break;

        case 'LEAVE_QUEUE':
          matchmaking.removeDuelsPlayer(ws);
          break;

        case 'SPAWN_ENEMIES':
          matchmaking.handleDuelsEnemySpawn(ws, data.payload);
          break;

        case 'STATS_UPDATE':
          // Could be either mode - check player mode
          const player = matchmaking.playerSessions.get(ws);
          if (player) {
            if (player.mode === 'duels') {
              matchmaking.handleDuelsStatsUpdate(ws, data.payload);
            } else if (player.mode === 'coop') {
              matchmaking.handleCoopStatsUpdate(ws, data.payload);
            }
          }
          break;

        case 'PLAYER_DEATH':
          // Check player mode
          const dyingPlayer = matchmaking.playerSessions.get(ws);
          if (dyingPlayer) {
            if (dyingPlayer.mode === 'duels') {
              matchmaking.handleDuelsPlayerDeath(ws);
            } else if (dyingPlayer.mode === 'coop') {
              matchmaking.handleCoopPlayerDeath(ws);
            }
          }
          break;

        // ===== CO-OP MESSAGES =====
        case 'FIND_PARTNER':
        case 'COOP_FIND_PARTNER':
          matchmaking.addCoopPlayer(ws, data.payload || {});
          break;

        case 'READY':
          matchmaking.handleCoopReady(ws, data.payload);
          break;

        case 'START_GAME':
          matchmaking.handleCoopStartGame(ws);
          break;

        case 'PLAYER_POSITION':
          matchmaking.handleCoopPlayerPosition(ws, data.payload);
          break;

        case 'PLAYER_SHOOT':
          matchmaking.handleCoopPlayerShoot(ws, data.payload);
          break;

        case 'ENEMY_KILLED':
          matchmaking.handleCoopEnemyKilled(ws, data.payload);
          break;

        case 'GAME_OVER':
          matchmaking.handleCoopGameOver(ws, data.payload);
          break;

        case 'CANCEL_SEARCH':
          matchmaking.removeDuelsPlayer(ws);
          matchmaking.removeCoopPlayer(ws);
          ws.send(JSON.stringify({ type: 'SEARCH_CANCELLED' }));
          break;

        // ===== GENERAL MESSAGES =====
        case 'PING':
          ws.send(JSON.stringify({ type: 'PONG' }));
          break;

        case 'GET_STATUS':
          ws.send(JSON.stringify({
            type: 'STATUS',
            payload: matchmaking.getStatus()
          }));
          break;

        default:
          console.log('❓ Unknown message type:', data.type);
      }
    } catch (error) {
      console.error('❌ Error handling message:', error);
    }
  });

  ws.on('close', () => {
    matchmaking.handleDisconnect(ws);
  });

  ws.on('error', (error) => {
    console.error('❌ WebSocket error:', error);
  });
});

// ==================== HTTP STATUS ENDPOINT ====================

server.on('request', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(matchmaking.getStatus()));
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('John Stick Unified Game Server is running! 🎮');
  }
});

server.listen(PORT, () => {
  console.log(`🚀 John Stick Unified Game Server running on port ${PORT}`);
  console.log(`📊 Status: http://localhost:${PORT}/status`);
  console.log(`🔌 WebSocket: ws://localhost:${PORT}`);
  console.log(`🎮 Supporting: Duels & Co-op modes`);
});

// ==================== STATUS LOGGING ====================

setInterval(() => {
  const status = matchmaking.getStatus();
  console.log('=== Server Status ===');
  console.log(`Connected Players: ${status.connectedPlayers}`);
  console.log(`Duels Queue: ${status.duels.queueLength} | Active: ${status.duels.activeMatches}`);
  console.log(`Co-op Queue: ${status.coop.queueLength} | Active: ${status.coop.activeRooms}`);
  console.log('===================');
}, 30000);
