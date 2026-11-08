const express = require('express');
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const db = new sqlite3.Database('./database.db');

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      score INTEGER DEFAULT 100,
      last_change INTEGER DEFAULT 0
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS game_submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id TEXT NOT NULL,
      prefix TEXT NOT NULL,
      username TEXT NOT NULL,
      bet INTEGER NOT NULL,
      dice INTEGER NOT NULL,
      other_cards_sum INTEGER NOT NULL,
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
      db.run('INSERT INTO users (username, password, score, last_change) VALUES (?, ?, 100, 0)', [username, hashedPassword], function (err) {
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

// アカウント削除機能
app.post('/account/delete', requireLogin, (req, res) => {
  const username = req.session.username;
  db.serialize(() => {
    db.run('DELETE FROM users WHERE username = ?', [username]);
    db.run('DELETE FROM game_submissions WHERE username = ?', [username]);
  });
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

app.get('/', (req, res) => {
  if (!req.session.userId) {
    return res.render('login', { error: null });
  }
  db.get('SELECT score FROM users WHERE id = ?', [req.session.userId], (err, user) => {
    res.render('dashboard', { username: req.session.username, score: user ? user.score : 100 });
  });
});

app.get('/game', requireLogin, (req, res) => {
  const gameId = req.query.game_id || '';
  res.render('game', { gameId, username: req.session.username });
});

app.post('/game/submit', requireLogin, (req, res) => {
  const { game_id, bet, dice, other_cards_sum } = req.body;
  const username = req.session.username;

  if (!game_id) return res.status(400).json({ error: 'ゲームIDを入力してください' });

  db.get('SELECT score FROM users WHERE username = ?', [username], (err, currentUser) => {
    if (err || !currentUser) return res.status(400).json({ error: 'ユーザー情報が見つかりません' });

    if (currentUser.score <= 0) {
      return res.status(400).json({ error: '持ち点が0以下のため参加できません' });
    }

    const betNum = parseInt(bet, 10);
    const diceNum = parseInt(dice, 10);
    const cardsNum = parseInt(other_cards_sum, 10);

    if (isNaN(betNum) || betNum < 10 || betNum % 10 !== 0) {
      return res.status(400).json({ error: '掛け金は10pt以上、10pt刻みで入力してください' });
    }

    if (betNum > currentUser.score) {
      return res.status(400).json({ error: `掛け金は現在の持ち点（${currentUser.score}pt）以下にしてください` });
    }

    const prefixMatch = game_id.trim().match(/^[a-zA-Z]+/);
    const numberMatch = game_id.trim().match(/\d+$/);
    
    const prefix = prefixMatch ? prefixMatch[0].toLowerCase() : 'other';
    const totalPlayers = numberMatch ? parseInt(numberMatch[0], 10) : 4;

    db.run(`
      INSERT INTO game_submissions (game_id, prefix, username, bet, dice, other_cards_sum)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(game_id, username) 
      DO UPDATE SET bet=excluded.bet, dice=excluded.dice, other_cards_sum=excluded.other_cards_sum
    `, [game_id, prefix, username, betNum, diceNum, cardsNum], (err) => {
      if (err) {
        return res.status(500).json({ error: '保存に失敗しました' });
      }

      db.all('SELECT * FROM game_submissions WHERE game_id = ?', [game_id], (err, players) => {
        if (err) return res.status(400).json({ error: 'データ取得エラー' });

        if (players.length < totalPlayers) {
          return res.json({
            success: true,
            status: 'waiting',
            message: `情報を送信しました（${players.length}/${totalPlayers}人）残りのメンバーの送信を待っています。`
          });
        }

        players.sort((a, b) => a.other_cards_sum - b.other_cards_sum);
        players.forEach((p, idx) => { p.rank = idx + 1; });

        const upperCount = (totalPlayers % 2 === 0) 
          ? (totalPlayers / 2) 
          : Math.floor((totalPlayers - 1) / 2);
        
        const drawRank = (totalPlayers % 2 !== 0) ? (upperCount + 1) : -1;

        let nonLastTotalChange = 0;
        let changes = {};

        players.forEach(p => {
          let change = 0;
          if (p.rank === totalPlayers) {
            return;
          } else if (p.rank <= upperCount) {
            change = Math.floor((p.other_cards_sum + (p.bet / 10)) * p.dice + (p.bet / (totalPlayers / 2)));
          } else if (p.rank === drawRank) {
            change = 0;
          } else {
            change = -Math.floor(p.other_cards_sum * p.dice);
          }

          changes[p.username] = change;
          nonLastTotalChange += change;
        });

        const lastPlayer = players.find(p => p.rank === totalPlayers);
        if (lastPlayer) {
          changes[lastPlayer.username] = -nonLastTotalChange;
        }

        let completedCount = 0;
        players.forEach(p => {
          const ptChange = changes[p.username];
          db.run('UPDATE users SET score = score + ?, last_change = ? WHERE username = ?', [ptChange, ptChange, p.username], () => {
            completedCount++;
            if (completedCount === players.length) {
              db.run('DELETE FROM game_submissions WHERE game_id = ?', [game_id], () => {
                res.json({
                  success: true,
                  status: 'completed',
                  message: '全員のデータが揃い、点数が確定しました！ランキング画面へ移動します...'
                });
              });
            }
          });
        });
      });
    });
  });
});

app.get('/ranking', requireLogin, (req, res) => {
  const prefixFilter = req.query.prefix || '';

  db.all('SELECT username, score, last_change FROM users ORDER BY score DESC', [], (err, overallRanking) => {
    db.all('SELECT DISTINCT prefix FROM game_submissions', [], (err, prefixes) => {
      
      if (prefixFilter) {
        db.all(`
          SELECT DISTINCT u.username, u.score, u.last_change 
          FROM users u 
          JOIN game_submissions gs ON u.username = gs.username 
          WHERE gs.prefix = ? 
          ORDER BY u.score DESC
        `, [prefixFilter], (err, fRows) => {
          res.render('ranking', {
            overallRanking,
            filteredRanking: fRows,
            prefixes: prefixes ? prefixes.map(p => p.prefix) : [],
            currentPrefix: prefixFilter,
            username: req.session.username
          });
        });
      } else {
        res.render('ranking', {
          overallRanking,
          filteredRanking: null,
          prefixes: prefixes ? prefixes.map(p => p.prefix) : [],
          currentPrefix: '',
          username: req.session.username
        });
      }
    });
  });
});

// ランキングリセット（石田のみ実行可能）
app.post('/ranking/reset', requireLogin, (req, res) => {
  if (req.session.username !== '石田') {
    return res.status(403).send('リセット権限はプレイヤー名「石田」のみに制限されています。');
  }
  db.run('UPDATE users SET score = 100, last_change = 0', [], (err) => {
    if (err) return res.status(500).send('リセットに失敗しました');
    res.redirect('/ranking');
  });
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
