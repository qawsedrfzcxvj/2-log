const express = require('express');
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// DB初期化
const db = new sqlite3.Database('./database.db');

db.serialize(() => {
  // ユーザーテーブル（初期100pt）
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      score INTEGER DEFAULT 100
    )
  `);

  // 各自が提出したゲームデータのテーブル
  db.run(`
    CREATE TABLE IF NOT EXISTS game_submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id TEXT NOT NULL,
      prefix TEXT NOT NULL,
      username TEXT NOT NULL,
      bet INTEGER NOT NULL,
      dice INTEGER NOT NULL,
      rank INTEGER NOT NULL,
      cards INTEGER NOT NULL,
      calculated INTEGER DEFAULT 0,
      UNIQUE(game_id, username)
    )
  `);
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');

app.use(session({
  secret: 'daifugo2_secret_key',
  resave: false,
  saveUninitialized: false
}));

function requireLogin(req, res, next) {
  if (!req.session.userId) {
    return res.redirect('/login');
  }
  next();
}

// ログイン・登録
app.get('/login', (req, res) => {
  res.render('login', { error: null });
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.render('login', { error: 'ユーザー名とパスワードを入力してください' });
  }

  db.get('SELECT * FROM users WHERE username = ?', [username], async (err, user) => {
    if (err) return res.render('login', { error: 'DBエラーが発生しました' });

    if (user) {
      const match = await bcrypt.compare(password, user.password);
      if (match) {
        req.session.userId = user.id;
        req.session.username = user.username;
        return res.redirect('/');
      } else {
        return res.render('login', { error: 'パスワードが違います' });
      }
    } else {
      const hashedPassword = await bcrypt.hash(password, 10);
      db.run('INSERT INTO users (username, password, score) VALUES (?, ?, 100)', [username, hashedPassword], function (err) {
        if (err) return res.render('login', { error: '登録に失敗しました' });
        req.session.userId = this.lastID;
        req.session.username = username;
        return res.redirect('/');
      });
    }
  });
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// ダッシュボード
app.get('/', requireLogin, (req, res) => {
  db.get('SELECT score FROM users WHERE id = ?', [req.session.userId], (err, user) => {
    res.render('dashboard', { username: req.session.username, score: user ? user.score : 100 });
  });
});

// ゲーム画面（自分の情報を送信・同じIDの参加状況確認）
app.get('/game', requireLogin, (req, res) => {
  const gameId = req.query.game_id || '';
  res.render('game', { gameId, username: req.session.username });
});

// ゲームIDごとの提出状況を取得するAPI
app.get('/game/status', requireLogin, (req, res) => {
  const { game_id } = req.query;
  db.all('SELECT username, bet, dice, rank, cards, calculated FROM game_submissions WHERE game_id = ?', [game_id], (err, rows) => {
    if (err) return res.status(500).json({ error: 'DBエラー' });
    res.json({ submissions: rows });
  });
});

// 自分の情報を提出する
app.post('/game/submit', requireLogin, (req, res) => {
  const { game_id, bet, dice, rank, cards } = req.body;
  const username = req.session.username;

  if (!game_id) return res.status(400).json({ error: 'ゲームIDを入力してください' });

  // アルファベット部分を抽出（例: "a 1" -> "a"）
  const match = game_id.trim().match(/^[a-zA-Z]+/);
  const prefix = match ? match[0].toLowerCase() : 'other';

  const betNum = parseInt(bet, 10);
  const diceNum = parseInt(dice, 10);
  const rankNum = parseInt(rank, 10);
  const cardsNum = parseInt(cards, 10);

  if (isNaN(betNum) || betNum < 10 || betNum % 10 !== 0) {
    return res.status(400).json({ error: '掛け金は10pt以上、10pt刻みで入力してください' });
  }

  // UPSERT（すでに提出していれば更新）
  db.run(`
    INSERT INTO game_submissions (game_id, prefix, username, bet, dice, rank, cards, calculated)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0)
    ON CONFLICT(game_id, username) 
    DO UPDATE SET bet=excluded.bet, dice=excluded.dice, rank=excluded.rank, cards=excluded.cards, calculated=0
  `, [game_id, prefix, username, betNum, diceNum, rankNum, cardsNum], (err) => {
    if (err) return res.status(500).json({ error: '提出の保存に失敗しました' });
    res.json({ success: true });
  });
});

// 点数計算実行（同じゲームIDの全提出データを使用）
app.post('/game/calculate', requireLogin, (req, res) => {
  const { game_id } = req.body;

  db.all('SELECT * FROM game_submissions WHERE game_id = ?', [game_id], (err, players) => {
    if (err || players.length === 0) {
      return res.status(400).json({ error: 'プレイヤーの提出データが見つかりません' });
    }

    const totalPlayers = players.length;
    // 代表値として最初のプレイヤーの掛け金・サイコロを採用、またはそれぞれ
    const betNum = players[0].bet;
    const diceNum = players[0].dice;

    const totalCardsAll = players.reduce((sum, p) => sum + p.cards, 0);
    const threshold = Math.floor(totalPlayers / 2);

    let results = [];
    let nonLastTotalPointChange = 0;

    // 1. 最下位以外を計算
    players.forEach(p => {
      const otherCardsSum = totalCardsAll - p.cards;
      if (p.rank === totalPlayers) return; // 最下位は後で

      let pointChange = 0;
      if (p.rank <= threshold) {
        pointChange = Math.floor((otherCardsSum + (betNum / 10)) * diceNum);
      } else {
        pointChange = -Math.floor(otherCardsSum * diceNum);
      }

      nonLastTotalPointChange += pointChange;
      results.push({ username: p.username, rank: p.rank, pointChange });
    });

    // 2. 最下位を計算
    const lastPlayer = players.find(p => p.rank === totalPlayers);
    if (lastPlayer) {
      const lastPointChange = -nonLastTotalPointChange;
      results.push({ username: lastPlayer.username, rank: totalPlayers, pointChange: lastPointChange });
    }

    // DB反映 & 計算済みフラグ
    db.serialize(() => {
      results.forEach(r => {
        db.run('UPDATE users SET score = score + ? WHERE username = ?', [r.pointChange, r.username]);
      });
      db.run('UPDATE game_submissions SET calculated = 1 WHERE game_id = ?', [game_id]);
    });

    res.json({ success: true, results });
  });
});

// 総合 & アルファベット別ランキング
app.get('/ranking', requireLogin, (req, res) => {
  const prefixFilter = req.query.prefix || '';

  // 総合ランキング
  db.all('SELECT username, score FROM users ORDER BY score DESC', [], (err, overallRanking) => {
    // アルファベット別グループ一覧を取得
    db.all('SELECT DISTINCT prefix FROM game_submissions', [], (err, prefixes) => {
      
      let filteredRanking = null;
      if (prefixFilter) {
        // そのプレフィックスのゲームに参加したことがあるユーザーのスコア一覧
        db.all(`
          SELECT DISTINCT u.username, u.score 
          FROM users u 
          JOIN game_submissions gs ON u.username = gs.username 
          WHERE gs.prefix = ? 
          ORDER BY u.score DESC
        `, [prefixFilter], (err, fRows) => {
          res.render('ranking', {
            overallRanking,
            filteredRanking: fRows,
            prefixes: prefixes.map(p => p.prefix),
            currentPrefix: prefixFilter,
            username: req.session.username
          });
        });
      } else {
        res.render('ranking', {
          overallRanking,
          filteredRanking: null,
          prefixes: prefixes.map(p => p.prefix),
          currentPrefix: '',
          username: req.session.username
        });
      }
    });
  });
});

// 週末リセット
app.post('/ranking/reset', requireLogin, (req, res) => {
  db.run('UPDATE users SET score = 100', [], (err) => {
    if (err) return res.status(500).send('リセットに失敗しました');
    res.redirect('/ranking');
  });
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
