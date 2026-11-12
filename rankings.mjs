export function setupRankings(db,{legacyCount,monthTarget,monthBonus}){
 db.exec(`
  CREATE TABLE IF NOT EXISTS point_resets(id INTEGER PRIMARY KEY, day TEXT NOT NULL, admin INTEGER NOT NULL REFERENCES users(id));
  CREATE TABLE IF NOT EXISTS point_reset_entries(reset_id INTEGER NOT NULL REFERENCES point_resets(id), user_id INTEGER NOT NULL, event TEXT NOT NULL, points INTEGER NOT NULL, PRIMARY KEY(reset_id,user_id,event));
  CREATE TABLE IF NOT EXISTS weekly_point_dates(user_id INTEGER NOT NULL,week TEXT NOT NULL,exercise TEXT NOT NULL,day TEXT NOT NULL,PRIMARY KEY(user_id,week,exercise));
  INSERT OR IGNORE INTO weekly_point_dates SELECT user_id,week,exercise,week FROM marks WHERE period=week;
 `);
 const events=db.prepare(`
  WITH completed AS (
   SELECT q.user_id,q.day FROM effective_quantities q
   LEFT JOIN challenge_periods p ON p.period=q.day AND p.kind='daily'
   WHERE q.reached=1 GROUP BY q.user_id,q.day HAVING COUNT(*)=COALESCE(json_array_length(p.data),?)
  ), numbered AS (
   SELECT user_id,day,ROW_NUMBER() OVER(PARTITION BY user_id,substr(day,1,7) ORDER BY day) AS number FROM completed
  )
  SELECT user_id,day,'exercise:'||exercise AS event,points FROM effective_quantities
  UNION ALL
  SELECT m.user_id,COALESCE(d.day,m.week),'weekly:'||m.exercise,m.points
  FROM marks m LEFT JOIN weekly_point_dates d USING(user_id,week,exercise) WHERE m.period=m.week
  UNION ALL SELECT user_id,day,'wheel:'||turn,CASE WHEN completed=1 THEN reward ELSE initial END FROM wheel_spins
  UNION ALL SELECT user_id,day,'monthly',? FROM numbered WHERE number=?
 `);
 const users=db.prepare('SELECT id,handle FROM users ORDER BY handle COLLATE NOCASE');
 const latest=db.prepare('SELECT id,day FROM point_resets WHERE day<=? ORDER BY id DESC LIMIT 1');
 const offsets=db.prepare('SELECT user_id,event,points FROM point_reset_entries WHERE reset_id=?');
 const saveOffset=db.prepare('INSERT INTO point_reset_entries VALUES(?,?,?,?)');
 function rows(){
  return events.all(legacyCount,monthBonus,monthTarget);
 }
 function standings(records,from,to){
  const reset=latest.get(to);
  const previous=new Map(reset?offsets.all(reset.id).map(row=>[row.user_id+':'+row.event,row.points]):[]);
  const scores=new Map();
  for(const row of records){
   if(row.day<from||row.day>to||row.day<(reset?.day||'')) continue;
   const offset=row.day===reset?.day?previous.get(row.user_id+':'+row.event):undefined;
   const points=offset===undefined?row.points:Math.max(0,row.points-offset);
   scores.set(row.user_id,(scores.get(row.user_id)||0)+points);
  }
  return users.all().map(({id,handle})=>({handle,points:scores.get(id)||0})).sort((a,b)=>b.points-a.points);
 }
 function state(deck){
  const year=Number(deck.day.slice(0,4));
  const month=Number(deck.day.slice(5,7))-1;
  const first=month-month%2;
  const date=(offset,day=1)=>new Date(Date.UTC(year,first+offset,day)).toISOString().slice(0,10);
  const start=date(0);
  const end=date(2,0);
  const previousStart=date(-2);
  const previousEnd=date(0,0);
  const records=rows();
  const lastStandings=standings(records,previousStart,previousEnd);
  const firstPlace=lastStandings[0]?.points;
  const winners=firstPlace>0?lastStandings.filter(row=>row.points===firstPlace):[];
  return {
   season:{start,end,previousStart,previousEnd,winners},
   seasonRanking:standings(records,start,deck.day),
   allTimeRanking:standings(records,'',deck.day),
   ranking:standings(records,deck.week,deck.day),
   monthlyRanking:standings(records,deck.month+'-01',deck.day)
  };
 }
 function reset(admin,day){
  const result=db.prepare('INSERT INTO point_resets(day,admin) VALUES(?,?)').run(day,admin);
  for(const row of rows()){
   if(row.day===day) saveOffset.run(result.lastInsertRowid,row.user_id,row.event,row.points);
  }
 }
 const recordWeekly=db.prepare('INSERT OR IGNORE INTO weekly_point_dates VALUES(?,?,?,?)');
 return {state,reset,recordWeekly};
}
