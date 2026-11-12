export const daily = [
 {id:'push', icon:'push', name:'Liegestütze', target:10, unit:'Wdh.', step:1, color:'pink', hint:'Auch an der Wand'},
 {id:'plank', icon:'plank', name:'Plank', target:30, unit:'Sek.', step:5, color:'cyan', hint:'Sekunden addieren'},
 {id:'pull', icon:'pull', name:'Klimmzüge', target:3, unit:'Wdh.', step:1, color:'purple', hint:'Auch mit Unterstützung'},
 {id:'situp', icon:'situp', name:'Bauchaufzüge', target:15, unit:'Wdh.', step:1, color:'orange', hint:'Auch als Crunches'},
 {id:'squat', icon:'squat', name:'Kniebeugen', target:15, unit:'Wdh.', step:1, color:'lime', hint:'Mit Körpergewicht'}
];

export const pools = [
 [['run','↗','Raus an die Luft','20 Minuten locker joggen oder zügig gehen',30,'pink'],['stairs','↟','Treppen statt Aufzug','10 Minuten Treppensteigen oder bergauf gehen',30,'pink'],['walk','◎','Umweg erwünscht','Gehe 30 Minuten auf einer neuen Route spazieren',30,'pink'],['cycle','↗','Kleine Radtour','Fahre 20 Minuten mit dem Rad',30,'pink']],
 [['cook','✿','Farbe auf dem Teller','Bereite eine Mahlzeit mit drei verschiedenfarbigen Gemüsesorten zu',25,'lime'],['snack','✿','Snack selbst gemacht','Bereite einen Snack aus Obst und Naturjoghurt oder einer pflanzlichen Alternative zu',25,'lime'],['recipe','✿','Küchenpremiere','Probiere ein neues Rezept mit Linsen, Bohnen oder Kichererbsen',25,'lime']],
 [['dance','♫','Wohnzimmer-Disco','Tanze zu drei Songs deiner Wahl',25,'cyan'],['balance','◇','Balance-Check','Stehe je Seite zweimal 30 Sekunden auf einem Bein',25,'cyan'],['mobility','✦','Bewegliche Pause','Mache 10 Minuten lockere Mobilitätsübungen',25,'cyan'],['deck','◇','Würfeltraining','Würfle dreimal und mache jeweils so viele Kniebeugen',25,'cyan'],['friend','♫','Zu zweit','Verabrede dich zu einem Spaziergang oder einer kurzen Trainingseinheit',25,'cyan']]
];
export const monthTarget = 12;
export const monthBonus = 100;
export { wheel } from './supabase/functions/_shared/wheel.mjs';
export function exercisePoints(exercise, quantity) {
 const {target,step}=exercise;
 const base=Math.floor(Math.min(quantity,target)/step);
 const extra=Math.min(Math.max(quantity-target,0),target);
 const bonus=Math.min(Math.floor(extra/(4*step)),Math.floor(base/4));
 return base+bonus;
}
export function schedule(now = new Date()) {
 const day = new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Berlin',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
 const monday = new Date(day+'T00:00:00Z');
 monday.setUTCDate(monday.getUTCDate()-((monday.getUTCDay()+6)%7));
 const week = monday.toISOString().slice(0,10);
 const index = Math.floor(monday.getTime()/604800000);
 return {day,week,month:day.slice(0,7),daily,weekly:pools.map((pool,i)=>pool[(index+i)%pool.length]),monthTarget,monthBonus};
}
