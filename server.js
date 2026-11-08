// 自分の情報を提出して即座に計算・反映・結果返却
app.post('/game/submit', requireLogin, (req, res) => {
  const { game_id, bet, dice, cards } = req.body;
  const username = req.session.username;

  if (!game_id) return res.status(400).json({ error: 'ゲームIDを入力してください' });

  // IDからアルファベット（グループ）と参加人数nを取得 (例: "a4" -> prefix: "a", n: 4)
  const prefixMatch = game_id.trim().match(/^[a-zA-Z]+/);
  const numberMatch = game_id.trim().match(/\d+$/);
  
  const prefix = prefixMatch ? prefixMatch[0].toLowerCase() : 'other';
  const totalPlayers = numberMatch ? parseInt(numberMatch[0], 10) : 4; // 数字がなければデフォルト4人

  const betNum = parseInt(bet, 10);
  const diceNum = parseInt(dice, 10);
  const cardsNum = parseInt(cards, 10);

  if (isNaN(betNum) || betNum < 10 || betNum % 10 !== 0) {
    return res.status(400).json({ error: '掛け金は10pt以上、10pt刻みで入力してください' });
  }

  // 1. 自身のデータ登録/更新
  db.run(`
    INSERT INTO game_submissions (game_id, prefix, username, bet, dice, rank, cards, calculated)
    VALUES (?, ?, ?, ?, ?, 0, ?, 0)
    ON CONFLICT(game_id, username) 
    DO UPDATE SET bet=excluded.bet, dice=excluded.dice, cards=excluded.cards
  `, [game_id, prefix, username, betNum, diceNum, cardsNum], (err) => {
    if (err) return res.status(500).json({ error: '保存に失敗しました' });

    // 2. このゲームIDの全参加者データから順位および点数計算
    db.all('SELECT * FROM game_submissions WHERE game_id = ?', [game_id], (err, players) => {
      if (err || players.length === 0) return res.status(400).json({ error: 'データ計算エラー' });

      // 残りカード枚数が少ない順に並べ替えて順位（rank）を決定（昇順）
      players.sort((a, b) => a.cards - b.cards);
      players.forEach((p, idx) => { p.rank = idx + 1; });

      const totalCardsAll = players.reduce((sum, p) => sum + p.cards, 0);

      // プラス点獲得の境界線（勝ちライン）算出
      const winThreshold = (totalPlayers % 2 === 0) 
        ? (totalPlayers / 2) 
        : Math.floor((totalPlayers - 1) / 2);
      
      const drawRank = (totalPlayers % 2 !== 0) ? (winThreshold + 1) : -1;

      let nonLastTotalPointChange = 0;
      let myPointChange = 0;

      players.forEach(p => {
        const otherCardsSum = totalCardsAll - p.cards;
        let pointChange = 0;

        if (p.rank === totalPlayers) {
          // 最下位（後で一括引き算）
          return;
        } else if (p.rank <= winThreshold) {
          // 勝ち
          pointChange = Math.floor((otherCardsSum + (betNum / 10)) * diceNum);
        } else if (p.rank === drawRank) {
          // 奇数の真ん中順位（0点）
          pointChange = 0;
        } else {
          // 負け（最下位以外）
          pointChange = -Math.floor(otherCardsSum * diceNum);
        }

        nonLastTotalPointChange += pointChange;
        if (p.username === username) myPointChange = pointChange;
      });

      // 最下位の場合の点数計算
      const myData = players.find(p => p.username === username);
      if (myData.rank === totalPlayers) {
        myPointChange = -nonLastTotalPointChange;
      }

      // ユーザーの総持ちptに反映
      db.run('UPDATE users SET score = score + ? WHERE username = ?', [myPointChange, username], () => {
        // 現在の最新ポイントと順位を取得して返却
        db.get('SELECT score FROM users WHERE username = ?', [username], (err, user) => {
          res.json({
            success: true,
            rank: myData.rank,
            totalPlayers: totalPlayers,
            pointChange: myPointChange,
            currentScore: user.score
          });
        });
      });
    });
  });
});
