const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const DATA_FILE = './data.json';

let state = {
  users: {},
  banned: [],
  game: {
    status: 'waiting',
    targetCount: 4,
    participants: [],
    inputs: {}
  }
};

if (fs.existsSync(DATA_FILE)) {
  try {
    const fileContent = fs.readFileSync(DATA_FILE, 'utf8');
    if (fileContent.trim()) {
      const parsed = JSON.parse(fileContent);
      state.users = parsed.users || {};
      state.banned = parsed.banned || [];
      state.game = parsed.game || state.game;
    }
  } catch (e) {
    console.log('data.json load error');
  }
}

function saveAndBroadcast() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(state));
  io.emit('stateUpdate', state);
}

function getRankDelta(rank, targetCount, b, c) {
  const N = Number(targetCount) || 2;
  const idx = Math.max(0, Number(rank) - 1);
  const half = Math.floor(N / 2);
  const isOdd = N % 2 !== 0;
  const mag = Number(b) * Number(c);

  if (idx < half) return mag;
  if (isOdd && idx === half) return 0;
  return -mag;
}

function getLastPlaceUser(inputs) {
  const entries = Object.entries(inputs);
  if (entries.length === 0) return null;
  entries.sort((x, y) => y[1].a - x[1].a);
  return entries[0][0];
}

io.on('connection', (socket) => {
  socket.emit('stateUpdate', state);

  socket.on('login', (username) => {
    if (!username) return;
    if (state.banned.includes(username)) {
      socket.emit('bannedNotice', username);
      return;
    }
    if (!state.users[username]) {
      state.users[username] = { points: 0 };
    }
    saveAndBroadcast();
  });

  socket.on('startGame', ({ username, targetCount }) => {
    if (username !== 'ad') return;
    state.game = {
      status: 'playing',
      targetCount: Number(targetCount) || 2,
      participants: [],
      inputs: {}
    };
    saveAndBroadcast();
  });

  socket.on('joinGame', (username) => {
    if (state.banned.includes(username)) return;
    if (state.game.status !== 'playing') return;
    if (!state.game.participants.includes(username) && state.game.participants.length < state.game.targetCount) {
      state.game.participants.push(username);
      saveAndBroadcast();
    }
  });

  socket.on('submitInput', ({ username, a, b, c }) => {
    if (state.banned.includes(username)) return;
    if (state.game.status !== 'playing') return;
    if (!state.game.participants.includes(username)) return;

    const numA = Number(a);
    const numB = Number(b);
    const numC = Number(c);
    const prev = state.game.inputs[username];

    if (prev && prev.appliedDelta && state.users[username]) {
      state.users[username].points -= prev.appliedDelta;
    }

    const isLast = numA === state.game.targetCount;
    const delta = isLast ? 0 : getRankDelta(numA, state.game.targetCount, numB, numC);

    if (!isLast && state.users[username]) {
      state.users[username].points += delta;
    }

    state.game.inputs[username] = {
      a: numA,
      b: numB,
      c: numC,
      delta,
      appliedDelta: isLast ? 0 : delta,
      isLast
    };

    if (Object.keys(state.game.inputs).length === state.game.targetCount) {
      finalizeLastPlace();
    } else {
      saveAndBroadcast();
    }
  });

  socket.on('adminAction', ({ username, type, targetUser, amount }) => {
    if (username !== 'ad') return;
    if (type === 'resetAll') {
      Object.keys(state.users).forEach(u => state.users[u].points = 0);
      state.game.status = 'waiting';
      state.game.participants = [];
      state.game.inputs = {};
    } else if (type === 'adjust' && state.users[targetUser]) {
      state.users[targetUser].points += Number(amount);
    } else if (type === 'forceResetGame') {
      state.game.status = 'waiting';
      state.game.participants = [];
      state.game.inputs = {};
    } else if (type === 'banUser' && targetUser && targetUser !== 'ad') {
      if (!state.banned.includes(targetUser)) {
        state.banned.push(targetUser);
      }
      delete state.users[targetUser];
      state.game.participants = state.game.participants.filter(u => u !== targetUser);
      delete state.game.inputs[targetUser];
      io.emit('userBanned', targetUser);
    }
    saveAndBroadcast();
  });
});

function finalizeLastPlace() {
  const entries = Object.entries(state.game.inputs);
  const lastUser = getLastPlaceUser(state.game.inputs);

  let nonLastSum = 0;
  entries.forEach(([user, val]) => {
    if (user !== lastUser) {
      nonLastSum += Number(val.delta) || 0;
    }
  });

  if (lastUser && state.users[lastUser]) {
    state.users[lastUser].points -= nonLastSum;
  }

  state.game.status = 'waiting';
  state.game.participants = [];
  state.game.inputs = {};
  saveAndBroadcast();
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
