const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 8080;

const server = http.createServer();
const wss = new WebSocket.Server({ server });

class MatchmakingQueue {
  constructor() {
    this.queue = [];
    this.activeMatches = new Map();
    this.playerSessions = new Map();
    this.matchIdCounter = 0;
  }

  addPlayer(ws, playerData) {
    const player = {
      ws,
      id: playerData.playerId,
      name: playerData.playerName || 'Anonymous',
      rating: playerData.rating || 1000,
      joinTime: Date.now()
    };

    this.queue.push(player);
    this.playerSessions.set(ws, player);
    
    console.log(`✅ Player ${player.name} joined queue (Rating: ${player.rating})`);
    
    this.tryMatchmaking();
  }

  removePlayer(ws) {
    const player = this.playerSessions.get(ws);
    if (player) {
      this.queue = this.queue.filter(p => p.ws !== ws);
      this.playerSessions.delete(ws);
      console.log(`❌ Player ${player.name} left queue`);
    }
  }

  tryMatchmaking() {
    while (this.queue.length >= 2) {
      const [player1, player2] = this.queue.splice(0, 2);
      this.createMatch(player1, player2);
    }
  }

  createMatch(player1, player2) {
    const matchId = `match_${++this.matchIdCounter}`;
    
    const match = {
      id: matchId,
      player1,
      player2,
      startTime: Date.now(),
      state: 'starting',
      countdown: 3
    };

    this.activeMatches.set(matchId, match);
    
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

    console.log(`🎮 Match created: ${player1.name} vs ${player2.name}`);

    this.startMatchCountdown(match);
  }

  startMatchCountdown(match) {
    const countdownInterval = setInterval(() => {
      match.countdown--;

      this.sendToMatch(match.id, {
        type: 'MATCH_COUNTDOWN',
        payload: { countdown: match.countdown }
      });

      if (match.countdown <= 0) {
        clearInterval(countdownInterval);
        this.startMatch(match);
      }
    }, 1000);
  }

  startMatch(match) {
    match.state = 'playing';
    match.startTime = Date.now();

    this.sendToMatch(match.id, {
      type: 'MATCH_START',
      payload: {
        matchId: match.id,
        startTime: match.startTime
      }
    });

    console.log(`▶️ Match ${match.id} started`);
  }

  handleEnemySpawn(ws, data) {
    const player = this.playerSessions.get(ws);
    if (!player || !player.matchId) return;

    const match = this.activeMatches.get(player.matchId);
    if (!match || match.state !== 'playing') return;

    const opponent = match.player1.ws === ws ? match.player2 : match.player1;

    this.sendToPlayer(opponent.ws, {
      type: 'ENEMY_SPAWN',
      payload: {
        enemies: data.enemies,
        timestamp: data.timestamp,
        fromOpponent: true
      }
    });
  }

  handleStatsUpdate(ws, stats) {
    const player = this.playerSessions.get(ws);
    if (!player || !player.matchId) return;

    const match = this.activeMatches.get(player.matchId);
    if (!match || match.state !== 'playing') return;

    player.stats = stats;

    const opponent = match.player1.ws === ws ? match.player2 : match.player1;
    this.sendToPlayer(opponent.ws, {
      type: 'OPPONENT_STATS',
      payload: stats
    });
  }

  handlePlayerDeath(ws) {
    const player = this.playerSessions.get(ws);
    if (!player || !player.matchId) return;

    const match = this.activeMatches.get(player.matchId);
    if (!match || match.state !== 'playing') return;

    match.state = 'finished';
    const opponent = match.player1.ws === ws ? match.player2 : match.player1;
    const winner = opponent;
    const loser = player;

    const ratingChange = this.calculateRatingChange(winner, loser);

    this.sendToPlayer(winner.ws, {
      type: 'MATCH_END',
      payload: {
        won: true,
        ratingChange: ratingChange,
        finalStats: winner.stats || {},
        rewards: {
          coins: 100,
          ratingChange: ratingChange
        }
      }
    });

    this.sendToPlayer(loser.ws, {
      type: 'MATCH_END',
      payload: {
        won: false,
        ratingChange: -Math.floor(ratingChange / 2),
        finalStats: loser.stats || {},
        rewards: {
          coins: 25,
          ratingChange: -Math.floor(ratingChange / 2)
        }
      }
    });

    console.log(`🏁 Match ${match.id} ended. Winner: ${winner.name}`);

    setTimeout(() => {
      this.activeMatches.delete(match.id);
    }, 60000);
  }

  calculateRatingChange(winner, loser) {
    const K = 32;
    const expectedWin = 1 / (1 + Math.pow(10, (loser.rating - winner.rating) / 400));
    return Math.floor(K * (1 - expectedWin));
  }

  sendToPlayer(ws, message) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  sendToMatch(matchId, message) {
    const match = this.activeMatches.get(matchId);
    if (!match) return;

    this.sendToPlayer(match.player1.ws, message);
    this.sendToPlayer(match.player2.ws, message);
  }

  handleDisconnect(ws) {
    const player = this.playerSessions.get(ws);
    if (!player) return;

    if (!player.matchId) {
      this.removePlayer(ws);
      return;
    }

    const match = this.activeMatches.get(player.matchId);
    if (match && match.state === 'playing') {
      const opponent = match.player1.ws === ws ? match.player2 : match.player1;
      
      this.sendToPlayer(opponent.ws, {
        type: 'OPPONENT_DISCONNECTED',
        payload: {
          message: 'Opponent disconnected. You win!'
        }
      });

      setTimeout(() => {
        this.handlePlayerDeath(opponent.ws);
      }, 1000);
    }

    this.playerSessions.delete(ws);
    console.log(`🔌 Player ${player.name} disconnected`);
  }
}

const matchmaking = new MatchmakingQueue();

wss.on('connection', (ws) => {
  console.log('🔗 New client connected');

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      
      switch (data.type) {
        case 'JOIN_QUEUE':
          matchmaking.addPlayer(ws, data.payload);
          break;

        case 'LEAVE_QUEUE':
          matchmaking.removePlayer(ws);
          break;

        case 'SPAWN_ENEMIES':
          matchmaking.handleEnemySpawn(ws, data.payload);
          break;

        case 'STATS_UPDATE':
          matchmaking.handleStatsUpdate(ws, data.payload);
          break;

        case 'PLAYER_DEATH':
          matchmaking.handlePlayerDeath(ws);
          break;

        case 'PING':
          ws.send(JSON.stringify({ type: 'PONG' }));
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

server.on('request', (req, res) => {
  // Add CORS headers
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
    res.end(JSON.stringify({
      status: 'online',
      queueLength: matchmaking.queue.length,
      activeMatches: matchmaking.activeMatches.size,
      connectedPlayers: matchmaking.playerSessions.size
    }));
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('John Stick Duels Server is running! 🎮');
  }
});

server.listen(PORT, () => {
  console.log(`🚀 John Stick Duels Server running on port ${PORT}`);
  console.log(`📊 Status: http://localhost:${PORT}/status`);
  console.log(`🔌 WebSocket: ws://localhost:${PORT}`);

});
