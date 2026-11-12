import {randomInt,randomUUID} from 'node:crypto';
import {daily,pools,schedule} from './deck.mjs';

const extra = [
 ['Bewegung',30,[
  ['Morgenrunde','Gehe 25 Minuten zügig spazieren.'],
  ['Intervallrunde','Wechsle fünfmal zwischen zwei Minuten Gehen und einer Minute lockerem Joggen.'],
  ['Schritte sammeln','Sammle an einem Tag 7.000 Schritte.'],
  ['Parkrunde','Gehe oder jogge eine Runde durch einen Park. Plane 25 Minuten ein.'],
  ['Kniebeugen in Sätzen','Mache drei Sätze mit je zwölf Kniebeugen.'],
  ['Wand-Liegestütze','Mache drei Sätze mit je zwölf Liegestützen an einer Wand.'],
  ['Wandsitz','Sammle insgesamt 90 Sekunden im Wandsitz, auf mehrere Sätze verteilt.'],
  ['Seitstütz','Halte pro Seite zweimal 20 Sekunden Seitstütz, bei Bedarf auf den Knien.'],
  ['Beckenheben','Mache drei Sätze mit je zwölf Wiederholungen.'],
  ['Wadenheben','Mache dreimal 15 Wiederholungen, bei Bedarf mit Halt.'],
  ['Rückwärts-Ausfallschritte','Mache zweimal acht Wiederholungen pro Seite.'],
  ['Schwimmrunde','Schwimme 15 Minuten in lockerem Tempo. Alternativ gehe 20 Minuten spazieren.'],
  ['Zügige Mittagspause','Geh in der Mittagspause 20 Minuten zügig nach draußen.'],
  ['Rumpfrunde','Mache zweimal je acht Bird Dogs pro Seite und 20 Sekunden Plank.']
 ]],
 ['Ernährung',25,[
  ['Haferfrühstück','Bereite Haferflocken mit Obst und einem Topping deiner Wahl zu.'],
  ['Hülsenfrüchte auf den Teller','Baue eine Portion Bohnen, Linsen oder Kichererbsen in eine Mahlzeit ein.'],
  ['Vollkorn ausprobieren','Probiere zu einer Mahlzeit ein Vollkornprodukt, das du selten isst.'],
  ['Neue Gemüsesorte','Koche eine Gemüsesorte, die du selten oder zum ersten Mal verwendest.'],
  ['Selbst gemachter Dip','Mixe einen Dip aus Joghurt, Sojajoghurt oder Bohnen und iss ihn mit Gemüse.'],
  ['Obst nach Saison','Wähle ein saisonales Obst und bereite daraus einen Snack zu.'],
  ['Reste-Küche','Mach aus vorhandenen Resten eine neue Mahlzeit.'],
  ['Buntes Ofengemüse','Backe zwei Gemüsesorten mit Gewürzen deiner Wahl.'],
  ['Kräuterprobe','Verfeinere ein Gericht mit zwei Kräutern.'],
  ['Frühstück vorbereiten','Bereite heute einen Teil deines morgigen Frühstücks vor.'],
  ['Rezept tauschen','Tausche mit jemandem ein Rezept und probiere eines davon aus.'],
  ['Getränk selbst mischen','Probiere Wasser mit Zitrone, Gurke oder Minze.'],
  ['Suppe selber kochen','Bereite eine einfache Gemüsesuppe zu.'],
  ['Pausenbox','Pack dir einen Snack aus zwei Komponenten, etwa Apfel und Joghurt.'],
  ['Gemeinsam kochen','Bereite mit einer anderen Person eine Mahlzeit zu.']
 ]],
 ['Spaß & Abwechslung',25,[
  ['Klopapier-Balance','Versuche fünf langsame Kniebeugen mit einer Klopapierrolle auf dem Kopf.'],
  ['Spaziergang-Bingo','Finde unterwegs drei Dinge: ein rotes Fahrrad, einen Vogel und etwas Rundes.'],
  ['Einbein-Zähneputzen','Steh beim Zähneputzen je Seite kurz auf einem Bein. Halte dich bei Bedarf fest.'],
  ['Würfelrunde','Würfle viermal und mache pro Wurf so viele Wand-Liegestütze wie Augen gefallen sind.'],
  ['Bewegte Werbepause','Mache in zwei Fernseh- oder Streamingpausen jeweils fünf Kniebeugen.'],
  ['Spielplatz-Runde','Gehe 20 Minuten spazieren und erkunde dabei eine Grünfläche, die du selten besuchst.'],
  ['Sockenwurf','Wirf fünf Sockenpaare in einen Wäschekorb. Pro Fehlwurf machst du zwei Kniebeugen.'],
  ['Zeitlupen-Sprint','Bewege dich 30 Sekunden in möglichst dramatischer Lauf-Zeitlupe. Wiederhole es zweimal.'],
  ['Tierische Runde','Gehe dreimal 15 Sekunden im Bärengang oder marschiere auf der Stelle.'],
  ['Foto-Spaziergang','Gehe 20 Minuten raus und fotografiere drei Dinge in derselben Farbe.'],
  ['Schattenboxen','Boxe dreimal je 30 Sekunden locker in die Luft, mit Pausen.'],
  ['Treppe zählen','Gehe gemütlich eine Treppe hoch und runter und schätze vorher die Stufenzahl. Wiederhole es dreimal.'],
  ['Trainingswürfel zu zweit','Würfelt abwechselnd. Jede Person macht insgesamt zehn bis zwanzig Kniebeugen oder Wand-Liegestütze.']
 ]]
];
const categories=['Bewegung','Ernährung','Spaß & Abwechslung'];
const colors=['pink','lime','cyan'];
const icons=['↗','✿','✦'];
export const weeklyDefaults=[
 ...pools.flatMap((group,index)=>group.map(item=>[...item,categories[index]])),
 ...extra.flatMap(([category,points,items],group)=>items.map(([name,hint],i)=>[`pool-${group}-${i}`,icons[group],name,hint,points,colors[group],category]))
];
export function setupChallenges(db,fail){
 db.exec(`
  CREATE TABLE IF NOT EXISTS challenge_catalog(id TEXT PRIMARY KEY,kind TEXT NOT NULL,enabled INTEGER NOT NULL,data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS challenge_periods(period TEXT NOT NULL,kind TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(period,kind));
 `);
 const insert=db.prepare('INSERT OR IGNORE INTO challenge_catalog VALUES(?,?,1,?)');
 for(const item of daily) insert.run(item.id,'daily',JSON.stringify(item));
 for(const [id,,name,hint,points,,category] of weeklyDefaults) insert.run(id,'weekly',JSON.stringify({id,name,hint,points,category,difficulty:'Mittel'}));
 const catalog=db.prepare('SELECT id,kind,enabled,data FROM challenge_catalog ORDER BY rowid');
 const snapshots=db.prepare('SELECT data FROM challenge_periods WHERE period=? AND kind=?');
 const save=db.prepare('INSERT OR IGNORE INTO challenge_periods VALUES(?,?,?)');
 function list(){
  return catalog.all().map(({kind,enabled,data})=>({...JSON.parse(data),kind,enabled:Boolean(enabled)}));
 }
 function snapshot(period,kind,choose){
  const existing=snapshots.get(period,kind);
  if(existing) return JSON.parse(existing.data);
  save.run(period,kind,JSON.stringify(choose()));
  return JSON.parse(snapshots.get(period,kind).data);
 }
 function current(now){
  const calendar=schedule(now);
  const dailyCards=snapshot(calendar.day,'daily',()=>list().filter(item=>item.kind==='daily'&&item.enabled));
  const weeklyCards=snapshot(calendar.week,'weekly',()=>{
   if(db.prepare('SELECT 1 FROM marks WHERE week=? AND period=? LIMIT 1').get(calendar.week,calendar.week)) return calendar.weekly;
   const prior=db.prepare("SELECT data FROM challenge_periods WHERE kind='weekly' AND period<? ORDER BY period DESC LIMIT 1").get(calendar.week);
   const previous=new Set(prior?JSON.parse(prior.data).map(item=>item[0]):[]);
   const pool=list().filter(item=>item.kind==='weekly'&&item.enabled);
   return categories.map((category,index)=>{
    const matching=pool.filter(item=>item.category===category);
    const fresh=matching.filter(item=>!previous.has(item.id));
    const options=fresh.length?fresh:matching;
    const item=options[randomInt(options.length)];
    return [item.id,icons[index],item.name,item.hint,item.points,colors[index],category,item.difficulty];
   });
  });
  return {...calendar,daily:dailyCards,weekly:weeklyCards};
 }
 function update(input){
  const {id,kind,enabled}=input||{};
  const name=typeof input?.name==='string'?input.name.trim():'';
  const hint=typeof input?.hint==='string'?input.hint.trim():'';
  if(!['daily','weekly'].includes(kind)||typeof enabled!=='boolean'||!name||name.length>80||hint.length>300) fail(400,'Prüfe Titel und Beschreibung.');
  const entries=list();
  const existing=entries.find(item=>item.id===id);
  if(id&&(!existing||existing.kind!==kind)) fail(404,'Aufgabe nicht gefunden.');
  const item={id:id||randomUUID(),name,hint};
  if(kind==='daily'){
   const {target,step,unit}=input;
   if(!Number.isInteger(target)||target<1||target>10000||!Number.isInteger(step)||step<1||step>target||!['Wdh.','Sek.'].includes(unit)) fail(400,'Prüfe Zielmenge, Einheit und Menge pro Punkt.');
   Object.assign(item,{target,step,unit,icon:existing?.icon||'squat',color:existing?.color||'lime'});
   if(!enabled&&!entries.some(row=>row.kind===kind&&row.enabled&&row.id!==id)) fail(400,'Mindestens eine Tagesübung muss aktiv bleiben.');
  } else {
   const {points,category,difficulty}=input;
   if(!hint||!categories.includes(category)||!['Leicht','Mittel','Schwer'].includes(difficulty)||!Number.isInteger(points)||points<1||points>1000) fail(400,'Prüfe Kategorie, Schwierigkeit, Punkte und Aufgabenbeschreibung.');
   Object.assign(item,{points,category,difficulty});
   for(const group of categories){
    if(!(enabled&&category===group)&&!entries.some(row=>row.kind===kind&&row.category===group&&row.enabled&&row.id!==id)) fail(400,'In jeder Wochenkategorie muss eine Aufgabe aktiv bleiben.');
   }
  }
  db.prepare('INSERT INTO challenge_catalog VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled,data=excluded.data').run(item.id,kind,Number(enabled),JSON.stringify(item));
 }
 return {current,list,update};
}
